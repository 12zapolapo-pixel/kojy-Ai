/**
 * Reads a bot's console log the way a person would when the owner says "it
 * disconnected": was it a KojyAI restart (every bot restarts when the
 * platform is updated), Highrise closing the connection (routine — the SDK
 * reconnects by itself), the owner or Kojy stopping it, or the bot exiting on
 * its own (a crash, maybe a bug)? get_logs puts this summary above the newest
 * console lines, so the answer doesn't depend on reading old output.
 * OWNERSHIP: apps/runner/src/agent
 */

export interface LogLine { ts: number; stream: string; line: string }

/** Written by the supervisor into each running bot's console when the runner shuts down. */
export const PLATFORM_RESTART_LINE = "■ KojyAI is restarting (platform update) — the bot starts again when it's back";
/** Printed by launcher.py each time the Highrise SDK (re)connects to the room. */
export const CONNECTED_PREFIX = "[kojy] Connected to Highrise";

export type BotEventKind = "platform_restart" | "highrise_reconnect" | "exit" | "stop";
export interface BotEvent {
  ts: number;
  kind: BotEventKind;
  detail: string;
  /** Seconds until the bot was in the room again; null if it isn't back (yet) or that can't be told. */
  backAfterS: number | null;
}

type Kind =
  | "start" | "stop" | "platform" | "exit" | "start_failed" | "installing" | "system"
  | "connected" | "launching" | "hr_closed" | "hr_reconnecting" | "hr_error" | "error_output" | "output";

const ERRORISH = /^(Traceback \(most recent call last\)|\s*File "|[\w.]*(Error|Exception|Exit)\b|ERROR\b|.*\bERROR\s)/;

function classify(l: LogLine): Kind {
  const t = l.line.trim();
  if (l.stream === "system") {
    if (t.startsWith("▶ Starting")) return "start";
    if (t.startsWith("■ Stopping")) return "stop";
    if (t.startsWith("■ KojyAI is restarting")) return "platform";
    if (t.startsWith("✖ Bot exited")) return "exit";
    if (t.startsWith("✖")) return "start_failed";
    if (/^(Creating Python environment|Installing packages)/.test(t)) return "installing";
    return "system";
  }
  if (l.stream === "stdin") return "system";
  if (t.startsWith(CONNECTED_PREFIX)) return "connected";
  if (t.startsWith("[kojy] Starting")) return "launching";
  if (/closed by server, reconnecting/.test(t)) return "hr_closed";
  if (t === "ERROR: reconnecting...") return "hr_reconnecting";
  if (t.startsWith("ERROR: ") || t === "Websocket error, exiting.") return "hr_error";
  if (!t) return "system";
  return ERRORISH.test(t) ? "error_output" : "output";
}

const pad = (n: number) => String(n).padStart(2, "0");
/** "11-03 14:46:58" in UTC. */
export function stamp(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

/**
 * The connection story told by the log: events (oldest first) and where
 * things stand at the end of it. A "▶ Starting" right after another start
 * (no stop, exit or restart note in between) means the runner went away while
 * the bot ran — a KojyAI restart from before the runner wrote that note.
 */
export function connectionEvents(lines: LogLine[]): {
  events: BotEvent[];
  state: "connected" | "connecting" | "reconnecting" | "offline" | "unknown";
  since: number | null;
} {
  const kinds = lines.map(classify);
  // Older launchers didn't print a "connected" line; there the bot's first
  // ordinary output after (re)connecting stands in for it.
  const segHasConnected: boolean[] = new Array(lines.length).fill(false);
  for (let i = 0, segStart = 0; i <= lines.length; i++) {
    if (i === lines.length || (kinds[i] === "start" && i > segStart)) {
      const has = kinds.slice(segStart, i).includes("connected");
      for (let j = segStart; j < i; j++) segHasConnected[j] = has;
      segStart = i;
    }
  }
  const isBack = (i: number) => kinds[i] === "connected" || (!segHasConnected[i] && kinds[i] === "output");

  const events: BotEvent[] = [];
  // Assigned through set() (a closure), so the type is spelled out to stop TS narrowing it.
  let state = "unknown" as "connected" | "connecting" | "reconnecting" | "offline" | "unknown";
  let since: number | null = null;
  let lastError = "";
  /** The event still waiting for the bot to be back in the room. */
  let open = null as BotEvent | null;
  const set = (s: typeof state, ts: number) => { if (state !== s) { state = s; since = ts; } };
  const push = (e: BotEvent) => { events.push(e); open = e; };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const k = kinds[i]!;
    switch (k) {
      case "start":
        // Running (or starting) and now starting again with no stop, exit or
        // restart note in between: the runner went away under the bot.
        if (state === "connected" || state === "connecting" || state === "reconnecting") {
          // When it actually went offline isn't in the log; only that it started again.
          const prev = i > 0 ? ` (its output before that ends at ${stamp(lines[i - 1]!.ts)})` : "";
          events.push({ ts: l.ts, kind: "platform_restart", detail: `KojyAI restarted while the bot was running; it started again${prev}`, backAfterS: null });
          open = null;
        }
        lastError = "";
        set("connecting", l.ts);
        break;
      case "platform":
        push({ ts: l.ts, kind: "platform_restart", detail: "KojyAI restarted (platform update)", backAfterS: null });
        set("offline", l.ts);
        break;
      case "stop":
        push({ ts: l.ts, kind: "stop", detail: "stopped or restarted from KojyAI (by the owner or Kojy)", backAfterS: null });
        set("offline", l.ts);
        break;
      case "exit": {
        const what = l.line.replace(/^✖\s*/, "").replace(/\s+—.*$/, "");
        push({ ts: l.ts, kind: "exit", detail: `${what}${lastError ? ` — last error: ${lastError.slice(0, 160)}` : ""}`, backAfterS: null });
        set("offline", l.ts);
        break;
      }
      case "installing":
        // Before a first start (a new project's log begins here). check_code
        // also installs while the bot runs, so it doesn't mean offline then.
        if (state === "unknown") set("offline", l.ts);
        break;
      case "start_failed":
        set("offline", l.ts);
        lastError = l.line.replace(/^✖\s*/, "");
        break;
      case "hr_closed":
      case "hr_reconnecting":
      case "hr_error": {
        if (k === "hr_error") lastError = l.line.trim();
        // Only a drop from the room is an event; the lines that follow while it
        // reconnects (or an error before it ever got in) belong to that event
        // or to the exit after it.
        if (state === "connected") {
          const detail = k === "hr_closed" ? "Highrise closed the connection"
            : k === "hr_error" ? `Highrise sent an error: ${l.line.trim().replace(/^ERROR:\s*/, "").slice(0, 120)}`
            : "the connection dropped (timeout or handshake error)";
          push({ ts: l.ts, kind: "highrise_reconnect", detail, backAfterS: null });
          set("reconnecting", l.ts);
        }
        break;
      }
      case "error_output":
        lastError = l.line.trim();
        break;
      default:
        break;
    }
    if (isBack(i)) {
      if (open && open.backAfterS === null && l.ts >= open.ts) open.backAfterS = Math.round((l.ts - open.ts) / 1000);
      open = null;
      if (state === "connecting" || state === "reconnecting" || state === "unknown") set("connected", l.ts);
    }
  }
  return { events, state, since };
}

const LABEL: Record<BotEventKind, string> = {
  platform_restart: "KojyAI restart",
  highrise_reconnect: "Highrise reconnect",
  exit: "Bot exited",
  stop: "Stopped/restarted from KojyAI",
};

/**
 * A few lines for get_logs: is the bot in the room now, and what happened in
 * the last day. `now` is the current time (ms).
 */
export function connectionReport(lines: LogLine[], now: number): string {
  const { events, state, since } = connectionEvents(lines);
  const out: string[] = [];
  const ago = (ts: number) => duration((now - ts) / 1000);
  if (state === "connected" && since !== null) out.push(`Connection: in the room since ${stamp(since)} (${ago(since)}).`);
  else if (state === "reconnecting" && since !== null) out.push(`Connection: NOT in the room — reconnecting to Highrise since ${stamp(since)} (${ago(since)}).`);
  else if (state === "connecting" && since !== null) out.push(`Connection: starting since ${stamp(since)} (${ago(since)}), not in the room yet.`);
  else if (state === "offline" && since !== null) out.push(`Connection: NOT running since ${stamp(since)} (${ago(since)}).`);
  else out.push("Connection: no console output yet.");

  const day = events.filter((e) => now - e.ts < 86_400_000);
  const n = (k: BotEventKind) => day.filter((e) => e.kind === k).length;
  out.push(`Last 24 h: ${n("platform_restart")} KojyAI restart(s) (platform updates; bots come back by themselves), ` +
    `${n("highrise_reconnect")} Highrise reconnect(s) (Highrise closes connections now and then; the SDK reconnects by itself), ` +
    `${n("exit")} exit(s) of the bot itself, ${n("stop")} stop/restart(s) from KojyAI.`);
  const recent = events.slice(-8);
  if (recent.length) {
    out.push("Recent events (newest last):");
    for (const e of recent) {
      const back = e.backAfterS !== null ? `back in the room after ${duration(e.backAfterS)}` : e === events[events.length - 1] && state !== "connected" ? "not back yet" : "came back";
      out.push(`- ${stamp(e.ts)} ${LABEL[e.kind]}: ${e.detail} — ${back}`);
    }
  }
  return out.join("\n");
}

const PY_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[,.]\d+)?\s+/;
const similar = (l: LogLine) => `${l.stream}|${l.line.replace(PY_TIMESTAMP, "").replace(/[0-9a-f]{8,}/gi, "#").replace(/\d+/g, "#")}`;

/**
 * Console lines for the AI, newest last: a UTC time on each, runs of
 * near-identical lines folded into one, and — when it's too long — the
 * OLDEST lines dropped, never the newest.
 */
export function formatConsole(lines: LogLine[], opts: { maxLines?: number; maxChars?: number } = {}): string {
  const maxLines = opts.maxLines ?? 40;
  const maxChars = opts.maxChars ?? 6000;
  const shown: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i + 1;
    while (j < lines.length && similar(lines[j]!) === similar(lines[i]!)) j++;
    const l = lines[i]!;
    const mark = l.stream === "stderr" ? "! " : l.stream === "system" ? "# " : l.stream === "stdin" ? "> " : "";
    shown.push(`${stamp(l.ts)} ${mark}${l.line.replace(PY_TIMESTAMP, "")}`);
    if (j - i > 1) shown.push(`               ⋯ and ${j - i - 1} more like it, until ${stamp(lines[j - 1]!.ts)}`);
    i = j;
  }
  let size = 0;
  let from = shown.length;
  while (from > 0 && shown.length - from < maxLines && size + shown[from - 1]!.length + 1 <= maxChars) size += shown[--from]!.length + 1;
  if (from === shown.length && shown.length) { // one huge line: keep its end
    return `… (earlier output not shown)\n${shown[shown.length - 1]!.slice(-maxChars)}`;
  }
  return `${from > 0 ? `… (${from} earlier line(s) not shown)\n` : ""}${shown.slice(from).join("\n")}`;
}
