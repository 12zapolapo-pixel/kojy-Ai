/**
 * What Kojy may do in a run it started by itself.
 *
 * Crash (the owner's choice: fix right away, no approval): read, test, edit
 * code and restart the bot. A crash's output can carry text a room visitor
 * typed (V-03), so even then a crash run can't delete files, touch the bot's
 * saved data or dependencies, change secrets or the entrypoint, stop the bot,
 * save long-term notes, or ADD code that reaches the internet, reads secrets,
 * runs programs, deletes files or builds code at runtime — a fix that really
 * needs one of those goes through propose_plan and the owner. Only the traceback reaches
 * the AI, with long quoted text (likely chat) left out.
 *
 * Daily check-up (nothing is broken): investigate and propose; changes wait
 * for the owner's approval.
 * OWNERSHIP: apps/runner/src/agent
 */

import { cleanRelPath, isPersistentData } from "@kojyai/shared/projects";

export type AutomatedKind = "crash" | "checkup";
export const AUTOMATED_KINDS = new Set<string>(["crash", "checkup"]);

/** A check-up run can't use these until the owner approves a plan. */
export const NEEDS_OWNER = new Set(["write_file", "edit_file", "delete_file", "bot_control", "set_entrypoint", "request_secrets", "remember"]);
export const OWNER_APPROVAL_NEEDED =
  "Not allowed yet: this run was started by the daily check-up, not by the owner. " +
  "Investigate and test as much as you like, then explain the cause and call propose_plan with the fix. Once the owner approves, you can change files and restart the bot.";

/** Never in a crash run. */
const CRASH_RUN_LOCKED: Record<string, string> = {
  delete_file: "deleting files",
  set_entrypoint: "changing the entrypoint",
  request_secrets: "asking for secrets",
  remember: "saving long-term notes",
};

/** Kinds of code a crash fix may not add (counted before and after the change). */
const RISKS: { label: string; re: RegExp }[] = [
  { label: "internet access", re: /\b(?:requests|urllib3?|httpx|aiohttp|http\.client|socket|websockets?|ftplib|smtplib|telnetlib|paramiko|open_connection|create_connection|start_server|sock_connect)\b/g },
  { label: "running programs", re: /\b(?:subprocess|os\.system|os\.popen|os\.exec\w*|os\.spawn\w*|pty|multiprocessing)\b/g },
  { label: "reading secrets or the environment", re: /\b(?:environ|getenv|putenv)\b|\b[A-Z0-9_]*(?:TOKEN|API_KEY|SECRET|PASSWORD)[A-Z0-9_]*\b/g },
  { label: "code built at runtime", re: /(?<![\w.])(?:eval|exec|compile|__import__)\s*\(|\b(?:importlib|marshal|pickle|base64|codecs|ctypes|__builtins__)\b/g },
  { label: "deleting files", re: /\b(?:os\.remove|os\.unlink|os\.rmdir|shutil\.rmtree|shutil\.move)\b|\.(?:unlink|rmdir)\s*\(/g },
];

/** Changing these installs (and so runs) other people's code. */
const DEPENDENCY_FILE = /(?:^|\/)(?:requirements[^/]*\.txt|pyproject\.toml|setup\.py|setup\.cfg|Pipfile(?:\.lock)?|poetry\.lock)$/i;

const count = (re: RegExp, text: string) => text.match(re)?.length ?? 0;

/** The kinds of risky code `after` has more of than `before`. */
export function addedRisks(before: string, after: string): string[] {
  return RISKS.filter(({ re }) => count(re, after) > count(re, before)).map((r) => r.label);
}

/**
 * Why `tool` can't run in this automatic run, or null if it can.
 * `currentText(rel)` returns a file's current content ("" if it doesn't exist).
 */
export function automaticRefusal(kind: AutomatedKind, tool: string, args: Record<string, unknown>, currentText: (rel: string) => string): string | null {
  if (kind === "checkup") return NEEDS_OWNER.has(tool) ? OWNER_APPROVAL_NEEDED : null;
  const no = (what: string) =>
    `Not allowed in an automatic crash fix: ${what}. Fix the crash without it; if the fix really needs it, explain why and call propose_plan so the owner can approve it.`;
  const locked = CRASH_RUN_LOCKED[tool];
  if (locked) return no(locked);
  if (tool === "bot_control" && String(args.action ?? "") === "stop") return no("stopping the bot (restart it instead)");
  if (tool !== "write_file" && tool !== "edit_file") return null;
  let rel: string;
  try {
    rel = cleanRelPath(String(args.path ?? ""));
  } catch {
    return null; // the tool itself reports the bad path
  }
  if (isPersistentData(rel)) return no(`changing the bot's saved data (${rel})`);
  if (DEPENDENCY_FILE.test(rel)) return no(`changing the bot's dependencies (${rel})`);
  const before = tool === "edit_file" ? String(args.old_text ?? "") : currentText(rel);
  const after = tool === "edit_file" ? String(args.new_text ?? "") : String(args.content ?? "");
  const risks = addedRisks(before, after);
  return risks.length ? no(`adding code for ${risks.join(" or ")}`) : null;
}

// ── reading a crash ───────────────────────────────────────────────────────────

const EXCEPTION_LINE = /^[A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt|Warning)\b/;
/** Traceback decoration of exception groups ("  | ", "+-+---"). */
const undecorate = (l: string) => l.replace(/^[\s|+-]+/, "");

/** The exception a crash ended with (the innermost one of an exception group), or "". */
export function lastException(tail: string[]): string {
  for (let i = tail.length - 1; i >= 0; i--) {
    const t = undecorate(tail[i]!).trim();
    if (EXCEPTION_LINE.test(t) && !/^(?:Base)?ExceptionGroup\b/.test(t)) return t;
  }
  return "";
}

/** The network or Highrise being away (DNS, refused, reset, timeout) — not a bug in the bot's code. */
const NETWORK_FAILURE = /ClientConnectorError|ClientConnectionError|ClientOSError|ServerDisconnectedError|ServerTimeoutError|WSServerHandshakeError|ConnectionResetError|ConnectionRefusedError|ConnectionAbortedError|gaierror|TimeoutError|Temporary failure in name resolution|Name or service not known|Network is unreachable|Cannot connect to host/;
export function isNetworkFailure(tail: string[]): boolean {
  return NETWORK_FAILURE.test(lastException(tail));
}

/** Quoted text this long in a traceback is most likely room chat or data, not code. */
const LONG_QUOTED = /(['"])(?:(?!\1)[^\\\n]|\\.){80,}\1/g;

/**
 * The traceback part of the bot's last output, for the AI: frames, code
 * lines and exception lines only (no log lines, which often quote chat), long
 * quoted text left out. "" when there's no traceback.
 */
export function crashExcerpt(tail: string[], maxLines = 40): string {
  const start = tail.findIndex((l) => l.includes("Traceback (most recent call last)"));
  if (start < 0) return "";
  return tail.slice(start)
    .filter((l) => {
      const t = undecorate(l);
      return /^[\s|+]/.test(l) || t.startsWith("Traceback") || t.startsWith("During handling") || t.startsWith("The above exception") || EXCEPTION_LINE.test(t);
    })
    .slice(-maxLines)
    .map((l) => l.replace(LONG_QUOTED, (_m, q: string) => `${q}<long text left out>${q}`).slice(0, 300))
    .join("\n");
}
