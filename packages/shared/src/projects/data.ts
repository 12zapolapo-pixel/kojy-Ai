/**
 * Bot data viewer — read-only look into a project's own SQLite databases
 * (e.g. Japalo's data/bot.db: players, coins, warnings).
 * OWNERSHIP: packages/shared/src/projects — used by the API (Data panel) and the runner (query_data)
 *
 * Opened read-only with query_only on, so nothing here can change the bot's
 * data. Table names are only ever taken from the database's own table list.
 */

import type * as SqliteModule from "node:sqlite";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";

// Loaded on first use, not on import: this module is part of
// @kojyai/shared/projects, which much code imports without needing SQLite
// (and some tools, like vitest's resolver, can't load "node:sqlite" eagerly).
type DatabaseSync = DatabaseSyncType;
let sqlite: typeof SqliteModule | null = null;
const DatabaseSync = function (file: string, opts: { readOnly: boolean }): DatabaseSync {
  sqlite ??= createRequire(import.meta.url)("node:sqlite") as typeof SqliteModule;
  return new sqlite.DatabaseSync(file, opts);
} as unknown as new (file: string, opts: { readOnly: boolean }) => DatabaseSync;
import { listFiles, resolveInside, ProjectFileError } from "./files.js";

const DB_FILE = /\.(db|sqlite3?)$/i;
const MAX_CELL = 2000;

export function listDatabases(uuid: string): string[] {
  return listFiles(uuid).filter((f) => !f.isDir && DB_FILE.test(f.path)).map((f) => f.path);
}

function open<T>(uuid: string, dbPath: string, fn: (db: DatabaseSync) => T): T {
  if (!DB_FILE.test(dbPath)) throw new ProjectFileError("Not a database file");
  const file = resolveInside(uuid, dbPath);
  if (!existsSync(file)) throw new ProjectFileError(`No such database: ${dbPath}`);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (err) {
    throw new ProjectFileError(`Can't open ${dbPath}: ${(err as Error).message}`);
  }
  try {
    db.exec("PRAGMA query_only = 1; PRAGMA busy_timeout = 2000;");
    return fn(db);
  } catch (err) {
    throw new ProjectFileError((err as Error).message);
  } finally {
    db.close();
  }
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

function tableNames(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
    .map((r) => r.name);
}

export function describeDatabase(uuid: string, dbPath: string) {
  return open(uuid, dbPath, (db) => tableNames(db).map((name) => ({
    name,
    rows: Number((db.prepare(`SELECT COUNT(*) AS n FROM ${quote(name)}`).get() as { n: number | bigint }).n),
    columns: (db.prepare(`PRAGMA table_info(${quote(name)})`).all() as { name: string; type: string }[]).map((c) => ({ name: c.name, type: c.type })),
  })));
}

/** A page of rows; `search` matches any column as text. */
export function readTable(uuid: string, dbPath: string, table: string, offset: number, limit: number, search?: string) {
  return open(uuid, dbPath, (db) => {
    if (!tableNames(db).includes(table)) throw new ProjectFileError(`No such table: ${table}`);
    const columns = (db.prepare(`PRAGMA table_info(${quote(table)})`).all() as { name: string }[]).map((c) => c.name);
    const where = search && columns.length ? `WHERE ${columns.map((c) => `CAST(${quote(c)} AS TEXT) LIKE ?`).join(" OR ")}` : "";
    const args = where ? columns.map(() => `%${search}%`) : [];
    const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)} ${where}`).get(...args) as { n: number | bigint }).n);
    const rows = (db.prepare(`SELECT * FROM ${quote(table)} ${where} LIMIT ? OFFSET ?`).all(...args, limit, offset) as Record<string, unknown>[])
      .map((row) => columns.map((c) => cell(row[c])));
    return { columns, rows, total };
  });
}

/**
 * Why `sql` can't be run as a read-only query for Kojy, or null if it can:
 * one SELECT (or WITH … SELECT) statement, nothing that attaches other files
 * or changes settings. The database is also opened read-only with
 * query_only on, so this is a second wall, not the only one.
 */
export function readQueryProblem(sql: string): string | null {
  const s = sql.trim().replace(/;\s*$/, "");
  if (!s) return "Empty query.";
  if (s.length > 2000) return "Query is too long (2000 characters max).";
  if (!/^(select|with)\b/i.test(s)) return "Only SELECT queries can be run (the bot's data is read-only here).";
  // Strip quoted text before looking for a second statement or forbidden words.
  const bare = s.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, "''");
  if (bare.includes(";")) return "Run one statement at a time.";
  if (/\b(attach|detach|pragma|insert|update|delete|replace|drop|alter|create|vacuum|reindex|load_extension)\b/i.test(bare)) {
    return "Only reading is allowed: no ATTACH, PRAGMA or changes.";
  }
  return null;
}

/** Why a data-changing statement may not run (null: it may): one INSERT, UPDATE, DELETE or REPLACE, nothing that changes the tables themselves. */
export function writeQueryProblem(sql: string): string | null {
  const s = sql.trim().replace(/;\s*$/, "");
  if (!s) return "Empty statement.";
  if (s.length > 4000) return "Statement is too long (4000 characters max).";
  if (!/^(insert|update|delete|replace|with)\b/i.test(s)) return "Only one INSERT, UPDATE, DELETE or REPLACE can be run (use query_data to read).";
  const bare = s.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, "''");
  if (bare.includes(";")) return "Run one statement at a time.";
  if (/\b(attach|detach|pragma|drop|alter|create|vacuum|reindex|load_extension)\b/i.test(bare)) return "Only rows can be changed: no ATTACH, PRAGMA, DROP, ALTER or CREATE.";
  if (/^with\b/i.test(s) && !/\b(insert|update|delete|replace)\b/i.test(bare)) return "Use query_data for a SELECT.";
  if (/^(update|delete)\b/i.test(s) && !/\bwhere\b/i.test(bare)) return "An UPDATE or DELETE needs a WHERE (to change every row on purpose, write WHERE 1=1).";
  return null;
}

/** The file path of a project's database, checked like every other project path. */
export function databaseFile(uuid: string, dbPath: string): string {
  if (!DB_FILE.test(dbPath)) throw new ProjectFileError("Not a database file");
  const file = resolveInside(uuid, dbPath);
  if (!existsSync(file)) throw new ProjectFileError(`No such database: ${dbPath}`);
  return file;
}

function cell(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  const s = String(v);
  return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL)}…` : s;
}
