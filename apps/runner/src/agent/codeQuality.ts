/**
 * Tools that make the coder AI's code better: a map of the project, a
 * forgiving text replace, the bot's spec sheet, an exact SDK lookup and a
 * real code checker (pyflakes + mypy against the installed SDK).
 * OWNERSHIP: apps/runner/src/agent
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { listFiles, projectDir, MAX_EDIT_BYTES } from "@kojyai/shared/projects";

/** Kojy's own files inside a project (tests, spec, room insights). Shown in the code panel, kept in snapshots. */
export const KOJY_DIR = ".kojy";
const SPEC_FILE = `${KOJY_DIR}/spec.md`;

const VENVS_DIR = process.env.VENVS_DIR ?? "/app/venvs";
const PYTHON_BIN = process.env.PYTHON_BIN ?? "python3";
const TOOLS_VENV = path.join(VENVS_DIR, ".kojy-tools");
const TOOLS = ["pyflakes==3.2.0", "mypy==1.13.0"];

/** Code that isn't part of the running bot (its own tests, one-off tools). */
const NOT_BOT_CODE = /^(tests?|tools|scripts|\.kojy)\//;

export function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const add = (d: Buffer) => { if (out.length < 60_000) out += d.toString("utf8"); };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (e) => { clearTimeout(timer); resolve({ code: -1, out: e.message }); });
    child.once("exit", (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

// ── project map ──────────────────────────────────────────────────────────────

/**
 * Files, classes, functions (with line numbers) and chat commands of the bot,
 * so the AI knows where things are without reading every file first.
 */
export function projectMap(uuid: string, maxChars = 2500): string {
  const dir = projectDir(uuid);
  const files = listFiles(uuid).filter((f) => !f.isDir && f.path.endsWith(".py") && f.size <= MAX_EDIT_BYTES && !NOT_BOT_CODE.test(f.path));
  const full: string[] = [];
  const short: string[] = [];
  for (const f of files) {
    const lines = readFileSync(path.join(dir, f.path), "utf8").split("\n");
    const defs: string[] = [];
    const top: string[] = [];
    const commands = new Set<string>();
    lines.forEach((line, i) => {
      const m = /^(\s*)(?:async\s+)?(def|class)\s+(\w+)/.exec(line);
      if (m) {
        const item = `${m[2] === "class" ? "class " : ""}${m[3]} L${i + 1}`;
        defs.push(item);
        if (m[2] === "class" || m[1]!.length <= 4 && /^on_|^_?handle|^cmd_/.test(m[3]!)) top.push(item);
      }
      for (const c of line.matchAll(/["'](![A-Za-z][\w-]{0,24})\b/g)) commands.add(c[1]!);
    });
    const cmds = commands.size ? ` · commands: ${[...commands].slice(0, 40).join(" ")}` : "";
    full.push(`${f.path} (${lines.length} lines): ${defs.join(", ") || "no functions"}${cmds}`);
    short.push(`${f.path} (${lines.length} lines): ${top.join(", ")}${cmds}`);
  }
  if (!files.length) return "(no Python files yet)";
  for (const variant of [full, short]) {
    const text = variant.join("\n");
    if (text.length <= maxChars) return text;
  }
  const text = short.join("\n");
  return `${text.slice(0, maxChars)}\n… (map cut short; use search_code)`;
}

// ── forgiving replace ────────────────────────────────────────────────────────

export type ReplaceResult = { ok: true; text: string; note: string } | { ok: false; message: string };

const indentOf = (line: string) => /^\s*/.exec(line)![0];

/**
 * Replace old with replacement in text. Exact match first; otherwise lines
 * are compared ignoring indentation and trailing spaces (the replacement is
 * re-indented to fit), and on failure the closest place is shown.
 */
export function forgivingReplace(text: string, old: string, replacement: string): ReplaceResult {
  if (!old.trim()) return { ok: false, message: "old_text is empty." };
  const exact = text.split(old).length - 1;
  if (exact === 1) return { ok: true, text: text.replace(old, () => replacement), note: "" };
  if (exact > 1) return { ok: false, message: `old_text matches ${exact} places; include more surrounding lines so it matches one.` };

  const lines = text.split("\n");
  const want = old.replace(/\n+$/, "").split("\n");
  while (want.length && !want[0]!.trim()) want.shift();
  const key = (l: string) => l.trim();
  const hits: number[] = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    if (want.every((w, j) => key(w) === key(lines[i + j]!))) hits.push(i);
  }
  if (hits.length === 1) {
    const at = hits[0]!;
    const firstWant = want.find((w) => w.trim()) ?? "";
    const firstHave = lines.slice(at, at + want.length).find((l) => l.trim()) ?? "";
    const from = indentOf(firstWant), to = indentOf(firstHave);
    const shifted = replacement.replace(/\n+$/, "").split("\n").map((l) => {
      if (!l.trim()) return l;
      return l.startsWith(from) ? to + l.slice(from.length) : to + l.trimStart();
    });
    lines.splice(at, want.length, ...shifted);
    return { ok: true, text: lines.join("\n"), note: ` (matched ignoring indentation at line ${at + 1})` };
  }
  if (hits.length > 1) return { ok: false, message: `old_text matches ${hits.length} places (lines ${hits.map((h) => h + 1).join(", ")}); include more surrounding lines.` };

  // Closest place: the window where the most lines match.
  let best = -1, bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    let score = 0;
    for (let j = 0; j < want.length && i + j < lines.length; j++) if (key(want[j]!) && key(want[j]!) === key(lines[i + j]!)) score++;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  if (best < 0) return { ok: false, message: "old_text was not found, and no line of it is in the file. Read the file again (read_file) and copy the exact text." };
  const shown = lines.slice(best, best + want.length + 2).map((l, i) => `${best + i + 1}| ${l}`).join("\n");
  return { ok: false, message: `old_text was not found. Closest place (${bestScore} of ${want.length} lines match), lines ${best + 1}-${best + want.length + 2}:\n${shown}\nCopy the text from there, or use replace_lines with these line numbers.` };
}

/** Replace lines start..end (1-based, inclusive) with replacement. */
export function replaceLines(text: string, start: number, end: number, replacement: string): ReplaceResult {
  const lines = text.split("\n");
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) {
    return { ok: false, message: `Lines must be 1-${lines.length} with start <= end.` };
  }
  lines.splice(start - 1, end - start + 1, ...(replacement === "" ? [] : replacement.replace(/\n$/, "").split("\n")));
  return { ok: true, text: lines.join("\n"), note: "" };
}

// ── spec sheet ───────────────────────────────────────────────────────────────

export function readSpec(uuid: string): string {
  const file = path.join(projectDir(uuid), SPEC_FILE);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

export function writeSpec(uuid: string, content: string): void {
  const file = path.join(projectDir(uuid), SPEC_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content.trim() + "\n");
}

// ── exact SDK lookup ─────────────────────────────────────────────────────────

// Reads the installed SDK: every action on self.highrise and self.webapi, the
// bot hooks, and the models with their fields. Argument: a word to search.
const SDK_PROBE = `
import inspect, sys, attrs
import highrise, highrise.models as models, highrise.webapi as webapi
from highrise import BaseBot, Highrise
q = sys.argv[1].lower().strip()
rows = []
def sig(f):
    try: return str(inspect.signature(f)).replace("'", "")
    except (TypeError, ValueError): return "(...)"
def tname(t):
    return t.__name__ if isinstance(t, type) else str(t).replace("'", "").replace("highrise.models.", "")
def doc(o):
    d = (inspect.getdoc(o) or "").strip().split("\\n\\n")[0].replace("\\n", " ")
    return d[:240]
for name, f in inspect.getmembers(Highrise, inspect.isfunction):
    if not name.startswith("_"): rows.append(("await self.highrise." + name + sig(f), doc(f)))
for name, f in inspect.getmembers(webapi.WebAPI, inspect.isfunction):
    if not name.startswith("_"): rows.append(("await self.webapi." + name + sig(f), doc(f)))
for name, f in inspect.getmembers(BaseBot, inspect.isfunction):
    if name.startswith("on_") or name == "before_start": rows.append(("hook async def " + name + sig(f), doc(f)))
def classes(owner, prefix):
    for name, c in inspect.getmembers(owner, inspect.isclass):
        if getattr(c, "__module__", "") != models.__name__ or name.startswith("_"): continue
        if attrs.has(c):
            fields = ", ".join(a.name + ": " + tname(a.type) for a in attrs.fields(c))
            rows.append(("class " + prefix + name + "(" + fields + ")", doc(c)))
        classes(c, prefix + name + ".")
classes(models, "")
words = [w for w in q.split() if w]
hits = [r for r in rows if all(w in (r[0] + " " + r[1]).lower() for w in words)] if words else rows
print("highrise-bot-sdk", getattr(highrise, "__version__", ""), "-", len(hits), "matches")
for head, d in hits[:40]:
    print(head)
    if d: print("    " + d)
`;

export async function sdkLookup(python: string, query: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  const r = await run(python, ["-c", SDK_PROBE, query.slice(0, 80)], cwd, env, 30_000);
  return r.code === 0 ? r.out.trim() : `SDK lookup failed:\n${r.out.slice(-1500)}`;
}

// ── code checker ─────────────────────────────────────────────────────────────

let toolsReady: Promise<string | null> | null = null;

/** The checker's own Python (pyflakes + mypy), installed once into the venvs volume. Null if it can't be set up. */
export function ensureCheckTools(): Promise<string | null> {
  toolsReady ??= (async () => {
    const python = path.join(TOOLS_VENV, "bin", "python");
    const marker = path.join(TOOLS_VENV, ".kojy-tools");
    if (existsSync(marker) && readFileSync(marker, "utf8") === TOOLS.join("\n")) return python;
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: VENVS_DIR, ...proxyEnv() };
    if (!existsSync(python)) {
      const v = await run(PYTHON_BIN, ["-m", "venv", TOOLS_VENV], VENVS_DIR, env, 120_000);
      if (v.code !== 0) return null;
    }
    const pip = await run(python, ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "-q", ...TOOLS], VENVS_DIR, env, 300_000);
    if (pip.code !== 0) return null;
    writeFileSync(marker, TOOLS.join("\n"));
    return python;
  })().then((p) => { if (!p) toolsReady = null; return p; });
  return toolsReady;
}

function proxyEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (/^(HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|SSL_CERT_FILE|PIP_\w+|REQUESTS_CA_BUNDLE)$/.test(k)) out[k] = v;
  return out;
}

export interface Issue { file: string; line: number; message: string; severity: "error" | "warning"; tool: string }

// mypy findings that are real bugs in bot code (a name or attribute that
// doesn't exist, a wrong call) vs ones worth a look (a value that may be an
// Error instead of the result, a wrong argument type).
const MYPY_ERRORS = new Set(["attr-defined", "name-defined", "call-arg", "call-overload"]);
const MYPY_WARNINGS = new Set(["union-attr", "arg-type", "operator", "index"]);

export function parseIssues(out: string, tool: "pyflakes" | "mypy"): Issue[] {
  const issues: Issue[] = [];
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (tool === "pyflakes") {
      const m = /^(.+?):(\d+):(?:\d+:)?\s+(.*)$/.exec(line);
      if (!m) continue;
      const msg = m[3]!;
      // Undefined names and broken imports break the bot; unused imports and the like don't.
      const severity = /undefined name|undefined local|referenced before assignment|unable to detect undefined names/.test(msg) ? "error"
        : /imported but unused|redefinition of unused|is assigned to but never used|f-string is missing placeholders/.test(msg) ? null : "warning";
      if (severity) issues.push({ file: m[1]!.replace(/^\.\//, ""), line: Number(m[2]), message: msg, severity, tool });
    } else {
      const m = /^(.+?):(\d+):(?:\d+:)?\s+error:\s+(.*?)\s+\[([\w-]+)\]$/.exec(line);
      if (!m) continue;
      const code = m[4]!;
      // union-attr: 'Item "X" of "X | Error" has no attribute': when X is the real
      // result the attribute doesn't exist at all (a bug); when X is Error, the
      // code just doesn't check for a failed request first.
      const realResult = code === "union-attr" && !/^Item "(Error|None)" of/.test(m[3]!);
      const severity = MYPY_ERRORS.has(code) || realResult ? "error" : MYPY_WARNINGS.has(code) ? "warning" : null;
      if (severity) issues.push({ file: m[1]!.replace(/^\.\//, ""), line: Number(m[2]), message: `${m[3]} [${code}]`, severity, tool });
    }
  }
  return issues;
}

/**
 * Runs pyflakes (undefined names) and mypy against the bot's installed
 * packages (the Highrise SDK's real classes and methods) on a copy of the code.
 */
export async function lintProject(workDir: string, botPython: string, entrypoint = ""): Promise<{ issues: Issue[]; note: string }> {
  const tools = await ensureCheckTools();
  if (!tools) return { issues: [], note: "(the extra checker couldn't be installed, so only syntax and loading were checked)" };
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: workDir, MYPY_CACHE_DIR: path.join(workDir, ".mypy_cache") };
  const pyFiles = botFiles(workDir, entrypoint);
  if (!pyFiles.length) return { issues: [], note: "" };
  const flakes = await run(tools, ["-m", "pyflakes", ...pyFiles], workDir, env, 60_000);
  const mypy = await run(tools, [
    "-m", "mypy", "--python-executable", botPython, "--ignore-missing-imports", "--check-untyped-defs", "--follow-imports=silent",
    "--no-error-summary", "--show-error-codes", "--no-color-output", "--hide-error-context", "--no-pretty", "--explicit-package-bases",
    "--exclude", "(^|/)(tests?|tools|scripts|data|\\.kojy)/", ...pyFiles,
  ], workDir, env, 150_000);
  const issues = [...parseIssues(flakes.out, "pyflakes"), ...parseIssues(mypy.out, "mypy")];
  const seen = new Set<string>();
  return {
    issues: issues.filter((i) => { const k = `${i.file}:${i.line}:${i.message}`; if (seen.has(k)) return false; seen.add(k); return true; }),
    note: mypy.code === null ? "(the type check took too long and was stopped)" : "",
  };
}

/**
 * The bot's own code: the entrypoint's package folder (highrise_bot/ for
 * "highrise_bot.bot:Bot"), or the top-level .py files for "bot:Bot". Leftover
 * files elsewhere (old runners, tools) aren't checked; what the bot imports
 * from them is still read for the type check.
 */
function botFiles(workDir: string, entrypoint: string): string[] {
  const top = entrypoint.split(":")[0]!.split(".")[0] ?? "";
  const all = listPy(workDir);
  if (top && isDir(path.join(workDir, top))) return all.filter((f) => f.startsWith(`${top}/`));
  const flat = all.filter((f) => !f.includes("/"));
  return flat.length ? flat : all;
}

function listPy(workDir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = path.join(workDir, rel);
    for (const name of readdirSafe(abs)) {
      const r = rel ? `${rel}/${name}` : name;
      if (/^(\.|__pycache__|venv|node_modules|data$)/.test(name)) continue;
      const full = path.join(workDir, r);
      if (isDir(full)) { if (!NOT_BOT_CODE.test(`${r}/`)) walk(r); }
      else if (name.endsWith(".py")) out.push(r);
    }
  };
  walk("");
  return out.slice(0, 400);
}

const readdirSafe = (p: string) => { try { return readdirSync(p); } catch { return []; } };
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

export function formatIssues(issues: Issue[]): string {
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const line = (i: Issue) => `${i.file}:${i.line}: ${i.message}`;
  return [
    errors.length ? `Errors (fix before restarting; these break the bot when that line runs):\n${errors.slice(0, 25).map(line).join("\n")}` : "",
    warnings.length ? `Warnings (look at these; e.g. a Highrise call can return an Error instead of the result):\n${warnings.slice(0, 15).map(line).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}
