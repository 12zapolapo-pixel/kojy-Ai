/**
 * KOJYAI Worker — Job Queue System
 *
 * OWNERSHIP: apps/worker/src/queues
 * LAYER: Infrastructure — background processing
 *
 * ARCHITECTURE:
 * - Built on BullMQ (Redis-backed queues)
 * - Each logical queue corresponds to a domain (intelligence, analytics, etc.)
 * - Processors are separate modules — one file per job type
 * - Cron scheduler adds recurring jobs on worker startup
 *
 * QUEUE TOPOLOGY:
 * ┌─────────────────────────────────────────────────────────┐
 * │ Redis (BullMQ backend)                                  │
 * │                                                         │
 * │  bot:lifecycle          → BotLifecycleProcessor        │
 * │  intelligence:memory    → MemoryCompressionProcessor   │
 * │  intelligence:churn     → ChurnPredictionProcessor     │
 * │  intelligence:relation  → RelationshipUpdateProcessor  │
 * │  analytics:aggregation  → AnalyticsAggregationProcessor│
 * │  notifications:delivery → NotificationDeliveryProcessor│
 * │  security:moderation    → ModerationScanProcessor      │
 * │  simulation:run         → SimulationRunProcessor       │
 * │  infra:backup           → BackupAutomationProcessor    │
 * │  notifications:email    → EmailSendProcessor           │
 * └─────────────────────────────────────────────────────────┘
 *
 * RETRY STRATEGY:
 * - Standard jobs: 3 attempts, exponential backoff (1min, 5min, 15min)
 * - Critical jobs (bot lifecycle, billing): 5 attempts, linear 2min
 * - Best-effort jobs (analytics): 1 attempt, no retry
 *
 * DEAD LETTER:
 * - Failed jobs after all retries → dead-letter queue: "dlq:{queue-name}"
 * - DLQ is monitored — alerts fire when count > 10
 * - Manual replay available via admin UI
 *
 * SCALING:
 * - Add more worker pods → BullMQ distributes jobs automatically
 * - Per-queue concurrency configured per resource intensity
 * - Memory-heavy jobs (compression, simulation): concurrency 2
 * - Light jobs (notifications, analytics): concurrency 10
 */

// QueueScheduler was removed in BullMQ v4 — scheduler is built into Queue now.
import { Queue, Worker, type Job, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { createLogger } from "../services/logger.js";
import { getWorkerRedisTlsOptions } from "../services/redis.js"; // L-06: one TLS resolution for every worker Redis client
import { QUEUE_NAMES } from "@kojyai/shared/constants";

// Processors
import { processMemoryCompression } from "../processors/memoryCompression.js";
import { processAnalyticsAggregation } from "../processors/analyticsAggregation.js";
import { processNotificationDelivery } from "../processors/notificationDelivery.js";
import { processChurnPrediction } from "../processors/churnPrediction.js";
import { processRelationshipUpdate } from "../processors/relationshipUpdate.js";
import { processModerationScan } from "../processors/moderationScan.js";
import { processSimulationRun } from "../processors/simulationRun.js";
import { processBackupAutomation } from "../processors/backupAutomation.js";
import { processEmailSend } from "../processors/emailSend.js";
import { processBotLifecycle } from "../processors/botLifecycle.js";
// FIX-19: AUDIT_FLUSH queue exists in shared constants but had no worker processor
import { processAuditFlush } from "../processors/auditFlush.js";
// BUG-2 FIX: STRIPE_WEBHOOK processor was missing entirely
import { processStripeWebhook } from "../processors/stripeWebhook.js";
// Emote catalog: daily refresh from webapi.highrise.game → SQLite
import { processEmoteCatalogRefresh } from "../processors/emoteCatalogRefresh.js";
// Delegation agent pipeline: plan → code → test → deploy
import { processDelegationRun } from "../processors/delegationRun.js";
// Highrise Bot Composer: full orchestrator (spec → code → sandbox → deploy)
import { processComposerRun }   from "../processors/composerRun.js";

const log = createLogger("queue-system");

// ─── Redis Connection ─────────────────────────────────────────────────────────

function createRedisConnection(): Redis {
  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    ...getWorkerRedisTlsOptions(), // SECURITY FIX (L-06)
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: false,
    lazyConnect: false,
  });

  redis.on("error", (err) => log.error({ err }, "Redis error"));
  redis.on("connect", () => log.info("Redis connected (worker)"));

  return redis;
}

/**
 * Adapts our ioredis `Redis` instance for BullMQ's `connection` option.
 *
 * This is a real but harmless cross-package type-declaration mismatch, not a
 * runtime bug: BullMQ's own `ConnectionOptions` type references ioredis's
 * `Redis` class via BullMQ's internal `import IORedis from "ioredis"`
 * (default-import style). Our code imports the same class via ioredis's
 * named `{ Redis }` export instead — required here because the default-import
 * style triggers a separate, genuine `tsc` resolution bug under this
 * project's `module: NodeNext` setting ("Cannot use namespace as a type").
 * Both imports resolve to the identical underlying class at runtime (ioredis
 * ships exactly one `Redis` implementation), which is why BullMQ has
 * connected and processed jobs correctly in every successful worker boot
 * this session — this is purely TypeScript treating two import paths to the
 * same class as nominally distinct types, not an actual incompatibility.
 *
 * Centralized here so every call site shares one explained cast instead of
 * repeating an unexplained `as unknown as ConnectionOptions`.
 */
function toBullMQConnection(client: Redis): ConnectionOptions {
  return client as unknown as ConnectionOptions;
}

// ─── Queue Registry ───────────────────────────────────────────────────────────

const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: "exponential" as const,
    delay: 60_000, // 1 minute base
  },
  removeOnComplete: { count: 100, age: 24 * 3600 },
  removeOnFail: { count: 50, age: 7 * 24 * 3600 },
};

const CRITICAL_JOB_OPTIONS = {
  ...DEFAULT_JOB_OPTIONS,
  attempts: 5,
  backoff: { type: "fixed" as const, delay: 120_000 }, // 2min fixed
};

const BEST_EFFORT_JOB_OPTIONS = {
  attempts: 1,
  removeOnComplete: { count: 50, age: 3600 },
  removeOnFail: { count: 10, age: 24 * 3600 },
};

// FIX-AUDIT: QueueDefinition.jobOptions was typed as `typeof DEFAULT_JOB_OPTIONS`,
// which TypeScript narrows to the literal backoff.type "exponential" (from the
// `as const`). But CRITICAL_JOB_OPTIONS legitimately uses "fixed" backoff, and
// BEST_EFFORT_JOB_OPTIONS has no backoff field at all — both are intentional,
// documented retry strategies (see header comment), not bugs. The old type
// just couldn't express that variety, which broke every queue definition that
// used anything other than DEFAULT_JOB_OPTIONS (8 of the 14 queues below).
interface JobOptionsShape {
  attempts: number;
  backoff?: { type: "exponential" | "fixed"; delay: number };
  removeOnComplete: { count: number; age: number };
  removeOnFail: { count: number; age: number };
}

// ─── Queue Definitions ────────────────────────────────────────────────────────

export interface QueueDefinition {
  name: string;
  concurrency: number;
  jobOptions: JobOptionsShape;
  processor: (job: Job) => Promise<unknown>;
  description: string;
}

const QUEUE_DEFINITIONS: QueueDefinition[] = [
  {
    name:        QUEUE_NAMES.BOT_LIFECYCLE,
    concurrency: 5,
    jobOptions:  CRITICAL_JOB_OPTIONS,
    processor:   processBotLifecycle,
    description: "Bot start/stop/restart lifecycle events",
  },
  {
    name:        QUEUE_NAMES.MEMORY_COMPRESSION,
    concurrency: 2, // AI API calls — keep concurrency low
    jobOptions:  DEFAULT_JOB_OPTIONS,
    processor:   processMemoryCompression,
    description: "Compresses raw bot memories using Claude",
  },
  {
    name:        QUEUE_NAMES.ANALYTICS_AGGREGATION,
    concurrency: 5,
    jobOptions:  BEST_EFFORT_JOB_OPTIONS,
    processor:   processAnalyticsAggregation,
    description: "Pre-aggregates metrics into analytics_snapshots",
  },
  {
    name:        QUEUE_NAMES.NOTIFICATION_DELIVERY,
    concurrency: 10,
    jobOptions:  DEFAULT_JOB_OPTIONS,
    processor:   processNotificationDelivery,
    description: "Delivers in-app and WS notifications to users",
  },
  {
    name:        QUEUE_NAMES.CHURN_PREDICTION,
    concurrency: 2,
    jobOptions:  BEST_EFFORT_JOB_OPTIONS,
    processor:   processChurnPrediction,
    description: "Runs churn prediction model per org",
  },
  {
    name:        QUEUE_NAMES.RELATIONSHIP_UPDATE,
    concurrency: 8,
    jobOptions:  DEFAULT_JOB_OPTIONS,
    processor:   processRelationshipUpdate,
    description: "Batched relationship score updates",
  },
  {
    name:        QUEUE_NAMES.MODERATION_SCAN,
    concurrency: 5,
    jobOptions:  DEFAULT_JOB_OPTIONS,
    processor:   processModerationScan,
    description: "Toxicity and moderation scanning",
  },
  {
    name:        QUEUE_NAMES.SIMULATION_RUN,
    concurrency: 2, // Simulation is compute-intensive
    jobOptions:  CRITICAL_JOB_OPTIONS,
    processor:   processSimulationRun,
    description: "Executes bot simulations",
  },
  {
    name:        QUEUE_NAMES.BACKUP_AUTOMATION,
    concurrency: 1,
    jobOptions:  CRITICAL_JOB_OPTIONS,
    processor:   processBackupAutomation,
    description: "Database and file backup automation",
  },
  {
    name:        QUEUE_NAMES.EMAIL_SEND,
    concurrency: 10,
    jobOptions:  DEFAULT_JOB_OPTIONS,
    processor:   processEmailSend,
    description: "Transactional email delivery",
  },
  {
    // FIX-19: AUDIT_FLUSH was defined in QUEUE_NAMES but had no entry here,
    // meaning audit log jobs enqueued from the API would sit in Redis forever.
    name:        QUEUE_NAMES.AUDIT_FLUSH,
    concurrency: 5,
    jobOptions:  BEST_EFFORT_JOB_OPTIONS, // audit flush is best-effort: no retry on fail
    processor:   processAuditFlush,
    description: "Flushes buffered audit log entries to the database",
  },
  {
    // BUG-2 FIX: STRIPE_WEBHOOK queue name existed in constants but had no
    // worker definition — enqueued Stripe events would pile up in Redis forever.
    name:        QUEUE_NAMES.STRIPE_WEBHOOK,
    concurrency: 3,
    jobOptions:  CRITICAL_JOB_OPTIONS, // billing events — 5 attempts, 2min fixed backoff
    processor:   processStripeWebhook,
    description: "Processes incoming Stripe webhook events (subscriptions, payments)",
  },
  {
    // Emote catalog refresh: daily fetch from webapi.highrise.game.
    // Low concurrency (1) — single global catalog, no reason to parallelize.
    // Best-effort: if it fails, the cached data from the previous day is still valid.
    name:        QUEUE_NAMES.EMOTE_CATALOG_REFRESH,
    concurrency: 1,
    jobOptions:  { ...DEFAULT_JOB_OPTIONS, attempts: 3 },
    processor:   processEmoteCatalogRefresh,
    description: "Refreshes the Highrise emote catalog in the SQLite cache",
  },
  {
    // Delegation agent pipeline: each job is one user→agent interaction.
    // Concurrency 3: allow up to 3 users' agents to run simultaneously.
    // CRITICAL priority: users wait for this — long waits are visible in the UI.
    name:        QUEUE_NAMES.DELEGATION_RUN,
    concurrency: 3,
    jobOptions:  CRITICAL_JOB_OPTIONS,
    processor:   processDelegationRun,
    description: "Runs the Delegation agent pipeline (plan → code → test → deploy)",
  },
  {
    // Highrise Bot Composer: the main product pipeline.
    // Concurrency 5 — each job is one user → AI → code → sandbox → deploy interaction.
    // CRITICAL priority: users are staring at this in real time.
    // Retry 2x on unexpected crashes (not on business-logic failures — those surface to user).
    name:        QUEUE_NAMES.COMPOSER_RUN,
    concurrency: 5,
    jobOptions:  { ...CRITICAL_JOB_OPTIONS, attempts: 2 },
    processor:   processComposerRun,
    description: "Runs the Highrise Bot Composer orchestrator pipeline",
  },
];

// ─── Queue Instances (exported for enqueueing from API) ───────────────────────

export const queues:  Map<string, Queue>  = new Map();
export const workers: Map<string, Worker> = new Map();

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initJobQueues(): void {
  const connection = createRedisConnection();

  for (const def of QUEUE_DEFINITIONS) {
    // Queue (for adding jobs — shared with API)
    const queue = new Queue(def.name, {
      connection: toBullMQConnection(connection.duplicate()),
      defaultJobOptions: def.jobOptions,
    });
    queues.set(def.name, queue);

    // Worker (for processing jobs)
    const worker = new Worker(
      def.name,
      async (job: Job) => {
        log.debug({
          jobId: job.id,
          queue: def.name,
          data: job.data,
        }, `Processing job ${job.id} on queue ${def.name}`);
        return def.processor(job);
      },
      {
        connection: toBullMQConnection(connection.duplicate()),
        concurrency: def.concurrency,
      },
    );
    workers.set(def.name, worker);

    // Worker event hooks
    worker.on("completed", (job) => {
      log.info({ jobId: job.id, queue: def.name }, "Job completed");
    });

    worker.on("failed", (job, err) => {
      log.error({
        jobId: job?.id,
        queue: def.name,
        error: err.message,
        attemptsMade: job?.attemptsMade,
      }, `Job failed`);

      // Move to DLQ after all retries exhausted
      if (job && job.attemptsMade >= (def.jobOptions.attempts ?? 3)) {
        void moveToDLQ(job, def.name, err, connection.duplicate());

        // Last-resort recovery: composerRun.ts / delegationRun.ts each wrap
        // their own agent call in try/catch to persist a "failed" state on
        // a thrown error — but that can't run at all if the worker process
        // itself was killed mid-job (OOM, restart, crash), which is exactly
        // the failure mode documented as routine in this environment. If
        // every retry is exhausted and the row is STILL sitting in a busy
        // stage, force it to failed here so composer.run's and
        // delegation.sendMessage's concurrency guards can never
        // permanently lock a project/session out from ever running again.
        if (def.name === QUEUE_NAMES.COMPOSER_RUN && job.data?.dbProjectId) {
          void db.update(schema.composerProjects)
            .set({ stage: "failed", lastError: `Job failed after ${job.attemptsMade} attempts: ${err.message}`, activeTask: null, updatedAt: new Date() } as any)
            .where(eq(schema.composerProjects.id, job.data.dbProjectId))
            .catch((dbErr) => log.warn({ dbErr, jobId: job.id }, "Failed to reset stuck composer project after DLQ"));
        }
        if (def.name === QUEUE_NAMES.DELEGATION_RUN && job.data?.delegationSessionId) {
          void db.update(schema.delegationSessions)
            .set({ taskStatus: "failed", activeTask: null } as any)
            .where(eq(schema.delegationSessions.id, job.data.delegationSessionId))
            .catch((dbErr) => log.warn({ dbErr, jobId: job.id }, "Failed to reset stuck delegation session after DLQ"));
        }
      }
    });

    log.info(`Queue initialized: ${def.name} (concurrency: ${def.concurrency})`);
  }

  // Start cron scheduler
  initCronScheduler();

  log.info(`All ${QUEUE_DEFINITIONS.length} queues initialized`);
}

/**
 * Gracefully closes all BullMQ workers and queues.
 * Workers drain in-flight jobs before closing (up to BullMQ's default drain timeout).
 * Called by the shutdown handler in boot.ts before closing Redis + DB.
 */
export async function closeAllQueues(): Promise<void> {
  // Close workers first — they hold the active job locks
  await Promise.allSettled(
    Array.from(workers.values()).map((w) => w.close()),
  );
  // Close queue clients (for enqueue side)
  await Promise.allSettled(
    Array.from(queues.values()).map((q) => q.close()),
  );
}

// ─── Cron Scheduler ───────────────────────────────────────────────────────────

function initCronScheduler(): void {
  const connection = createRedisConnection();

  const CRON_JOBS = [
    {
      queue: QUEUE_NAMES.MEMORY_COMPRESSION,
      cron: "0 */6 * * *",          // Every 6 hours
      name: "memory-compression-sweep",
      data: { type: "sweep_all_orgs" },
    },
    {
      queue: QUEUE_NAMES.ANALYTICS_AGGREGATION,
      cron: "0 * * * *",            // Every hour
      name: "hourly-analytics",
      data: { period: "hour" },
    },
    {
      queue: QUEUE_NAMES.ANALYTICS_AGGREGATION,
      cron: "0 0 * * *",            // Daily at midnight UTC
      name: "daily-analytics",
      data: { period: "day" },
    },
    {
      queue: QUEUE_NAMES.CHURN_PREDICTION,
      cron: "0 4 * * *",            // Daily at 4am UTC (off-peak)
      name: "daily-churn-prediction",
      data: {},
    },
    {
      queue: QUEUE_NAMES.BACKUP_AUTOMATION,
      cron: "0 2 * * *",            // Daily at 2am UTC
      name: "daily-backup",
      data: {},
    },
    {
      // Emote catalog: fetch once per day at 3am UTC (after backup, before peak).
      // Uses force:false so it's a no-op if the cache was recently refreshed
      // (e.g. manual force-refresh or same-day worker restart).
      queue: QUEUE_NAMES.EMOTE_CATALOG_REFRESH,
      cron: "0 3 * * *",            // Daily at 3am UTC
      name: "daily-emote-catalog-refresh",
      data: { force: false },
    },
  ];

  for (const cronJob of CRON_JOBS) {
    const queue = queues.get(cronJob.queue);
    if (!queue) {
      log.warn(`Cannot schedule cron for unknown queue: ${cronJob.queue}`);
      continue;
    }

    void queue.add(cronJob.name, cronJob.data, {
      repeat: { pattern: cronJob.cron },
      jobId: `cron:${cronJob.name}`,
    });

    log.info(`Cron scheduled: ${cronJob.name} (${cronJob.cron})`);
  }
}

// ─── DLQ ─────────────────────────────────────────────────────────────────────

async function moveToDLQ(
  job: Job,
  queueName: string,
  error: Error,
  connection: Redis,
): Promise<void> {
  try {
    const dlqName = `dlq:${queueName}`;
    const dlq = new Queue(dlqName, { connection: toBullMQConnection(connection) });
    await dlq.add("failed-job", {
      originalJobId: job.id,
      originalQueue: queueName,
      data: job.data,
      error: error.message,
      stack: error.stack,
      failedAt: new Date().toISOString(),
    });
    log.warn({ jobId: job.id }, `Moved failed job to DLQ: ${dlqName}`);
  } catch (dlqError) {
    log.error({ jobId: job.id, dlqError }, "Failed to move job to DLQ");
  }
}

// ─── Helper: Enqueue ──────────────────────────────────────────────────────────

/** Type-safe helper for enqueueing jobs from the API */
export async function enqueue<T extends object>(
  queueName: string,
  data: T,
  options?: { delay?: number; priority?: number },
): Promise<string> {
  // M-11: fail loudly instead of returning undefined (callers never checked it).
  const queue = queues.get(queueName);
  if (!queue) {
    log.error(`Unknown queue: ${queueName}`);
    throw new Error(`Unknown queue: ${queueName}`);
  }
  const job = await queue.add(
    `${queueName}:${Date.now()}`,
    data,
    {
      ...(options?.delay    !== undefined ? { delay: options.delay }       : {}),
      ...(options?.priority !== undefined ? { priority: options.priority } : {}),
    },
  );
  return job.id ?? "";
}
