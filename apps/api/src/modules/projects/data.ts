/**
 * Bot data viewer — read-only look into a project's own SQLite databases
 * (e.g. Japalo's data/bot.db: players, coins, warnings) and the JSON files
 * bots save under data/ (every starter bot does: wallets.json, tips.json…),
 * shown as tables. Editing JSON goes through the normal file save.
 * OWNERSHIP: apps/api/src/modules/projects
 *
 * Opened read-only with query_only on, so nothing here can change the bot's
 * data. Table names are only ever taken from the database's own table list.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { listFiles, resolveInside, ProjectFileError } from "@kojyai/shared/projects";
import { jsonTable, cell } from "./dataJson.js";

const DB_FILE = /\.(db|sqlite3?)$/i;

const JSON_FILE = /^data\/.+\.json$/i;
const MAX_JSON_BYTES = 5 * 1024 * 1024;

export function listDatabases(uuid: string): string[] {
  return listFiles(uuid).filter((f) => !f.isDir && (DB_FILE.test(f.path) || JSON_FILE.test(f.path))).map((f) => f.path)
    .sort((a, b) => Number(JSON_FILE.test(a)) - Number(JSON_FILE.test(b)) || a.localeCompare(b));
}


function readJson(uuid: string, path: string): ReturnType<typeof jsonTable> {
  const file = resolveInside(uuid, path);
  if (!existsSync(file)) throw new ProjectFileError(`No such file: ${path}`);
  if (statSync(file).size > MAX_JSON_BYTES) throw new ProjectFileError(`${path} is over 5 MB.`);
  try {
    return jsonTable(JSON.parse(readFileSync(file, "utf8")));
  } catch (err) {
    if (err instanceof ProjectFileError) throw err;
    throw new ProjectFileError(`${path} isn't valid JSON right now (the bot may be writing it).`);
  }
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
  if (JSON_FILE.test(dbPath)) {
    const t = readJson(uuid, dbPath);
    return [{ name: dbPath.split("/").pop()!, rows: t.rows.length, columns: t.columns.map((c) => ({ name: c, type: "" })), kind: t.kind }];
  }
  return open(uuid, dbPath, (db) => tableNames(db).map((name) => ({
    name,
    rows: Number((db.prepare(`SELECT COUNT(*) AS n FROM ${quote(name)}`).get() as { n: number | bigint }).n),
    columns: (db.prepare(`PRAGMA table_info(${quote(name)})`).all() as { name: string; type: string }[]).map((c) => ({ name: c.name, type: c.type })),
    kind: "sqlite" as const,
  })));
}

/** A page of rows; `search` matches any column as text. */
export function readTable(uuid: string, dbPath: string, table: string, offset: number, limit: number, search?: string) {
  if (JSON_FILE.test(dbPath)) {
    const t = readJson(uuid, dbPath);
    const q = search?.toLowerCase();
    const rows = q ? t.rows.filter((r) => r.some((c) => c !== null && String(c).toLowerCase().includes(q))) : t.rows;
    return { columns: t.columns, rows: rows.slice(offset, offset + limit), total: rows.length };
  }
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

