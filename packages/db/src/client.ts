/**
 * Database Client — Drizzle ORM + node-postgres
 * OWNERSHIP: packages/db
 *
 * One factory shared by the API and the worker. Each app still owns its own
 * pool (different sizes), but the connection rules — TLS, timeouts, retries,
 * migrations — live here once instead of in two drifting copies.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;

export interface DbLogger {
  info(msg: string): void;
  warn(obj: unknown, msg?: string): void;
}

export interface CreateDbOptions {
  url: string;
  /** Max pooled connections. */
  max: number;
  /** Per-statement timeout in ms; 0 disables it. */
  statementTimeoutMs?: number;
  connectTimeoutMs?: number;
  log: DbLogger;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * TLS for the database connection. Opt-in because the bundled docker-compose
 * Postgres sits on a private network without TLS:
 *   DB_SSL=true                      enable TLS with certificate verification
 *   DB_SSL_CA=<path or PEM>          custom CA (managed DBs / self-signed)
 *   DB_SSL_REJECT_UNAUTHORIZED=false encrypt without verifying the server (last resort)
 *   DB_SSL=false                     explicit "trusted private network"
 * An `sslmode=` parameter already in DATABASE_URL always wins.
 */
function resolveSsl(url: string, log: DbLogger): pg.ConnectionConfig["ssl"] {
  let host = "";
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    if (u.searchParams.has("sslmode") || u.searchParams.has("ssl")) return undefined;
  } catch { /* pg surfaces a bad URL itself */ }

  const mode = (process.env.DB_SSL ?? "").trim().toLowerCase();
  const on  = ["true", "1", "on", "require", "required"].includes(mode);
  const off = ["false", "0", "off"].includes(mode);

  if (!on) {
    if (process.env.NODE_ENV === "production" && !off && host && !LOCAL_HOSTS.has(host) && host !== "postgres") {
      log.warn(
        { host },
        "DATABASE_URL points at a non-local host but TLS is not enabled. Set DB_SSL=true " +
        "(and DB_SSL_CA if needed), or DB_SSL=false to acknowledge a trusted private network.",
      );
    }
    return undefined;
  }

  const rejectUnauthorized = process.env.DB_SSL_REJECT_UNAUTHORIZED?.trim().toLowerCase() !== "false";
  if (!rejectUnauthorized) {
    log.warn({}, "DB_SSL_REJECT_UNAUTHORIZED=false — database traffic is encrypted but the server's identity is NOT verified.");
  }
  const ca = process.env.DB_SSL_CA?.trim();
  return {
    rejectUnauthorized,
    ...(ca ? { ca: ca.includes("-----BEGIN") ? ca.replace(/\\n/g, "\n") : readFileSync(ca, "utf8") } : {}),
  };
}

/** Opens a pool, verifies it with up to 3 attempts, and returns Drizzle over it. */
export async function createDb(opts: CreateDbOptions): Promise<{ db: Database; pool: pg.Pool }> {
  const ssl = resolveSsl(opts.url, opts.log);
  const pool = new pg.Pool({
    connectionString: opts.url,
    max: opts.max,
    connectionTimeoutMillis: opts.connectTimeoutMs ?? 10_000,
    keepAlive: true,
    ...(opts.statementTimeoutMs ? { statement_timeout: opts.statementTimeoutMs } : {}),
    ...(ssl ? { ssl } : {}),
  });
  // An idle client erroring (e.g. the server restarting) must not crash the process.
  pool.on("error", (err) => opts.log.warn({ err: err.message }, "Idle Postgres client error"));

  for (let attempt = 1; ; attempt++) {
    try {
      const client = await pool.connect();
      await client.query("SELECT 1");
      client.release();
      opts.log.info("Postgres connected successfully");
      break;
    } catch (err) {
      if (attempt >= 3) {
        await pool.end().catch(() => undefined);
        throw new Error(`Postgres connection failed after 3 attempts: ${err}`);
      }
      opts.log.warn({ attempt }, `Postgres connection attempt ${attempt} failed, retrying in 3s…`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  return { db: drizzle(pool, { schema }), pool };
}

/**
 * Folder holding the generated SQL migrations: DB_MIGRATIONS_DIR if set,
 * else `migrations/` next to the running bundle (apps copy it into dist/ at
 * build time), else the package's own folder when running from source.
 */
export function migrationsFolder(): string {
  if (process.env.DB_MIGRATIONS_DIR) return process.env.DB_MIGRATIONS_DIR;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, "migrations"), path.resolve(here, "../migrations")];
  return candidates.find((dir) => existsSync(path.join(dir, "meta", "_journal.json"))) ?? candidates[1]!;
}

/** Applies any pending migrations (idempotent; tracked in drizzle.__drizzle_migrations). */
export async function runMigrations(db: Database, folder = migrationsFolder()): Promise<void> {
  await migrate(db, { migrationsFolder: folder });
}
