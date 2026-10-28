/**
 * Emote Catalog Refresh Processor
 * OWNERSHIP: apps/worker/src/processors
 *
 * Fetches the Highrise emote catalog from webapi.highrise.game and upserts
 * it into the SQLite emote cache. Scheduled daily via the cron scheduler in
 * jobQueues.ts (daily at 03:00 UTC — off-peak, well after the nightly backup).
 *
 * Also runs once at worker startup so the cache is never stale for long after
 * a fresh deploy (boot.ts calls refreshEmoyCatalogIfStale on startup).
 *
 * WHY A DEDICATED QUEUE ENTRY:
 * - Rate limit isolation: a slow webapi.highrise.game response doesn't block
 *   critical queues like bot_lifecycle or notification_delivery.
 * - Independent retry: if the fetch fails (transient network), BullMQ retries
 *   this job without affecting other queues.
 * - Visibility: queue failures show up in the DLQ dashboard distinctly.
 */

import type { Job } from "bullmq";
import { createLogger } from "../services/logger.js";
import { fetchAndCacheEmotes } from "../sqlite/emoteFetcher.js";
import { getEmoteCount, isStale } from "../sqlite/emoteCache.js";

const log = createLogger("emote-catalog-refresh");

export async function processEmoteCatalogRefresh(job: Job): Promise<void> {
  const force = Boolean(job.data?.force);

  // Skip if cache is fresh and this is a routine (non-forced) run.
  // "Stale" = no fetch in the last 24h or empty cache.
  if (!force && !isStale()) {
    log.info({
      cachedCount: getEmoteCount(),
    }, "Emote catalog is fresh — skipping refresh");
    return;
  }

  log.info("Fetching Highrise emote catalog...");
  const startMs = Date.now();

  const count = await fetchAndCacheEmotes();

  const elapsed = Date.now() - startMs;
  log.info({
    emotesStored: count,
    elapsedMs: elapsed,
  }, "Emote catalog refresh complete");
}

/**
 * Startup helper — called by boot.ts to ensure the cache has at least some
 * data before the first daily cron fires. No-ops if the cache is fresh.
 */
export async function refreshEmoteCatalogIfStale(): Promise<void> {
  if (!isStale()) {
    log.info({ count: getEmoteCount() }, "Emote catalog is fresh at startup");
    return;
  }
  log.info("Emote catalog is stale at startup — refreshing now...");
  try {
    const count = await fetchAndCacheEmotes();
    log.info({ emotesStored: count }, "Startup emote refresh complete");
  } catch (err) {
    // Non-fatal: the worker still starts, just without cached emotes yet.
    log.error({ err }, "Startup emote refresh failed — will retry on next cron");
  }
}
