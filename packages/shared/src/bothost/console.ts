/**
 * A bot host's live console: the node's websocket, which streams every line
 * the bot prints, its power state and its resource use as they happen.
 * OWNERSHIP: packages/shared/src/bothost
 *
 * Protocol (Pterodactyl's, as documented at sillydev.co.uk/docs/panel): get a
 * token from the panel, open the socket with the panel's Origin, send `auth`,
 * then read `console output`, `status` and `stats`. A token lasts 10 minutes;
 * on `token expiring` a fresh one goes over the same socket. A dropped socket
 * is reopened with backoff (never for a suspended server, close code 4409).
 * The panel allows 5 token requests a minute per server, so they are spaced
 * at least 13 seconds apart.
 */

import WebSocket from "ws";
import { HostApiError, POWER_STATES, type PowerState } from "./client.js";

export interface HostStats { memoryBytes: number; memoryLimitBytes: number; cpu: number; diskBytes: number; uptimeMs: number; state: string }

export interface ConsoleEvents {
  /** One line of the bot's output (colour codes removed). */
  line(text: string): void;
  status(state: PowerState): void;
  stats?(stats: HostStats): void;
  /** A note from the node itself, e.g. about installing. */
  daemon?(text: string): void;
  /** Authenticated; `again` is true after a reconnect. */
  ready?(again: boolean): void;
  /** Something went wrong with the connection (it is retried). */
  problem?(text: string): void;
  /** The connection won't be retried (suspended server, or the key no longer works). */
  ended?(why: string): void;
}

export interface ConsoleOptions {
  credentials: () => Promise<{ token: string; socket: string }>;
  origin: string;
  events: ConsoleEvents;
  /** Waits before reconnecting, in order (the last repeats). */
  delaysMs?: number[];
  minCredentialGapMs?: number;
  pingEveryMs?: number;
  createSocket?: (url: string, origin: string) => WebSocket;
}

// eslint-disable-next-line no-control-regex -- terminal colour codes are control characters; removing them is the point
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "").replace(/\r/g, "");
}

export class HostConsole {
  private ws: WebSocket | null = null;
  private closed = true;
  private attempts = 0;
  private everReady = false;
  private jwtErrors = 0;
  private lastCredentialsAt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private alive = true;
  private readonly delays: number[];
  private readonly minGap: number;

  constructor(private readonly opts: ConsoleOptions) {
    this.delays = opts.delaysMs ?? [1_000, 5_000, 15_000, 30_000, 60_000];
    this.minGap = opts.minCredentialGapMs ?? 13_000;
  }

  start(): void {
    if (!this.closed) return;
    this.closed = false;
    void this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.retryTimer = this.pingTimer = null;
    const ws = this.ws;
    this.ws = null;
    try { ws?.terminate(); } catch { /* already gone */ }
  }

  get isReady(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.everReady;
  }

  /** Ask for recent output (only answered while the server runs); it arrives as ordinary lines. */
  requestLogs(): void { this.send("send logs"); }

  private send(event: string, args?: string[]): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(args ? { event, args } : { event }));
  }

  private async credentials(): Promise<{ token: string; socket: string }> {
    const wait = this.minGap - (Date.now() - this.lastCredentialsAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCredentialsAt = Date.now();
    return this.opts.credentials();
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    let creds: { token: string; socket: string };
    try {
      creds = await this.credentials();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A key that no longer works won't start working by retrying every minute.
      if (err instanceof HostApiError && (err.status === 401 || err.status === 403 || err.status === 404)) {
        this.closed = true;
        this.opts.events.ended?.(message);
        return;
      }
      this.opts.events.problem?.(`Couldn't open the live console: ${message}`);
      return this.retry();
    }
    if (this.closed) return;
    const ws = this.opts.createSocket?.(creds.socket, this.opts.origin)
      ?? new WebSocket(creds.socket, { origin: this.opts.origin, handshakeTimeout: 15_000, maxPayload: 4 * 1024 * 1024 });
    this.ws = ws;
    ws.on("open", () => this.send("auth", [creds.token]));
    ws.on("message", (raw) => this.onMessage(ws, String(raw)));
    ws.on("pong", () => { this.alive = true; });
    ws.on("error", (err) => this.opts.events.problem?.(`Live console: ${err.message}`));
    ws.on("close", (code) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (code === 4409) {
        this.closed = true;
        this.opts.events.ended?.("The host suspended this server.");
        return;
      }
      this.retry(code === 4410 ? 5_000 : undefined);
    });
  }

  private onMessage(ws: WebSocket, raw: string): void {
    if (ws !== this.ws) return;
    let msg: { event?: unknown; args?: unknown };
    try { msg = JSON.parse(raw) as typeof msg; } catch { return; }
    const args = Array.isArray(msg.args) ? msg.args.map((a) => String(a)) : [];
    switch (msg.event) {
      case "auth success": {
        const again = this.everReady;
        this.everReady = true;
        this.attempts = 0;
        this.jwtErrors = 0;
        this.keepAlive(ws);
        this.opts.events.ready?.(again);
        break;
      }
      case "console output":
        for (const line of stripAnsi(args[0] ?? "").split("\n")) this.opts.events.line(line);
        break;
      case "status":
        if (POWER_STATES.includes(args[0] as PowerState)) this.opts.events.status(args[0] as PowerState);
        break;
      case "stats":
        try {
          const s = JSON.parse(args[0] ?? "{}") as Record<string, unknown>;
          const n = (v: unknown) => Number(v) || 0;
          this.opts.events.stats?.({
            memoryBytes: n(s.memory_bytes), memoryLimitBytes: n(s.memory_limit_bytes), cpu: n(s.cpu_absolute),
            diskBytes: n(s.disk_bytes), uptimeMs: n(s.uptime), state: String(s.state ?? ""),
          });
        } catch { /* malformed stats: skip */ }
        break;
      case "daemon message":
        this.opts.events.daemon?.(stripAnsi(args[0] ?? ""));
        break;
      case "token expiring":
      case "token expired":
        void this.reauth();
        break;
      case "jwt error":
        // A fresh token usually fixes it; if not, start over with backoff.
        if (++this.jwtErrors > 2) ws.close();
        else void this.reauth();
        break;
      case "daemon error":
        this.opts.events.problem?.(`The host's node: ${args[0] ?? "error"}`);
        break;
      default:
        break;
    }
  }

  private async reauth(): Promise<void> {
    try {
      const creds = await this.credentials();
      this.send("auth", [creds.token]);
    } catch (err) {
      this.opts.events.problem?.(`Couldn't renew the live console's token: ${err instanceof Error ? err.message : String(err)}`);
      this.ws?.close();
    }
  }

  /** A socket that stops answering pings (a silent network drop) is closed, and so reopened. */
  private keepAlive(ws: WebSocket): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.alive = true;
    this.pingTimer = setInterval(() => {
      if (ws !== this.ws) return;
      if (!this.alive) { ws.terminate(); return; }
      this.alive = false;
      try { ws.ping(); } catch { /* closing */ }
    }, this.opts.pingEveryMs ?? 30_000);
    this.pingTimer.unref?.();
  }

  private retry(delayMs?: number): void {
    if (this.closed) return;
    const wait = delayMs ?? this.delays[Math.min(this.attempts, this.delays.length - 1)]!;
    this.attempts++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.connect(); }, wait);
    this.retryTimer.unref?.();
  }
}

/**
 * The lines of `history` (oldest first, from `send logs`) that come after
 * what was already saved (`recent`, oldest first). The newest saved lines
 * (at least 3, or all of them when fewer) must appear in the history in a
 * row; everything after their last appearance is new. With no overlap,
 * everything is new.
 */
export function unseenLines(history: string[], recent: string[]): string[] {
  if (!recent.length || !history.length) return history;
  const longest = Math.min(recent.length, 20);
  const shortest = Math.min(recent.length, 3);
  for (let k = longest; k >= shortest; k--) {
    const tail = recent.slice(-k);
    for (let end = history.length - 1; end >= k - 1; end--) {
      let match = true;
      for (let j = 0; j < k && match; j++) match = history[end - k + 1 + j] === tail[j];
      if (match) return history.slice(end + 1);
    }
  }
  return history;
}
