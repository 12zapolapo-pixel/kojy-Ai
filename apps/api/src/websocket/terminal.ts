/**
 * Shell gateway — /ws/terminal, the browser's end of a bot's shell.
 * OWNERSHIP: apps/api/src/websocket
 *
 * The browser connects and sends, within 5 s:
 *   {"type":"auth","token":"<session token>","projectId":"<uuid>","cols":80,"rows":24}
 * then
 *   {"type":"in","d":"ls\r"}            keystrokes (UTF-8 text)
 *   {"type":"resize","cols":120,"rows":30}
 * and receives the runner's messages as they are (see TermOut in
 * @kojyai/shared/projects): {"t":"o","d":"<base64>"} output, {"t":"ready"},
 * {"t":"exit","code":0}, {"t":"err","m":"…"}.
 *
 * SECURITY:
 * - Same origin check and token auth as /ws (no cookies — V-10).
 * - The caller must be able to edit AND start bots (a shell can do both),
 *   in the org that owns the project. Re-checked every 5 minutes.
 * - The shell itself runs on the runner as the project's sandbox user
 *   (apps/runner/src/terminal.ts); the runner refuses without a sandbox.
 * - Every message to the runner is signed (signBotControlMessage).
 * - Opening one is rate-limited and written to the audit log.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import { randomUUID } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { hasPermission } from "@kojyai/shared/permissions";
import { signBotControlMessage } from "@kojyai/shared/crypto";
import { TERM_IN_PREFIX, TERM_OUT_PREFIX, TERM_PING_MS, type TermInAction } from "@kojyai/shared/projects";
import { checkRateLimit, RATE_LIMITS } from "@kojyai/security";
import { db, schema } from "../db/client.js";
import { getRedis, getRedisPublisher, listenChannel } from "../utils/redis.js";
import { resolveOrgId } from "../utils/resolveOrgId.js";
import { emitAuditLog } from "../events/audit.js";
import { createLogger } from "../utils/logger.js";
import { isAllowedOrigin, sessionIdFromToken } from "./gateway.js";

const log = createLogger("ws-terminal");

const AUTH_TIMEOUT_MS = 5_000;
const REAUTH_MS = 5 * 60_000;
const MAX_PER_USER = 4;
const MAX_INPUT_CHARS = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const perUser = new Map<number, number>();

interface Access { userId: number; sessionId: string; project: { id: number; uuid: string; orgId: number; name: string } }

/** Who the token belongs to, and whether they may open a shell for `projectUuid`. */
async function authorize(token: string, projectUuid: string): Promise<Access> {
  const sessionId = await sessionIdFromToken(token);
  const [session] = await db.select().from(schema.sessions)
    .where(and(eq(schema.sessions.id, sessionId), gt(schema.sessions.expiresAt, new Date()))).limit(1);
  if (!session) throw new Error("Your session has expired. Sign in again.");
  const [user] = await db.select({ id: schema.users.id, role: schema.users.role, tier: schema.users.tier }).from(schema.users)
    .where(and(eq(schema.users.id, session.userId), eq(schema.users.status, "active"))).limit(1);
  if (!user) throw new Error("Your account isn't active.");
  if (!hasPermission(user.role, user.tier, "bots:update") || !hasPermission(user.role, user.tier, "bots:start")) {
    throw new Error("You don't have permission to use the shell.");
  }
  const orgId = await resolveOrgId({ db, user: { id: user.id }, session: { activeOrgId: session.activeOrgId ?? null } });
  const [project] = await db.select({ id: schema.botProjects.id, uuid: schema.botProjects.uuid, orgId: schema.botProjects.orgId, name: schema.botProjects.name })
    .from(schema.botProjects).where(and(eq(schema.botProjects.uuid, projectUuid), eq(schema.botProjects.orgId, orgId))).limit(1);
  if (!project) throw new Error("Bot not found.");
  return { userId: user.id, sessionId, project };
}

function send(ws: WebSocket, msg: object | string): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
}

export function initTerminalGateway(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, path: "/ws/terminal", maxPayload: 64 * 1024 });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    if (!isAllowedOrigin(req.headers.origin)) { ws.close(4003, "Origin not allowed"); return; }

    let access: Access | null = null;
    let sid: string | null = null;
    let stopListening: (() => void) | null = null;
    let pinger: NodeJS.Timeout | null = null;
    let reauth: NodeJS.Timeout | null = null;
    let counted = false;
    let opening = false;
    let ended = false;
    const authTimer = setTimeout(() => { if (!access) ws.close(4001, "Auth timeout"); }, AUTH_TIMEOUT_MS);

    const toRunner = (action: TermInAction, payload?: Record<string, unknown>) => {
      const pub = getRedisPublisher();
      if (!pub || !sid) return;
      pub.publish(`${TERM_IN_PREFIX}${sid}`, signBotControlMessage(sid, action, payload))
        .catch((err: unknown) => log.warn({ err }, "Could not reach the runner"));
    };

    const end = (code = 1000, reason = "") => {
      if (ended) return;
      ended = true;
      clearTimeout(authTimer);
      if (pinger) clearInterval(pinger);
      if (reauth) clearInterval(reauth);
      if (sid) toRunner("close");
      stopListening?.();
      if (counted && access) {
        const n = (perUser.get(access.userId) ?? 1) - 1;
        if (n <= 0) perUser.delete(access.userId); else perUser.set(access.userId, n);
      }
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code, reason);
    };

    const open = async (msg: Record<string, unknown>) => {
      const token = typeof msg["token"] === "string" ? msg["token"] : "";
      const projectId = typeof msg["projectId"] === "string" ? msg["projectId"] : "";
      if (!token || !UUID.test(projectId)) throw new Error("Bad request.");
      const a = await authorize(token, projectId);
      if ((perUser.get(a.userId) ?? 0) >= MAX_PER_USER) throw new Error(`You can have up to ${MAX_PER_USER} shells open. Close one first.`);
      const limit = await checkRateLimit(getRedis(), String(a.userId), RATE_LIMITS.TERMINAL_OPEN);
      if (!limit.allowed) throw new Error(`Too many shells opened — try again in ${limit.retryAfter ?? 60}s.`);
      if (ended) return;
      access = a;
      clearTimeout(authTimer);
      perUser.set(a.userId, (perUser.get(a.userId) ?? 0) + 1);
      counted = true;

      sid = randomUUID();
      const out = await listenChannel(`${TERM_OUT_PREFIX}${sid}`, (raw) => {
        send(ws, raw);
        try { if ((JSON.parse(raw) as { t?: string }).t === "exit") setTimeout(() => end(1000, "Shell closed"), 50); } catch { /* output */ }
      });
      stopListening = out;
      if (ended) { out(); return; }

      const pub = getRedisPublisher();
      if (!pub) throw new Error("The bot runner can't be reached right now (Redis is down).");
      const cols = Number(msg["cols"]) || 80;
      const rows = Number(msg["rows"]) || 24;
      await pub.publish(`project_control:${a.project.uuid}`, signBotControlMessage(a.project.uuid, "terminal_open", { sid, cols, rows }));
      pinger = setInterval(() => toRunner("ping"), TERM_PING_MS);
      reauth = setInterval(() => {
        authorize(token, projectId).catch(() => {
          send(ws, { t: "err", m: "Your session ended." });
          end(4003, "Session expired");
        });
      }, REAUTH_MS);
      await emitAuditLog(db, {
        orgId: a.project.orgId, actorId: a.userId, actorType: "user", action: "project.shell_open",
        resourceType: "project", resourceId: a.project.uuid,
      });
      log.info({ userId: a.userId, project: a.project.uuid }, "Shell opened");
    };

    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw.toString()) as Record<string, unknown>; } catch { return; }
      if (!msg || typeof msg !== "object") return;
      if (!access) {
        if (msg["type"] !== "auth" || opening) return;
        opening = true;
        open(msg).catch((err: Error) => {
          send(ws, { t: "err", m: err.message || "Couldn't open the shell." });
          end(4001, "Not allowed");
        });
        return;
      }
      if (!sid) return;
      if (msg["type"] === "in" && typeof msg["d"] === "string" && msg["d"].length <= MAX_INPUT_CHARS) toRunner("in", { d: msg["d"] });
      else if (msg["type"] === "resize") toRunner("resize", { cols: Number(msg["cols"]) || 80, rows: Number(msg["rows"]) || 24 });
    });
    ws.on("close", () => end());
    ws.on("error", (err) => log.warn({ err }, "Shell socket error"));
  });

  log.info("Shell gateway ready on /ws/terminal");
  return wss;
}
