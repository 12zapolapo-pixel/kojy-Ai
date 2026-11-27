/**
 * What Kojy may do in a run it started by itself — a crash (or an error the
 * bot survived) or the daily check-up. Both fix the bot right away with no
 * approval step: the owner wants every problem fixed automatically.
 *
 * The bot's output can carry text a room visitor typed (V-03), so such a run
 * still can't delete files, touch the bot's saved data or dependencies,
 * change secrets or the entrypoint, stop the bot, save long-term notes, run
 * shell commands or git, or ADD code that reaches the internet, reads secrets,
 * runs programs, deletes files or builds code at runtime. None of that waits
 * for the owner: Kojy is told to fix the problem another way. Only the
 * traceback reaches the AI, with long quoted text (likely chat) left out.
 * OWNERSHIP: apps/runner/src/agent
 */

import { cleanRelPath, isPersistentData } from "@kojyai/shared/projects";

export type AutomatedKind = "crash" | "checkup";
export const AUTOMATED_KINDS = new Set<string>(["crash", "checkup"]);

/** Never in an automatic run. */
export const AUTOMATIC_RUN_LOCKED: Record<string, string> = {
  delete_file: "deleting files",
  set_entrypoint: "changing the entrypoint",
  request_secrets: "asking for secrets",
  remember: "saving long-term notes",
  save_test: "saving tests",
  run_command: "running shell commands",
  run_python: "running Python scripts",
  git: "using git (pushing or pulling)",
  fetch_url: "reading web pages",
  web_search: "searching the web",
  replace_in_files: "replacing text across files",
  rename_symbol: "renaming across files",
  add_package: "changing the bot's dependencies (a missing well-known package is added by KojyAI itself)",
  restore_file: "restoring files (KojyAI undoes a fix that doesn't hold by itself)",
  format_code: "reformatting code",
  run_unit_tests: "running the bot's unit tests",
  modify_data: "changing the bot's saved data",
  http_request: "sending web requests",
  call_function: "running the bot's functions",
  move_file: "moving or renaming files",
  undo_changes: "undoing changes (KojyAI undoes a fix that doesn't hold by itself)",
};

/**
 * The tools an automatic run is given: what finding and fixing a bug in the
 * code takes. The rest are refused in such a run anyway (or don't help fix
 * code), and every tool's description goes with every AI request — fewer
 * tools, smaller requests, more AI keys that can take them.
 */
export const AUTOMATIC_RUN_TOOLS = new Set([
  "list_files", "read_file", "search_code", "edit_file", "multi_edit", "write_file", "append_file", "check_code", "test_in_room", "test_discord", "run_saved_tests",
  "get_logs", "bot_control", "find_env_vars", "find_emotes", "discord_check", "work_log", "search_chat",
  "find_symbol", "inspect_package",
]);

/** The tool specs an automatic run gets. */
export function automaticTools<T extends { function: { name: string } }>(specs: T[]): T[] {
  return specs.filter((t) => AUTOMATIC_RUN_TOOLS.has(t.function.name));
}

/** Kinds of code an automatic fix may not add (counted before and after the change). */
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
 * Why `tool` can't run in this automatic run, or null if it can. The same
 * rules for crashes and check-ups. `currentText(rel)` returns a file's current
 * content ("" if it doesn't exist).
 */
export function automaticRefusal(_kind: AutomatedKind, tool: string, args: Record<string, unknown>, currentText: (rel: string) => string): string | null {
  const no = (what: string) =>
    `Not allowed in an automatic fix: ${what}. Don't wait for the owner — fix the problem another way within these limits ` +
    "(handle the bad value, add a guard or a default, catch the error where it happens, change the logic).";
  if (tool === "propose_plan") {
    return "Don't stop for the owner's approval in an automatic fix: the owner wants every problem fixed automatically. Make the fix yourself (within the limits), check it, restart the bot and confirm it's back.";
  }
  const locked = AUTOMATIC_RUN_LOCKED[tool];
  if (locked) return no(locked);
  if (tool === "bot_control" && String(args.action ?? "") === "stop") return no("stopping the bot (restart it instead)");
  if (!["write_file", "edit_file", "append_file", "multi_edit", "edit_lines"].includes(tool)) return null;
  let rel: string;
  try {
    rel = cleanRelPath(String(args.path ?? ""));
  } catch {
    return null; // the tool itself reports the bad path
  }
  if (isPersistentData(rel)) return no(`changing the bot's saved data (${rel})`);
  if (DEPENDENCY_FILE.test(rel)) return no(`changing the bot's dependencies (${rel}); a missing well-known package is added by KojyAI itself`);
  const edits = tool === "multi_edit" ? (Array.isArray(args.edits) ? args.edits as Record<string, unknown>[] : []) : [];
  const lineRange = () => currentText(rel).split("\n").slice(Math.max(0, Number(args.start_line) - 1), Math.max(0, Number(args.end_line))).join("\n");
  const before = tool === "edit_file" ? String(args.old_text ?? "")
    : tool === "edit_lines" ? lineRange()
    : tool === "multi_edit" ? edits.map((e) => String(e.old_text ?? "")).join("\n")
    : tool === "append_file" ? "" : currentText(rel);
  const after = tool === "edit_file" || tool === "edit_lines" ? String(args.new_text ?? "")
    : tool === "multi_edit" ? edits.map((e) => String(e.new_text ?? "")).join("\n")
    : String(args.content ?? "");
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

/**
 * An error line with what changes from one time to the next taken out
 * (quoted text, numbers, ids, addresses), so the same bug hit by different
 * visitors counts as one error. "KeyError: 'amy'" and "KeyError: 'bob'" →
 * "KeyError: '…'".
 */
export function normalizeError(line: string): string {
  return undecorate(line).trim()
    .replace(/(['"])(?:(?!\1)[^\\\n]|\\.)*\1/g, "'…'")
    .replace(/\b0x[0-9a-f]+\b/gi, "0x…")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "…")
    .replace(/\b\d+(\.\d+)?\b/g, "N")
    .replace(/\s+/g, " ")
    .slice(0, 200);
}

/** Where in the bot's own code an error happened ("bot.py:302 in on_user_join"), from its traceback lines. */
export function crashLocation(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /File "([^"]+)", line (\d+), in (\S+)/.exec(lines[i]!);
    if (!m) continue;
    const file = m[1]!;
    if (/site-packages|[/\\]lib[/\\]python3|<frozen|launcher\.py$/.test(file)) continue;
    const rel = file.replace(/^.*?[/\\]projects[/\\][^/\\]+[/\\]/, "").replace(/^.*?[/\\]kojy-(?:test|check)-[^/\\]+[/\\]/, "");
    return `${rel}:${m[2]} in ${m[3]}`;
  }
  return "";
}

/**
 * Two crashes with the same signature are the same bug: the same error in
 * the same function. Line numbers are left out — a fix that adds lines above
 * moves the crash without changing it.
 */
export function crashSignature(tail: string[]): string {
  const ex = lastException(tail);
  return ex ? `${normalizeError(ex)} @ ${crashLocation(tail).replace(/:\d+ in /, " in ")}` : "";
}

/**
 * The signature of every traceback in some console lines (e.g. a test room
 * run), in order. An exception group's traceback is one, up to its last
 * decorated line; its real error inside decides the signature.
 */
export function tracebackSignatures(lines: string[]): string[] {
  const out: string[] = [];
  let block: string[] | null = null;
  let group = false;
  const flush = () => {
    if (block) { const sig = crashSignature(block); if (sig) out.push(sig); }
    block = null;
    group = false;
  };
  const begin = (line: string, text: string) => { block = [line]; group = text.startsWith("Exception Group"); };
  for (const line of lines) {
    const text = undecorate(line).trim();
    const starts = /^(?:Exception Group )?Traceback \(most recent call last\)/.test(text);
    if (!block) { if (starts) begin(line, text); continue; }
    if (group) {
      if (/^[\s|+]/.test(line)) { (block as string[]).push(line); continue; }
      flush();
      if (starts) begin(line, text);
      continue;
    }
    if (starts && !/^\s*[|+]/.test(line)) { flush(); begin(line, text); continue; }
    (block as string[]).push(line);
    if (EXCEPTION_LINE.test(text)) flush();
  }
  flush();
  return out;
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
