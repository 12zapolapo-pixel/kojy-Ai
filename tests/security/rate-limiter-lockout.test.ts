/**
 * V-07: rejected requests must not extend a sliding-window lockout.
 * Needs a Redis (RATE_LIMIT_TEST_REDIS_URL or REDIS_URL); skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { checkRateLimit } from "../../packages/security/src/index.js";

const URL = process.env.RATE_LIMIT_TEST_REDIS_URL ?? process.env.REDIS_URL ?? "";
const test = URL ? it : it.skip;
let redis: Redis;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(() => { if (URL) redis = new Redis(URL); });
afterAll(async () => { await redis?.quit(); });

describe("sliding-window rate limiter (V-07)", () => {
  test("allows maxHits, then rejects", async () => {
    const cfg = { windowMs: 1000, maxHits: 3, keyPrefix: `rl:test:${Date.now()}:a` };
    const r = [];
    for (let i = 0; i < 4; i++) r.push(await checkRateLimit(redis, "ip", cfg));
    expect(r.map((x) => x.allowed)).toEqual([true, true, true, false]);
    expect(r[2]!.remaining).toBe(0);
    expect(r[3]!.retryAfter).toBeGreaterThanOrEqual(1);
  });

  test("a client that keeps retrying while blocked is let back in when the window passes", async () => {
    const cfg = { windowMs: 800, maxHits: 2, keyPrefix: `rl:test:${Date.now()}:b` };
    await checkRateLimit(redis, "nat", cfg);
    await checkRateLimit(redis, "nat", cfg);
    // Hammer it while blocked, for longer than one window. The old code
    // recorded each rejected hit and refreshed the TTL, so this never ended.
    const t0 = Date.now();
    let allowedAgainAt = 0;
    while (Date.now() - t0 < 2000) {
      const r = await checkRateLimit(redis, "nat", cfg);
      if (r.allowed) { allowedAgainAt = Date.now() - t0; break; }
      await sleep(100);
    }
    expect(allowedAgainAt).toBeGreaterThan(0);
    expect(allowedAgainAt).toBeLessThan(1200);
  });

  test("rejected calls are not stored", async () => {
    const cfg = { windowMs: 5000, maxHits: 2, keyPrefix: `rl:test:${Date.now()}:c` };
    for (let i = 0; i < 10; i++) await checkRateLimit(redis, "x", cfg);
    expect(await redis.zcard(`${cfg.keyPrefix}:x`)).toBe(2);
  });
});
