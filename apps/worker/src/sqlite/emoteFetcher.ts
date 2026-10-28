/**
 * Highrise Emote Fetcher
 * OWNERSHIP: apps/worker/src/sqlite
 *
 * Fills the SQLite emote cache. Highrise's web API can no longer list emotes
 * (GET /emotes returns 404 and /items?category=emote comes back empty), so the
 * source is the built-in list in emoteCatalog.ts — ids already checked in a
 * real room. Runs periodically in the worker; it's cheap and has no network.
 *
 * FILTER: skips legendary rarity — per the product spec, the numbered
 * emote-command system only covers the non-legendary emotes. Emotes whose
 * rarity Highrise doesn't report are treated as common.
 */

import { upsertEmotes, type EmoteRarity } from "./emoteCache.js";
import { EMOTE_CATALOG } from "@kojyai/shared/projects";

function normalizeRarity(raw: string): EmoteRarity | "legendary" {
  switch (raw.toLowerCase()) {
    case "rare":      return "rare";
    case "epic":      return "epic";
    case "legendary": return "legendary";
    default:          return "common";
  }
}

/** Stores the built-in emote list in the cache. Returns how many were stored. */
export async function fetchAndCacheEmotes(): Promise<number> {
  const emotes = EMOTE_CATALOG.flatMap(([emoteId, name, rawRarity, seconds]) => {
    const rarity = normalizeRarity(rawRarity);
    if (rarity === "legendary") return [];
    return [{
      emoteId,
      name,
      rarity,
      category:   emoteId.split("-")[0] ?? null,
      durationMs: seconds ? Math.round(seconds * 1000) : null,
      isLoopable: 1, // SQLite stores booleans as 0/1
    }];
  });

  upsertEmotes(emotes);
  return emotes.length;
}
