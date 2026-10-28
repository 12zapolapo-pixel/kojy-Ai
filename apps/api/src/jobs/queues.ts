/**
 * Job Queue — API-side client
 * OWNERSHIP: apps/api/src/jobs
 *
 * The worker app owns queue processors.
 * The API app only needs to ADD jobs to queues.
 * This file creates Queue clients (no Worker processors) for the API.
 */

import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { resolveRedisTls } from "@kojyai/shared/redis";
import { QUEUE_NAMES } from "@kojyai/shared/constants";
import { createLogger } from "../utils/logger.js";

const log = createLogger("api-queues");

const queues = new Map<string, Queue>();
let initialized = false;

import type { ConnectionOptions } from "bullmq";

// Fail-fast limits for the PRODUCER side (this file only ADDS jobs; the worker
// app has its own connections). See enqueue() for why both exist.
const ENQUEUE_READY_TIMEOUT_MS = 3_000;   // waiting for a usable Redis connection
const ENQUEUE_ADD_TIMEOUT_MS   = 10_000;  // backstop for a connected-but-stalled Redis

// RELIABILITY FIX (L-15): this used to open a brand-new Redis TCP connection for
// EVERY distinct queue (8-10 of them), multiplying across every API replica and
// reaching Redis's client limit far sooner than necessary. All producer queues
// now share ONE connection (BullMQ supports this for Queue instances; it is
// only Workers/QueueEvents that need their own blocking connections, and those
// live in apps/worker).
let _sharedConnection: Redis | null = null;

function getConnection(): Redis {
  if (_sharedConnection) return _sharedConnection;
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  _sharedConnection = new Redis(url, {
    // SECURITY FIX (L-06): TLS, same resolution as utils/redis.ts.
    ...resolveRedisTls(url, (f, m) => log.warn(f, m)).options,
    password:             process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
    lazyConnect:          false,
    // RELIABILITY FIX (M-11 follow-up): with the default offline queue, every
    // command issued while Redis is down is buffered in memory and waits
    // FOREVER — requests hang instead of failing, and (worse) the buffered
    // "add" fires when Redis comes back, running a job the caller was already
    // told had failed. Producers must fail fast instead. (This is the
    // documented BullMQ setting for producers; Workers must NOT use it.)
    enableOfflineQueue:   false,
  });
  // Without a listener an ioredis connection error on the shared client would
  // be an uncaught exception (the per-Queue listener only covers BullMQ's
  // re-emitted errors).
  _sharedConnection.on("error", (err) => log.warn({ err }, "Shared queue connection error"));
  return _sharedConnection;
}

function getOrCreateQueue(name: string): Queue {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, { connection: getConnection() as unknown as ConnectionOptions });
    // BullMQ re-emits connection errors on the Queue; an EventEmitter with no
    // "error" listener turns a Redis blip into an uncaught exception.
    queue.on("error", (err) => log.warn({ err, queue: name }, "Queue connection error"));
    queues.set(name, queue);
  }
  return queue;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Thrown when a job could not be queued. The message is deliberately generic
 * (it can reach API clients); the underlying cause is logged, not exposed.
 */
export class EnqueueError extends Error {
  constructor(public readonly queueName: string, cause?: unknown) {
    super("Could not queue the background job. Please try again.");
    this.name  = "EnqueueError";
    this.cause = cause;
  }
}

/**
 * Queue a job. Resolves to the job id, or THROWS EnqueueError.
 *
 * SECURITY/RELIABILITY FIX (M-11): this used to return `undefined` on failure,
 * and none of its call sites checked the return value — so a Redis problem
 * reported success everywhere (bot "started", Stripe event "processed", reset
 * email "sent") while nothing happened. It now fails loudly. Callers where the
 * job is a best-effort side effect of already-committed work must catch
 * EnqueueError themselves and log it; callers where queuing IS the operation
 * should let it propagate.
 */
export async function enqueue<T extends object>(
  queueName: string,
  data: T,
  options?: { delay?: number; priority?: number },
): Promise<string> {
  if (!process.env.REDIS_URL) {
    log.error(`Cannot enqueue ${queueName} — Redis not configured`);
    throw new EnqueueError(queueName, new Error("REDIS_URL not configured"));
  }
  try {
    const queue = getOrCreateQueue(queueName);

    // Step 1 — never issue a command unless Redis is actually connected. If the
    // wait times out, NOTHING was sent, so there is nothing that can be
    // replayed later (no ghost job) and the caller can safely retry.
    const client = await withTimeout(queue.waitUntilReady(), ENQUEUE_READY_TIMEOUT_MS, "Redis connection");
    if (client.status !== "ready") throw new Error(`Redis connection not ready (${client.status})`);

    // Step 2 — the add itself. enableOfflineQueue:false makes a connection that
    // drops mid-call reject immediately; the timeout is only a backstop for a
    // connected-but-stalled Redis.
    const job = await withTimeout(
      queue.add(`${queueName}:${Date.now()}`, data, options),
      ENQUEUE_ADD_TIMEOUT_MS,
      "Queue add",
    );
    return job.id ?? "";
  } catch (err) {
    log.error({ err }, `Failed to enqueue job on ${queueName}`);
    throw new EnqueueError(queueName, err);
  }
}

export { QUEUE_NAMES };

/** Waiting/active/failed/delayed job counts for each queue (Infrastructure page). */
export async function queueCounts(): Promise<{ name: string; waiting: number; active: number; failed: number; delayed: number; completed: number }[]> {
  return Promise.all(Object.values(QUEUE_NAMES).map(async (name) => {
    const c = await getOrCreateQueue(name).getJobCounts("waiting", "active", "failed", "delayed", "completed");
    return { name, waiting: c.waiting ?? 0, active: c.active ?? 0, failed: c.failed ?? 0, delayed: c.delayed ?? 0, completed: c.completed ?? 0 };
  }));
}
