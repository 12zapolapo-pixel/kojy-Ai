/**
 * KOJYAI WebSocket Gateway
 *
 * OWNERSHIP: apps/api/src/websocket
 * LAYER: Realtime transport — sits between Redis pub/sub and browser clients
 *
 * ARCHITECTURE:
 * - One gateway instance per API pod
 * - Bot runtime and worker jobs publish events to Redis channels
 * - Gateway subscribes Redis, fans out to connected authenticated clients
 * - Supports bot-level, org-level, and simulation-level subscriptions
 *
 * SECURITY:
 * - Cookie-based auth with 5s message-based fallback
 * - JWT + session DB re-verified every 5 minutes (REAUTH_INTERVAL_MS)
 * - Per-user connection limit enforced (MAX_WS_PER_USER = 5)
 * - Platform total cap at MAX_TOTAL_WS_CLIENTS = 500
 *
 * SCALING:
 * - Each API pod maintains its own WS connections
 * - Redis pub/sub ensures events reach clients on any pod
 * - Horizontal scaling: add pods, Redis fan-out handles distribution
 *
 * FAILURE:
 * - Redis down: in-process pub/sub only (clients on same pod get events)
 * - DB down during re-auth: disconnect client safely
 * - Malformed message: log + ignore (no crash)
 */

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server as HttpServer } from "http";
import { randomUUID } from "node:crypto";
import { jwtVerify } from "jose";
import { db } from "../db/client.js";
import { schema } from "../db/client.js"; // FIX-2: schema re-exported from client.ts
import { eq, gt, and, sql, inArray } from "drizzle-orm"; // FIX-13: inArray added
import { getRedis, getRedisSubscriber, getRedisPublisher } from "../utils/redis.js";
import { emitAuditLog } from "../events/audit.js";
import { createLogger } from "../utils/logger.js";
import { resolveClientIp } from "../utils/clientIp.js";
import type { ServerEvent, ClientEvent } from "@kojyai/shared/events";
import { parseClientEvent } from "@kojyai/shared/events";
import { WS_CHANNELS, LIMITS, REDIS_KEYS } from "@kojyai/shared/constants";

const log = createLogger("ws-gateway");

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuthedClient {
  ws: WebSocket;
  userId: number;
  sessionId: string;
  // FIX-12: IDs in the shared event protocol are strings (UUIDs/nanoids).
  // Using Set<number> + parseInt() silently destroys non-numeric IDs.
  subscribedBots: Set<string> | "all";
  subscribedOrgs: Set<string>;
  subscribedSims: Set<string>;
  // Delegation agent status subscriptions — keyed by string userId
  subscribedDelegations: Set<string>;
  authenticated: boolean;
  /** Resolved client IP (spoof-resistant, see utils/clientIp.ts) — key for the auth-failure throttle. */
  ip: string;
  /** Failed authentication attempts on THIS connection (L-07). */
  authFailures: number;
  authTimer: ReturnType<typeof setTimeout> | null;
  reauthTimer: ReturnType<typeof setInterval> | null;
}

// ─── State ────────────────────────────────────────────────────────────────────

const clients = new Map<WebSocket, AuthedClient>();
const logBuffer: Array<ServerEvent & { type: "bot_log" }> = [];
const userConnections = new Map<number, Set<WebSocket>>();

// ─── Pod identity (cross-pod fan-out de-duplication) ──────────────────────────
//
// RELIABILITY FIX: broadcastBotEvent() / broadcastOrgEvent() / broadcastSimEvent()
// deliver to this pod's local clients directly AND publish to Redis for other
// pods — but this pod's own subscriber also receives that publish and fanned it
// out to the same local clients a second time, so every event raised by the API
// process reached connected clients TWICE. Published events are now stamped with
// this pod's id and the subscriber skips its own echo. Events published by other
// processes (the worker publishes raw events with no stamp) are unaffected.
const POD_ID = randomUUID();

function publishEvent(channel: string, event: ServerEvent): void {
  const pub = getRedisPublisher();
  if (!pub) return;
  // RELIABILITY FIX: this used to be `void pub.publish(...)`. A rejected publish
  // (Redis down / reconnecting) then became an UNHANDLED PROMISE REJECTION, which
  // terminates the process on current Node versions.
  pub.publish(channel, JSON.stringify({ ...event, _origin: POD_ID })).catch((err) => {
    log.warn({ err, channel }, "Redis publish failed — event delivered to local clients only");
  });
}

/**
 * Parses a message from a Redis pub/sub channel. Returns null (and logs) for
 * malformed JSON or this pod's own echo. RELIABILITY FIX: the handlers used to
 * call JSON.parse() bare inside an event-emitter callback, so ONE malformed
 * message on any subscribed channel threw an uncaught exception and took the
 * whole API process down.
 */
function parseRemoteEvent(raw: string, channel: string): ServerEvent | null {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn({ channel }, "Ignoring malformed (non-JSON) message on Redis channel");
    return null;
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
    log.warn({ channel }, "Ignoring Redis message with no event type");
    return null;
  }
  if (parsed._origin === POD_ID) return null; // our own echo — already delivered locally
  delete parsed._origin;
  return parsed as ServerEvent;
}

// ─── WebSocket auth-failure throttle (L-07) ───────────────────────────────────
//
// SECURITY FIX (L-07): the WS auth path could be retried without limit. Session
// ids are 128 random characters so guessing is infeasible, but that was the ONLY
// defence. Two independent layers now sit in front of it:
//   - per CONNECTION: AUTH_FAIL_MAX_PER_CONNECTION failures -> socket closed
//   - per IP: AUTH_FAIL_MAX_PER_IP failures in AUTH_FAIL_WINDOW_SECONDS -> new
//     attempts are refused BEFORE any DB lookup, until the window expires
// Only FAILURES are counted, so ordinary reconnects never trip it. Redis is
// used when available (shared across pods); an in-memory fallback keeps the
// guard working when Redis is down. Fails OPEN if both are unusable-by-design:
// a throttle must never lock legitimate users out of the platform.
const AUTH_FAIL_WINDOW_SECONDS   = 60;
const AUTH_FAIL_MAX_PER_IP       = 20;
const AUTH_FAIL_MAX_PER_CONNECTION = 5;
const AUTH_THROTTLE_REDIS_TIMEOUT_MS = 500; // never let a slow Redis stall the 5s auth deadline
const LOCAL_THROTTLE_MAX_ENTRIES = 10_000;  // bounded: keys are attacker-influenced

// INCR + EXPIRE atomically so a crash between them can't leave a TTL-less key.
const AUTH_FAIL_LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n
`;

const localAuthFailures = new Map<string, { count: number; resetAt: number }>();

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const t = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("timeout")), ms); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

function pruneLocalThrottle(now: number): void {
  for (const [k, v] of localAuthFailures) if (v.resetAt <= now) localAuthFailures.delete(k);
  // Still full of live entries -> drop oldest-inserted until under the cap.
  for (const k of localAuthFailures.keys()) {
    if (localAuthFailures.size < LOCAL_THROTTLE_MAX_ENTRIES) break;
    localAuthFailures.delete(k);
  }
}

async function isAuthBlocked(ip: string): Promise<boolean> {
  if (!ip || ip === "unknown") return false; // no meaningful key; per-connection cap still applies
  const redis = getRedis();
  if (redis) {
    try {
      // Redis is AUTHORITATIVE whenever it answers: it is shared across pods,
      // and it is what an operator clears (DEL rl:wsauth:<ip>) to unblock an IP.
      // The in-memory counter below is only a fallback for when Redis is down.
      const n = Number(await withTimeout(redis.get(`rl:wsauth:${ip}`), AUTH_THROTTLE_REDIS_TIMEOUT_MS));
      return n >= AUTH_FAIL_MAX_PER_IP;
    } catch { /* Redis unavailable -> fall back to this pod's own view */ }
  }
  const e = localAuthFailures.get(ip);
  return !!e && e.resetAt > Date.now() && e.count >= AUTH_FAIL_MAX_PER_IP;
}

async function recordAuthFailure(ip: string): Promise<void> {
  if (!ip || ip === "unknown") return;
  const now = Date.now();
  // Always keep the local view too, so the guard still works if Redis drops.
  const e = localAuthFailures.get(ip);
  if (e && e.resetAt > now) e.count++;
  else {
    if (localAuthFailures.size >= LOCAL_THROTTLE_MAX_ENTRIES) pruneLocalThrottle(now);
    localAuthFailures.set(ip, { count: 1, resetAt: now + AUTH_FAIL_WINDOW_SECONDS * 1000 });
  }
  const redis = getRedis();
  if (!redis) return;
  try {
    await withTimeout(redis.eval(AUTH_FAIL_LUA, 1, `rl:wsauth:${ip}`, AUTH_FAIL_WINDOW_SECONDS) as Promise<unknown>, AUTH_THROTTLE_REDIS_TIMEOUT_MS);
  } catch (err) {
    log.warn({ err }, "WS auth throttle: Redis unavailable, using in-memory counter only");
  }
}

/** Counts a failed auth against the connection and IP; closes the socket at the cap. */
async function handleAuthFailure(ws: WebSocket, client: AuthedClient): Promise<void> {
  client.authFailures++;
  await recordAuthFailure(client.ip);
  if (client.authFailures >= AUTH_FAIL_MAX_PER_CONNECTION) {
    log.warn({ ip: client.ip, failures: client.authFailures }, "WS closed — too many failed authentication attempts");
    ws.close(4008, "Too many failed authentication attempts");
  }
}

// SECURITY FIX (H-04): Cross-Site WebSocket Hijacking defense. WS upgrade
// requests are not subject to the same-origin restrictions a browser
// enforces on fetch()/XHR — any site a victim visits can open a connection
// here and have the browser silently attach cookies. tryCookieAuth() below
// is dormant today (auth.login never sets a cookie — see H-05/auth
// router.ts), so this cannot be exploited *yet*, but fixing it now rather
// than "whenever the cookie work lands" means it can never be forgotten as
// a joint change, and it costs nothing to have active early. Built from
// FRONTEND_URL (same source of truth as the CORS config in boot.ts) plus an
// explicit allowlist for additional trusted origins if ever needed.
const ALLOWED_WS_ORIGINS = new Set(
  [process.env.FRONTEND_URL ?? "http://localhost:5173", ...((process.env.WS_EXTRA_ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean))],
);

function isAllowedOrigin(origin: string | undefined): boolean {
  // No Origin header at all means this isn't a browser request (browsers
  // always send Origin on a WS upgrade) — e.g. a server-to-server client
  // using the Bearer-token message-auth path, which isn't subject to CSWSH
  // in the first place since nothing is silently attached by a browser.
  // Only reject when an Origin IS present and doesn't match — that's the
  // actual CSWSH signature.
  if (!origin) return true;
  return ALLOWED_WS_ORIGINS.has(origin);
}

// ─── Gateway Init ─────────────────────────────────────────────────────────────

export function initWebSocketGateway(server: HttpServer): void {
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: LIMITS.WS_MAX_MESSAGE_BYTES,
  });

  // Subscribe to Redis channels for cross-pod fan-out
  initRedisSubscriptions(wss);

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    // SECURITY FIX (H-04): reject cross-origin upgrade requests before any
    // auth attempt — see ALLOWED_WS_ORIGINS/isAllowedOrigin above.
    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin)) {
      log.warn({ origin }, "WS connection rejected — origin not allowed");
      ws.close(4003, "Origin not allowed");
      return;
    }

    if (clients.size >= LIMITS.WS_MAX_CLIENTS_TOTAL) {
      sendEvent(ws, { type: "error", code: "CAPACITY", message: "Server at capacity", ts: Date.now() });
      ws.close(1013, "Server at capacity");
      return;
    }

    const client: AuthedClient = {
      ws,
      userId: 0,
      sessionId: "",
      subscribedBots: new Set(),
      subscribedOrgs: new Set(),
      subscribedSims: new Set(),
      subscribedDelegations: new Set(),
      authenticated: false,
      ip: resolveClientIp(req.socket.remoteAddress, req.headers["x-forwarded-for"]),
      authFailures: 0,
      authTimer: null,
      reauthTimer: null,
    };
    clients.set(ws, client);

    // 5 second auth deadline
    client.authTimer = setTimeout(() => {
      if (!client.authenticated) {
        sendEvent(ws, { type: "error", code: "AUTH_TIMEOUT", message: "Authentication required", ts: Date.now() });
        ws.close(4001, "Auth timeout");
      }
    }, LIMITS.AUTH_TIMEOUT_MS);

    // Attempt cookie-based auth immediately
    void tryCookieAuth(ws, client, req);

    ws.on("message", (raw) => handleMessage(ws, client, raw));
    ws.on("close", () => handleClose(ws, client));
    ws.on("error", (err) => log.error({ err, userId: client.userId }, "WS error"));
  });

  // Heartbeat — detect dead connections
  setInterval(() => {
    for (const [ws, client] of clients) {
      if ((ws as any).isAlive === false) {
        log.warn({ userId: client.userId }, "Dead connection detected");
        ws.terminate();
        continue;
      }
      (ws as any).isAlive = false;
      ws.ping();
    }
  }, LIMITS.PING_INTERVAL_MS);

  log.info("WebSocket gateway ready on /ws");
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function tryCookieAuth(
  ws: WebSocket,
  client: AuthedClient,
  req: IncomingMessage,
): Promise<void> {
  const cookie = req.headers["cookie"] ?? "";
  const sessionId = extractSessionCookie(cookie);
  if (!sessionId) return; // no cookie -> wait for message-based auth, nothing to count

  try {
    if (await isAuthBlocked(client.ip)) return; // refused before any DB lookup
    const userId = await verifySession(sessionId);
    completeAuth(ws, client, userId, sessionId);
  } catch {
    // Cookie auth failed — count it, then wait for message-based auth
    await handleAuthFailure(ws, client);
  }
}

/**
 * Verifies a session id against the DB and returns its user id. Throws if the
 * session is missing/expired or the user is not active. VERIFY ONLY — it does
 * not mutate the client; callers decide what to do with the result.
 *
 * RELIABILITY FIX: this used to be `authenticateBySession` and ended by calling
 * completeAuth(). The 5-minute re-auth timer called it too, so every re-auth
 * created a NEW setInterval without clearing the old one — each idle connection
 * doubled its re-auth timers every 5 minutes (each running 2 DB queries), and
 * handleClose could only ever clear the most recent one. Verification and
 * completion are now separate.
 */
async function verifySession(sessionId: string): Promise<number> {
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("Invalid session");

  const [session] = await db
    .select()
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.id, sessionId),
        gt(schema.sessions.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!session) throw new Error("Invalid session");

  const [user] = await db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.id, session.userId), eq(schema.users.status, "active")))
    .limit(1);

  if (!user) throw new Error("User not found or suspended");

  return session.userId;
}

async function authenticateByToken(
  ws: WebSocket,
  client: AuthedClient,
  token: string,
): Promise<void> {
  // Sessions are issued as raw IDs (the same value used as
  // `Authorization: Bearer <sessionId>` for tRPC — see extractSessionId in
  // apps/api/src/trpc.ts), not signed JWTs. Try JWT verification first for
  // forward-compatibility with any future token-minting flow, but fall back
  // to treating the token as a raw session ID, which is the actual format
  // produced by auth.login today.
  let sessionId: string | undefined;
  try {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
    const { payload } = await jwtVerify(token, secret);
    // A validly-signed JWT without a string sessionId claim must not fall
    // through as `undefined` into the DB query.
    sessionId = typeof payload["sessionId"] === "string" ? payload["sessionId"] : undefined;
    if (!sessionId) throw new Error("JWT has no sessionId claim");
  } catch {
    sessionId = token;
  }

  const userId = await verifySession(sessionId);
  completeAuth(ws, client, userId, sessionId);
}

function completeAuth(
  ws: WebSocket,
  client: AuthedClient,
  userId: number,
  sessionId: string,
): void {
  // SECURITY/RELIABILITY FIX: completeAuth used to run again for a connection
  // that was already authenticated (cookie auth racing a message auth, or a
  // client simply re-sending `auth`). That leaked timers AND — worse — silently
  // re-pointed an authenticated connection at a DIFFERENT user while keeping
  // every subscription the first user had been authorized for. Same identity
  // is a harmless no-op; a different identity is refused and the socket closed.
  if (client.authenticated) {
    if (client.userId !== userId) {
      log.warn({ from: client.userId, to: userId }, "WS identity change attempt — closing connection");
      ws.close(4004, "Re-authentication as a different user is not allowed");
    }
    return;
  }

  // Track connections per user. Limit is checked BEFORE the client is marked
  // authenticated so a refused connection never receives broadcast events.
  if (!userConnections.has(userId)) {
    userConnections.set(userId, new Set());
  }
  const conns = userConnections.get(userId)!;
  if (conns.size >= LIMITS.WS_MAX_PER_USER) {
    sendEvent(ws, { type: "error", code: "TOO_MANY_CONNECTIONS", message: "Connection limit reached", ts: Date.now() });
    ws.close(4002, "Too many connections");
    return;
  }

  client.userId = userId;
  client.sessionId = sessionId;
  client.authenticated = true;
  if (client.authTimer) clearTimeout(client.authTimer);

  conns.add(ws);
  (ws as any).isAlive = true;

  // FIX (L-08): the recent-log replay that used to live here always filtered
  // against an EMPTY subscription set (nothing can be subscribed yet at the
  // moment of authentication), so it never delivered anything. Replay now
  // happens per bot, right after a subscribe_bot passes its ownership check.

  sendEvent(ws, { type: "auth_ack", userId: String(userId), orgIds: [], ts: Date.now() } as any);

  // Re-auth timer — verify only; never calls completeAuth (see verifySession).
  client.reauthTimer = setInterval(async () => {
    try {
      const current = await verifySession(sessionId);
      if (current !== userId) throw new Error("Session now belongs to a different user");
    } catch {
      log.warn({ userId }, "Re-auth failed — disconnecting");
      ws.close(4003, "Session expired");
    }
  }, LIMITS.REAUTH_INTERVAL_MS);
}

// ─── Message Handling ─────────────────────────────────────────────────────────

function handleMessage(ws: WebSocket, client: AuthedClient, raw: any): void {
  (ws as any).isAlive = true;

  // SECURITY FIX (M-05): JSON.parse + a bare `as ClientEvent` cast validated
  // nothing at runtime. parseClientEvent() runs the real zod schema; anything
  // malformed or unknown is rejected before any handler sees it.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    return;
  }

  const msg = parseClientEvent(parsed);
  if (!msg) {
    sendEvent(ws, { type: "error", code: "INVALID_MESSAGE", message: "Malformed or unknown message", ts: Date.now() });
    return;
  }

  if (msg.type === "auth") {
    void handleAuthMessage(ws, client, msg.token);
    return;
  }

  if (!client.authenticated) {
    sendEvent(ws, { type: "error", code: "UNAUTHORIZED", message: "Not authenticated", ts: Date.now() });
    return;
  }

  switch (msg.type) {
    case "ping":
      sendEvent(ws, { type: "pong", ts: Date.now() });
      break;

    case "subscribe_bot": {
      // [SECURITY PATCH — Phase 6 pentest finding] Previously trusted
      // msg.botId with zero validation — any authenticated client could
      // subscribe to any bot's channel (status, logs, control events)
      // regardless of org membership.
      // NOTE: subscribedBots is only ever initialized as `new Set()` (see
      // client creation above) — nothing in this file ever sets it to the
      // string "all". This check is currently dead code, not a working
      // "admin sees everything" path — flagging rather than asserting an
      // intent I can't verify. If an admin/superadmin bypass is genuinely
      // wanted, it needs to be wired at client-creation time based on
      // ctx.user.role, and reverified here.
      if (client.subscribedBots === "all") { break; }
      void verifyBotOwnership(client.userId, msg.botId).then((owned) => {
        if (!owned) {
          sendEvent(ws, {
            type: "error", code: "FORBIDDEN",
            message: "You do not have permission to view this bot.",
            ts: Date.now(),
          });
          log.warn({ userId: client.userId, botId: msg.botId }, "Unauthorized bot subscribe attempt");
          return;
        }
        (client.subscribedBots as Set<string>).add(msg.botId); // FIX-12: store string ID directly — parseInt destroys UUID/nanoid IDs
        replayBotLogs(ws, msg.botId); // L-08: ownership just verified — safe to replay history
      }).catch((err) => {
        log.error({ err, userId: client.userId }, "Bot ownership check error on subscribe");
        sendEvent(ws, { type: "error", code: "INTERNAL_ERROR", message: "Could not verify bot ownership.", ts: Date.now() });
      });
      break;
    }

    case "unsubscribe_bot": {
      if (client.subscribedBots !== "all") {
        (client.subscribedBots as Set<string>).delete(msg.botId); // FIX-12
      }
      break;
    }

    case "subscribe_org": {
      // [SECURITY PATCH — Phase 6 pentest finding] Previously trusted
      // msg.orgId with zero validation — any authenticated client could
      // subscribe to any org's channel regardless of membership.
      void verifyOrgMembership(client.userId, msg.orgId).then((member) => {
        if (!member) {
          sendEvent(ws, {
            type: "error", code: "FORBIDDEN",
            message: "You are not a member of this organization.",
            ts: Date.now(),
          });
          log.warn({ userId: client.userId, orgId: msg.orgId }, "Unauthorized org subscribe attempt");
          return;
        }
        client.subscribedOrgs.add(msg.orgId); // FIX-12: string, no parseInt
      }).catch((err) => {
        log.error({ err, userId: client.userId }, "Org membership check error on subscribe");
        sendEvent(ws, { type: "error", code: "INTERNAL_ERROR", message: "Could not verify org membership.", ts: Date.now() });
      });
      break;
    }

    case "subscribe_simulation": {
      // [SECURITY PATCH — Phase 6 pentest finding] Same unvalidated-subscribe
      // gap as subscribe_delegation — reusing the same ownership check
      // inject_sim_event already relies on, rather than a second bespoke one.
      void verifySimOwnership(client.userId, msg.simulationId).then((owned) => {
        if (!owned) {
          sendEvent(ws, {
            type: "error", code: "FORBIDDEN",
            message: "You do not have permission to view this simulation.",
            ts: Date.now(),
          });
          log.warn({ userId: client.userId, simulationId: msg.simulationId }, "Unauthorized simulation subscribe attempt");
          return;
        }
        client.subscribedSims.add(msg.simulationId); // FIX-12: string, no parseInt
      }).catch((err) => {
        log.error({ err, userId: client.userId }, "Sim ownership check error on subscribe");
        sendEvent(ws, { type: "error", code: "INTERNAL_ERROR", message: "Could not verify simulation ownership.", ts: Date.now() });
      });
      break;
    }

    case "subscribe_delegation":
      // [SECURITY PATCH — Phase 6 pentest finding] Previously trusted
      // msg.userId with zero validation — any authenticated client could
      // subscribe to ANY other user's delegation:{userId} channel and
      // eavesdrop on their live Composer runs (spec, generated code, test
      // results, deploy status — all now flow over this channel per the
      // artifact-forwarding fix). This channel is inherently single-user,
      // so the fix is a direct identity check, not a DB lookup.
      if (msg.userId !== String(client.userId)) {
        sendEvent(ws, {
          type: "error", code: "FORBIDDEN",
          message: "You can only subscribe to your own delegation channel.",
          ts: Date.now(),
        });
        log.warn({ userId: client.userId, requestedUserId: msg.userId }, "Unauthorized delegation subscribe attempt");
        break;
      }
      client.subscribedDelegations.add(msg.userId);
      break;

    case "unsubscribe_delegation":
      client.subscribedDelegations.delete(msg.userId);
      break;

    case "inject_sim_event": {
      // SECURITY/CORRECTNESS FIX (M-17): this used to only check ownership and
      // then publish to `sim:control:<id>` — a pub/sub channel NOTHING reads.
      // The worker drains REDIS_KEYS.SIM_INJECT_QUEUE (a list), which is what
      // the tRPC simulation.injectEvent procedure pushes to. So the WebSocket
      // path silently dropped every event, and also skipped the
      // "simulation must be running" check and the audit row. It now runs the
      // exact same checks and the exact same mechanism as the tRPC procedure.
      void handleInjectSimEvent(ws, client, msg).catch((err) => {
        log.error({ err, userId: client.userId }, "Sim event injection error");
        sendEvent(ws, { type: "error", code: "INTERNAL_ERROR", message: "Could not inject simulation event.", ts: Date.now() });
      });
      break;
    }
  }
}

async function handleAuthMessage(ws: WebSocket, client: AuthedClient, token: string): Promise<void> {
  // Already authenticated: nothing to do, and no reason to hit the DB again.
  if (client.authenticated) return;

  // SECURITY FIX (L-07): refuse BEFORE any DB lookup once this IP has failed too often.
  if (await isAuthBlocked(client.ip)) {
    sendEvent(ws, { type: "error", code: "RATE_LIMITED", message: "Too many failed attempts. Try again later.", ts: Date.now() });
    ws.close(4008, "Too many failed authentication attempts");
    return;
  }

  try {
    await authenticateByToken(ws, client, token);
  } catch {
    sendEvent(ws, { type: "error", code: "AUTH_FAILED", message: "Invalid token", ts: Date.now() });
    await handleAuthFailure(ws, client);
  }
}

/** Replays this pod's recent log lines for ONE bot (L-08). Call only after ownership is verified. */
function replayBotLogs(ws: WebSocket, botId: string): void {
  const recent = logBuffer.filter((e) => String(e.botId) === botId).slice(-50);
  for (const entry of recent) sendEvent(ws, entry);
}

async function handleInjectSimEvent(
  ws: WebSocket,
  client: AuthedClient,
  msg: Extract<ClientEvent, { type: "inject_sim_event" }>,
): Promise<void> {
  const reject = (code: string, message: string): void =>
    sendEvent(ws, { type: "error", code, message, ts: Date.now() });

  if (!client.userId) return reject("UNAUTHENTICATED", "Not authenticated.");

  // Ownership: the simulation must belong to an org this user is a member of.
  const memberships = await db
    .select({ orgId: schema.orgMembers.orgId })
    .from(schema.orgMembers)
    .where(eq(schema.orgMembers.userId, client.userId));

  const [sim] = memberships.length === 0 ? [] : await db
    .select({ uuid: schema.simulations.uuid, orgId: schema.simulations.orgId, status: schema.simulations.status })
    .from(schema.simulations)
    .where(and(
      eq(schema.simulations.uuid, msg.simulationId),
      inArray(schema.simulations.orgId, memberships.map((m) => m.orgId)),
    ))
    .limit(1);

  if (!sim) {
    log.warn({ userId: client.userId, simulationId: msg.simulationId }, "Unauthorized sim event injection attempt");
    return reject("FORBIDDEN", "You do not have permission to inject events into this simulation.");
  }

  if (sim.status !== "running") {
    return reject("CONFLICT", "Simulation is not running — start it before injecting chaos events.");
  }

  const redis = getRedis();
  if (!redis) return reject("SERVICE_UNAVAILABLE", "Event queue unavailable — Redis is offline.");

  await redis.rpush(REDIS_KEYS.SIM_INJECT_QUEUE(sim.uuid), JSON.stringify({
    type:    msg.eventType,
    payload: msg.payload,
    ts:      Date.now(),
  }));

  await emitAuditLog(db, {
    orgId:        sim.orgId,
    actorId:      client.userId,
    actorType:    "user",
    action:       "simulation.inject_event",
    resourceType: "simulation",
    resourceId:   sim.uuid,
    afterState:   { eventType: msg.eventType, via: "websocket" },
  });
}

function handleClose(ws: WebSocket, client: AuthedClient): void {
  if (client.authTimer) clearTimeout(client.authTimer);
  if (client.reauthTimer) clearInterval(client.reauthTimer);
  clients.delete(ws);
  if (client.userId) {
    const conns = userConnections.get(client.userId);
    conns?.delete(ws);
    // Don't leak one empty Set per user that has ever connected.
    if (conns && conns.size === 0) userConnections.delete(client.userId);
  }
}

// ─── Broadcasting ─────────────────────────────────────────────────────────────

/** Broadcast a server event to all clients subscribed to that bot */
// FIX-12: botId is now string — no parseInt(), no number cast
export function broadcastBotEvent(botId: string, event: ServerEvent): void {
  addToLogBuffer(event);

  for (const [ws, client] of clients) {
    if (!client.authenticated) continue;
    const subs = client.subscribedBots;
    if (subs === "all" || (subs as Set<string>).has(botId)) {
      sendEvent(ws, event);
    }
  }

  // Also publish to Redis for other pods
  publishEvent(WS_CHANNELS.BOT(botId), event);
}

// FIX-12: orgId is now string
export function broadcastOrgEvent(orgId: string, event: ServerEvent): void {
  for (const [ws, client] of clients) {
    if (!client.authenticated) continue;
    if (client.subscribedOrgs.has(orgId)) {
      sendEvent(ws, event);
    }
  }
  publishEvent(WS_CHANNELS.ORG(orgId), event);
}

// FIX-12/15: simId is now string — parseInt(UUID) = NaN which breaks fan-out entirely
export function broadcastSimEvent(simId: string, event: ServerEvent): void {
  for (const [ws, client] of clients) {
    if (!client.authenticated) continue;
    if (client.subscribedSims.has(simId)) {
      sendEvent(ws, event);
    }
  }
  publishEvent(WS_CHANNELS.SIMULATION(simId), event);
}

export function broadcastSystemEvent(event: ServerEvent): void {
  for (const [ws, client] of clients) {
    if (client.authenticated) sendEvent(ws, event);
  }
}

// ─── Redis Subscriptions ──────────────────────────────────────────────────────

function initRedisSubscriptions(_wss: WebSocketServer): void {
  const sub = getRedisSubscriber();
  if (!sub) {
    log.warn("Redis subscriber unavailable — cross-pod WS fan-out disabled");
    return;
  }

  // Subscribe to wildcard channels — fan out to local clients.
  // ioredis exposes psubscribe/subscribe as fire-and-forget commands; matched
  // messages arrive via the "pmessage"/"message" events, not per-call callbacks.
  void sub.psubscribe("bot:*", "org:*", "sim:*", "delegation:*");
  void sub.subscribe("system");

  sub.on("pmessage", (pattern: string, channel: string, msg: string) => {
    const event = parseRemoteEvent(msg, channel);
    if (!event) return;
    if (pattern === "bot:*") {
      // Worker-originated / other-pod log lines never pass through
      // broadcastBotEvent here, so buffer them for per-bot replay (L-08).
      addToLogBuffer(event);
      // FIX-12: extract string ID directly — no parseInt
      const botId = channel.split(":")[1] ?? "";
      fanOutLocally(
        (c) => c.subscribedBots === "all" || (c.subscribedBots as Set<string>).has(botId),
        event,
      );
    } else if (pattern === "org:*") {
      const orgId = channel.split(":")[1] ?? ""; // FIX-12: string
      fanOutLocally((c) => c.subscribedOrgs.has(orgId), event);
    } else if (pattern === "sim:*") {
      const simId = channel.split(":")[1] ?? ""; // FIX-12: string
      fanOutLocally((c) => c.subscribedSims.has(simId), event);
    } else if (pattern === "delegation:*") {
      // delegation:{userId} — fan out to any client subscribed to this user's delegation
      const userId = channel.slice("delegation:".length);
      fanOutLocally((c) => c.subscribedDelegations.has(userId), event);
    }
  });

  sub.on("message", (channel: string, msg: string) => {
    if (channel !== "system") return;
    const event = parseRemoteEvent(msg, channel);
    if (!event) return;
    // SECURITY FIX (H-16/H-17): the "system" channel carries multiple event
    // types — system_alert is genuinely meant to broadcast to everyone
    // (e.g. platform-wide maintenance notices), but "notification" is a
    // per-user event (billing failed, bot went offline, etc.) that was
    // previously fanned out to every authenticated client on the platform
    // via the same undifferentiated `c.authenticated` check. Scope
    // notification events to their actual target userId; leave every other
    // system-channel event type's broadcast behavior unchanged.
    if (event.type === "notification") {
      fanOutLocally((c) => c.userId === event.userId, event);
    } else {
      fanOutLocally((c) => c.authenticated, event);
    }
  });
}

function fanOutLocally(
  predicate: (client: AuthedClient) => boolean,
  event: ServerEvent,
): void {
  for (const [ws, client] of clients) {
    if (client.authenticated && predicate(client)) {
      sendEvent(ws, event);
    }
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sendEvent(ws: WebSocket, event: ServerEvent): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

function extractSessionCookie(cookieStr: string): string | null {
  const match = cookieStr.match(/(?:^|;\s*)session=([^;]+)/);
  return match?.[1] ?? null;
}

function addToLogBuffer(event: ServerEvent): void {
  if (event.type !== "bot_log") return;
  logBuffer.push(event as any);
  if (logBuffer.length > LIMITS.LOG_BUFFER_SIZE) {
    logBuffer.shift();
  }
}

/**
 * Verifies that a simulation belongs to an org the user is a member of.
 * Called before processing inject_sim_event to prevent cross-org interference.
 */
async function verifySimOwnership(userId: number, simulationId: string): Promise<boolean> {
  try {
    // Get all orgs this user belongs to
    const memberships = await db
      .select({ orgId: schema.orgMembers.orgId })
      .from(schema.orgMembers)
      .where(eq(schema.orgMembers.userId, userId));

    if (memberships.length === 0) return false;

    const orgIds = memberships.map((m) => m.orgId);

    // Check the simulation belongs to one of those orgs
    const [sim] = await db
      .select({ id: schema.simulations.id })
      .from(schema.simulations)
      .where(
        and(
          eq(schema.simulations.uuid, simulationId),
          // FIX-13: inArray() is the safe Drizzle helper — raw sql`IN (${orgIds.join(",")})` 
          // is string interpolation inside SQL and bypasses the ORM's parameterisation.
          inArray(schema.simulations.orgId, orgIds),
        ),
      )
      .limit(1);

    return !!sim;
  } catch {
    return false; // Fail closed on DB error
  }
}

/**
 * [SECURITY PATCH — Phase 6 pentest finding] Verifies the user is actually a
 * member of the org they're trying to subscribe to. subscribe_org previously
 * trusted msg.orgId with zero validation, same class of gap as
 * subscribe_delegation and subscribe_simulation above.
 */
async function verifyOrgMembership(userId: number, orgId: string): Promise<boolean> {
  try {
    const [membership] = await db
      .select({ orgId: schema.orgMembers.orgId })
      .from(schema.orgMembers)
      .where(and(
        eq(schema.orgMembers.userId, userId),
        eq(schema.orgMembers.orgId, Number(orgId)),
      ))
      .limit(1);
    return !!membership;
  } catch {
    return false; // Fail closed on DB error
  }
}

/**
 * [SECURITY PATCH — Phase 6 pentest finding] Verifies a bot belongs to an org
 * the user is a member of — mirrors verifySimOwnership exactly, swapping the
 * target table. subscribe_bot previously trusted msg.botId with zero
 * validation, same class of gap as the other subscribe_* handlers above.
 */
async function verifyBotOwnership(userId: number, botUuid: string): Promise<boolean> {
  try {
    const memberships = await db
      .select({ orgId: schema.orgMembers.orgId })
      .from(schema.orgMembers)
      .where(eq(schema.orgMembers.userId, userId));

    if (memberships.length === 0) return false;

    const orgIds = memberships.map((m) => m.orgId);

    const [bot] = await db
      .select({ id: schema.bots.id })
      .from(schema.bots)
      .where(
        and(
          eq(schema.bots.uuid, botUuid),
          inArray(schema.bots.orgId, orgIds),
        ),
      )
      .limit(1);

    return !!bot;
  } catch {
    return false; // Fail closed on DB error
  }
}

export function getGatewayStats() {
  return {
    totalClients: clients.size,
    authenticatedClients: [...clients.values()].filter((c) => c.authenticated).length,
    uniqueUsers: userConnections.size,
  };
}
