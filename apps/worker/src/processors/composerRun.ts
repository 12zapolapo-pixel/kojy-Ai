/**
 * Composer Run Processor
 * OWNERSHIP: apps/worker/src/processors
 *
 * Executes the full Highrise Bot Orchestrator pipeline for one user prompt.
 * Publishes DelegationStatusEvents to Redis at each stage so the frontend
 * Composer page updates in real time via WebSocket.
 *
 * Pipeline: prompt → spec → codegen → sandbox → testing → [fix] → deploy → done
 *
 * On completion writes: spec, files, testResults, history back to composer_projects row.
 * On successful deploy (roomId + token present, tests passed): creates a
 * real bots row (first deploy) or version-bumps its bot_scripts (subsequent
 * runs on an already-deployed project), sets composerProjects.botId, and
 * starts/reloads it via bot_control:* — see writeGeneratedScripts() below.
 * There is no botPid/monitoring concept here — a Composer-built bot runs as
 * registered ScriptPlugins inside runtime-manager's shared process, the
 * same as every other bot, not as its own separate process.
 * On failure writes: lastError, stage=failed.
 */

import type { Job } from "bullmq";
import { eq, and, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../db/client.js";
import { getRedisPublisher, publishBotControl } from "../services/redis.js";
import { createLogger }      from "../services/logger.js";
import { runHighriseOrchestrator } from "@kojyai/engine/highrise";
import type { PipelineStage, ComposerStageEvent, ProjectFile, TestResult, HighriseBotSpec, ComposerArtifact } from "@kojyai/engine/highrise";
import type { DelegationStatusEvent } from "@kojyai/shared/events";
import { decryptApiKey } from "@kojyai/shared/crypto";
import { createBotRecord, BotQuotaExceededError } from "@kojyai/shared/highrise";

const log = createLogger("composer-run");

// ─── Job data shape ───────────────────────────────────────────────────────────

interface ComposerRunJobData {
  projectId:  string;
  dbProjectId: number;
  userId:     number;
  orgId:      number;
  botName:    string;
  language:   "python" | "javascript";
  roomId:     string;
  userPrompt: string;
  history:    Array<{ role: "user" | "assistant"; content: string }>;
}

// ─── Processor ───────────────────────────────────────────────────────────────

export async function processComposerRun(job: Job): Promise<void> {
  const data = job.data as ComposerRunJobData;
  const { projectId, dbProjectId, userId, orgId, botName, language, roomId, userPrompt, history } = data;

  log.info({
    projectId, userId, botName,
    prompt: userPrompt.slice(0, 100),
  }, "Composer pipeline starting");

  // ── Stage broadcaster ──────────────────────────────────────────────────────

  const broadcast = async (event: ComposerStageEvent): Promise<void> => {
    // 1. Update DB stage
    const dbUpdate: Record<string, unknown> = {
      stage:     event.stage,
      updatedAt: new Date(),
    };

    if (event.artifact?.kind === "spec") {
      dbUpdate.spec = event.artifact.spec;
    }
    if (event.artifact?.kind === "code") {
      dbUpdate.files = event.artifact.files;
    }
    if (event.artifact?.kind === "testResult") {
      dbUpdate.testResults = event.artifact.results;
    }
    if (event.stage === "done") {
      dbUpdate.activeTask = null;
    }
    if (event.stage === "failed") {
      dbUpdate.lastError  = event.message;
      dbUpdate.activeTask = null;
    }

    try {
      await db.update(schema.composerProjects)
        .set(dbUpdate as any)
        .where(eq(schema.composerProjects.id, dbProjectId));
    } catch (err) {
      log.warn({ err }, "Failed to update composer project stage in DB");
    }

    // 2. Publish WS event to Redis → gateway → frontend
    const redis = getRedisPublisher();
    if (redis) {
      const wsEvent: DelegationStatusEvent & { projectId: string; artifact?: ComposerArtifact | undefined } = {
        type:        "delegation_status",
        sessionUuid: projectId,
        taskStatus:  event.stage as any,
        message:     event.message,
        botId:       projectId,
        ts:          event.ts,
        projectId,          // frontend uses this to match to the right composer instance
        artifact:    event.artifact, // spec / files / testResults / deploy / deployError — previously dropped, never reached the browser
      };
      await redis.publish(`delegation:${userId}`, JSON.stringify(wsEvent)).catch((err) => {
        log.warn({ err }, "Failed to publish composer stage event to Redis");
      });
    }

    log.info({ projectId }, `[${event.stage.toUpperCase()}] ${event.message}`);
  };

  // ── Fetch token from vault if room deploy is intended ──────────────────────

  let apiTokenRef = "";
  if (roomId) {
    try {
      const [project] = await db
        .select({ tokenVault: schema.composerProjects.tokenVault })
        .from(schema.composerProjects)
        .where(eq(schema.composerProjects.id, dbProjectId))
        .limit(1);
      apiTokenRef = project?.tokenVault ?? "";
    } catch (err) {
      log.warn({ err }, "Failed to fetch token vault");
    }
  }

  // ── Run orchestrator ───────────────────────────────────────────────────────
  //
  // Wrapped in try/catch so stage ALWAYS reaches a terminal state ("failed"),
  // even on an unhandled throw (LLM API error, etc.) or the worker process
  // itself dying mid-job. Without this, a project could be left stuck at a
  // busy stage (e.g. "codegen") forever — composer.run's concurrency guard
  // would then permanently refuse to ever re-run it, since it only allows
  // starting from idle/done/failed. The error is re-thrown after the DB
  // write so BullMQ's own retry (attempts: 2) and dead-letter-queue handling
  // still apply exactly as before; a retry re-enters from "failed", which
  // the guard already permits.
  let result: Awaited<ReturnType<typeof runHighriseOrchestrator>>;
  try {
    result = await runHighriseOrchestrator(
      {
        userPrompt,
        projectId,
        botName,
        language,
        roomId,
        apiTokenRef,
        history,
      },
      broadcast,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error({ err, projectId }, "composer run threw — marking project failed");
    try {
      await db.update(schema.composerProjects)
        .set({ stage: "failed", lastError: message, activeTask: null, updatedAt: new Date() } as any)
        .where(eq(schema.composerProjects.id, dbProjectId));
    } catch (dbErr) {
      log.warn({ dbErr, projectId }, "Failed to persist failed stage after orchestrator throw");
    }
    throw err;
  }

  // ── Deploy: create/update the real bot now that tests passed ──────────────
  //
  // Previously this was entirely cosmetic — deployHighriseBot() logged a
  // message and returned a fake {status:"deployed"} object; nothing was
  // ever written to the bots table, and the frontend's Deploy button (in
  // ToolsPanel) had no onClick handler at all. This is the real
  // implementation: first deploy creates a bot row via the same
  // createBotRecord() apps/api's "+ New Bot" button uses (not a duplicate
  // — the actual shared function), writes each generated file as a
  // bot_scripts row using the same version-bump pattern Delegation already
  // uses, and starts it via bot_control:* — the same channel/mechanism
  // every other bot control path on the platform uses.
  let deployInfo: { botId: number; botUuid: string; roomName: string } | null = null;
  let deployError: string | null = null;

  if (result.success && roomId && apiTokenRef) {
    await broadcast({ stage: "deploying", message: `Deploying "${botName}" to room ${roomId}…`, ts: Date.now() });
    try {
      const [existingProject] = await db
        .select({ botId: schema.composerProjects.botId })
        .from(schema.composerProjects)
        .where(eq(schema.composerProjects.id, dbProjectId))
        .limit(1);

      const plaintextToken = decryptApiKey(apiTokenRef);

      if (!existingProject?.botId) {
        // First deploy — create the real bot.
        const created = await createBotRecord(
          {
            orgId, ownerId: userId,
            name: botName,
            highriseApiKey: plaintextToken,
            activeRoomId: roomId,
            greetMessage: undefined, personality: undefined, language: undefined,
            runtimeMode: "ai",
            tags: ["composer-built"],
          },
          {
            db, schema, eq, and,
            count: (await import("drizzle-orm")).count,
            makeUuid: () => nanoid(36).replace(/[^a-z0-9-]/gi, "-").slice(0, 36),
          },
        );

        await writeGeneratedScripts(created.botId, orgId, result.files, null);

        await db.update(schema.composerProjects)
          .set({ botId: created.botId, updatedAt: new Date() } as any)
          .where(eq(schema.composerProjects.id, dbProjectId));

        await db.insert(schema.auditLogs).values({
          actorId: userId, actorType: "user", action: "bot.create",
          resourceType: "bot", resourceId: created.uuid,
          afterState: { name: botName, orgId, source: "composer" },
        });

        // SECURITY FIX (C-03): signed via publishBotControl rather than a raw
        // unsigned redis.publish — the API's bot_control:* subscriber now
        // verifies an HMAC before acting on anything on this channel.
        await publishBotControl(created.uuid, "start")
          .catch((err) => log.warn({ err }, "Failed to signal bot start after composer deploy"));

        deployInfo = { botId: created.botId, botUuid: created.uuid, roomName: created.roomName };
        log.info({ projectId, botId: created.botId, botUuid: created.uuid }, "Composer deploy: bot created and started");
      } else {
        // Re-running an already-deployed project (e.g. asked for another
        // feature) — this bot already exists, so version-bump its scripts
        // instead of creating a second bot for the same project.
        const [bot] = await db
          .select({ uuid: schema.bots.uuid })
          .from(schema.bots)
          .where(eq(schema.bots.id, existingProject.botId))
          .limit(1);

        if (bot) {
          await writeGeneratedScripts(existingProject.botId, orgId, result.files, null);

          // SECURITY FIX (C-03): signed, see note above.
          await publishBotControl(bot.uuid, "reload_scripts")
            .catch((err) => log.warn({ err }, "Failed to signal script reload after composer re-run"));
          deployInfo = { botId: existingProject.botId, botUuid: bot.uuid, roomName: roomId };
          log.info({ projectId, botId: existingProject.botId }, "Composer deploy: existing bot's scripts updated");
        } else {
          deployError = "This project's previously-deployed bot no longer exists.";
        }
      }
    } catch (err) {
      if (err instanceof BotQuotaExceededError) {
        deployError = err.message;
      } else {
        deployError = err instanceof Error ? err.message : "Deploy failed for an unknown reason";
        log.error({ err, projectId }, "Composer deploy failed");
      }
    }
  }

  // ── Broadcast final result (also persists stage/spec/files/testResults) ──

  const resultMessage = buildResultMessage(result, botName, deployInfo, deployError);

  await broadcast({
    stage:   result.success ? "done" : "failed",
    message: resultMessage,
    ts:      Date.now(),
    ...(deployInfo
      ? { artifact: { kind: "deploy" as const, botId: deployInfo.botId, botUuid: deployInfo.botUuid, roomName: deployInfo.roomName } }
      : deployError
      ? { artifact: { kind: "deployError" as const, message: deployError } }
      : {}),
  });

  // broadcast() doesn't touch conversation history (not a pipeline-stage
  // artifact) — appended here as the one remaining field this function owns.
  const finalHistory = [
    ...history,
    { role: "user"      as const, content: userPrompt,   ts: Date.now() - 1000 },
    { role: "assistant" as const, content: resultMessage, ts: Date.now() },
  ];

  await db.update(schema.composerProjects)
    .set({ history: finalHistory as any } as any)
    .where(eq(schema.composerProjects.id, dbProjectId));

  log.info({
    projectId,
    success:  result.success,
    retries:  result.retries,
    files:    result.files.length,
    deployed: deployInfo !== null,
  }, "Composer pipeline complete");
}

// ─── Deploy Helpers ─────────────────────────────────────────────────────────

/**
 * Writes each generated file as a bot_scripts row, using the exact same
 * version-bump pattern delegationRun.ts already uses (deactivate any
 * previous version of a script with this name, find the next version
 * number, insert) — so a Composer-built bot's scripts and a
 * Delegation-edited bot's scripts are managed identically, not by two
 * different versioning schemes.
 */
async function writeGeneratedScripts(
  botId: number,
  orgId: number,
  files: ProjectFile[],
  delegationSessionId: number | null,
): Promise<void> {
  for (const file of files) {
    const scriptName = file.path.replace(/\.(ts|js)$/, "");

    await db.update(schema.botScripts)
      .set({ isActive: false })
      .where(and(eq(schema.botScripts.botId, botId), eq(schema.botScripts.name, scriptName)));

    const [latestVersion] = await db
      .select({ version: schema.botScripts.version })
      .from(schema.botScripts)
      .where(and(eq(schema.botScripts.botId, botId), eq(schema.botScripts.name, scriptName)))
      .orderBy(desc(schema.botScripts.version))
      .limit(1);

    const nextVersion = (latestVersion?.version ?? 0) + 1;
    const scriptUuid = nanoid(36).replace(/[^a-z0-9-]/gi, "-").slice(0, 36);

    await db.insert(schema.botScripts).values({
      uuid: scriptUuid, botId, orgId,
      name: scriptName,
      code: file.content,
      description: `Generated by Composer`,
      version: nextVersion,
      isActive: true,
      lastTestOutput: "Passed sandbox tests as part of Composer's generation pipeline",
      lastTestStatus: "passed",
      lastTestedAt: new Date(),
      delegationSessionId,
    });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildResultMessage(
  result: Awaited<ReturnType<typeof runHighriseOrchestrator>>,
  botName: string,
  deployInfo: { botId: number; botUuid: string; roomName: string } | null,
  deployError: string | null,
): string {
  if (!result.success) {
    return `❌ **Failed**: ${result.errorMessage ?? "Unknown error"}\n\nTry rephrasing your prompt or check the test details in the Simulation tab.`;
  }

  const fileList = result.files.map(f => `\`${f.path}\``).join(", ");
  const retryNote = result.retries > 0
    ? ` (${result.retries} fix attempt${result.retries > 1 ? "s" : ""} needed to pass all tests)`
    : "";
  const testSummary = `**Tests:** ${result.testResults.filter(t => t.passed).length}/${result.testResults.length} passed`;

  if (deployInfo) {
    return `✅ **"${botName}"** is ready${retryNote} and **live in ${deployInfo.roomName}**!\n\n**Generated files:** ${fileList}\n\n${testSummary}\n\nFind it on your Bots page — it's starting up now.`;
  }

  if (deployError) {
    return `✅ **"${botName}"** passed all tests${retryNote}, but deploying it failed: ${deployError}\n\n**Generated files:** ${fileList}\n\n${testSummary}\n\nFix the issue above and send another message to retry — the generated code is saved.`;
  }

  return `✅ **"${botName}"** is ready${retryNote}!\n\n**Generated files:** ${fileList}\n\n${testSummary}\n\nAdd your Highrise API token and Room ID in the Deploy tab to bring it live.`;
}
