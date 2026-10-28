/**
 * Worker DB Client — Drizzle ORM + Postgres
 * OWNERSHIP: apps/worker/src/db
 *
 * The worker owns its own pool (5 connections — jobs are sequential per
 * queue) but shares the schema and connection rules with the API through
 * @kojyai/db. Migrations are applied by the API, never here.
 */

import type pg from "pg";
import { createDb, type Database } from "@kojyai/db";
import * as schema from "./schemas/schema.js";
import { createLogger } from "../services/logger.js";

const log = createLogger("worker-db");

let _pool: pg.Pool | null = null;
export let db: Database;
export { schema };

export async function connectDB(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const opened = await createDb({
    url,
    max: 5,
    statementTimeoutMs: 60_000,
    log: { info: (m) => log.info(m), warn: (o, m) => log.warn(o as object, m ?? "") },
  });
  _pool = opened.pool;
  db = opened.db;
}

export function getPool(): pg.Pool {
  if (!_pool) throw new Error("DB not initialized — call connectDB() first");
  return _pool;
}
