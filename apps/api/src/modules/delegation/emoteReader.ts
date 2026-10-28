/**
 * Emote Catalog Reader — API side
 * OWNERSHIP: apps/api/src/modules/delegation
 *
 * Reads the SQLite emote cache that the worker writes to. Both processes
 * share the same SQLite file on disk (same host in dev/production).
 *
 * This is intentionally a separate implementation from the worker's
 * emoteCache.ts — the API only needs to READ; the worker owns all writes.
 * Keeping them separate avoids a cross-app dependency (apps/api importing
 * from apps/worker) which would break the monorepo module boundaries.
 *
 * The SQLite file path is resolved from SQLITE_DIR env var, defaulting to
 * .sqlite/emote-cache.db relative to cwd(), which matches the worker's
 * default path exactly.
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

const SQLITE_DIR = process.env.SQLITE_DIR ?? path.join(process.cwd(), ".sqlite");
const DB_PATH = path.join(SQLITE_DIR, "emote-cache.db");

export interface EmoteCatalogEntry {
  emoteId:    string;
  name:       string;
  rarity:     "common" | "rare" | "epic";
  category:   string | null;
  commandNum: number | null;
  isLoopable: boolean;
}

export interface EmoteCatalogResult {
  emotes:       EmoteCatalogEntry[];
  count:        number;
  lastFetchedAt: string | null;
}

let _db: DatabaseSync | null = null;

function getDb(): DatabaseSync | null {
  if (_db) return _db;
  if (!fs.existsSync(DB_PATH)) return null;

  try {
    _db = new DatabaseSync(DB_PATH, { readOnly: true });
    return _db;
  } catch {
    return null;
  }
}

export function readEmoteCatalog(rarity: "common" | "rare" | "epic" | "all" = "all"): EmoteCatalogResult {
  const db = getDb();
  if (!db) {
    return { emotes: [], count: 0, lastFetchedAt: null };
  }

  try {
    // L-32: the router validated a `rarity` input and then ignored it. Apply it,
    // as a bound parameter (never interpolated), at the query level.
    const filter = rarity === "all" ? "" : " WHERE rarity = ?";
    const params = rarity === "all" ? [] : [rarity];
    const rows = db.prepare(
      `SELECT emote_id, name, rarity, category, command_num, is_loopable FROM emotes${filter} ORDER BY command_num ASC NULLS LAST, name ASC`
    ).all(...params) as Array<{
      emote_id:   string;
      name:       string;
      rarity:     string;
      category:   string | null;
      command_num: number | null;
      is_loopable: number;
    }>;

    const countRow = db.prepare(`SELECT COUNT(*) as count FROM emotes${filter}`).get(...params) as { count: number };
    const metaRow  = db.prepare("SELECT value FROM meta WHERE key = 'last_fetch'").get() as { value: string } | undefined;

    return {
      emotes: rows.map((r) => ({
        emoteId:    r.emote_id,
        name:       r.name,
        rarity:     r.rarity as EmoteCatalogEntry["rarity"],
        category:   r.category,
        commandNum: r.command_num,
        isLoopable: Boolean(r.is_loopable),
      })),
      count:        countRow.count,
      lastFetchedAt: metaRow?.value ?? null,
    };
  } catch {
    return { emotes: [], count: 0, lastFetchedAt: null };
  }
}
