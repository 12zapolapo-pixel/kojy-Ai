/**
 * Worker Boot — Entry Point
 * OWNERSHIP: apps/worker/src
 *
 * STARTUP ORDER:
 * 1. Validate env
 * 2. Connect to Postgres (worker's own pool)
 * 3. Connect to Redis (worker's own clients)
 * 4. Initialize BullMQ job queues + processors
 * 5. Start cron schedulers
 *
 * Does NOT import from apps/api — worker is a standalone process.
 */

import "./env.js"; // MUST stay first — loads .env before any other module reads process.env at import time
import { connectDB, getPool }              from "./db/client.js";
import { connectRedis, getRedis,
         getRedisPublisher }               from "./services/redis.js";
import { initJobQueues, closeAllQueues }   from "./queues/jobQueues.js";
import { createLogger }                    from "./services/logger.js";
import { refreshEmoteCatalogIfStale }      from "./processors/emoteCatalogRefresh.js";


const log = createLogger("worker-boot");

const REQUIRED_ENV = ["DATABASE_URL", "REDIS_URL", "JWT_SECRET", "ENCRYPTION_KEY"];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    log.fatal(`Missing required env: ${key} — check .env.example`);
    process.exit(1);
  }
}

// Any one AI provider will do (same rule as the API's boot check).
const AI_PROVIDER_KEYS = ["GROQ_API_KEY", "OPENAI_API_KEY", "MISTRAL_API_KEY"];
if (!AI_PROVIDER_KEYS.some((key) => process.env[key])) {
  log.fatal(`Missing required env: at least one of ${AI_PROVIDER_KEYS.join(", ")} must be set — check .env.example`);
  process.exit(1);
}

// SECURITY FIX (C-03): see apps/api/src/boot.ts for the full rationale —
// an unauthenticated Redis instance is a complete bypass of every tRPC
// authorization check for bot start/stop/restart/broadcast.
if (process.env.NODE_ENV === "production" && !process.env.REDIS_PASSWORD) {
  log.fatal("REDIS_PASSWORD must be set in production — an unauthenticated Redis instance is a full bot-control bypass.");
  process.exit(1);
}

async function main() {
  // Postgres — worker-owned pool (5 connections)
  await connectDB();
  log.info("Postgres connected");

  // Redis — worker-owned clients (main + publisher)
  await connectRedis();
  log.info("Redis connected");

  // BullMQ queues + processors + cron schedulers
  initJobQueues();
  log.info("All job queues initialized — worker ready");

  // Heartbeat for the Infrastructure page (expires if the worker dies).
  const beat = () => void getRedis()?.set("worker:heartbeat", JSON.stringify({
    ts: Date.now(), rssMb: Math.round(process.memoryUsage().rss / 1048576), uptimeS: Math.round(process.uptime()),
  }), "EX", 60).catch(() => undefined);
  beat();
  setInterval(beat, 15_000).unref();

  // Emote catalog: refresh if stale (no-op if already fresh from today).
  // Non-blocking — boot continues even if this fails (worker is otherwise ready).
  refreshEmoteCatalogIfStale().catch((err) => {
    log.warn({ err }, "Startup emote catalog refresh failed — will retry on next cron");
  });

  const shutdown = async (sig: string) => {
    log.info(`${sig} received — starting graceful shutdown`);

    try {
      // 1. Stop accepting new jobs and drain in-flight ones (BullMQ handles the drain)
      await closeAllQueues();
      log.info("BullMQ workers and queues closed");

      // 2. Close Redis clients (main + publisher)
      await Promise.allSettled([
        getRedis()?.quit(),
        getRedisPublisher()?.quit(),
      ]);
      log.info("Redis connections closed");

      // 3. Drain Postgres pool
      await getPool().end();
      log.info("Postgres pool closed");

    } catch (err) {
      log.error({ err }, "Error during graceful shutdown");
    } finally {
      log.info("Worker shutdown complete");
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT",  () => void shutdown("SIGINT"));
}

main().catch((err) => {
  log.fatal({ err }, "Worker boot failed");
  process.exit(1);
});
