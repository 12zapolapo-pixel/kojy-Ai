/**
 * KojyAI runner — hosts the owners' Python Highrise bots.
 * OWNERSHIP: apps/runner
 *
 * The API writes project files and publishes signed control messages on
 * `project_control:<uuid>`; this service runs each bot as its own process
 * (see supervisor.ts). Kept separate from the API so restarting or updating
 * the website never drops bots, and a misbehaving bot can't take the API down.
 */

import "./env.js";
import os from "node:os";
import { statfs } from "node:fs/promises";
import { Redis } from "ioredis";
import { createDb, runMigrations } from "@kojyai/db";
import { resolveRedisTls } from "@kojyai/shared/redis";
import { verifyBotControlMessage } from "@kojyai/shared/crypto";
import { createLogger } from "./logger.js";
import { Supervisor } from "./supervisor.js";
import { Agent } from "./agent/agent.js";

const log = createLogger("runner-boot");
const CONTROL_PREFIX = "project_control:";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  if (!process.env.ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY is not set");

  const { db, pool } = await createDb({
    url: process.env.DATABASE_URL,
    max: 4,
    log: { info: (m) => log.info(m), warn: (o, m) => log.warn(o as object, m ?? "") },
  });
  // The API normally applies migrations; doing it here too means the runner
  // can start first without failing on a missing table.
  if (process.env.DB_AUTO_MIGRATE !== "false") await runMigrations(db);

  const supervisor = new Supervisor(db);

  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  const redisOptions = {
    ...resolveRedisTls(url, (f, m) => log.warn(f, m)).options,
    password: process.env.REDIS_PASSWORD || undefined,
    retryStrategy: (times: number) => Math.min(times * 500, 5000),
  };
  const sub = new Redis(url, redisOptions);
  const redis = new Redis(url, redisOptions); // a subscribed connection can't run commands
  for (const c of [sub, redis]) c.on("error", (e: Error) => log.warn(`Redis error: ${e.message}`));

  const agent = new Agent(db, supervisor, redis);
  await agent.resetStates();
  // Subscribe only once both connections are fully ready: a subscribe issued
  // while ioredis is still connecting could leave the runner deaf to start/
  // stop commands (seen once in the all-in-one container). A self-test
  // message proves the subscription works, now and every minute after.
  const ready = (c: Redis) => (c.status === "ready" ? Promise.resolve() : new Promise<void>((res) => c.once("ready", () => res())));
  await Promise.all([ready(sub), ready(redis)]);
  await sub.psubscribe(`${CONTROL_PREFIX}*`);
  const SELFTEST = `${CONTROL_PREFIX}__selftest__`;
  let lastSelftest = 0;
  const checkSubscription = async (): Promise<void> => {
    const sentAt = Date.now();
    await redis.publish(SELFTEST, String(sentAt)).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 3000));
    if (lastSelftest >= sentAt) return;
    log.error("Not receiving control messages from the API — resubscribing");
    sub.disconnect(true); // reconnects, and ioredis resubscribes by itself
  };
  sub.on("pmessage", (_pattern: string, channel: string, raw: string) => {
    if (channel === SELFTEST) { lastSelftest = Number(raw) || Date.now(); return; }
    const uuid = channel.slice(CONTROL_PREFIX.length);
    const verified = verifyBotControlMessage(uuid, raw);
    if (!verified.ok) { log.warn(`Rejected project_control message for ${uuid}: ${verified.reason}`); return; }
    const target = verified.action.startsWith("agent") ? agent.handle(uuid, verified.action) : supervisor.handle(uuid, verified.action, verified.payload);
    target
      .catch((err) => log.error({ err, uuid, action: verified.action }, "Control action failed"));
  });

  await checkSubscription();
  setInterval(() => void checkSubscription(), 60_000).unref();

  await supervisor.restoreAll();
  log.info("Runner ready");

  // Heartbeat + host stats for the Infrastructure page (the runner sees the
  // bots' volume, so it reports disk space too). Expires if the runner dies.
  const projectsDir = process.env.PROJECTS_DIR ?? "/app/projects";
  const beat = async () => {
    let disk: { totalGb: number; freeGb: number } | null = null;
    try {
      const st = await statfs(projectsDir);
      disk = { totalGb: +(st.blocks * st.bsize / 1e9).toFixed(1), freeGb: +(st.bavail * st.bsize / 1e9).toFixed(1) };
    } catch { /* not supported here */ }
    await redis.set("runner:heartbeat", JSON.stringify({
      ts: Date.now(), bots: supervisor.runningCount(), rssMb: Math.round(process.memoryUsage().rss / 1048576),
      load: os.loadavg().map((n) => +n.toFixed(2)), cpus: os.cpus().length,
      memTotalMb: Math.round(os.totalmem() / 1048576), memFreeMb: Math.round(os.freemem() / 1048576),
      uptimeS: Math.round(process.uptime()), hostUptimeS: Math.round(os.uptime()), disk,
    }), "EX", 60).catch(() => undefined);
  };
  void beat();
  setInterval(() => void beat(), 15_000).unref();

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info(`${signal} — stopping bots`);
    await supervisor.shutdown();
    await Promise.allSettled([sub.quit(), redis.quit(), pool.end()]);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT",  () => void shutdown("SIGINT"));
}

main().catch((err) => {
  log.fatal({ err }, "Runner failed to start");
  process.exit(1);
});
