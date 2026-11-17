/**
 * Kojy's look into a bot's own saved data (its SQLite databases, read-only)
 * and its room activity numbers — so it can answer "who has the most coins?"
 * or "how many people used !trivia this week?" from facts.
 * OWNERSHIP: apps/runner/src/agent
 *
 * Queries run in a worker thread that is killed after a few seconds: node's
 * SQLite is synchronous, and a slow query on the runner's main thread would
 * freeze every bot's supervisor (same reason as search_code, V-04).
 */

import { Worker } from "node:worker_threads";
import { and, count, desc, eq, gte, isNotNull, sql, sum } from "drizzle-orm";
import { botActivity } from "@kojyai/db/schema";
import { databaseFile, describeDatabase, listDatabases, listFiles, readQueryProblem, isPersistentData } from "@kojyai/shared/projects";
import type { Database } from "@kojyai/db";
import type { ToolResult } from "./tools.js";
import { untrusted } from "./prompt.js";

const QUERY_TIMEOUT_MS = 4000;
const MAX_ROWS = 50;
const MAX_CELL = 300;

const QUERY_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
let db;
try {
  db = new DatabaseSync(workerData.file, { readOnly: true });
  db.exec("PRAGMA query_only = 1; PRAGMA busy_timeout = 1000;");
  const stmt = db.prepare(workerData.sql);
  const rows = [];
  for (const row of stmt.iterate()) { rows.push(row); if (rows.length > workerData.max) break; }
  parentPort.postMessage({ rows });
} catch (err) {
  parentPort.postMessage({ error: String(err && err.message || err) });
} finally {
  try { db && db.close(); } catch {}
}`;

export function queryInWorker(file: string, query: string, max = MAX_ROWS): Promise<{ rows?: Record<string, unknown>[]; error?: string } | "timeout"> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(QUERY_WORKER, { eval: true, workerData: { file, sql: query, max }, resourceLimits: { maxOldGenerationSizeMb: 128 } });
    const timer = setTimeout(() => { void worker.terminate(); resolve("timeout"); }, QUERY_TIMEOUT_MS);
    worker.once("message", (m: { rows?: Record<string, unknown>[]; error?: string }) => { clearTimeout(timer); void worker.terminate(); resolve(m); });
    worker.once("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

const show = (v: unknown): string => {
  if (v === null || v === undefined) return "NULL";
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  const s = typeof v === "bigint" ? v.toString() : String(v);
  return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL)}…` : s;
};

/** Rows as a small text table (tab-separated). */
export function formatRows(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "(no rows)";
  const cols = Object.keys(rows[0]!);
  return [cols.join("\t"), ...rows.map((r) => cols.map((c) => show(r[c]).replace(/[\t\n]/g, " ")).join("\t"))].join("\n");
}

export async function queryData(uuid: string, args: Record<string, unknown>): Promise<ToolResult> {
  const dbs = listDatabases(uuid);
  const query = typeof args.sql === "string" ? args.sql.trim() : "";
  // No query: what data the bot keeps.
  if (!query) {
    const jsonFiles = listFiles(uuid).filter((f) => !f.isDir && isPersistentData(f.path) && /\.json$/i.test(f.path)).map((f) => f.path).slice(0, 20);
    if (!dbs.length) {
      return {
        ok: true, summary: "The bot has no database",
        output: `The bot has no SQLite database.${jsonFiles.length ? ` It saves data in JSON files (read them with read_file): ${jsonFiles.join(", ")}` : " It doesn't seem to save data in data/ either."}`,
      };
    }
    const parts = dbs.map((db) => {
      const tables = describeDatabase(uuid, db);
      return `${db}:\n${tables.map((t) => `  ${t.name} (${t.rows} rows): ${t.columns.map((c) => `${c.name}${c.type ? ` ${c.type}` : ""}`).join(", ")}`).join("\n") || "  (no tables)"}`;
    });
    if (jsonFiles.length) parts.push(`JSON data files (read with read_file): ${jsonFiles.join(", ")}`);
    return { ok: true, output: `${parts.join("\n")}\n\nAsk with sql (one SELECT) to read rows.`, summary: `Looked at the bot's data (${dbs.length} database${dbs.length > 1 ? "s" : ""})` };
  }

  const problem = readQueryProblem(query);
  if (problem) return { ok: false, output: problem, summary: "Query refused" };
  const dbPath = typeof args.db === "string" && args.db ? args.db : dbs[0];
  if (!dbPath) return { ok: false, output: "The bot has no SQLite database.", summary: "No database" };
  const result = await queryInWorker(databaseFile(uuid, dbPath), query);
  if (result === "timeout") return { ok: false, output: `The query took over ${QUERY_TIMEOUT_MS / 1000}s and was stopped. Add a LIMIT or a simpler WHERE.`, summary: "Query stopped (too slow)" };
  if (result.error) return { ok: false, output: `SQLite error: ${result.error}`, summary: "Query failed" };
  const rows = result.rows ?? [];
  const more = rows.length > MAX_ROWS;
  // The rows hold what room visitors typed (names, messages): data, never instructions.
  return {
    ok: true,
    output: `${dbPath}, ${more ? `first ${MAX_ROWS}` : rows.length} row${rows.length === 1 ? "" : "s"}:\n${untrusted(formatRows(rows.slice(0, MAX_ROWS)))}${more ? "\n(more rows: add LIMIT/ORDER BY to narrow it)" : ""}`,
    summary: `Queried ${dbPath} (${more ? `${MAX_ROWS}+` : rows.length} rows)`,
  };
}

/** This bot's room activity over the last `days`: events, visitors, tip gold, top commands. */
export async function roomActivity(db: Database, projectId: number, args: Record<string, unknown>): Promise<ToolResult> {
  const days = Math.min(Math.max(Number(args.days) || 7, 1), 90);
  const a = botActivity;
  const scope = and(eq(a.source, "project"), eq(a.sourceId, projectId), gte(a.createdAt, new Date(Date.now() - days * 86_400_000)));
  const [kinds, visitors, gold, commands, tippers] = await Promise.all([
    db.select({ kind: a.kind, n: count() }).from(a).where(scope).groupBy(a.kind),
    db.select({ n: sql<number>`count(distinct ${a.actorId})`.mapWith(Number) }).from(a)
      .where(and(scope, sql`${a.kind} in ('chat','whisper','join','tip','emote')`)),
    db.select({ total: sum(a.amount) }).from(a).where(and(scope, eq(a.kind, "tip"))),
    db.select({ command: a.detail, n: count() }).from(a).where(and(scope, isNotNull(a.detail))).groupBy(a.detail).orderBy(desc(count())).limit(10),
    db.select({ name: sql<string>`max(${a.actorName})`, total: sum(a.amount) }).from(a)
      .where(and(scope, eq(a.kind, "tip"), isNotNull(a.amount))).groupBy(a.actorId).orderBy(desc(sum(a.amount))).limit(5),
  ]);
  const n = (k: string) => Number(kinds.find((x) => x.kind === k)?.n ?? 0);
  const lines = [
    `Last ${days} day${days > 1 ? "s" : ""}: ${n("chat")} chat messages, ${n("whisper")} whispers, ${n("reply")} bot replies, ${n("join")} joins, ${visitors[0]?.n ?? 0} different visitors.`,
    `Tips: ${n("tip")}${gold[0]?.total ? ` (${Number(gold[0].total)} gold)` : ""}. Emotes: ${n("emote")}. Crashes: ${n("crash")}, starts: ${n("start")}.`,
    commands.length ? `Most used commands: ${commands.map((c) => `${c.command} ×${Number(c.n)}`).join(", ")}` : "No commands recorded yet (counted from messages starting with ! or /).",
    tippers.length ? `Top tippers: ${untrusted(tippers.map((t) => `${t.name ?? "?"} ${Number(t.total)} gold`).join(", "))}` : "",
  ].filter(Boolean);
  return { ok: true, output: lines.join("\n"), summary: `Checked this bot's room activity (${days} days)` };
}
