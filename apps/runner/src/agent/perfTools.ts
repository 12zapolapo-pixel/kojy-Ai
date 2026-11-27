/**
 * Kojy's speed and quality tools: making code faster and better, and proving it.
 *
 * - profile_code: where a function's (or snippet's) time and memory go — by
 *   function, by line of the bot's own code (CPU sampling), the slow calls into
 *   libraries with the bot code that made them, and every moment async code
 *   blocked the event loop. `repeat` calls it many times (a fast handler).
 * - benchmark: new code against the old, sampled in turns, with the speed-up
 *   judged against the noise, peak memory, and whether both give the same
 *   `result`; with `sizes`, how the time grows with the data (O(n) vs O(n²)).
 * - code_metrics: complexity, length, nesting and arguments per function,
 *   duplicated and renamed-copy code, unused code, long files, a 0-100 score;
 *   compare= shows before → after against this request's start or the last
 *   version that ran fine.
 * - type_check: mypy against the bot's own packages (cache kept per bot);
 *   likely bugs apart from type-hint notes, with what each kind means.
 * - optimize_query: SQLite's plan and time for each query (one, or every one
 *   in the code, each on the database it belongs to), the index that fixes a
 *   full scan, the database's health; create_index / tune apply them after a
 *   backup and show the time before → after.
 * - bot_resources: the running bot's CPU, memory, threads and open files over
 *   a few seconds, and memory growth since the last check (a leak).
 * Code runs in a copy of the project with placeholder values for its secrets
 * (the real ones are never needed to measure code, and imports that read
 * os.environ still work).
 * OWNERSHIP: apps/runner/src/agent
 */

import { Worker } from "node:worker_threads";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PROJECTS_DIR, cleanRelPath, databaseFile, listDatabases, listFiles, projectDir, resolveInside, isPersistentData, MAX_EDIT_BYTES,
  extractSnapshot, extractKnownGood,
} from "@kojyai/shared/projects";
import type { ToolSpec } from "./groq.js";
import type { ToolContext, ToolResult } from "./tools.js";
import type { CodeToolHelpers } from "./codeTools.js";
import { CODEINTEL, PERFTOOLS, VENVS_DIR } from "../supervisor.js";
import { grantDir, sandboxUid } from "../sandbox.js";
import { untrusted } from "./prompt.js";

type Args = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : "");
const clip = (t: string, max = 8000) => (t.length > max ? `${t.slice(0, max)}\n… (${t.length - max} more characters)` : t);
const fn = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): ToolSpec => ({
  type: "function", function: { name, description, parameters: { type: "object", properties, required } },
});
const str = (description: string) => ({ type: "string", description });

export const PERF_TOOL_SPECS: ToolSpec[] = [
  fn("profile_code", "Find what makes code slow: runs a function (module+function+args) or a snippet (code) under a profiler — the slowest functions, the hottest lines of the bot's code, slow library calls and which bot line made them, memory, and every time async code blocked the event loop. repeat calls it many times (for a fast handler). Profile before optimizing; benchmark after.",
    { module: str("e.g. shop"), function: str("e.g. top_players or Class.method"), args: { type: "array", items: {} }, kwargs: { type: "object" }, code: str("or a snippet, e.g. import shop\\nshop.top_players(load())"), repeat: { type: "integer", description: "calls, 1-10000 (default 1)" } }),
  fn("benchmark", "Prove a speed-up: times `code` against `baseline` (the old version), in turns, and says how many times faster (judged against the noise), the memory each uses, and whether both set the same `result`. setup runs first (imports, test data). sizes: setup sees `n` for each size and the result says how the time grows (O(n), O(n²)…) — the way to find code that gets slow as the room or data grows.",
    { code: str("the new code, e.g. result = top_fast(data)"), baseline: str("the old code, e.g. result = top_slow(data)"), setup: str("e.g. from shop import top_fast, top_slow\\ndata = make_data(n)"), sizes: { type: "array", items: { type: "integer" }, description: "e.g. [500, 1000, 2000, 4000]" }, seconds: { type: "number", description: "0.5-8 (default 2)" } }, ["code"]),
  fn("code_metrics", "Code quality numbers: each function's complexity, length, nesting and arguments (worst first, with what's too much), duplicated code (also copies with renamed variables), unused code, long files, a 0-100 score. compare='request' or 'last_working' shows before → after.",
    { path: str("optional file or folder"), compare: { type: "string", enum: ["request", "last_working"] } }),
  fn("type_check", "Type-check the bot's code with mypy against its installed packages: wrong attribute or method names, wrong argument types or counts, None used where a value is needed, wrong return types — likely bugs found before the code runs (type-hint notes listed apart).",
    { path: str("optional file or folder") }),
  fn("optimize_query", "Make the bot's database fast: the plan and time of a query (sql), or of every query in the code, full table scans and the index that fixes each, and the database's health. create_index=true adds the indexes, tune=true sets WAL mode and refreshes the planner's statistics (both after a backup) and shows the time before → after.",
    { sql: str("one SELECT/UPDATE/DELETE, optional"), db: str("database path if several"), create_index: { type: "boolean" }, tune: { type: "boolean" } }),
  fn("bot_resources", "How hard the running bot works the server, over a few seconds: CPU (average and peak), memory, threads, open files and connections — and how memory changed since the last check (call again minutes later to spot a leak).",
    { seconds: { type: "integer", description: "3-30 (default 5)" } }),
];

export const PERF_TOOL_NAMES = new Set(PERF_TOOL_SPECS.map((t) => t.function.name));

const PY_TARGET = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*){0,6}$/;

async function botPython(ctx: ToolContext): Promise<string> {
  const venvPython = path.join(VENVS_DIR, ctx.project.uuid, "bin", "python");
  return existsSync(venvPython) ? venvPython : ctx.supervisor.ensureVenv(ctx.project.uuid, projectDir(ctx.project.uuid), ctx.project.id);
}

/**
 * Stand-in values for the bot's secrets: code that reads os.environ["TOKEN"]
 * when it's imported still loads, and no real secret is ever handed to code
 * that's only being measured. Numbers where the name says it's one.
 */
export async function placeholderSecrets(ctx: ToolContext): Promise<Record<string, string>> {
  let names: string[] = [];
  try { names = Object.keys(await ctx.supervisor.secrets(ctx.project)); } catch { /* none */ }
  return Object.fromEntries(names.filter((n) => /^[A-Za-z_]\w{0,99}$/.test(n))
    .map((n) => [n, /(^|_)(PORT|ID|COUNT|LIMIT|SIZE|INTERVAL|SECONDS|TIMEOUT|MAX|MIN)$/i.test(n) ? "0" : "kojy-placeholder"]));
}

/** perftools.py in the bot's environment, in a copy of the project (measuring can't change the real files). */
async function perf(ctx: ToolContext, h: CodeToolHelpers, mode: "profile" | "benchmark", spec: Record<string, unknown>, timeoutS: number): Promise<{ code: number | null; out: string }> {
  const dir = projectDir(ctx.project.uuid);
  const python = await botPython(ctx);
  const uid = sandboxUid(ctx.project.id);
  const work = mkdtempSync(path.join(tmpdir(), "kojy-perf-"));
  try {
    cpSync(dir, work, { recursive: true, filter: (src) => !/[/\\](\.git|node_modules|__pycache__|venv|\.venv)$/.test(src) });
    grantDir(work, uid);
    return await h.runCapture(uid, "timeout", ["-k", "5", String(timeoutS), python, PERFTOOLS, mode, JSON.stringify(spec)], work,
      { ...await placeholderSecrets(ctx), PATH: process.env.PATH, HOME: work, PYTHONPATH: work, PYTHONDONTWRITEBYTECODE: "1", TERM: "dumb" }, (timeoutS + 10) * 1000);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ── code_metrics ─────────────────────────────────────────────────────────────

interface Fn { file: string; line: number; name: string; complexity: number; length: number; nesting: number; params: number; async: boolean }
interface Metrics {
  files: number; lines: number; functions: Fn[]; unused: string[]; duplicates: string[][]; same_functions: string[][];
  similar_functions?: string[][]; long_files?: string[];
}

/** What's too much for one function, in words ("" when fine). */
export function tooMuch(f: Fn): string {
  const out: string[] = [];
  if (f.complexity > 10) out.push(`complexity ${f.complexity} (over 10: hard to test, split it)`);
  if (f.length > 60) out.push(`${f.length} lines long`);
  if (f.nesting > 4) out.push(`nested ${f.nesting} deep (return early instead)`);
  if (f.params > 6) out.push(`${f.params} arguments`);
  return out.join(", ");
}

const copies = (m: Pick<Metrics, "duplicates" | "same_functions" | "similar_functions">) => m.duplicates.length + m.same_functions.length + (m.similar_functions?.length ?? 0);

/** A 0-100 score for a project's metrics, for before/after comparisons. */
export function qualityScore(m: Pick<Metrics, "functions" | "unused" | "duplicates" | "same_functions" | "similar_functions">): number {
  if (!m.functions.length) return 100;
  const bad = m.functions.filter((f) => tooMuch(f)).length / m.functions.length;
  const avg = m.functions.reduce((a, f) => a + f.complexity, 0) / m.functions.length;
  const penalty = bad * 40 + Math.max(0, avg - 3) * 4 + Math.min(m.unused.length, 10) * 1.5 + Math.min(copies(m), 10) * 2;
  return Math.max(0, Math.round(100 - penalty));
}

/** The numbers compared before → after. */
export function metricsSummary(m: Metrics): Record<string, number> {
  const fns = m.functions;
  return {
    score: qualityScore(m),
    avgComplexity: fns.length ? Math.round((fns.reduce((a, f) => a + f.complexity, 0) / fns.length) * 10) / 10 : 0,
    worstComplexity: Math.max(0, ...fns.map((f) => f.complexity)),
    tooMuch: fns.filter((f) => tooMuch(f)).length,
    copies: copies(m),
    unused: m.unused.length,
    functions: fns.length,
    lines: m.lines,
  };
}

const LABELS: Record<string, [string, "up" | "down" | ""]> = {
  score: ["Quality score", "up"], avgComplexity: ["Average complexity", "down"], worstComplexity: ["Worst complexity", "down"],
  tooMuch: ["Functions too complex/long/deep", "down"], copies: ["Copied code", "down"], unused: ["Probably unused", "down"],
  functions: ["Functions", ""], lines: ["Lines of code", ""],
};

/** "Quality score: 83 → 97 (better)" lines, and the functions whose complexity changed. */
export function compareMetrics(before: Metrics, after: Metrics): string {
  const b = metricsSummary(before), a = metricsSummary(after);
  const rows = Object.keys(LABELS).map((k) => {
    const [label, good] = LABELS[k]!;
    const d = a[k]! - b[k]!;
    const word = !d || !good ? "" : (d > 0) === (good === "up") ? " (better)" : " (worse)";
    return `- ${label}: ${b[k]} → ${a[k]}${word}`;
  });
  const old = new Map(before.functions.map((f) => [f.name, f.complexity]));
  const changed = after.functions.filter((f) => old.has(f.name) && old.get(f.name) !== f.complexity)
    .map((f) => `${f.name} ${old.get(f.name)} → ${f.complexity}`);
  const gone = before.functions.filter((f) => !after.functions.some((x) => x.name === f.name)).map((f) => f.name);
  const added = after.functions.filter((f) => !old.has(f.name)).map((f) => f.name);
  return [
    ...rows,
    changed.length ? `Complexity changed: ${changed.slice(0, 12).join(", ")}` : "",
    added.length ? `New functions: ${added.slice(0, 15).join(", ")}` : "",
    gone.length ? `Removed functions: ${gone.slice(0, 15).join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

async function metricsOf(ctx: ToolContext, h: CodeToolHelpers, root: string, target: string): Promise<Metrics | string> {
  const uid = sandboxUid(ctx.project.id);
  grantDir(root, uid);
  const r = await h.runCapture(uid, process.env.PYTHON_BIN ?? "python3", ["-I", CODEINTEL, "metrics", target], root, { PATH: process.env.PATH, HOME: root, PYTHONDONTWRITEBYTECODE: "1" }, 60_000);
  try { return JSON.parse(r.out.trim().split("\n").pop() ?? "") as Metrics; } catch { return r.out; }
}

async function codeMetrics(ctx: ToolContext, args: Args, h: CodeToolHelpers): Promise<ToolResult> {
  const uuid = ctx.project.uuid;
  const dir = projectDir(uuid);
  const target = s(args.path) ? cleanRelPath(s(args.path)) : ".";
  if (target !== "." && !existsSync(resolveInside(uuid, target))) return { ok: false, output: `No such file or folder: ${target}`, summary: `Couldn't find ${target}` };
  const m = await metricsOf(ctx, h, dir, target);
  if (typeof m === "string") return { ok: false, output: clip(`The metrics failed:\n${m}`), summary: "Metrics failed" };

  const compare = s(args.compare);
  if (compare === "request" || compare === "last_working") {
    const tmp = mkdtempSync(path.join(tmpdir(), "kojy-metrics-"));
    try {
      if (compare === "request") {
        if (!ctx.snapshotId) return { ok: false, output: "Nothing changed in this request yet, so there's no before to compare with. Run code_metrics now for the before numbers, change the code, then compare='request'.", summary: "Nothing to compare yet" };
        extractSnapshot(uuid, ctx.snapshotId, tmp);
      } else if (!extractKnownGood(uuid, tmp)) {
        return { ok: false, output: "No version that ran fine has been kept for this bot yet.", summary: "No working version kept" };
      }
      const before = existsSync(path.join(tmp, target)) || target === "." ? await metricsOf(ctx, h, tmp, target) : null;
      if (!before || typeof before === "string") return { ok: false, output: `Couldn't measure the earlier version${before ? `:\n${clip(before, 2000)}` : ` (${target} didn't exist then)`}.`, summary: "Comparison failed" };
      const a = metricsSummary(m), b = metricsSummary(before);
      return {
        ok: true,
        output: `Before (${compare === "request" ? "the start of this request" : "the last version that ran fine"}) → now:\n${compareMetrics(before, m)}`,
        summary: `Code metrics: score ${b.score} → ${a.score}, worst complexity ${b.worstComplexity} → ${a.worstComplexity}`,
      };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  if (!m.functions.length) return { ok: true, output: "No Python functions to measure.", summary: "No functions" };
  const worst = [...m.functions].sort((a, b) => b.complexity - a.complexity || b.length - a.length);
  const flagged = worst.filter((f) => tooMuch(f));
  const sum = metricsSummary(m);
  const lines = [
    `${m.files} files, ${m.lines} lines, ${m.functions.length} functions. Average complexity ${sum.avgComplexity}. Quality score ${sum.score}/100.`,
    flagged.length ? `\nToo much (${flagged.length}):\n${flagged.slice(0, 15).map((f) => `- ${f.file}:${f.line} ${f.name}: ${tooMuch(f)}`).join("\n")}` : "\nNo function is too complex, long or deeply nested.",
    `\nMost complex:\n${worst.slice(0, 8).map((f) => `- ${f.file}:${f.line} ${f.name}: complexity ${f.complexity}, ${f.length} lines, nesting ${f.nesting}, ${f.params} args`).join("\n")}`,
    m.same_functions.length ? `\nFunctions with the same body (keep one):\n${m.same_functions.map((d) => `- ${d.join(" = ")}`).join("\n")}` : "",
    m.similar_functions?.length ? `\nThe same code with renamed variables (one function with a parameter would do):\n${m.similar_functions.map((d) => `- ${d.join(" ≈ ")}`).join("\n")}` : "",
    m.duplicates.length ? `\nDuplicated code (6+ lines the same; make it one function):\n${m.duplicates.map((d) => `- ${d.join(", ")}`).join("\n")}` : "",
    m.unused.length ? `\nProbably unused (defined, never referenced by name; check with find_symbol before removing — dynamic use is possible):\n${m.unused.map((u) => `- ${u}`).join("\n")}` : "",
    m.long_files?.length ? `\nLong files (over 800 lines; split by feature): ${m.long_files.join(", ")}` : "",
    "\nAfter simplifying, code_metrics compare='request' shows before → after.",
  ];
  return { ok: true, output: clip(lines.filter(Boolean).join("\n"), 9000), summary: `Code metrics: score ${sum.score}/100, ${flagged.length} function${flagged.length === 1 ? "" : "s"} to simplify` };
}

// ── type_check ───────────────────────────────────────────────────────────────

const MYPY = () => process.env.KOJY_MYPY ?? "mypy";
/** mypy findings about missing or loose type hints, not bugs: listed apart so they aren't "fixed" for nothing. */
const HINT_ONLY = new Set(["var-annotated", "annotation-unchecked", "import-untyped", "import-not-found", "unused-ignore", "no-untyped-def", "no-untyped-call", "no-any-return", "type-arg"]);
/** What each kind of likely bug means, said once per kind. */
const MEANS: Record<string, string> = {
  "union-attr": "the value can be None (or another type) here: check `if x is None` first",
  "attr-defined": "that attribute or method doesn't exist on it (inspect_package shows what does)",
  "arg-type": "a value of the wrong type is passed",
  "call-arg": "wrong number or names of arguments",
  "return-value": "it returns a different type than declared",
  "index": "indexing something that can't be indexed (or can be None)",
  "operator": "an operation between types that don't mix (e.g. str + int)",
  "assignment": "a variable gets a value of a different type than before or than declared",
  "call-overload": "no version of that function takes these arguments",
  "func-returns-value": "using the result of a function that returns nothing",
  "misc": "",
};

export function readMypy(out: string): { bugs: Map<string, string[]>; hints: number } {
  const bugs = new Map<string, string[]>();
  let hints = 0;
  for (const line of out.split("\n")) {
    const m = /^(.+?):(\d+)(?::\d+)?: error: (.*?)(?:\s+\[([\w-]+)\])?\s*$/.exec(line.trim());
    if (!m) continue;
    const code = m[4] ?? "misc";
    if (HINT_ONLY.has(code)) { hints++; continue; }
    const list = bugs.get(code) ?? [];
    list.push(`${m[1]!.replace(/^\.\//, "")}:${m[2]}: ${m[3]}`);
    bugs.set(code, list);
  }
  return { bugs, hints };
}

async function typeCheck(ctx: ToolContext, args: Args, h: CodeToolHelpers): Promise<ToolResult> {
  const uuid = ctx.project.uuid;
  const dir = projectDir(uuid);
  const target = s(args.path) ? cleanRelPath(s(args.path)) : ".";
  if (target !== "." && !existsSync(resolveInside(uuid, target))) return { ok: false, output: `No such file or folder: ${target}`, summary: `Couldn't find ${target}` };
  const python = await botPython(ctx);
  const uid = sandboxUid(ctx.project.id);
  // Kept per bot: the second check (after a fix) only re-reads what changed — seconds instead of a cold start.
  const cache = path.join(VENVS_DIR, uuid, ".mypy_cache");
  mkdirSync(cache, { recursive: true });
  grantDir(cache, uid);
  grantDir(dir, uid);
  const r = await h.runCapture(uid, MYPY(), ["--python-executable", python, "--ignore-missing-imports", "--check-untyped-defs", "--no-color-output", "--no-error-summary",
    "--show-error-codes", "--hide-error-context", "--follow-imports", "silent", "--cache-dir", cache, "--exclude", "(^|/)(venv|\\.venv|data|node_modules)/", target],
  dir, { PATH: process.env.PATH, HOME: cache, MYPY_FORCE_COLOR: "0" }, 120_000);
  if (r.code === -1 || /command not found|No such file or directory: 'mypy'|ENOENT/.test(r.out)) return { ok: false, output: "mypy isn't installed here, so types can't be checked (check_code still works).", summary: "Type check unavailable" };
  const { bugs, hints } = readMypy(r.out);
  const total = [...bugs.values()].reduce((a, l) => a + l.length, 0);
  const hintNote = hints ? `\n(${hints} type-hint note${hints === 1 ? "" : "s"} too — missing or loose annotations, not bugs; leave them unless the owner wants full typing.)` : "";
  if (!total) {
    if (r.code !== 0 && !hints && !/^\s*$/.test(r.out)) return { ok: false, output: clip(`mypy couldn't check it:\n${r.out}`), summary: "Type check failed to run" };
    return { ok: true, output: `No likely bugs found by the type checker.${hintNote}`, summary: "Type check: no likely bugs" };
  }
  const groups = [...bugs.entries()].sort((a, b) => b[1].length - a[1].length).map(([code, list]) =>
    `${code} ×${list.length}${MEANS[code] ? ` — ${MEANS[code]}` : ""}:\n${list.slice(0, 10).map((l) => `- ${l}`).join("\n")}${list.length > 10 ? `\n… ${list.length - 10} more` : ""}`);
  return {
    ok: false,
    output: clip(`${total} likely bug${total === 1 ? "" : "s"} (or a wrong type hint):\n\n${groups.join("\n\n")}${hintNote}`, 9000),
    summary: `Type check: ${total} likely bug${total === 1 ? "" : "s"}`,
  };
}

// ── optimize_query ───────────────────────────────────────────────────────────

const DB_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
let db;
const isRead = (q) => /^\\s*(select|with)\\b/i.test(q) && !/\\b(insert|update|delete|replace)\\b/i.test(q.replace(/'(?:[^']|'')*'/g, ""));
// Unbound parameters are NULL: a scan still reads every row, an index finds nothing at once — the worst case for a scan.
const timeIt = (q) => { try { const st = db.prepare(q); st.all(); const t0 = performance.now(); let n = 0; while (n < 300 && performance.now() - t0 < 150) { st.all(); n++; } return (performance.now() - t0) / n; } catch { return null; } };
const plans = () => workerData.queries.map((q) => { try { return { q, plan: db.prepare("EXPLAIN QUERY PLAN " + q).all().map((r) => String(r.detail)), ms: workerData.time && isRead(q) ? timeIt(q) : null }; } catch (err) { return { q, error: String(err && err.message || err) }; } });
const one = (sql) => { try { const r = db.prepare(sql).get(); return r ? Object.values(r)[0] : null; } catch { return null; } };
try {
  const writes = workerData.ddl.length > 0 || workerData.tune;
  db = new DatabaseSync(workerData.file, { readOnly: !writes });
  db.exec("PRAGMA busy_timeout = 3000;");
  const before = workerData.skipBefore ? [] : plans();
  const did = [];
  let after = null;
  if (writes) {
    if (workerData.backup) db.exec("VACUUM INTO '" + workerData.backup.replace(/'/g, "''") + "'");
    for (const d of workerData.ddl) db.exec(d);
    if (workerData.tune) {
      // Can't switch while another connection is busy: the rest still goes ahead.
      try { did.push("journal_mode=" + String(db.prepare("PRAGMA journal_mode = WAL").get().journal_mode)); } catch { did.push("journal_mode=busy"); }
      if (workerData.vacuum) { db.exec("VACUUM"); did.push("vacuum"); }
    }
    db.exec("ANALYZE");
    did.push("analyze");
    after = plans();
  }
  const tables = {}, columns = {};
  for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
    const q = '"' + String(t.name).replace(/"/g, '""') + '"';
    try { tables[t.name] = Number(db.prepare("SELECT count(*) AS n FROM " + q).get().n); } catch {}
    try { columns[t.name] = db.prepare("PRAGMA table_info(" + q + ")").all().map((c) => String(c.name)); } catch {}
  }
  const indexes = db.prepare("SELECT name, tbl_name AS t FROM sqlite_master WHERE type='index'").all().map((r) => ({ name: String(r.name), table: String(r.t) }));
  const health = { journal: String(one("PRAGMA journal_mode") ?? ""), pages: Number(one("PRAGMA page_count") ?? 0), free: Number(one("PRAGMA freelist_count") ?? 0),
    pageSize: Number(one("PRAGMA page_size") ?? 4096), analyzed: one("SELECT count(*) FROM sqlite_master WHERE name = 'sqlite_stat1'") === 1 };
  parentPort.postMessage({ before, after, tables, columns, indexes, health, did });
} catch (err) {
  parentPort.postMessage({ error: String(err && err.message || err) });
} finally { try { db && db.close(); } catch {} }`;

interface QueryPlan { q: string; plan?: string[]; ms?: number | null; error?: string }
interface Health { journal: string; pages: number; free: number; pageSize: number; analyzed: boolean }
interface DbResult {
  before?: QueryPlan[]; after?: QueryPlan[] | null; tables?: Record<string, number>; columns?: Record<string, string[]>;
  indexes?: { name: string; table: string }[]; health?: Health; did?: string[]; error?: string;
}

function inWorker(data: { file: string; queries: string[]; ddl?: string[]; backup?: string; tune?: boolean; vacuum?: boolean; time?: boolean; skipBefore?: boolean }): Promise<DbResult | "timeout"> {
  return new Promise((resolve, reject) => {
    const w = new Worker(DB_WORKER, { eval: true, workerData: { ddl: [], backup: "", tune: false, vacuum: false, time: false, skipBefore: false, ...data }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const timer = setTimeout(() => { void w.terminate(); resolve("timeout"); }, 60_000);
    w.once("message", (m: DbResult) => { clearTimeout(timer); void w.terminate(); resolve(m); });
    w.once("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

/** The tables a query plan reads row by row (a full scan; "SCAN t USING INDEX" is not one). */
export function fullScans(plan: string[]): string[] {
  return plan.map((p) => /^SCAN (\w+)(?:\s+AS \w+)?\s*$/.exec(p.trim())?.[1]).filter((t): t is string => !!t);
}

/** SQL statements written in Python code (string literals that start like a query and use a table). */
export function queriesInCode(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:[rRbB]?f?)("""|'''|"|')((?:SELECT|UPDATE|DELETE)\b[\s\S]*?)\1/gi)) {
    const q = m[2]!.replace(/\{[^}]*\}/g, "?").replace(/\s+/g, " ").trim();
    if (/\b(FROM|UPDATE)\s+\w+/i.test(q) && q.length < 1000) out.add(q);
  }
  return [...out];
}

/**
 * The columns a full scan should be indexed on, from the query: equality
 * columns first, then the ORDER BY columns (the index then gives the order, so
 * "ORDER BY … LIMIT 5" stops after 5 rows), then range columns.
 */
export function indexColumns(query: string, columns?: string[]): string[] {
  const where = /\bWHERE\b([\s\S]*?)(?:\bORDER\s+BY\b|\bGROUP\s+BY\b|\bLIMIT\b|$)/i.exec(query)?.[1] ?? "";
  const order = /\bORDER\s+BY\s+([\w\s,.]+?)(?:\bLIMIT\b|$)/i.exec(query)?.[1] ?? "";
  const eq = [...where.matchAll(/(?:\b\w+\.)?(\w+)\s*(?:=|\bIS\b|\bIN\b)/gi)].map((m) => m[1]!);
  const range = [...where.matchAll(/(?:\b\w+\.)?(\w+)\s*(?:<|>|<=|>=|\bBETWEEN\b|\bLIKE\b)/gi)].map((m) => m[1]!);
  const sort = order.split(",").map((c) => c.trim().split(/\s+/)[0]!.replace(/^\w+\./, "")).filter(Boolean);
  const kw = /^(and|or|not|null|is|in|like|between|select|where)$/i;
  return [...new Set([...eq, ...sort, ...range])].filter((c) => !kw.test(c) && !/^\d/.test(c) && (!columns || columns.includes(c))).slice(0, 3);
}

/** Rows from which reading a whole table on every query starts to cost real time. */
const SCAN_MATTERS = 500;
const ms = (x: number) => (x >= 1 ? `${x.toFixed(2)} ms` : `${(x * 1000).toFixed(1)} µs`);

/** What the health numbers mean, as advice ("" when healthy). */
export function healthNotes(h: Health): string[] {
  const out: string[] = [];
  if (h.journal && h.journal.toLowerCase() !== "wal") out.push(`journal mode is ${h.journal}: WAL lets the bot read while it writes and makes writes faster (fewer "database is locked" errors) — tune=true`);
  if (!h.analyzed) out.push("the planner has no statistics yet (ANALYZE) — tune=true or create_index=true adds them");
  const wasted = h.pages ? h.free / h.pages : 0;
  if (wasted > 0.25 && h.pages * h.pageSize > 1048576) out.push(`${Math.round(wasted * 100)}% of the file is empty space (${((h.free * h.pageSize) / 1048576).toFixed(1)} MB) — tune=true with the bot stopped shrinks it (VACUUM)`);
  return out;
}

async function optimizeQuery(ctx: ToolContext, args: Args): Promise<ToolResult> {
  const uuid = ctx.project.uuid;
  const dbs = listDatabases(uuid);
  if (!dbs.length) return { ok: false, output: "The bot has no SQLite database, so there's no query to optimize.", summary: "No database" };
  const change = args.create_index === true || args.tune === true;
  // A bot on an outside host uses the database there; the copy here only shows the plans.
  const host = typeof ctx.supervisor.hostNote === "function" ? ctx.supervisor.hostNote(uuid) : null;
  if (change && host) {
    return { ok: false, output: `This bot runs on an outside host (${host}), so its live database is there, not here: an index or tuning made here wouldn't reach it. Put the indexes in the bot's own startup code instead (db.execute("CREATE INDEX IF NOT EXISTS …") once after connecting), and PRAGMA journal_mode=WAL there too.`, summary: "Database is on the outside host" };
  }

  let queries: string[];
  if (s(args.sql).trim()) {
    const q = s(args.sql).trim().replace(/;\s*$/, "");
    const bare = q.replace(/'(?:[^']|'')*'/g, "");
    if (!/^(select|update|delete|with)\b/i.test(q) || bare.includes(";") || /\b(attach|pragma|drop|alter|create|insert|vacuum)\b/i.test(bare)) {
      return { ok: false, output: "Give one SELECT, UPDATE or DELETE.", summary: "Query refused" };
    }
    queries = [q];
  } else {
    const dir = projectDir(uuid);
    queries = listFiles(uuid).filter((f) => !f.isDir && f.path.endsWith(".py") && !isPersistentData(f.path) && f.size <= MAX_EDIT_BYTES && !/(^|\/)(venv|\.venv)\//.test(f.path))
      .flatMap((f) => { try { return queriesInCode(readFileSync(path.join(dir, f.path), "utf8")); } catch { return []; } }).slice(0, 40);
  }

  // Each query goes to the database that has its tables.
  const chosen = s(args.db) ? [s(args.db)] : dbs;
  const byDb = new Map<string, string[]>(chosen.map((d) => [d, []]));
  if (chosen.length === 1) byDb.set(chosen[0]!, queries);
  else {
    const probes = await Promise.all(chosen.map(async (d) => [d, await inWorker({ file: databaseFile(uuid, d), queries })] as const));
    queries.forEach((q, i) => {
      const home = probes.find(([, r]) => r !== "timeout" && !r.error && !r.before?.[i]?.error)?.[0] ?? chosen[0]!;
      byDb.get(home)!.push(q);
    });
  }

  const parts: string[] = [];
  let slowCount = 0, total = 0, created = 0, elsewhere = 0;
  const startup: string[] = [];
  for (const [dbPath, qs] of byDb) {
    if (!qs.length && chosen.length > 1 && !change) continue;
    const file = databaseFile(uuid, dbPath);
    const first = await inWorker({ file, queries: qs, time: true });
    if (first === "timeout") { parts.push(`${dbPath}: no answer within 60s (busy?) — try again.`); continue; }
    if (first.error) { parts.push(`${dbPath}: SQLite error: ${first.error}`); continue; }
    const cols = new Map(Object.entries(first.columns ?? {}));
    const suggestions = new Map<string, string>();
    const lines: string[] = [];
    for (const r of first.before ?? []) {
      // A query from the code that belongs to another of the bot's databases (db= picked this one).
      if (r.error && /no such table/i.test(r.error) && !s(args.sql) && dbs.length > 1) { elsewhere++; continue; }
      total++;
      if (r.error) { lines.push(`✗ ${r.q.slice(0, 160)}\n   can't plan it: ${r.error}`); continue; }
      const scans = fullScans(r.plan ?? []);
      const rows = Math.max(0, ...scans.map((t) => first.tables?.[t] ?? 0));
      // Small tables are read in no time today; the index is still suggested because they grow.
      const big = rows >= SCAN_MATTERS;
      if (scans.length && big) slowCount++;
      const time = typeof r.ms === "number" ? ` · ${ms(r.ms)} per run` : "";
      const verdict = !scans.length ? "fast: uses an index"
        : big ? `SLOW: reads every row of ${scans.map((t) => `${t} (${first.tables?.[t] ?? "?"} rows)`).join(", ")}`
        : `reads every row of ${scans.join(", ")} — fine at ${rows} row${rows === 1 ? "" : "s"}, slow once it grows: index suggested`;
      lines.push(`${!scans.length ? "✓" : big ? "⚠" : "·"} ${r.q.slice(0, 160)}\n   plan: ${(r.plan ?? []).join(" | ")}\n   ${verdict}${time}`);
      for (const t of scans) {
        const c = indexColumns(r.q, cols.get(t));
        if (!c.length) continue;
        const name = `idx_${t}_${c.join("_")}`.slice(0, 60);
        if ((first.indexes ?? []).some((i) => i.name === name)) continue;
        suggestions.set(name, `CREATE INDEX IF NOT EXISTS "${name}" ON "${t}" (${c.map((x) => `"${x}"`).join(", ")})`);
      }
    }
    const sugg = [...suggestions.values()];
    const health = first.health ? healthNotes(first.health) : [];
    let section = `${dbPath} (${Object.entries(first.tables ?? {}).map(([t, n]) => `${t} ${n} rows`).join(", ") || "no tables"}):\n${lines.join("\n") || "(no queries for this database)"}`;
    const ddl = args.create_index === true ? sugg : [];
    if (ddl.length || args.tune === true) {
      const dir = path.join(PROJECTS_DIR, ".data-backups", uuid);
      mkdirSync(dir, { recursive: true });
      const backup = path.join(dir, `${dbPath.replace(/[/\\]/g, "__")}.${Date.now()}.bak`);
      const vacuum = args.tune === true && !ctx.supervisor.isRunning(uuid) && !!first.health && first.health.pages > 0 && first.health.free / first.health.pages > 0.25;
      const done = await inWorker({ file, queries: qs, ddl, backup, tune: args.tune === true, vacuum, time: true, skipBefore: true });
      if (done === "timeout" || done.error) {
        rmSync(backup, { force: true });
        parts.push(`${section}\nChanging it failed: ${done === "timeout" ? "timed out (the database is busy; stop the bot and try again)" : done.error}. Nothing was changed.`);
        continue;
      }
      created += ddl.length;
      startup.push(...ddl);
      const speed = (done.after ?? []).map((a, i) => {
        const b = first.before?.[i];
        if (typeof b?.ms !== "number" || typeof a.ms !== "number" || !fullScans(b.plan ?? []).length) return "";
        return `- ${a.q.slice(0, 90)}: ${ms(b.ms)} → ${ms(a.ms)}${a.ms > 0 ? ` (${(b.ms / a.ms).toFixed(0)}× faster)` : ""}${fullScans(a.plan ?? []).length ? " — still scans" : ""}`;
      }).filter(Boolean);
      const did = (done.did ?? []).map((d) => (d === "journal_mode=busy" ? "journal mode NOT changed (the bot was using the database; stop it and tune again)"
        : d.startsWith("journal_mode=") ? `journal mode ${d.slice(13).toUpperCase()}` : d === "analyze" ? "planner statistics updated (ANALYZE)" : "empty space removed (VACUUM)"));
      section += `\n${ddl.length ? `Created ${ddl.length} index${ddl.length === 1 ? "" : "es"}: ${ddl.map((d) => d.replace(/^CREATE INDEX IF NOT EXISTS /, "")).join("; ")}.\n` : ""}Done (after a backup; modify_data restore=true undoes it): ${did.join(", ")}.${speed.length ? `\nTime per run, before → after (worst case: no matching rows):\n${speed.join("\n")}` : ""}`;
      const healthAfter = done.health ? healthNotes(done.health) : [];
      if (healthAfter.length) section += `\nStill: ${healthAfter.join("; ")}.`;
    } else {
      if (sugg.length) section += `\nIndexes that would fix the slow ones (create_index=true adds them):\n${sugg.join(";\n")};`;
      if (health.length) section += `\nHealth: ${health.join("; ")}.`;
    }
    parts.push(section);
  }
  if (!total && !change) {
    return { ok: true, output: `No SQL queries found in the code (give one with sql).\n\n${parts.join("\n\n")}`.trim(), summary: "No queries in the code" };
  }
  const tail = startup.length ? `\n\nAlso put these in the bot's startup code (once after connecting) so a new or re-created database gets them too:\n${startup.map((d) => `db.execute('${d.replace(/'/g, "\\'")}')`).join("\n")}` : "";
  const note = elsewhere ? `\n(${elsewhere} quer${elsewhere === 1 ? "y" : "ies"} in the code use${elsewhere === 1 ? "s" : ""} another of the bot's databases: run without db= to see them.)` : "";
  return {
    ok: true,
    output: clip(`${parts.join("\n\n")}${tail}${note}`, 9000),
    summary: change ? `Database: ${created} index${created === 1 ? "" : "es"} added${args.tune === true ? ", tuned" : ""}` : `Query plans: ${slowCount} of ${total} scan every row`,
  };
}

// ── bot_resources ────────────────────────────────────────────────────────────

/** A process and its children, from /proc: pids. */
function processTree(root: number): number[] {
  const parent = new Map<number, number>();
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try { const st = readFileSync(`/proc/${d}/stat`, "utf8"); parent.set(Number(d), Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[1])); } catch { /* gone */ }
  }
  const out = [root];
  for (let i = 0; i < out.length; i++) for (const [pid, pp] of parent) if (pp === out[i] && !out.includes(pid)) out.push(pid);
  return out;
}

function cpuTicks(pids: number[]): number {
  let t = 0;
  for (const pid of pids) {
    try { const st = readFileSync(`/proc/${pid}/stat`, "utf8"); const f = st.slice(st.lastIndexOf(")") + 2).split(" "); t += Number(f[11]) + Number(f[12]); } catch { /* gone */ }
  }
  return t;
}

export function procStatus(pid: number): { rss: number; threads: number; name: string } {
  const st = readFileSync(`/proc/${pid}/status`, "utf8");
  const get = (k: string) => new RegExp(`^${k}:\\s+(\\S+)`, "m").exec(st)?.[1] ?? "0";
  return { rss: Number(get("VmRSS")) * 1024, threads: Number(get("Threads")), name: get("Name") };
}

const rssOf = (pids: number[]) => pids.reduce((a, p) => { try { return a + procStatus(p).rss; } catch { return a; } }, 0);

/** Each bot's last measurement, to tell memory growth (a leak) from one check to the next. */
const lastCheck = new Map<string, { at: number; rss: number; pid: number }>();

/** What memory did since the last check, in words ("" when there's nothing to compare). */
export function memoryTrend(prev: { at: number; rss: number; pid: number } | undefined, now: { at: number; rss: number; pid: number }): string {
  if (!prev) return "";
  if (prev.pid !== now.pid) return "The bot restarted since the last check, so memory can't be compared yet; check again in a few minutes.";
  const mins = (now.at - prev.at) / 60_000;
  const mb = (now.rss - prev.rss) / 1048576;
  const ago = mins >= 1 ? `${mins.toFixed(1)} min` : `${Math.round(mins * 60)}s`;
  const change = `${mb >= 0 ? "+" : ""}${mb.toFixed(1)} MB since the last check ${ago} ago`;
  if (mins < 2) return `Memory: ${change} (check again in a few minutes to see a trend).`;
  const rate = mb / mins;
  if (mb > 5 && rate > 0.5) return `Memory: ${change} (${rate.toFixed(1)} MB/min) — GROWING. If it keeps growing, something keeps data it never drops: a list or dict that only gets bigger (chat history, a cache without a limit, tasks never awaited). profile_code shows what holds memory.`;
  return `Memory: ${change} — steady.`;
}

async function botResources(ctx: ToolContext, args: Args): Promise<ToolResult> {
  const uuid = ctx.project.uuid;
  const pid = ctx.supervisor.pidOf?.(uuid);
  if (!pid || !existsSync(`/proc/${pid}`)) {
    return { ok: false, output: ctx.supervisor.isRunning(uuid) ? "The bot runs on an outside host, so its CPU and memory can't be read from here." : "The bot isn't running. Start it (bot_control start), then measure.", summary: "Bot not running here" };
  }
  const seconds = Math.min(Math.max(Math.trunc(Number(args.seconds)) || 5, 3), 30);
  const pids = processTree(pid);
  const hz = 100;
  const cpu: number[] = [];
  const startRss = rssOf(pids);
  let ticks = cpuTicks(pids), t = Date.now();
  for (let i = 0; i < seconds; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const nt = cpuTicks(pids), now = Date.now();
    cpu.push(((nt - ticks) / hz) / ((now - t) / 1000) * 100);
    ticks = nt; t = now;
  }
  let rss = 0, threads = 0, files = 0, sockets = 0, unreadable = false;
  const names: string[] = [];
  for (const p of pids) {
    try { const st = procStatus(p); rss += st.rss; threads += st.threads; names.push(st.name); } catch { continue; }
    try { for (const fd of readdirSync(`/proc/${p}/fd`)) { files++; try { if (readlinkSync(`/proc/${p}/fd/${fd}`).startsWith("socket:")) sockets++; } catch { /* closed */ } } } catch { unreadable = true; }
  }
  const avg = cpu.reduce((a, x) => a + x, 0) / cpu.length, peak = Math.max(...cpu);
  const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;
  const now = { at: Date.now(), rss, pid };
  const trend = memoryTrend(lastCheck.get(uuid), now);
  lastCheck.set(uuid, now);
  const notes = [
    avg > 50 ? "CPU is high: something loops without waiting, or does heavy work on every message — profile_code the busiest handler." : peak > 80 ? "CPU spikes: one command or timer does heavy work at once — profile_code it." : "",
    rss > 400 * 1048576 ? "Memory is high for a bot: look for data kept forever (check again later to see if it grows)." : "",
    files > 200 ? "Many open files/connections: something opens files or sessions without closing them (use `with`, reuse one aiohttp session)." : "",
  ].filter(Boolean);
  return {
    ok: true,
    output: [
      `${names.join(" + ")} (${pids.length} process${pids.length === 1 ? "" : "es"}), over ${seconds}s: CPU ${avg.toFixed(1)}% of one core on average (peak ${peak.toFixed(1)}%), memory ${mb(rss)} (${mb(startRss)} at the start), ${threads} threads, ${unreadable ? "open files not readable here" : `${files} open files (${sockets} network connections)`}.`,
      ...(trend ? [trend] : []),
      notes.length ? notes.join("\n") : "All normal for a bot.",
    ].join("\n"),
    summary: `Bot uses ${avg.toFixed(0)}% CPU, ${mb(rss)}${/GROWING/.test(trend) ? " — memory growing" : ""}`,
  };
}

// ── profile_code / benchmark ─────────────────────────────────────────────────

async function profileCode(ctx: ToolContext, args: Args, h: CodeToolHelpers): Promise<ToolResult> {
  const code = s(args.code);
  const repeat = Math.min(Math.max(Math.trunc(Number(args.repeat)) || 1, 1), 10_000);
  let spec: Record<string, unknown>;
  if (code.trim()) {
    if (code.length > 20_000) return { ok: false, output: "The snippet is over 20,000 characters.", summary: "Snippet too big" };
    spec = { code, repeat };
  } else {
    const mod = s(args.module).trim(), func = s(args.function).trim();
    if (!PY_TARGET.test(mod) || !/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)?$/.test(func)) return { ok: false, output: "Give module + function (e.g. shop, top_players) or a code snippet.", summary: "Nothing to profile" };
    spec = { module: mod, function: func, args: Array.isArray(args.args) ? args.args : [], kwargs: args.kwargs && typeof args.kwargs === "object" ? args.kwargs : {}, repeat };
  }
  const r = await perf(ctx, h, "profile", spec, 120);
  const timedOut = r.code === 124 || r.code === 137;
  const blocked = /BLOCKED THE EVENT LOOP (\d+)/.exec(r.out)?.[1];
  const total = /: ([\d.]+ (?:s|ms|µs)) in total/.exec(r.out)?.[1];
  const hot = /Hottest lines[^\n]*\n\s*([\d.]+%)\s+(\S+)/.exec(r.out);
  return {
    ok: r.code === 0 && !/^FAILED/m.test(r.out),
    output: clip(timedOut ? `Stopped after 120s (it may never finish).\n${untrusted(r.out)}` : untrusted(r.out), 9000),
    summary: timedOut ? "Profiling timed out" : `Profiled: ${total ?? "?"}${hot ? `, hottest ${hot[2]} (${hot[1]})` : ""}${blocked ? `, blocked the event loop ${blocked}×` : ""}`,
  };
}

async function benchmark(ctx: ToolContext, args: Args, h: CodeToolHelpers): Promise<ToolResult> {
  const code = s(args.code), baseline = s(args.baseline), setup = s(args.setup);
  if (!code.trim()) return { ok: false, output: "Give the code to time.", summary: "Nothing to time" };
  if (code.length + baseline.length + setup.length > 30_000) return { ok: false, output: "The code is over 30,000 characters.", summary: "Code too big" };
  const seconds = Math.min(Math.max(Number(args.seconds) || 2, 0.5), 8);
  const sizes = (Array.isArray(args.sizes) ? args.sizes : []).map((x) => Math.trunc(Number(x))).filter((x) => x > 0 && x <= 10_000_000).slice(0, 6);
  if (sizes.length === 1) return { ok: false, output: "Give at least two sizes, e.g. [1000, 2000, 4000], to see how the time grows.", summary: "Need more sizes" };
  const r = await perf(ctx, h, "benchmark", { code, ...(baseline ? { baseline } : {}), ...(setup ? { setup } : {}), seconds, ...(sizes.length ? { sizes } : {}) }, Math.ceil(seconds * (sizes.length ? 10 : 6) + 30));
  const result = /^RESULT: (.*)$/m.exec(r.out)?.[1];
  const perRun = /^(?:new: +)?([\d.]+ (?:s|ms|µs)) per run/m.exec(r.out)?.[1];
  const growsNew = /^new: [^\n]*\n {2}→ grows like n\^([\d.]+)/m.exec(r.out)?.[1];
  const differs = /Same `result` from both: NO/.test(r.out);
  const failed = r.code !== 0 || /^FAILED/m.test(r.out);
  return {
    ok: !failed && !differs,
    output: clip(`${r.out.trim()}${differs ? "\nThe two versions give different results: the new one changes behaviour — fix it before using it." : ""}`),
    summary: failed ? "Benchmark failed"
      : growsNew ? `Benchmark: grows like n^${growsNew}${result ? `; ${result.replace(/^at n=\d+ /, "")}` : ""}`
      : result ? `Benchmark: ${result.replace(/^the new version is /, "")}${differs ? " (but results differ!)" : ""}` : `Benchmark: ${perRun ?? "?"} per run`,
  };
}

export async function runPerfTool(name: string, args: Args, ctx: ToolContext, h: CodeToolHelpers): Promise<ToolResult | null> {
  switch (name) {
    case "profile_code": return profileCode(ctx, args, h);
    case "benchmark": return benchmark(ctx, args, h);
    case "code_metrics": return codeMetrics(ctx, args, h);
    case "type_check": return typeCheck(ctx, args, h);
    case "optimize_query": return optimizeQuery(ctx, args);
    case "bot_resources": return botResources(ctx, args);
    default: return null;
  }
}
