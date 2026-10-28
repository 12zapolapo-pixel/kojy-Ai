/**
 * WebSocket Store — Zustand
 *
 * OWNERSHIP: apps/web/src/state
 * LAYER: Frontend — realtime transport state
 *
 * DESIGN:
 * - ONE WebSocket connection per browser tab (not per component)
 * - All WS events dispatched from here to domain stores
 * - Domain stores (botStore, simStore) never create their own connections
 * - Reconnect: exponential backoff capped at 30s
 * - Re-auth: sends JWT on every reconnect
 * - Subscription tracking: re-subscribes to all channels after reconnect
 *
 * EVENT DISPATCH PATTERN:
 * WS message received
 *   → parse JSON → ServerEvent discriminated union
 *   → switch on event.type
 *   → call domain store mutation directly (synchronous)
 *   → push to recentActivity log for ActivityFeed
 *
 * BATCHING:
 * - SimTick events: buffered 50ms before dispatching to simStore
 *   (prevents 10x speed sim from triggering 100 React renders/sec)
 * - All other events: dispatched immediately
 *
 * PERFORMANCE:
 * - recentActivity capped at 200 entries — oldest dropped
 * - SimTick events NOT pushed to recentActivity (too noisy)
 * - WS send queue — operations queued if WS not yet open
 */

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { ServerEvent, ClientEvent } from "@kojyai/shared/events";
import { useBotStore } from "./botStore";
import { useSimulationStore } from "./simulationStore";
import { useNotificationStore } from "./notificationStore";
import { useAuthStore } from "./authStore";

// ─── Types ────────────────────────────────────────────────────────────────────

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting";

interface ActivityEntry {
  id: string;
  type: ServerEvent["type"];
  botId?: string;
  botName?: string;
  message: string;
  level?: string;
  ts: number;
}

interface WsStore {
  // Connection state
  connected: boolean;
  status:    ConnectionStatus;
  error:     string | null;
  latencyMs: number | null;

  // Activity feed data
  recentActivity: ActivityEntry[];

  // Subscriptions (re-applied after reconnect)
  subscribedBots: Set<string>;
  subscribedOrgs: Set<string>;
  subscribedSims: Set<string>;
  subscribedDelegations: Set<string>;

  // Last delegation status event (for DelegationStudio to react to)
  // projectId/artifact are Composer-specific extensions to the base delegation_status event.
  // Typed loosely here (unknown) rather than importing @kojyai/engine's ComposerArtifact — this
  // store layer shouldn't take a dependency on the engine package; consumers (e.g. ComposerPage)
  // narrow `artifact` using their own imported ComposerArtifact type when reading it.
  lastDelegationEvent: { type: "delegation_status"; sessionUuid: string; taskStatus: string; message: string; botId?: string; scriptUuid?: string; ts: number; projectId?: string; artifact?: unknown } | null;

  // Actions
  connect:               () => void;
  disconnect:            () => void;
  subscribeBot:          (botId: string) => void;
  subscribeOrg:          (orgId: string) => void;
  subscribeSimulation:   (simId: string) => void;
  subscribeDelegation:   (userId: string) => void;
  unsubscribeDelegation: (userId: string) => void;
  send:                  (event: ClientEvent) => void;
  clearActivity:         () => void;
}

// ─── Internal WS State ────────────────────────────────────────────────────────
// Not in Zustand — doesn't need to be reactive

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let pingTs = 0;
let sendQueue: ClientEvent[] = [];

// SimTick batching buffer
let simTickBatch: ServerEvent[] = [];
let simTickFlushTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Store ────────────────────────────────────────────────────────────────────

export const useWsStore = create<WsStore>()(
  subscribeWithSelector((set, get) => ({
    connected:      false,
    status:         "disconnected",
    error:          null,
    latencyMs:      null,
    recentActivity: [],
    subscribedBots: new Set(),
    subscribedOrgs: new Set(),
    subscribedSims: new Set(),
    subscribedDelegations: new Set(),
    lastDelegationEvent: null,

    connect: () => {
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
      }
      createConnection(set, get);
    },

    disconnect: () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pingTimer) clearInterval(pingTimer);
      if (ws) ws.close(1000, "Client disconnect");
      ws = null;
      reconnectAttempts = 0;
      set({ connected: false, status: "disconnected" });
    },

    subscribeBot: (botId) => {
      set((s) => ({ subscribedBots: new Set([...s.subscribedBots, botId]) }));
      get().send({ type: "subscribe_bot", botId });
    },

    subscribeOrg: (orgId) => {
      set((s) => ({ subscribedOrgs: new Set([...s.subscribedOrgs, orgId]) }));
      get().send({ type: "subscribe_org", orgId });
    },

    subscribeSimulation: (simId) => {
      set((s) => ({ subscribedSims: new Set([...s.subscribedSims, simId]) }));
      get().send({ type: "subscribe_simulation", simulationId: simId });
    },

    subscribeDelegation: (userId) => {
      set((s) => ({ subscribedDelegations: new Set([...s.subscribedDelegations, userId]) }));
      get().send({ type: "subscribe_delegation", userId });
    },

    unsubscribeDelegation: (userId) => {
      set((s) => {
        const next = new Set(s.subscribedDelegations);
        next.delete(userId);
        return { subscribedDelegations: next };
      });
      get().send({ type: "unsubscribe_delegation", userId });
    },

    send: (event) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        sendQueue.push(event);
        return;
      }
      ws.send(JSON.stringify(event));
    },

    clearActivity: () => set({ recentActivity: [] }),
  })),
);

// ─── Connection Manager ───────────────────────────────────────────────────────

function createConnection(set: any, get: () => WsStore): void {
  // FIX-AUDIT: was a hardcoded `ws://` fallback regardless of the page's own
  // protocol. On an HTTPS production deployment with VITE_WS_URL unset (e.g.
  // a missed env var in a deployment config), this would be blocked outright
  // by the browser's mixed-content policy (browsers refuse plaintext ws://
  // connections from an https:// page) — breaking all realtime features
  // silently, not just weakening their security. Deriving the scheme from
  // window.location.protocol matches the page's own security level.
  const wsScheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = import.meta.env.VITE_WS_URL ?? `${wsScheme}//${window.location.host}/ws`;

  set({ status: reconnectAttempts > 0 ? "reconnecting" : "connecting", error: null });

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    reconnectAttempts = 0;
    set({ connected: true, status: "connected", error: null });

    // Authenticate the connection. The server only sets `client.authenticated`
    // via cookie auth (auth.login doesn't issue a cookie — sessions are bearer
    // tokens) or this "auth" message; without it every other message is
    // rejected with UNAUTHORIZED. completeHandshake() (triggered by the
    // server's "auth_ack" reply) does the queue drain / resubscribe / heartbeat
    // setup — sending those eagerly here would race the server's async
    // session lookup.
    const token = useAuthStore.getState().token;
    if (token) {
      ws!.send(JSON.stringify({ type: "auth", token } satisfies ClientEvent));
    } else {
      completeHandshake(set, get);
    }
  };

  ws.onmessage = (event) => {
    let msg: ServerEvent;
    try {
      msg = JSON.parse(event.data as string) as ServerEvent;
    } catch {
      return;
    }
    dispatchEvent(msg, set, get);
  };

  ws.onclose = (e) => {
    if (pingTimer) clearInterval(pingTimer);
    set({ connected: false, status: "disconnected" });

    // Don't reconnect on intentional close
    if (e.code === 1000) return;

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s max
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30_000);
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => createConnection(set, get), delay);
  };

  ws.onerror = () => {
    set({ error: "WebSocket error — reconnecting…" });
  };
}

// ─── Post-Auth Handshake ───────────────────────────────────────────────────────
//
// Run once the connection is authenticated — either immediately (anonymous
// connection, no token) or after the server's "auth_ack" confirms the
// session was accepted.

function completeHandshake(set: any, get: () => WsStore): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  // Drain send queue
  for (const event of sendQueue) {
    ws.send(JSON.stringify(event));
  }
  sendQueue = [];

  // Re-subscribe to all channels
  const { subscribedBots, subscribedOrgs, subscribedSims, subscribedDelegations } = get();
  for (const botId of subscribedBots) {
    ws.send(JSON.stringify({ type: "subscribe_bot", botId } satisfies ClientEvent));
  }
  for (const orgId of subscribedOrgs) {
    ws.send(JSON.stringify({ type: "subscribe_org", orgId } satisfies ClientEvent));
  }
  for (const simId of subscribedSims) {
    ws.send(JSON.stringify({ type: "subscribe_simulation", simulationId: simId } satisfies ClientEvent));
  }
  for (const userId of subscribedDelegations) {
    ws.send(JSON.stringify({ type: "subscribe_delegation", userId } satisfies ClientEvent));
  }

  // Heartbeat ping every 30s
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      pingTs = Date.now();
      ws.send(JSON.stringify({ type: "ping" } satisfies ClientEvent));
    }
  }, 30_000);
}

// ─── Event Dispatcher ─────────────────────────────────────────────────────────

function dispatchEvent(event: ServerEvent, set: any, get: () => WsStore): void {
  const botStore = useBotStore.getState();
  const simStore = useSimulationStore.getState();
  const notifStore = useNotificationStore.getState();

  switch (event.type) {
    case "pong":
      set({ latencyMs: Date.now() - pingTs });
      break;

    case "auth_ack":
      // Auth confirmed — now safe to resubscribe, drain the send queue, and
      // start the heartbeat.
      completeHandshake(set, get);
      break;

    case "bot_status":
      botStore.updateBotStatus(event.botId, event.status, event.error);
      pushActivity(set, get, {
        type:    "bot_status",
        botId:   event.botId,
        message: `Bot status → ${event.status}`,
        ts:      event.ts,
      });
      break;

    case "bot_health":
      botStore.updateBotHealth(event.botId, event.score);
      break;

    case "bot_log":
      pushActivity(set, get, {
        type:    "bot_log",
        botId:   event.botId,
        message: event.message,
        level:   event.level,
        ts:      event.ts,
      });
      break;

    case "bot_memory":
      pushActivity(set, get, {
        type:    "bot_memory",
        botId:   event.botId,
        message: `Memory ${event.action}: ${event.summary.slice(0, 60)}…`,
        ts:      event.ts,
      });
      break;

    case "bot_relationship":
      pushActivity(set, get, {
        type:    "bot_relationship",
        botId:   event.botId,
        message: `Relationship update with ${event.targetId}`,
        ts:      event.ts,
      });
      break;

    case "sim_tick":
      // Batch sim ticks — don't dispatch every tick as an activity entry
      bufferSimTick(event, simStore);
      break;

    case "sim_status":
      simStore.setSimulationStatus(event.simulationId, event.status, event.progress);
      pushActivity(set, get, {
        type:    "sim_status",
        message: `Simulation ${event.status} (${event.progress}%)`,
        ts:      event.ts,
      });
      break;

    case "sim_agent_action":
      pushActivity(set, get, {
        type:    "sim_agent_action",
        message: `Agent ${event.agentId}: ${event.action}`,
        ts:      event.ts,
      });
      break;

    case "notification":
      notifStore.addNotification({
        id:               Number(event.notificationId),
        type:             event.notificationType as any,
        title:            event.title,
        body:             event.body,
        actionUrl:        null,
        readAt:           null,
        createdAt:        new Date(event.ts),
        userId:           0,
      });
      break;

    case "system_alert":
      pushActivity(set, get, {
        type:    "system_alert",
        message: `[${event.severity.toUpperCase()}] ${event.message}`,
        ts:      event.ts,
      });
      break;

    case "error":
      console.error("[WS Error]", event.code, event.message);
      break;

    case "delegation_status":
      set({ lastDelegationEvent: event });
      pushActivity(set, get, {
        type:    "bot_log",
        botId:   event.botId ?? "",
        message: `[Delegation] ${event.taskStatus}: ${event.message}`,
        ts:      event.ts,
      });
      break;
  }
}

// ─── Activity Feed ────────────────────────────────────────────────────────────

const MAX_ACTIVITY = 200;

function pushActivity(
  set: any,
  get: () => WsStore,
  entry: Omit<ActivityEntry, "id">,
): void {
  const id = `${entry.ts}-${Math.random().toString(36).slice(2)}`;
  set((state: WsStore) => {
    const next = [{ ...entry, id }, ...state.recentActivity];
    return { recentActivity: next.slice(0, MAX_ACTIVITY) };
  });
}

// ─── SimTick Batching ─────────────────────────────────────────────────────────

function bufferSimTick(event: ServerEvent & { type: "sim_tick" }, simStore: any): void {
  simTickBatch.push(event);
  if (!simTickFlushTimer) {
    simTickFlushTimer = setTimeout(() => {
      // Apply the most recent tick only (discard intermediate states)
      const latest = simTickBatch[simTickBatch.length - 1] as typeof event;
      if (latest) {
        simStore.applyTick(latest.simulationId, latest.second, latest.agents);
      }
      simTickBatch = [];
      simTickFlushTimer = null;
    }, 50); // 50ms buffer = max 20 React renders/sec regardless of sim speed
  }
}
