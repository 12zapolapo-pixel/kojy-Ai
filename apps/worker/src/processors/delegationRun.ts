/**
 * Delegation Run Processor
 * OWNERSHIP: apps/worker/src/processors
 *
 * BullMQ job processor for the DELEGATION_RUN queue. Each job represents
 * one user→Delegation agent interaction: it runs the full pipeline
 * (plan → code → test → deploy) and writes results back to MySQL.
 *
 * Why BullMQ and not in-process?
 * - The pipeline can take 30–120 seconds (LLM calls). A tRPC handler
 *   shouldn't block for that long.
 * - BullMQ provides retry, priority, and DLQ for free.
 * - The worker is the only process that writes to bot_scripts directly
 *   (the API only reads it via bots.getScripts).
 *
 * FLOW:
 *   delegation.sendMessage (tRPC) → enqueue DELEGATION_RUN
 *   processDelegationRun (this) runs the agent pipeline
 *   Publishes DelegationStatusEvent via Redis pub/sub at each stage
 *   Writes completed bot_scripts row to MySQL on success
 *   Signals runtime-manager.ts to reload scripts for the target bot
 */

import type { Job } from "bullmq";
import { eq, and, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createLogger } from "../services/logger.js";
import { db, schema } from "../db/client.js";
import { getRedisPublisher, publishBotControl } from "../services/redis.js";
import { getAllEmotes } from "../sqlite/emoteCache.js";
import { runDelegationAgent } from "@kojyai/engine/delegation";
import type { DelegationTaskStatus } from "@kojyai/engine/delegation";
import type { DelegationStatusEvent } from "@kojyai/shared/events";

const log = createLogger("delegation-run");

// ─── Job data shape ───────────────────────────────────────────────────────────

interface DelegationRunJobData {
  delegationSessionId: number;
  sessionUuid:         string;
  userId:              number;
  orgId:               number;
  botId:               number;
  botUuid:             string;
  botName:             string;
  roomId:              string;
  userRequest:         string;
  pastContext:         string[];
}

// ─── Processor ────────────────────────────────────────────────────────────────

export async function processDelegationRun(job: Job): Promise<void> {
  const data = job.data as DelegationRunJobData;
  const {
    delegationSessionId, sessionUuid, userId, orgId,
    botId, botUuid, botName, roomId, userRequest, pastContext,
  } = data;

  log.info({
    sessionUuid, botUuid, userId,
    request: userRequest.slice(0, 100),
  }, "Delegation agent pipeline starting");

  // ─── Load existing scripts for context ────────────────────────────────────

  const existingScripts = await db
    .select({ name: schema.botScripts.name })
    .from(schema.botScripts)
    .where(and(eq(schema.botScripts.botId, botId), eq(schema.botScripts.isActive, true)));

  const existingScriptNames = existingScripts.map((s) => s.name);

  // ─── Load emote catalog from SQLite ──────────────────────────────────────

  const emoteRows = getAllEmotes();
  const emoteCatalog = emoteRows
    .filter((e) => e.commandNum !== null)
    .map((e) => ({
      commandNum: e.commandNum!,
      emoteId:    e.emoteId,
      name:       e.name,
      rarity:     e.rarity,
    }));

  // ─── Status broadcaster ───────────────────────────────────────────────────

  const broadcastStatus = async (
    status: DelegationTaskStatus,
    message: string,
  ): Promise<void> => {
    // 1. Update delegation_sessions row in MySQL
    try {
      await db.update(schema.delegationSessions)
        .set({
          taskStatus: status as any,
          activeTask: status === "idle" || status === "done" || status === "failed"
            ? null
            : message,
        })
        .where(eq(schema.delegationSessions.id, delegationSessionId));
    } catch (err) {
      log.warn({ err }, "Failed to update delegation session status in DB");
    }

    // 2. Publish DelegationStatusEvent to Redis → WS gateway → frontend
    const redis = getRedisPublisher();
    if (redis) {
      const event: DelegationStatusEvent = {
        type:        "delegation_status",
        sessionUuid,
        taskStatus:  status,
        message,
        botId:       botUuid,
        ts:          Date.now(),
      };
      const channel = `delegation:${userId}`;
      await redis.publish(channel, JSON.stringify(event)).catch((err) => {
        log.warn({ err }, "Failed to publish delegation status to Redis");
      });
    }

    log.info(`[${status.toUpperCase()}] ${message}`);
  };

  // ─── Run the agent pipeline ───────────────────────────────────────────────
  //
  // Wrapped in try/catch so taskStatus ALWAYS reaches a terminal state, even
  // on an unhandled throw or the worker process dying mid-job. Without this,
  // a stuck "planning"/"coding" status would permanently trip delegation's
  // "one active run per user" guard — and because that guard is per-user
  // (not per-bot, per-project), it would lock the user out of Delegation
  // entirely, for every bot, not just the one in flight. Re-thrown after the
  // DB write so BullMQ's existing retry/DLQ handling still applies.
  let result: Awaited<ReturnType<typeof runDelegationAgent>>;
  try {
    result = await runDelegationAgent(
      {
        userRequest, sessionUuid, userId, orgId,
        botUuid, botName, roomId,
        existingScripts: existingScriptNames,
        pastContext,
        emoteCatalog: emoteCatalog.length > 0 ? emoteCatalog : null,
      },
      broadcastStatus,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error({ err, sessionUuid }, "delegation agent threw — marking session failed");
    try {
      await db.update(schema.delegationSessions)
        .set({ taskStatus: "failed", activeTask: null })
        .where(eq(schema.delegationSessions.id, delegationSessionId));
    } catch (dbErr) {
      log.warn({ dbErr, sessionUuid }, "Failed to persist failed status after agent throw");
    }
    throw err;
  }

  // ─── Handle result ────────────────────────────────────────────────────────

  if (!result.success) {
    log.warn({
      sessionUuid, reason: result.errorMessage,
    }, "Delegation agent pipeline failed");

    // Append failure message to the session's message history
    await appendAgentMessage(delegationSessionId, {
      role:    "assistant",
      content: result.errorMessage ?? "I wasn't able to complete that request. Please try rephrasing.",
      status:  "failed",
      scriptName: null,
    });

    return;
  }

  // ─── Write the completed script to bot_scripts ────────────────────────────

  const scriptUuid = nanoid(36).replace(/[^a-z0-9-]/gi, "-").slice(0, 36);

  // Deactivate any previous version of a script with this name
  await db.update(schema.botScripts)
    .set({ isActive: false })
    .where(
      and(
        eq(schema.botScripts.botId, botId),
        eq(schema.botScripts.name, result.scriptName),
      ),
    );

  // Find the version number for this script name
  const [latestVersion] = await db
    .select({ version: schema.botScripts.version })
    .from(schema.botScripts)
    .where(and(eq(schema.botScripts.botId, botId), eq(schema.botScripts.name, result.scriptName)))
    .orderBy(desc(schema.botScripts.version))
    .limit(1);

  const nextVersion = (latestVersion?.version ?? 0) + 1;

  await db.insert(schema.botScripts).values({
    uuid:               scriptUuid,
    botId,
    orgId,
    name:               result.scriptName,
    code:               result.code,
    description:        result.description,
    version:            nextVersion,
    isActive:           true,
    lastTestOutput:     result.testOutput,
    lastTestStatus:     "passed",
    lastTestedAt:       new Date(),
    delegationSessionId,
  });

  log.info({
    sessionUuid, scriptUuid, scriptName: result.scriptName,
    version: nextVersion, botUuid, retries: result.retries,
  }, "Bot script deployed");

  // ─── Signal runtime-manager to reload scripts for this bot ───────────────

  // SECURITY FIX (C-03): signed via publishBotControl instead of a raw
  // unsigned redis.publish — see packages/shared/src/crypto/botControlSignature.ts.
  await publishBotControl(botUuid, "reload_scripts")
    .catch((err) => log.warn({ err }, "Failed to signal script reload"));

  const redis = getRedisPublisher();

  // ─── Update session with success status + agent reply ─────────────────────

  const doneEvent: DelegationStatusEvent = {
    type:        "delegation_status",
    sessionUuid,
    taskStatus:  "done",
    message:     `"${result.scriptName}" is live on ${botName}! ${result.retries > 0 ? `(took ${result.retries} fix attempt${result.retries === 1 ? "" : "s"})` : ""}`,
    botId:       botUuid,
    scriptUuid,
    ts:          Date.now(),
  };

  if (redis) {
    await redis
      .publish(`delegation:${userId}`, JSON.stringify(doneEvent))
      .catch(() => null);
  }

  const agentReply = buildSuccessMessage(result.scriptName, botName, result.description, result.retries);

  await appendAgentMessage(delegationSessionId, {
    role:       "assistant",
    content:    agentReply,
    status:     "done",
    scriptName: result.scriptName,
    scriptUuid,
  });

  await db.update(schema.delegationSessions)
    .set({ taskStatus: "done", activeTask: null })
    .where(eq(schema.delegationSessions.id, delegationSessionId));

  log.info({ sessionUuid, scriptName: result.scriptName }, "Delegation agent pipeline complete");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function appendAgentMessage(
  sessionId: number,
  message: {
    role: "assistant";
    content: string;
    status: string;
    scriptName: string | null;
    scriptUuid?: string;
  },
): Promise<void> {
  const [session] = await db
    .select({ messages: schema.delegationSessions.messages })
    .from(schema.delegationSessions)
    .where(eq(schema.delegationSessions.id, sessionId))
    .limit(1);

  if (!session) return;

  const existing = (session.messages as any[]) ?? [];
  const updated = [
    ...existing,
    { ...message, ts: Date.now() },
  ];

  await db.update(schema.delegationSessions)
    .set({ messages: updated as any })
    .where(eq(schema.delegationSessions.id, sessionId));
}

function buildSuccessMessage(
  scriptName: string,
  botName:    string,
  description: string,
  retries:    number,
): string {
  const retrieNote = retries > 0
    ? ` It took ${retries} fix attempt${retries === 1 ? "" : "s"} to get all tests passing.`
    : "";

  return `✅ **"${scriptName}"** is now live on **${botName}**.\n\n${description}${retrieNote}\n\nThe script passed all tests in the sandbox before deploying. You can view the code in the Bot Detail → Scripts tab.`;
}
