/**
 * Kojy round 6: making code faster and better, and proving it.
 *
 * - profile_code: where a function's (or snippet's) time and memory go, the
 *   bot's own code marked, plus every moment async code blocked the event
 *   loop (the bot can't answer anyone then) — asyncio's debug mode.
 * - benchmark: time per run of new code against the old version, the
 *   speedup, and whether both give the same `result` — so a speed-up is
 *   measured and known not to change behaviour.
 * - code_metrics: per function complexity, length, nesting and argument
 *   count (worst first), duplicated code, and code nothing uses.
 * - type_check: mypy against the bot's own packages — wrong attributes,
 *   wrong argument types, None where a value is needed — before it runs.
 * - optimize_query: SQLite's query plan for one query, or for every query
 *   in the code; full table scans get the index that fixes them (created
 *   with create_index=true, after a backup).
 * - bot_resources: the running bot's CPU, memory, threads and open files.
 * OWNERSHIP: apps/runner/src/agent
 */

import { Worker } from "node:worker_threads";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PROJECTS_DIR, cleanRelPath, databaseFile, listDatabases, listFiles, projectDir, resolveInside, isPersistentData, MAX_EDIT_BYTES,
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
  fn("profile_code", "Find what makes code slow: runs one function (module+function+args) or a snippet (code) under a profiler and shows where the time and memory go (the bot's own code marked *), and for async code every time it blocked the event loop. Profile before optimizing; benchmark after.",
    { module: str("e.g. shop"), function: str("e.g. top_players or Class.method"), args: { type: "array", items: {} }, kwargs: { type: "object" }, code: str("or a snippet instead, e.g. import shop\\nshop.top_players(load())") }),
  fn("benchmark", "Measure a speed-up: times `code` (and `baseline`, the old version) many times and shows the time per run of each, how many times faster, and whether both set the same `result` variable. setup runs once first (imports, test data). Use it to prove an optimization works and changes nothing.",
    { code: str("the new code, e.g. result = top_fast(data)"), baseline: str("the old code, e.g. result = top_slow(data)"), setup: str("e.g. from shop import top_fast, top_slow\\ndata = make_data(5000)"), seconds: { type: "number", description: "time per version, 0.5-8 (default 2)" } }, ["code"]),
  fn("code_metrics", "Code quality numbers: each function's complexity, length, nesting depth and argument count (worst first, with what's too much), duplicated code, and functions/classes nothing uses. Use it to find what to simplify or remove.",
    { path: str("optional file or folder") }),
  fn("type_check", "Type-check the bot's Python code with mypy against its own installed packages: wrong attribute or method names, wrong argument types or counts, None used where a value is needed, wrong return types — bugs found before the code runs.",
    { path: str("optional file or folder") }),
  fn("optimize_query", "Make the bot's database fast: shows SQLite's plan for a query (sql), or for every SQL query found in the code (no sql), flags full table scans and says which index fixes each. create_index=true creates the suggested indexes (after a backup).",
    { sql: str("one SELECT/UPDATE/DELETE, optional"), db: str("database path if several"), create_index: { type: "boolean" } }),
  fn("bot_resources", "How hard the running bot works the server: CPU use (measured over a few seconds), memory, threads, open files and connections, and how long it has run. Use it when the bot or the server is slow or a memory leak is suspected (call it twice, minutes apart, to see memory grow)."),
];

export const PERF_TOOL_NAMES = new Set(PERF_TOOL_SPECS.map((t) => t.function.name));

const PY_TARGET = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*){0,6}$/;

async function botPython(ctx: ToolContext): Promise<string> {
  const venvPython = path.join(VENVS_DIR, ctx.project.uuid, "bin", "python");
  return existsSync(venvPython) ? venvPython : ctx.supervisor.ensureVenv(ctx.project.uuid, projectDir(ctx.project.uuid), ctx.project.id);
}

/** perftools.py in the bot's environment, in a copy of the project (profiling and timing can't change the real files), without secrets. */
async function perf(ctx: ToolContext, h: CodeToolHelpers, mode: "profile" | "benchmark", spec: Record<string, unknown>, timeoutS: number): Promise<{ code: number | null; out: string }> {
  const dir = projectDir(ctx.project.uuid);
  const python = await botPython(ctx);
  const uid = sandboxUid(ctx.project.id);
  const work = mkdtempSync(path.join(tmpdir(), "kojy-perf-"));
  try {
    cpSync(dir, work, { recursive: true, filter: (src) => !/[/\\](\.git|node_modules|__pycache__|venv|\.venv)$/.test(src) });
    grantDir(work, uid);
    return await h.runCapture(uid, "timeout", ["-k", "5", String(timeoutS), python, PERFTOOLS, mode, JSON.stringify(spec)], work,
      { PATH: process.env.PATH, HOME: work, PYTHONPATH: work, PYTHONDONTWRITEBYTECODE: "1", TERM: "dumb" }, (timeoutS + 10) * 1000);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ── code_metrics ─────────────────────────────────────────────────────────────

interface Fn { file: string; line: number; name: string; complexity: number; length: number; nesting: number; params: number; async: boolean }
interface Metrics { files: number; lines: number; functions: Fn[]; unused: string[]; duplicates: string[][]; same_functions: string[][] }

/** What's too much for one function, in words ("" when fine). */
export function tooMuch(f: Fn): string {
  const out: string[] = [];
  if (f.complexity > 10) out.push(`complexity ${f.complexity} (over 10: hard to test, split it)`);
  if (f.length > 60) out.push(`${f.length} lines long`);
  if (f.nesting > 4) out.push(`nested ${f.nesting} deep (return early instead)`);
  if (f.params > 6) out.push(`${f.params} arguments`);
  return out.join(", ");
}

/** A 0-100 score for a project's metrics, for before/after comparisons. */
export function qualityScore(m: Pick<Metrics, "functions" | "unused" | "duplicates" | "same_functions">): number {
  if (!m.functions.length) return 100;
  const bad = m.functions.filter((f) => tooMuch(f)).length / m.functions.length;
  const avg = m.functions.reduce((a, f) => a + f.complexity, 0) / m.functions.length;
  const penalty = bad * 40 + Math.max(0, avg - 3) * 4 + Math.min(m.unused.length, 10) * 1.5 + Math.min(m.duplicates.length + m.same_functions.length, 10) * 2;
  return Math.max(0, Math.round(100 - penalty));
}

async function codeMetrics(ctx: ToolContext, args: Args, h: CodeToolHelpers): Promise<ToolResult> {
  const uuid = ctx.project.uuid;
  const dir = projectDir(uuid);
  const target = s(args.path) ? cleanRelPath(s(args.path)) : ".";
  if (target !== "." && !existsSync(resolveInside(uuid, target))) return { ok: false, output: `No such file or folder: ${target}`, summary: `Couldn't find ${target}` };
  const uid = sandboxUid(ctx.project.id);
  grantDir(dir, uid);
  const r = await h.runCapture(uid, process.env.PYTHON_BIN ?? "python3", ["-I", CODEINTEL, "metrics", target], dir, { PATH: process.env.PATH, HOME: dir, PYTHONDONTWRITEBYTECODE: "1" }, 60_000);
  let m: Metrics;
  try { m = JSON.parse(r.out.trim().split("\n").pop() ?? "") as Metrics; } catch { return { ok: false, output: clip(`The metrics failed:\n${r.out}`), summary: "Metrics failed" }; }
  if (!m.functions.length) return { ok: true, output: "No Python functions to measure.", summary: "No functions" };
  const worst = [...m.functions].sort((a, b) => b.complexity - a.complexity || b.length - a.length);
  const flagged = worst.filter((f) => tooMuch(f));
  const avg = m.functions.reduce((a, f) => a + f.complexity, 0) / m.functions.length;
  const score = qualityScore(m);
  const lines = [
    `${m.files} files, ${m.lines} lines, ${m.functions.length} functions. Average complexity ${avg.toFixed(1)}. Quality score ${score}/100.`,
    flagged.length ? `\nToo much (${flagged.length}):\n${flagged.slice(0, 15).map((f) => `- ${f.file}:${f.line} ${f.name}: ${tooMuch(f)}`).join("\n")}` : "\nNo function is too complex, long or deeply nested.",
    `\nMost complex:\n${worst.slice(0, 8).map((f) => `- ${f.file}:${f.line} ${f.name}: complexity ${f.complexity}, ${f.length} lines, nesting ${f.nesting}, ${f.params} args`).join("\n")}`,
    m.same_functions.length ? `\nFunctions with the same body (keep one):\n${m.same_functions.map((d) => `- ${d.join(" = ")}`).join("\n")}` : "",
    m.duplicates.length ? `\nDuplicated code (6+ lines the same; make it one function):\n${m.duplicates.map((d) => `- ${d.join(", ")}`).join("\n")}` : "",
    m.unused.length ? `\nProbably unused (defined, never referenced by name; check with find_symbol before removing — dynamic use is possible):\n${m.unused.map((u) => `- ${u}`).join("\n")}` : "",
  ];
  return { ok: true, output: clip(lines.filter(Boolean).join("\n"), 9000), summary: `Code metrics: score ${score}/100, ${flagged.length} function${flagged.length === 1 ? "" : "s"} to simplify` };
}

// ── type_check ───────────────────────────────────────────────────────────────

const MYPY = () => process.env.KOJY_MYPY ?? "mypy";

async function typeCheck(ctx: ToolContext, args: Args, h: CodeToolHelpers): Promise<ToolResult> {
  const uuid = ctx.project.uuid;
  const dir = projectDir(uuid);
  const target = s(args.path) ? cleanRelPath(s(args.path)) : ".";
  if (target !== "." && !existsSync(resolveInside(uuid, target))) return { ok: false, output: `No such file or folder: ${target}`, summary: `Couldn't find ${target}` };
  const python = await botPython(ctx);
  const uid = sandboxUid(ctx.project.id);
  const cache = mkdtempSync(path.join(tmpdir(), "kojy-mypy-"));
  try {
    grantDir(cache, uid);
    grantDir(dir, uid);
    const r = await h.runCapture(uid, MYPY(), ["--python-executable", python, "--ignore-missing-imports", "--check-untyped-defs", "--no-color-output", "--no-error-summary",
      "--show-error-codes", "--hide-error-context", "--follow-imports", "silent", "--cache-dir", cache, "--exclude", "(^|/)(venv|\\.venv|data|node_modules)/", target],
    dir, { PATH: process.env.PATH, HOME: cache, MYPY_FORCE_COLOR: "0" }, 120_000);
    if (r.code === -1 || /command not found|No such file or directory: 'mypy'|ENOENT/.test(r.out)) return { ok: false, output: "mypy isn't installed here, so types can't be checked (check_code still works).", summary: "Type check unavailable" };
    const errors = r.out.split("\n").filter((l) => /: error: /.test(l)).map((l) => `- ${l.replace(/^\.\//, "").trim()}`);
    const notes = r.out.split("\n").filter((l) => /: note: /.test(l) && !/See https|use --|unannotated/.test(l)).slice(0, 5);
    if (!errors.length) {
      return /Success|^\s*$/.test(r.out) || r.code === 0
        ? { ok: true, output: "No type errors found.", summary: "Type check: no errors" }
        : { ok: false, output: clip(`mypy couldn't check it:\n${r.out}`), summary: "Type check failed to run" };
    }
    return {
      ok: false,
      output: clip(`${errors.length} type error${errors.length === 1 ? "" : "s"} (each a likely bug, or a wrong type hint):\n${errors.slice(0, 40).join("\n")}${errors.length > 40 ? `\n… ${errors.length - 40} more` : ""}${notes.length ? `\n${notes.join("\n")}` : ""}`, 9000),
      summary: `Type check: ${errors.length} error${errors.length === 1 ? "" : "s"}`,
    };
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

// ── optimize_query ───────────────────────────────────────────────────────────

const PLAN_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
let db;
try {
  db = new DatabaseSync(workerData.file, { readOnly: !workerData.ddl.length });
  db.exec("PRAGMA busy_timeout = 2000;");
  if (workerData.backup) db.exec("VACUUM INTO '" + workerData.backup.replace(/'/g, "''") + "'");
  for (const d of workerData.ddl) db.exec(d);
  const out = [];
  for (const q of workerData.queries) {
    try {
      const plan = db.prepare("EXPLAIN QUERY PLAN " + q).all().map((r) => String(r.detail));
      out.push({ q, plan });
    } catch (err) { out.push({ q, error: String(err && err.message || err) }); }
  }
  const tables = {}, columns = {};
  for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
    const q = '"' + String(t.name).replace(/"/g, '""') + '"';
    try { tables[t.name] = Number(db.prepare("SELECT count(*) AS n FROM " + q).get().n); } catch {}
    try { columns[t.name] = db.prepare("PRAGMA table_info(" + q + ")").all().map((c) => String(c.name)); } catch {}
  }
  const indexes = db.prepare("SELECT name, tbl_name AS t, sql FROM sqlite_master WHERE type='index'").all().map((r) => ({ name: String(r.name), table: String(r.t), sql: r.sql ? String(r.sql) : "" }));
  parentPort.postMessage({ out, tables, columns, indexes });
} catch (err) {
  parentPort.postMessage({ error: String(err && err.message || err) });
} finally { try { db && db.close(); } catch {} }`;

interface PlanResult { out?: { q: string; plan?: string[]; error?: string }[]; tables?: Record<string, number>; columns?: Record<string, string[]>; indexes?: { name: string; table: string; sql: string }[]; error?: string }

function planInWorker(file: string, queries: string[], ddl: string[] = [], backup = ""): Promise<PlanResult | "timeout"> {
  return new Promise((resolve, reject) => {
    const w = new Worker(PLAN_WORKER, { eval: true, workerData: { file, queries, ddl, backup }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const timer = setTimeout(() => { void w.terminate(); resolve("timeout"); }, 20_000);
    w.once("message", (m: PlanResult) => { clearTimeout(timer); void w.terminate(); resolve(m); });
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

/** The columns a full scan of `table` should be indexed on, from the query's WHERE / ORDER BY (equality first). */
export function indexColumns(query: string, columns?: string[]): string[] {
  const where = /\bWHERE\b([\s\S]*?)(?:\bORDER\s+BY\b|\bGROUP\s+BY\b|\bLIMIT\b|$)/i.exec(query)?.[1] ?? "";
  const order = /\bORDER\s+BY\s+([\w\s,.]+?)(?:\bLIMIT\b|$)/i.exec(query)?.[1] ?? "";
  const eq = [...where.matchAll(/(?:\b\w+\.)?(\w+)\s*(?:=|\bIS\b|\bIN\b)/gi)].map((m) => m[1]!);
  const range = [...where.matchAll(/(?:\b\w+\.)?(\w+)\s*(?:<|>|<=|>=|\bBETWEEN\b|\bLIKE\b)/gi)].map((m) => m[1]!);
  const sort = order.split(",").map((c) => c.trim().split(/\s+/)[0]!.replace(/^\w+\./, "")).filter(Boolean);
  const kw = /^(and|or|not|null|is|in|like|between|select|where)$/i;
  const cols = [...new Set([...eq, ...range, ...sort])].filter((c) => !kw.test(c) && !/^\d/.test(c) && (!columns || columns.includes(c)));
  return cols.slice(0, 3);
}

async function optimizeQuery(ctx: ToolContext, args: Args): Promise<ToolResult> {
  const uuid = ctx.project.uuid;
  const dbs = listDatabases(uuid);
  const dbPath = s(args.db) || dbs[0];
  if (!dbPath) return { ok: false, output: "The bot has no SQLite database, so there's no query to optimize.", summary: "No database" };
  const file = databaseFile(uuid, dbPath);
  let queries: string[];
  if (s(args.sql).trim()) {
    const q = s(args.sql).trim().replace(/;\s*$/, "");
    if (!/^(select|update|delete|with)\b/i.test(q) || q.replace(/'(?:[^']|'')*'/g, "").includes(";") || /\b(attach|pragma|drop|alter|create|insert)\b/i.test(q.replace(/'(?:[^']|'')*'/g, ""))) {
      return { ok: false, output: "Give one SELECT, UPDATE or DELETE.", summary: "Query refused" };
    }
    queries = [q];
  } else {
    const dir = projectDir(uuid);
    queries = listFiles(uuid).filter((f) => !f.isDir && f.path.endsWith(".py") && !isPersistentData(f.path) && f.size <= MAX_EDIT_BYTES && !/(^|\/)(venv|\.venv)\//.test(f.path))
      .flatMap((f) => { try { return queriesInCode(readFileSync(path.join(dir, f.path), "utf8")); } catch { return []; } }).slice(0, 40);
    if (!queries.length) return { ok: true, output: "No SQL queries found in the code. Give one with sql.", summary: "No queries in the code" };
  }
  const first = await planInWorker(file, queries);
  if (first === "timeout") return { ok: false, output: "The database didn't answer within 20s (busy?). Try again.", summary: "Query plan timed out" };
  if (first.error) return { ok: false, output: `SQLite error: ${first.error}`, summary: "Query plan failed" };
  // Only real columns of the scanned table get an index.
  const colsOf = new Map(Object.entries(first.columns ?? {}));
  const suggestions = new Map<string, string>();
  const lines: string[] = [];
  for (const r of first.out ?? []) {
    if (r.error) { lines.push(`✗ ${r.q.slice(0, 160)}\n   can't plan it: ${r.error}`); continue; }
    const scans = fullScans(r.plan ?? []);
    const rows = scans.map((t) => first.tables?.[t] ?? 0);
    const verdict = scans.length ? `SLOW: reads every row of ${scans.map((t, i) => `${t} (${rows[i]} rows)`).join(", ")}` : "fast: uses an index";
    lines.push(`${scans.length ? "⚠" : "✓"} ${r.q.slice(0, 160)}\n   plan: ${(r.plan ?? []).join(" | ")}\n   ${verdict}`);
    for (const t of scans) {
      const cols = indexColumns(r.q, colsOf.get(t));
      if (!cols.length) continue;
      const name = `idx_${t}_${cols.join("_")}`.slice(0, 60);
      if ((first.indexes ?? []).some((i) => i.name === name)) continue;
      suggestions.set(name, `CREATE INDEX IF NOT EXISTS "${name}" ON "${t}" (${cols.map((c) => `"${c}"`).join(", ")})`);
    }
  }
  const sugg = [...suggestions.values()];
  if (args.create_index === true && sugg.length) {
    const dir = path.join(PROJECTS_DIR, ".data-backups", uuid);
    mkdirSync(dir, { recursive: true });
    const backup = path.join(dir, `${dbPath.replace(/[/\\]/g, "__")}.${Date.now()}.bak`);
    const after = await planInWorker(file, queries, sugg, backup);
    if (after === "timeout" || after.error) {
      rmSync(backup, { force: true });
      return { ok: false, output: `Creating the indexes failed: ${after === "timeout" ? "timed out (the database is busy; stop the bot and try again)" : after.error}. Nothing was changed.`, summary: "Index creation failed" };
    }
    const before = (first.out ?? []).filter((r) => fullScans(r.plan ?? []).length).length;
    const fixed = (after.out ?? []).filter((r, i) => fullScans(first.out?.[i]?.plan ?? []).length && !fullScans(r.plan ?? []).length).length;
    return {
      ok: true,
      output: `Created ${sugg.length} index${sugg.length === 1 ? "" : "es"} (backup first; modify_data restore=true undoes it):\n${sugg.join(";\n")};\n\nAfter: ${fixed} of the ${before} quer${before === 1 ? "y" : "ies"} that read every row now use an index.\n${(after.out ?? []).map((r) => `- ${r.q.slice(0, 120)}: ${(r.plan ?? []).join(" | ")}`).join("\n")}`,
      summary: `Created ${sugg.length} index${sugg.length === 1 ? "" : "es"}`,
    };
  }
  const slow = lines.filter((l) => l.startsWith("⚠")).length;
  return {
    ok: true,
    output: clip(`${lines.join("\n")}${sugg.length ? `\n\nIndexes that would fix the slow ones (create them with create_index=true):\n${sugg.join(";\n")};` : ""}\n\nTable sizes: ${Object.entries(first.tables ?? {}).map(([t, n]) => `${t} ${n}`).join(", ") || "(none)"}. A full scan only matters on tables that grow (hundreds of rows and up).`, 9000),
    summary: `Query plans: ${slow} of ${lines.length} scan every row${sugg.length ? `, ${sugg.length} index${sugg.length === 1 ? "" : "es"} suggested` : ""}`,
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

async function botResources(ctx: ToolContext): Promise<ToolResult> {
  const pid = ctx.supervisor.pidOf?.(ctx.project.uuid);
  if (!pid || !existsSync(`/proc/${pid}`)) {
    return { ok: false, output: ctx.supervisor.isRunning(ctx.project.uuid) ? "The bot runs on an outside host, so its CPU and memory can't be read from here." : "The bot isn't running. Start it (bot_control start), then measure.", summary: "Bot not running here" };
  }
  const pids = processTree(pid);
  const hz = 100;
  const t0 = cpuTicks(pids), w0 = Date.now();
  await new Promise((r) => setTimeout(r, 3000));
  const cpu = ((cpuTicks(pids) - t0) / hz) / ((Date.now() - w0) / 1000) * 100;
  let rss = 0, threads = 0, files = 0, sockets = 0;
  const names: string[] = [];
  for (const p of pids) {
    try { const st = procStatus(p); rss += st.rss; threads += st.threads; names.push(st.name); } catch { continue; }
    try { for (const fd of readdirSync(`/proc/${p}/fd`)) { files++; try { if (readlinkSync(`/proc/${p}/fd/${fd}`).startsWith("socket:")) sockets++; } catch { /* closed */ } } } catch { /* not readable */ }
  }
  const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;
  const notes = [
    cpu > 50 ? "CPU is high: something loops without waiting, or does heavy work on every message — profile_code the busiest handler." : "",
    rss > 400 * 1048576 ? "Memory is high: look for lists/dicts that only grow (caches, history) — call this again in a few minutes to see if it keeps growing." : "",
    files > 200 ? "Many open files/connections: something opens files or sessions without closing them (use `with`, reuse one aiohttp session)." : "",
  ].filter(Boolean);
  return {
    ok: true,
    output: `${names.join(" + ")} (${pids.length} process${pids.length === 1 ? "" : "es"}): CPU ${cpu.toFixed(1)}% of one core (over 3s), memory ${mb(rss)}, ${threads} threads, ${files} open files (${sockets} network connections).${notes.length ? `\n${notes.join("\n")}` : "\nAll normal for a bot."}`,
    summary: `Bot uses ${cpu.toFixed(0)}% CPU, ${mb(rss)}`,
  };
}

// ── profile_code / benchmark ─────────────────────────────────────────────────

async function profileCode(ctx: ToolContext, args: Args, h: CodeToolHelpers): Promise<ToolResult> {
  const code = s(args.code);
  let spec: Record<string, unknown>;
  if (code.trim()) {
    if (code.length > 20_000) return { ok: false, output: "The snippet is over 20,000 characters.", summary: "Snippet too big" };
    spec = { code };
  } else {
    const mod = s(args.module).trim(), func = s(args.function).trim();
    if (!PY_TARGET.test(mod) || !/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)?$/.test(func)) return { ok: false, output: "Give module + function (e.g. shop, top_players) or a code snippet.", summary: "Nothing to profile" };
    spec = { module: mod, function: func, args: Array.isArray(args.args) ? args.args : [], kwargs: args.kwargs && typeof args.kwargs === "object" ? args.kwargs : {} };
  }
  const r = await perf(ctx, h, "profile", spec, 90);
  const timedOut = r.code === 124 || r.code === 137;
  const blocked = /BLOCKED THE EVENT LOOP (\d+)/.exec(r.out)?.[1];
  const total = /: ([\d.]+ (?:s|ms|µs)) in total/.exec(r.out)?.[1];
  return {
    ok: r.code === 0 && !/^FAILED/m.test(r.out),
    output: clip(timedOut ? `Stopped after 90s (it may never finish).\n${r.out}` : untrusted(r.out), 9000),
    summary: timedOut ? "Profiling timed out" : `Profiled: ${total ?? "?"}${blocked ? `, blocked the event loop ${blocked}×` : ""}`,
  };
}

async function benchmark(ctx: ToolContext, args: Args, h: CodeToolHelpers): Promise<ToolResult> {
  const code = s(args.code), baseline = s(args.baseline), setup = s(args.setup);
  if (!code.trim()) return { ok: false, output: "Give the code to time.", summary: "Nothing to time" };
  if (code.length + baseline.length + setup.length > 30_000) return { ok: false, output: "The code is over 30,000 characters.", summary: "Code too big" };
  const seconds = Math.min(Math.max(Number(args.seconds) || 2, 0.5), 8);
  const r = await perf(ctx, h, "benchmark", { code, ...(baseline ? { baseline } : {}), ...(setup ? { setup } : {}), seconds }, Math.ceil(seconds * 6 + 20));
  const result = /^RESULT: (.*)$/m.exec(r.out)?.[1];
  const perRun = /^(?:new: +)?([\d.]+ (?:s|ms|µs)) per run/m.exec(r.out)?.[1];
  const differs = /Same `result` from both: NO/.test(r.out);
  return {
    ok: r.code === 0 && !differs,
    output: clip(`${r.out.trim()}${differs ? "\nThe two versions give different results: the new one changes behaviour — fix it before using it." : ""}`),
    summary: r.code !== 0 ? "Benchmark failed" : result ? `Benchmark: ${result.replace(/^the new version is /, "")}${differs ? " (but results differ!)" : ""}` : `Benchmark: ${perRun ?? "?"} per run`,
  };
}

export async function runPerfTool(name: string, args: Args, ctx: ToolContext, h: CodeToolHelpers): Promise<ToolResult | null> {
  switch (name) {
    case "profile_code": return profileCode(ctx, args, h);
    case "benchmark": return benchmark(ctx, args, h);
    case "code_metrics": return codeMetrics(ctx, args, h);
    case "type_check": return typeCheck(ctx, args, h);
    case "optimize_query": return optimizeQuery(ctx, args);
    case "bot_resources": return botResources(ctx);
    default: return null;
  }
}

