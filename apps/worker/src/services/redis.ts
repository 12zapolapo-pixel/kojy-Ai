/**
 * Worker Redis — IORedis singleton
 * OWNERSHIP: apps/worker/src/services
 *
 * Worker owns its own Redis connections — does NOT import from apps/api.
 * Worker needs:
 *   - publisher: for emitting bot/org events back to the API's WS gateway
 *   - general:   for cache reads and BullMQ metadata
 *
 * Note: BullMQ creates its own connections via createRedisConnection() in jobQueues.ts.
 * These clients are for non-BullMQ Redis operations inside processors.
 */

import { Redis } from "ioredis";
import { resolveRedisTls } from "@kojyai/shared/redis";
import { createLogger } from "./logger.js";
import { signBotControlMessage } from "@kojyai/shared/crypto";

const log = createLogger("worker-redis");

let _redis:     Redis | null = null;
let _publisher: Redis | null = null;

// SECURITY FIX (L-06): shared TLS resolution (also used by jobQueues.ts).
export function getWorkerRedisTlsOptions() {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  return resolveRedisTls(url, (f, m) => log.warn(f, m)).options;
}

function makeClient(name: string): Redis {
  const client = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    ...getWorkerRedisTlsOptions(),
    password:             process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: 3,
    enableReadyCheck:     true,
    lazyConnect:          false,
    retryStrategy:        (times: number) => Math.min(times * 500, 5000),
  });
  client.on("connect", ()  => log.info(`Redis [${name}] connected`));
  client.on("error",   (e: Error) => log.warn(`Redis [${name}] error: ${e.message}`));
  client.on("close",   ()  => log.warn(`Redis [${name}] closed`));
  return client;
}

export async function connectRedis(): Promise<void> {
  _redis     = makeClient("worker-main");
  _publisher = makeClient("worker-pub");
  await Promise.all([_redis.ping(), _publisher.ping()]);
  log.info("Worker Redis connected (main + publisher)");
}

export function getRedis():          Redis | null { return _redis; }
export function getRedisPublisher(): Redis | null { return _publisher; }

/** Publish a bot event so the API's WS gateway can fan it out to connected clients. */
export async function publishBotEvent(botId: string, event: object): Promise<void> {
  const pub = getRedisPublisher();
  if (!pub) return;
  try {
    // Must match WS_CHANNELS.BOT(botId) in @kojyai/shared/constants exactly —
    // the gateway's "bot:*" pattern subscription parses the botId out of the
    // channel name via channel.split(":")[1], so any extra path segment here
    // (e.g. the old "bot:events:${botId}") breaks that parsing silently.
    await pub.publish(`bot:${botId}`, JSON.stringify(event));
  } catch (err) {
    log.warn({ botId, err }, "Failed to publish bot event");
  }
}

/**
 * Publish a control command for the API's bot runtime manager to act on
 * (start/stop/restart/broadcast). Deliberately a SEPARATE channel from
 * publishBotEvent's "bot:${botId}" — these are commands for the runtime
 * manager to execute against the live Highrise connection, not events meant
 * for the browser, and must never be forwarded by the WS gateway's fan-out.
 */
export async function publishBotControl(
  botId: string,
  action: "start" | "stop" | "restart" | "broadcast" | "reload_scripts",
  payload?: Record<string, unknown>,
): Promise<void> {
  const pub = getRedisPublisher();
  if (!pub) return;
  try {
    // SECURITY FIX (C-03): signed, not a raw unsigned JSON blob — the API's
    // subscriber now verifies this HMAC before acting on anything arriving
    // on bot_control:*. See packages/shared/src/crypto/botControlSignature.ts.
    await pub.publish(`bot_control:${botId}`, signBotControlMessage(botId, action, payload));
  } catch (err) {
    log.warn({ botId, action, err }, "Failed to publish bot control command");
  }
}

/** Cache helper */
export async function cacheOrCompute<T>(
  key:     string,
  ttlSecs: number,
  compute: () => Promise<T>,
): Promise<T> {
  const r = getRedis();
  if (r) {
    try {
      const cached = await r.get(key);
      if (cached) return JSON.parse(cached) as T;
    } catch { /* miss */ }
  }
  const value = await compute();
  if (r) {
    try { await r.setex(key, ttlSecs, JSON.stringify(value)); } catch { /* ignore */ }
  }
  return value;
}
