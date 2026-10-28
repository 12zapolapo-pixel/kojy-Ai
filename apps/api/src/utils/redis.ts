/**
 * Redis Utility — IORedis singleton clients
 * OWNERSHIP: apps/api/src/utils
 *
 * THREE CLIENTS:
 * - redis:     General use (get/set/incr/expire/pipeline)
 * - publisher: Pub/sub publishing (dedicated connection)
 * - subscriber: Pub/sub subscribing (dedicated connection, cannot do regular commands)
 *
 * Redis protocol requires dedicated connections for subscribe/psubscribe.
 * Never mix pub/sub and regular commands on the same client.
 */

import { Redis } from "ioredis";
import { resolveRedisTls } from "@kojyai/shared/redis";
import { createLogger } from "./logger.js";

const log = createLogger("redis");

let _redis:      Redis | null = null;
let _publisher:  Redis | null = null;
let _subscriber: Redis | null = null;

// SECURITY FIX (L-06): TLS is resolved once (and warned about once) from env.
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
let _tlsOptions: ReturnType<typeof resolveRedisTls>["options"] | null = null;
export function getRedisTlsOptions() {
  if (!_tlsOptions) _tlsOptions = resolveRedisTls(REDIS_URL, (f, m) => log.warn(f, m)).options;
  return _tlsOptions;
}

function createClient(name: string): Redis {
  const client = new Redis(REDIS_URL, {
    ...getRedisTlsOptions(),
    password:              process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest:  3,
    enableReadyCheck:      true,
    lazyConnect:           false,
    retryStrategy:         (times: number) => Math.min(times * 500, 5000),
  });

  client.on("connect", ()  => log.info(`Redis [${name}] connected`));
  client.on("error",   (e: Error) => log.warn(`Redis [${name}] error: ${e.message}`));
  client.on("close",   ()  => log.warn(`Redis [${name}] connection closed`));

  return client;
}

export async function connectRedis(): Promise<void> {
  _redis      = createClient("main");
  _publisher  = createClient("publisher");
  _subscriber = createClient("subscriber");

  await Promise.all([
    _redis.ping(),
    _publisher.ping(),
    _subscriber.ping(),
  ]);
}

export function getRedis():      Redis | null { return _redis; }
export function getRedisPublisher():  Redis | null { return _publisher; }
export function getRedisSubscriber(): Redis | null { return _subscriber; }

/** Cache helper — get or compute with TTL */
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
