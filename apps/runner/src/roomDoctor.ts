/**
 * Room doctor — why a bot isn't getting into its Highrise room, decided from
 * Highrise's own words, so the owner is only asked for what only they can do.
 * OWNERSHIP: apps/runner
 *
 * Highrise doesn't refuse a bad token at the connection: it accepts the
 * WebSocket and sends an Error first, e.g. {"_type":"Error","message":"API
 * token not found"} (checked against the real API), which the SDK prints as
 * `ERROR: Error(message='API token not found', ...)` before it stops. That
 * message says which it is: the token, the room, the bot's access to the
 * room — or something passing (busy, rate limits) that waiting fixes.
 *
 * When the bot's own run doesn't settle it, KojyAI asks Highrise itself, from
 * its own server, with the bot's token and room ID (what the bot does when it
 * starts — nothing more; the connection is closed on the first answer):
 *  - Highrise lets it in: the token and room are fine, so the problem is
 *    where or how the bot runs (its code, its bot host) — KojyAI fixes that;
 *  - Highrise answers with an Error: that's its verdict on this token and
 *    room — only the owner can change those;
 *  - no answer: Highrise or the network is away — waiting fixes it.
 */

import WebSocket from "ws";

export const HIGHRISE_BOT_API = process.env.HR_BOTAPI_URL ?? "wss://highrise.game/web/botapi";
/** Sent as the SDK sends it, so Highrise treats KojyAI's question like the bot's own connection. */
const USER_AGENT = "highrise-python-bot-sdk/25.1.0";
const ASK_TIMEOUT_MS = 15_000;

export type RefusalKind =
  /** The token isn't one Highrise knows (wrong, revoked, or the bot was deleted). */
  | "token"
  /** The token or the room ID (Highrise doesn't say which). */
  | "credentials"
  /** The room ID isn't a room Highrise knows. */
  | "room"
  /** The bot isn't allowed in that room (not added, removed, banned). */
  | "access"
  /** The same bot is connected somewhere else. */
  | "duplicate"
  /** Busy, rate limits, maintenance: passing. */
  | "busy"
  | "unknown";

/** Highrise's message out of an SDK line like `ERROR: Error(message='API token not found', do_not_reconnect=False, rid=None)`. */
export function highriseMessage(line: string | null | undefined): string {
  const text = (line ?? "").trim();
  const m = /message=(['"])((?:\\.|(?!\1).)*)\1/.exec(text);
  const said = m?.[2] !== undefined ? m[2].replace(/\\(['"\\])/g, "$1") : text.replace(/^ERROR:\s*/, "").replace(/ closing connection with ID: .*$/, "");
  return said.trim().slice(0, 300);
}

/** What Highrise's message is about. */
export function refusalKind(message: string): RefusalKind {
  const m = message.toLowerCase();
  // Refused before Highrise said anything (a firewall or proxy in front of it can do that): not its verdict on the token.
  if (/\bhttp \d{3}\b/.test(m)) return /\bhttp (429|5\d\d)\b/.test(m) ? "busy" : "unknown";
  if (/rate.?limit|too many|try again|busy|unavailable|maintenance|overload|timed? ?out|internal|server error|temporar/.test(m)) return "busy";
  if (/already (connected|in)|another (session|connection|instance)|duplicate|logged in elsewhere|connected elsewhere/.test(m)) return "duplicate";
  const bad = /not found|invalid|unknown|expired|revoked|missing|incorrect|wrong|bad|denied|unauthori[sz]ed|does ?n.?t exist|no such/;
  const aboutToken = /\b(api[ _-]?)?(token|key)\b/.test(m);
  const aboutRoom = /\broom\b/.test(m);
  if (aboutToken && aboutRoom && bad.test(m)) return "credentials";
  if (aboutToken && bad.test(m)) return "token";
  if (/\bban(ned)?\b|not (allowed|permitted|invited|added|authori[sz]ed)|no (access|permission)|permission|forbidden|kicked|removed from/.test(m)) return "access";
  if (aboutRoom && (bad.test(m) || /closed|deleted/.test(m))) return "room";
  if (/unauthori[sz]ed|authenticat/.test(m)) return "token";
  return "unknown";
}

/** A refusal only the owner can sort out (their token, their room, the bot's access to it). */
export const ownersRefusal = (kind: RefusalKind) => kind === "token" || kind === "credentials" || kind === "room" || kind === "access";

/** What the owner has to do about a refusal, in plain words (with Highrise's own). */
export function refusalAdvice(kind: RefusalKind, said: string): string {
  const quote = said ? ` (Highrise said: “${said}”)` : "";
  switch (kind) {
    case "token": return `Highrise doesn't accept the bot's token${quote}. Copy the bot's token again from create.highrise.game into HIGHRISE_BOT_TOKEN in its Secrets — KojyAI starts it by itself once it's saved.`;
    case "room": return `Highrise doesn't know the room in HIGHRISE_ROOM_ID${quote}. Put the right room ID in its Secrets — KojyAI starts it by itself once it's saved.`;
    case "access": return `Highrise won't let the bot into that room${quote}. Add the bot to the room again in Highrise (and check it isn't banned there) — KojyAI keeps trying and gets it in as soon as it's allowed.`;
    case "duplicate": return `Highrise says this bot is already connected somewhere else${quote}. Stop the other copy (the same token can only be used once) — KojyAI keeps trying meanwhile.`;
    default: return `Highrise refuses the bot's token for this room${quote}. Check HIGHRISE_BOT_TOKEN and HIGHRISE_ROOM_ID in its Secrets — KojyAI starts it by itself once they're saved.`;
  }
}

export type HighriseAnswer =
  | { kind: "ok"; roomName: string | null; userId: string | null }
  | { kind: "refused"; message: string; refusal: RefusalKind }
  | { kind: "unreachable"; why: string };

export interface AskOptions {
  url?: string;
  timeoutMs?: number;
  /** For tests: a stand-in for the ws WebSocket class. */
  WebSocketImpl?: typeof WebSocket;
}

/**
 * Connects to Highrise with the bot's token and room ID, as the bot does, and
 * returns its first answer. Never throws.
 */
export function askHighrise(roomId: string, token: string, opts: AskOptions = {}): Promise<HighriseAnswer> {
  const Impl = opts.WebSocketImpl ?? WebSocket;
  const timeoutMs = opts.timeoutMs ?? ASK_TIMEOUT_MS;
  return new Promise((resolve) => {
    let done = false;
    let ws: WebSocket | null = null;
    const finish = (answer: HighriseAnswer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* already closed */ }
      setTimeout(() => { try { ws?.terminate(); } catch { /* gone */ } }, 2_000).unref();
      resolve(answer);
    };
    const timer = setTimeout(() => finish({ kind: "unreachable", why: `Highrise didn't answer within ${Math.round(timeoutMs / 1000)}s` }), timeoutMs);
    timer.unref();
    try {
      ws = new Impl(opts.url ?? HIGHRISE_BOT_API, { headers: { "room-id": roomId, "api-token": token, "user-agent": USER_AGENT }, handshakeTimeout: timeoutMs });
    } catch (err) {
      finish({ kind: "unreachable", why: (err as Error).message.slice(0, 200) });
      return;
    }
    ws.on("unexpected-response", (_req, res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      // Busy or a firewall in front of Highrise: not the token's fault.
      if (status === 429 || status >= 500 || res.headers["cf-mitigated"]) finish({ kind: "unreachable", why: `Highrise answered HTTP ${status}` });
      else finish({ kind: "refused", message: `HTTP ${status}`, refusal: status === 401 ? "token" : "unknown" });
    });
    ws.on("message", (data) => {
      let msg: Record<string, unknown> = {};
      try { msg = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data).toString("utf8")) as Record<string, unknown>; } catch { /* not JSON */ }
      if (msg._type === "SessionMetadata") {
        const info = (msg.room_info ?? {}) as Record<string, unknown>;
        finish({ kind: "ok", roomName: typeof info.room_name === "string" ? info.room_name.slice(0, 120) : null, userId: typeof msg.user_id === "string" ? msg.user_id : null });
      } else if (msg._type === "Error") {
        const said = (typeof msg.message === "string" ? msg.message : "").slice(0, 300);
        const refusal = refusalKind(said);
        finish(refusal === "busy" ? { kind: "unreachable", why: `Highrise said: ${said}` } : { kind: "refused", message: said, refusal });
      } else {
        finish({ kind: "unreachable", why: "Highrise answered something KojyAI doesn't recognise" });
      }
    });
    ws.on("close", (code) => finish({ kind: "unreachable", why: `Highrise closed the connection (${code})` }));
    ws.on("error", (err) => finish({ kind: "unreachable", why: err.message.slice(0, 200) }));
  });
}
