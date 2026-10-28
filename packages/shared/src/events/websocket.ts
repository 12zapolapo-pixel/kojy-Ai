/**
 * @kojyai/shared — WebSocket Event Contracts
 *
 * OWNERSHIP: api/websocket owns emission. web/state owns consumption.
 * worker publishes to Redis; ws_gateway fans out to subscribed clients.
 *
 * DESIGN: All events are discriminated unions keyed by `type`.
 * The client switches on `type` and gets full type safety on `payload`.
 *
 * PROTOCOL:
 *   Client → Server: ClientEvent (subscribe, unsubscribe, auth, ping)
 *   Server → Client: ServerEvent (log, bot_status, sim_tick, presence, etc.)
 */

import { z } from "zod";
import type { BotStatus, BotHealthScore, SimulationStatus } from "../types/entities.js";

// ─── Client → Server ──────────────────────────────────────────────────────────

export type ClientEvent =
  | { type: "auth"; token: string }
  | { type: "ping" }
  | { type: "subscribe_bot"; botId: string }
  | { type: "unsubscribe_bot"; botId: string }
  | { type: "subscribe_org"; orgId: string }
  | { type: "subscribe_simulation"; simulationId: string }
  | { type: "inject_sim_event"; simulationId: string; eventType: string; payload: Record<string, unknown> }
  | { type: "request_presence"; roomId: string }
  // Delegation — subscribe to real-time agent status updates for the 3D scene
  | { type: "subscribe_delegation"; userId: string }
  | { type: "unsubscribe_delegation"; userId: string };

// ─── Runtime validation of Client → Server messages (M-05) ────────────────────
//
// SECURITY FIX (M-05): every HTTP procedure validates its input with zod, but
// WebSocket messages used to be trusted via a bare `JSON.parse(...) as
// ClientEvent` type assertion — TypeScript types are erased at runtime, so a
// client could send `{"type":"subscribe_bot","botId":{"$ne":1}}` or a
// 10 MB string and the handlers would run on it as-is. This is the actual
// runtime gate. Anything that doesn't match exactly one variant is rejected.
//
// Bounds are deliberately generous for legitimate IDs (UUIDs, nanoids,
// numeric user ids as strings) but tight enough to stop abuse.
const wsId = z.string().min(1).max(128);

export const clientEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth"),                  token:        z.string().min(1).max(8192) }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("subscribe_bot"),         botId:        wsId }),
  z.object({ type: z.literal("unsubscribe_bot"),       botId:        wsId }),
  z.object({ type: z.literal("subscribe_org"),         orgId:        wsId }),
  z.object({ type: z.literal("subscribe_simulation"),  simulationId: wsId }),
  z.object({
    type:         z.literal("inject_sim_event"),
    simulationId: wsId,
    eventType:    z.string().min(1).max(128),
    payload:      z.record(z.string(), z.unknown()),
  }),
  z.object({ type: z.literal("request_presence"),      roomId:       wsId }),
  z.object({ type: z.literal("subscribe_delegation"),  userId:       wsId }),
  z.object({ type: z.literal("unsubscribe_delegation"), userId:      wsId }),
]);

// Compile-time guard: if ClientEvent and the schema ever drift apart, this
// line stops type-checking instead of the drift being silent.
type _SchemaMatchesClientEvent = z.infer<typeof clientEventSchema> extends ClientEvent ? true : never;
const _schemaMatchesClientEvent: _SchemaMatchesClientEvent = true;
void _schemaMatchesClientEvent;

/**
 * Parse an untrusted, already-JSON-decoded value into a ClientEvent.
 * Returns null for anything malformed or unknown — callers must reject it.
 */
export function parseClientEvent(value: unknown): ClientEvent | null {
  const result = clientEventSchema.safeParse(value);
  return result.success ? (result.data as ClientEvent) : null;
}

// ─── Server → Client ──────────────────────────────────────────────────────────

export type ServerEvent =
  | AuthAckEvent
  | PongEvent
  | BotStatusEvent
  | BotLogEvent
  | BotHealthEvent
  | BotRelationshipEvent
  | BotMemoryEvent
  | SimTickEvent
  | SimStatusEvent
  | SimAgentActionEvent
  | OrgActivityEvent
  | PresenceEvent
  | NotificationEvent
  | SystemAlertEvent
  | DelegationStatusEvent
  | ErrorEvent;

export interface AuthAckEvent {
  type: "auth_ack";
  userId: string;
  orgIds: string[];
}

export interface PongEvent {
  type: "pong";
  ts: number;
}

export interface BotStatusEvent {
  type: "bot_status";
  botId: string;
  status: BotStatus;
  error: string | null;
  ts: number;
}

export interface BotLogEvent {
  type: "bot_log";
  botId: string;
  level: "info" | "warn" | "error" | "debug" | "council" | "judge" | "memory";
  source: "bot" | "manager" | "council" | "judge" | "memory" | "docker" | "system" | "highrise" | "moderation";
  message: string;
  ts: number;
}

export interface BotHealthEvent {
  type: "bot_health";
  botId: string;
  score: BotHealthScore;
  metrics: {
    responseLatencyMs: number;
    memoryUsageMb: number;
    errorRate: number;
    uptimeSeconds: number;
  };
  ts: number;
}

export interface BotRelationshipEvent {
  type: "bot_relationship";
  botId: string;
  targetId: string;
  delta: {
    trust?: number;
    loyalty?: number;
    affinity?: number;
  };
  ts: number;
}

export interface BotMemoryEvent {
  type: "bot_memory";
  botId: string;
  action: "created" | "compressed" | "archived";
  memoryId: string;
  summary: string;
  ts: number;
}

/** Simulation tick — emitted every N ms while simulation is running */
export interface SimTickEvent {
  type: "sim_tick";
  simulationId: string;
  second: number;
  agents: SimAgentState[];
  ts: number;
}

export interface SimAgentState {
  agentId: string;
  position: { x: number; y: number; z: number };
  animation: string;
  expression: string;
  currentTask: string | null;
  speaking: boolean;
  speechText: string | null;
}

export interface SimStatusEvent {
  type: "sim_status";
  simulationId: string;
  status: SimulationStatus;
  progress: number; // 0–100
  ts: number;
}

export interface SimAgentActionEvent {
  type: "sim_agent_action";
  simulationId: string;
  agentId: string;
  action: string;
  taskId: string | null;
  payload: Record<string, unknown>;
  ts: number;
}

export interface OrgActivityEvent {
  type: "org_activity";
  orgId: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  ts: number;
}

export interface PresenceEvent {
  type: "presence";
  roomId: string;
  onlineUsers: Array<{ id: string; username: string; avatarUrl: string | null }>;
  ts: number;
}

export interface NotificationEvent {
  type: "notification";
  // SECURITY FIX (H-16/H-17): this type previously had no target identifier
  // at all — the gateway's fan-out logic could only check "is this client
  // authenticated", not "is this notification meant for them", so every
  // notification for any user was pushed live to every connected user.
  // userId is required going forward; every publish site must supply it.
  userId: number;
  notificationId: string;
  title: string;
  body: string;
  notificationType: string;
  ts: number;
}

export interface SystemAlertEvent {
  type: "system_alert";
  severity: "info" | "warning" | "critical";
  message: string;
  ts: number;
}

/**
 * Delegation agent status — emitted during an agent run to drive the
 * Three.js office scene (DelegationStudio) and the chat status indicator.
 *
 * taskStatus mirrors delegation_sessions.taskStatus exactly.
 * message is a human-readable description of what the agent is currently
 * doing, suitable for display in the chat bubble below the status badge.
 */
export interface DelegationStatusEvent {
  type: "delegation_status";
  /** The string UUID of the delegation session being updated */
  sessionUuid: string;
  taskStatus: "idle" | "planning" | "coding" | "testing" | "deploying" | "done" | "failed";
  /** Human-readable description, e.g. "Planning emote command system..." */
  message: string;
  /** The bot UUID this agent run is targeting, if applicable */
  botId?: string;
  /** The bot_scripts uuid that was just deployed, if taskStatus === "done" */
  scriptUuid?: string;
  ts: number;
}

export interface ErrorEvent {
  type: "error";
  code: string;
  message: string;
  ts: number;
}
