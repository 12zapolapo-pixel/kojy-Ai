/**
 * System Router — live server status for the Infrastructure page.
 * OWNERSHIP: apps/api/src/modules/system
 *
 * Everything here is measured, not estimated: database and Redis are pinged,
 * the worker and runner report heartbeats to Redis every 15s (a missing
 * heartbeat = that service is down), and the worker records the result of the
 * last backup and restore drill. Admins only (not audit-logged: the page polls).
 */

import { TRPCError } from "@trpc/server";
import { sql, count } from "drizzle-orm";
import { router, protectedProc } from "../../trpc.js";
import { schema } from "../../db/client.js";
import { getRedis } from "../../utils/redis.js";
import { queueCounts } from "../../jobs/queues.js";

const adminOnly = protectedProc.use(({ ctx, next }) => {
  if (ctx.user!.role !== "admin" && ctx.user!.role !== "superadmin") throw new TRPCError({ code: "FORBIDDEN", message: "Administrator access required." });
  return next({ ctx });
});

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: boolean; ms: number; value?: T; error?: string }> {
  const t = performance.now();
  try {
    const value = await fn();
    return { ok: true, ms: Math.round(performance.now() - t), value };
  } catch (err) {
    return { ok: false, ms: Math.round(performance.now() - t), error: (err as Error).message.slice(0, 200) };
  }
}

export interface Heartbeat { ts: number; [k: string]: unknown }

export const systemRouter = router({
  status: adminOnly.query(async ({ ctx }) => {
    const redis = getRedis();
    const [dbCheck, redisCheck, beats, queues, jsBots, pyBots] = await Promise.all([
      timed(async () => {
        const r = await ctx.db.execute(sql`select pg_database_size(current_database()) as size`);
        return Math.round(Number((r.rows[0] as { size: string }).size) / 1048576);
      }),
      timed(async () => {
        if (!redis) throw new Error("not connected");
        const info = await redis.info("memory");
        return Math.round(Number(/used_memory:(\d+)/.exec(info)?.[1] ?? 0) / 1048576);
      }),
      redis ? redis.mget("worker:heartbeat", "runner:heartbeat", "backup:last").catch(() => [null, null, null]) : Promise.resolve([null, null, null]),
      redis ? queueCounts().catch(() => []) : Promise.resolve([]),
      ctx.db.select({ status: schema.bots.status, n: count() }).from(schema.bots).groupBy(schema.bots.status),
      ctx.db.select({ status: schema.botProjects.status, n: count() }).from(schema.botProjects).groupBy(schema.botProjects.status),
    ]);
    const parse = (v: string | null | undefined) => { try { return v ? JSON.parse(v) as Heartbeat : null; } catch { return null; } };
    const [worker, runner, backup] = (beats as (string | null)[]).map(parse);
    const fresh = (h: Heartbeat | null | undefined) => !!h && Date.now() - h.ts < 45_000;
    const tally = (rows: { status: string; n: number }[]) => Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));

    return {
      checkedAt: Date.now(),
      api: { ok: true, uptimeS: Math.round(process.uptime()), rssMb: Math.round(process.memoryUsage().rss / 1048576), node: process.version },
      database: { ok: dbCheck.ok, latencyMs: dbCheck.ms, sizeMb: dbCheck.value ?? null, error: dbCheck.error ?? null },
      redis: { ok: redisCheck.ok, latencyMs: redisCheck.ms, usedMb: redisCheck.value ?? null, error: redisCheck.error ?? null },
      worker: { ok: fresh(worker), heartbeat: worker },
      runner: { ok: fresh(runner), heartbeat: runner },
      backup,
      queues,
      bots: { js: tally(jsBots as { status: string; n: number }[]), python: tally(pyBots as { status: string; n: number }[]) },
      ai: { groq: !!process.env.GROQ_API_KEY && !process.env.GROQ_API_KEY.includes("placeholder"), alertsWebhook: !!process.env.ALERT_WEBHOOK_URL },
    };
  }),

  /** What the website should show: billing/email are optional and off by default. */
  features: protectedProc.query(() => ({
    billing: process.env.BILLING_DISABLED !== "true" && !!process.env.STRIPE_SECRET_KEY,
    email: !!process.env.RESEND_API_KEY,
    signupsOpen: process.env.SIGNUPS === "open",
  })),
});

