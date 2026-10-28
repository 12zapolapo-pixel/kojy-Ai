/**
 * SQLite Emote Cache
 * OWNERSHIP: apps/worker/src/sqlite
 *
 * WHY SQLITE HERE:
 * The Highrise emote catalog is global reference data — every org/user sees
 * the same list, there's nothing multi-tenant about it. Putting it in the
 * shared MySQL instance would be a misuse of a relational store (no FKs, no
 * per-org data, just a read-mostly lookup table). Redis is the wrong fit too
 * (expensive for large structured payloads, doesn't survive restart without
 * persistence config). A small local SQLite file is exactly right: it's a
 * single file on disk, zero network overhead, and survives process restarts.
 *
 * The worker owns the write path (periodic re-fetch from Highrise webapi).
 * The API reads via a shared file path (both run on the same host in this
 * stack). On a multi-host deployment, promote to MySQL or a shared volume.
 *
 * Node 22 includes node:sqlite built-in — no npm package needed.
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

const SQLITE_DIR = process.env.SQLITE_DIR ?? path.join(process.cwd(), ".sqlite");
const DB_PATH = path.join(SQLITE_DIR, "emote-cache.db");

let _db: DatabaseSync | null = null;

export type EmoteRarity = "common" | "rare" | "epic";

export interface CachedEmote {
  emoteId:     string;
  name:        string;
  rarity:      EmoteRarity;
  category:    string | null;
  durationMs:  number | null;
  isLoopable:  number;   // SQLite boolean (0/1)
  commandNum:  number | null;  // 1–200 mapping for the emote-command feature
  fetchedAt:   string;  // ISO timestamp
}

function getDb(): DatabaseSync {
  if (_db) return _db;

  fs.mkdirSync(SQLITE_DIR, { recursive: true });

  _db = new DatabaseSync(DB_PATH);

  // WAL mode for better concurrent reads (API + worker both hit this file)
  _db.exec("PRAGMA journal_mode = WAL;");
  _db.exec("PRAGMA synchronous = NORMAL;");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS emotes (
      emote_id    TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      rarity      TEXT NOT NULL CHECK(rarity IN ('common', 'rare', 'epic')),
      category    TEXT,
      duration_ms INTEGER,
      is_loopable INTEGER NOT NULL DEFAULT 1,
      command_num INTEGER UNIQUE,
      fetched_at  TEXT NOT NULL
    );

    -- Index for the most common query: get all non-legendary emotes ordered
    -- by command_num for the numbered emote-command system (1–200).
    CREATE INDEX IF NOT EXISTS emotes_command_num_idx
      ON emotes (command_num) WHERE command_num IS NOT NULL;

    CREATE INDEX IF NOT EXISTS emotes_rarity_idx ON emotes (rarity);

    -- Single-row config/metadata table
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  return _db;
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Upsert the full emote catalog. Assigns command_num 1–200 to the rarest
 * non-legendary emotes first (epic → rare → common), skipping legendaries
 * entirely, matching the product spec ("rare and epic emotes, no legendaries").
 */
export function upsertEmotes(emotes: Omit<CachedEmote, "commandNum" | "fetchedAt">[]): void {
  const db = getDb();
  const fetchedAt = new Date().toISOString();

  // Sort: epic first, then rare, then common; legendaries already filtered out
  // by the caller (the Highrise webapi fetcher). Within each rarity, sort
  // alphabetically for stable numbering.
  const ordered = [...emotes].sort((a, b) => {
    const rank: Record<EmoteRarity, number> = { epic: 0, rare: 1, common: 2 };
    const diff = rank[a.rarity] - rank[b.rarity];
    return diff !== 0 ? diff : a.name.localeCompare(b.name);
  });

  const insert = db.prepare(`
    INSERT INTO emotes (emote_id, name, rarity, category, duration_ms, is_loopable, command_num, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(emote_id) DO UPDATE SET
      name        = excluded.name,
      rarity      = excluded.rarity,
      category    = excluded.category,
      duration_ms = excluded.duration_ms,
      is_loopable = excluded.is_loopable,
      command_num = excluded.command_num,
      fetched_at  = excluded.fetched_at
  `);

  db.exec("BEGIN");
  try {
    ordered.forEach((emote, idx) => {
      const commandNum = idx < 200 ? idx + 1 : null;
      insert.run(
        emote.emoteId, emote.name, emote.rarity, emote.category ?? null,
        emote.durationMs ?? null, emote.isLoopable ? 1 : 0,
        commandNum, fetchedAt,
      );
    });
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_fetch', ?)").run(fetchedAt);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export function getEmoteByNumber(num: number): CachedEmote | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM emotes WHERE command_num = ?").get(num) as CachedEmote | undefined;
  return row ?? null;
}

export function getEmoteById(emoteId: string): CachedEmote | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM emotes WHERE emote_id = ?").get(emoteId) as CachedEmote | undefined;
  return row ?? null;
}

export function getAllEmotes(rarity?: EmoteRarity): CachedEmote[] {
  const db = getDb();
  // FIX-AUDIT: node:sqlite's .all() returns Record<string, SQLOutputValue>[] —
  // a generic row shape that doesn't structurally overlap enough with
  // CachedEmote (e.g. `rarity: EmoteRarity` vs SQLOutputValue's broader union)
  // for TS to allow a direct cast. The SQLite columns do map 1:1 to CachedEmote
  // at runtime; routing through `unknown` is the standard way to assert that
  // without lying to the type checker about structural compatibility.
  if (rarity) {
    return db.prepare("SELECT * FROM emotes WHERE rarity = ? ORDER BY command_num ASC NULLS LAST").all(rarity) as unknown as CachedEmote[];
  }
  return db.prepare("SELECT * FROM emotes ORDER BY command_num ASC NULLS LAST, name ASC").all() as unknown as CachedEmote[];
}

export function getEmoteCount(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as count FROM emotes").get() as { count: number };
  return row.count;
}

export function getLastFetchTime(): Date | null {
  const db = getDb();
  const row = db.prepare("SELECT value FROM meta WHERE key = 'last_fetch'").get() as { value: string } | undefined;
  return row ? new Date(row.value) : null;
}

export function isStale(maxAgeMs = 24 * 60 * 60 * 1000): boolean {
  const last = getLastFetchTime();
  if (!last) return true;
  return Date.now() - last.getTime() > maxAgeMs;
}

export function closeDb(): void {
  if (_db) { _db.close(); _db = null; }
}
