/**
 * Highrise Bot WebSocket Client
 * OWNERSHIP: packages/engine/src/runtime
 *
 * A faithful TypeScript port of the connection protocol used by the official
 * Highrise Python Bot SDK (pocketzworld/python-bot-sdk, src/highrise/__main__.py):
 *
 *   - Connect to wss://highrise.game/web/botapi[?events=...] with
 *     `room-id` / `api-token` / `user-agent` headers.
 *   - First message is `SessionMetadata` (success) or `Error` (failure).
 *   - Send `{_type:"KeepaliveRequest"}` every 15s or the server disconnects.
 *   - All other messages are `_type`-discriminated JSON.
 *   - Outgoing "Request" messages may carry a client-chosen `rid`; the
 *     matching response echoes it back.
 *
 * This client owns reconnection (with capped exponential backoff) so callers
 * (the bot runtime manager) just need to handle `session`, `event`, `error`,
 * and `status` — the same way a Highrise SDK consumer would.
 */

import { EventEmitter } from "node:events";
import WebSocket from "ws";
import {
  HIGHRISE_BOT_API_URL,
  HIGHRISE_KEEPALIVE_INTERVAL_MS,
  HIGHRISE_READ_TIMEOUT_MS,
  type ChatRequest,
  type EmoteRequest,
  type GetRoomUsersResponse,
  type GetWalletResponse,
  type HighriseError,
  type HighriseEvent,
  type HighriseIncoming,
  type ModerateRoomRequest,
  type ReactionRequest,
  type SessionMetadata,
  type SetOutfitRequest,
  type TeleportRequest,
} from "./highrise-protocol.js";

const SDK_NAME = "kojyai-highrise-client";
const SDK_VERSION = "1.0.0";

export type HighriseConnectionStatus =
  | "connecting"
  | "online"
  | "reconnecting"
  | "error"
  | "stopped";

export interface HighriseClientOptions {
  apiKey: string;
  roomId: string;
  /** Subscribe to a subset of event types (default: all). */
  events?: string[];
  /** Override the bot API base URL — primarily for tests. */
  baseUrl?: string;
  /** Max reconnect backoff, ms. Default 30s. */
  maxBackoffMs?: number;
  /**
   * L-35: give up after this many CONSECUTIVE failed reconnect attempts (the counter
   * resets whenever a session is established). Default 20 (~9 minutes at the 30s
   * backoff cap). 0 = retry forever (the old behaviour). On giving up the client
   * reports status "error", emits "error", then stop()s so the owner of the client
   * (runtime-manager's bounded crash handling) decides what happens next instead of
   * this loop silently hammering Highrise indefinitely.
   */
  maxReconnectAttempts?: number;
}

interface PendingRequest {
  resolve: (value: HighriseIncoming) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Events emitted:
 *  - "status"  (status: HighriseConnectionStatus, detail?: string)
 *  - "session" (meta: SessionMetadata)        — fired on (re)connect success
 *  - "event"   (event: HighriseEvent)         — every room event
 *  - "error"   (err: HighriseError | Error)
 *  - "close"   ()                              — fully stopped (stop() called)
 */
export class HighriseClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private readTimeoutTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private stopped = false;
  private reconnectAttempts = 0;
  private ridCounter = 0;

  public sessionMetadata: SessionMetadata | null = null;

  constructor(private readonly opts: HighriseClientOptions) {
    super();
  }

  /** Opens the connection. Resolves once SessionMetadata is received. */
  async connect(): Promise<SessionMetadata> {
    this.stopped = false;
    return this.attemptConnect();
  }

  /** Closes the connection and disables reconnection. */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Connection stopped"));
    }
    this.pending.clear();
    this.ws?.close(1000, "stopped");
    this.ws = null;
    this.setStatus("stopped");
    this.emit("close");
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.sessionMetadata !== null;
  }

  // ─── Outgoing Requests ────────────────────────────────────────────────────

  sendChat(message: string, whisperTargetId?: string | null): void {
    this.send({ _type: "ChatRequest", message, whisper_target_id: whisperTargetId ?? null } satisfies ChatRequest);
  }

  sendEmote(emoteId: string, targetUserId?: string | null): void {
    this.send({ _type: "EmoteRequest", emote_id: emoteId, target_user_id: targetUserId ?? null } satisfies EmoteRequest);
  }

  sendReaction(reaction: ReactionRequest["reaction"], targetUserId: string): void {
    this.send({ _type: "ReactionRequest", reaction, target_user_id: targetUserId } satisfies ReactionRequest);
  }

  async moderateRoom(
    userId: string,
    action: ModerateRoomRequest["moderation_action"],
    actionLengthSeconds?: number,
  ): Promise<HighriseIncoming> {
    return this.sendAndWait({
      _type: "ModerateRoomRequest",
      user_id: userId,
      moderation_action: action,
      action_length: actionLengthSeconds ?? null,
    } satisfies ModerateRoomRequest);
  }

  async teleport(userId: string, destination: TeleportRequest["destination"]): Promise<HighriseIncoming> {
    return this.sendAndWait({ _type: "TeleportRequest", user_id: userId, destination } satisfies TeleportRequest);
  }

  async getRoomUsers(): Promise<GetRoomUsersResponse> {
    return this.sendAndWait({ _type: "GetRoomUsersRequest", rid: this.nextRid() }) as unknown as Promise<GetRoomUsersResponse>;
  }

  async getWallet(): Promise<GetWalletResponse> {
    return this.sendAndWait({ _type: "GetWalletRequest" }) as unknown as Promise<GetWalletResponse>;
  }

  async setOutfit(outfit: SetOutfitRequest["outfit"]): Promise<HighriseIncoming> {
    return this.sendAndWait({ _type: "SetOutfitRequest", outfit } satisfies SetOutfitRequest);
  }

  // ─── Connection Internals ─────────────────────────────────────────────────

  private nextRid(): string {
    this.ridCounter += 1;
    return `r${Date.now()}-${this.ridCounter}`;
  }

  private send(req: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new Error("Highrise connection is not open");
    }
    this.ws.send(JSON.stringify(req));
  }

  private sendAndWait(req: Record<string, unknown>, timeoutMs = 10_000): Promise<HighriseIncoming> {
    const rid = (req.rid as string | undefined) ?? this.nextRid();
    req.rid = rid;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error(`Timed out waiting for response to ${req._type} (rid=${rid})`));
      }, timeoutMs);

      this.pending.set(rid, { resolve, reject, timer });

      try {
        this.send(req);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(rid);
        reject(err as Error);
      }
    });
  }

  private attemptConnect(): Promise<SessionMetadata> {
    return new Promise((resolve, reject) => {
      // HR_BOTAPI_URL: same override the Python SDK honours (tests, local mocks).
      const baseUrl = this.opts.baseUrl ?? process.env.HR_BOTAPI_URL ?? HIGHRISE_BOT_API_URL;
      const query = this.opts.events?.length ? `?events=${this.opts.events.join(",")}` : "";
      const url = `${baseUrl}${query}`;

      this.setStatus(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");

      let ws: WebSocket;
      try {
        ws = new WebSocket(url, {
          headers: {
            "room-id":    this.opts.roomId,
            "api-token":  this.opts.apiKey,
            "user-agent": `${SDK_NAME}/${SDK_VERSION}`,
          },
        });
      } catch (err) {
        this.setStatus("error", (err as Error).message);
        reject(err as Error);
        return;
      }

      this.ws = ws;
      let settled = false;

      ws.on("open", () => {
        this.armReadTimeout();
      });

      ws.on("message", (raw: WebSocket.RawData) => {
        this.armReadTimeout();

        let msg: HighriseIncoming;
        try {
          msg = JSON.parse(raw.toString()) as HighriseIncoming;
        } catch {
          return; // ignore malformed frames
        }

        // First message: SessionMetadata or Error
        if (!settled) {
          settled = true;

          if (msg._type === "Error") {
            const err = msg as HighriseError;
            this.setStatus("error", err.message);
            this.emit("error", err);
            // Highrise said don't retry (bad token, banned bot…): stop for
            // good, or the close handler below would reconnect anyway.
            if (err.do_not_reconnect) this.stopped = true;
            ws.close();
            reject(new Error(err.message));
            if (!err.do_not_reconnect) this.scheduleReconnect();
            return;
          }

          if (msg._type === "SessionMetadata") {
            const meta = msg as unknown as SessionMetadata;
            this.sessionMetadata = meta;
            this.reconnectAttempts = 0;
            this.startKeepalive();
            this.setStatus("online");
            this.emit("session", meta);
            resolve(meta);
            return;
          }

          // Unexpected first message — still surface it, but don't hang.
          this.setStatus("error", `Unexpected first message: ${msg._type}`);
          reject(new Error(`Unexpected first message: ${msg._type}`));
          ws.close();
          return;
        }

        this.handleMessage(msg);
      });

      ws.on("error", (err: Error) => {
        if (!settled) {
          settled = true;
          this.setStatus("error", err.message);
          reject(err);
        }
        this.emit("error", err);
      });

      ws.on("close", (code: number, reason: Buffer) => {
        this.clearTimers();
        this.sessionMetadata = null;

        if (!settled) {
          settled = true;
          const err = new Error(`Connection closed before session established (code ${code})`);
          this.setStatus("error", err.message);
          reject(err);
        }

        if (!this.stopped) {
          this.setStatus("reconnecting", `closed (code ${code}): ${reason.toString()}`);
          this.scheduleReconnect();
        }
      });
    });
  }

  /** Re-attempts connection after a backoff, surfacing results via `session`/`error`/`status` events rather than the original connect() promise. */
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;

    const maxAttempts = this.opts.maxReconnectAttempts ?? 20;
    if (maxAttempts > 0 && this.reconnectAttempts >= maxAttempts) {
      const message = `Gave up reconnecting to Highrise after ${this.reconnectAttempts} consecutive failed attempts`;
      this.setStatus("error", message);
      // EventEmitter throws on an unhandled "error" event — only emit if someone listens.
      if (this.listenerCount("error") > 0) {
        this.emit("error", { _type: "Error", message, do_not_reconnect: true } as unknown as HighriseError);
      }
      this.stop();
      return;
    }

    const max = this.opts.maxBackoffMs ?? 30_000;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, max);
    this.reconnectAttempts += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this.attemptConnect().catch(() => {
        // attemptConnect's own close/error handlers already scheduled the next retry.
      });
    }, delay);
  }

  /** Dispatches a non-session message: either a tagged room event, or a response to a pending request (matched by `rid`). */
  private handleMessage(msg: HighriseIncoming): void {
    if (msg._type === "Error") {
      const err = msg as HighriseError;
      if (err.rid && this.pending.has(err.rid)) {
        const p = this.pending.get(err.rid)!;
        clearTimeout(p.timer);
        this.pending.delete(err.rid);
        p.reject(new Error(err.message));
        return;
      }
      this.emit("error", err);
      if (err.do_not_reconnect) this.stop();
      return;
    }

    // Response to a pending request?
    const rid = (msg as { rid?: string | null }).rid;
    if (rid && this.pending.has(rid)) {
      const p = this.pending.get(rid)!;
      clearTimeout(p.timer);
      this.pending.delete(rid);
      p.resolve(msg);
      return;
    }

    // Otherwise it's a room event.
    this.emit("event", msg as HighriseEvent);
  }

  private startKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = setInterval(() => {
      try {
        this.send({ _type: "KeepaliveRequest" });
      } catch {
        // Connection is down — the close handler will trigger reconnect.
      }
    }, HIGHRISE_KEEPALIVE_INTERVAL_MS);
  }

  /** If no frame arrives within HIGHRISE_READ_TIMEOUT_MS, treat the connection as dead and reconnect. */
  private armReadTimeout(): void {
    if (this.readTimeoutTimer) clearTimeout(this.readTimeoutTimer);
    this.readTimeoutTimer = setTimeout(() => {
      this.ws?.terminate();
    }, HIGHRISE_READ_TIMEOUT_MS);
  }

  private clearTimers(): void {
    if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
    if (this.readTimeoutTimer) { clearTimeout(this.readTimeoutTimer); this.readTimeoutTimer = null; }
  }

  private setStatus(status: HighriseConnectionStatus, detail?: string): void {
    this.emit("status", status, detail);
  }
}
