/**
 * Database Client — Drizzle ORM + Postgres
 * OWNERSHIP: apps/api/src/db
 *
 * Connection rules (TLS, retries, migrations) live in @kojyai/db; this file
 * only sizes the API's pool and exposes the module-level `db` handle.
 */

import type pg from "pg";
import { createDb, runMigrations, type Database } from "@kojyai/db";
import * as schema       from "./schemas/schema.js";
import { createLogger }  from "../utils/logger.js";

const log = createLogger("db");

let _pool: pg.Pool | null = null;
export let db: Database;

/** Reads a non-negative integer env var, falling back (with a warning) on junk. */
function intEnv(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > max) {
    log.warn({ name, raw, fallback }, `Ignoring invalid ${name}; using default`);
    return fallback;
  }
  return n;
}

export async function connectDB(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const opened = await createDb({
    url,
    max:                intEnv("DB_POOL_SIZE", 20, 500) || 20,
    statementTimeoutMs: intEnv("DB_STATEMENT_TIMEOUT_MS", 30_000, 3_600_000),
    connectTimeoutMs:   intEnv("DB_CONNECT_TIMEOUT_MS", 10_000, 120_000) || 10_000,
    log: { info: (m) => log.info(m), warn: (o, m) => log.warn(o as object, m ?? "") },
  });
  _pool = opened.pool;
  db = opened.db;

  // Single-owner installs have nobody to run `drizzle-kit migrate` by hand,
  // so the API applies pending migrations on boot unless told not to.
  if ((process.env.DB_AUTO_MIGRATE ?? "true").toLowerCase() !== "false") {
    await runMigrations(db);
    log.info("Database migrations are up to date");
  }
}

export function getPool(): pg.Pool {
  if (!_pool) throw new Error("DB not initialized — call connectDB() first");
  return _pool;
}

export { schema };
