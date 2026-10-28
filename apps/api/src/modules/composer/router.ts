/**
 * Composer Module Router
 * OWNERSHIP: apps/api/src/modules/composer
 *
 * All tRPC procedures powering the Highrise Bot Composer page.
 *
 * PROCEDURES:
 *
 * composer.run
 *   Accepts a user prompt + project context.
 *   Creates or updates a composer project in MySQL.
 *   Enqueues a COMPOSER_RUN BullMQ job.
 *   Returns projectId immediately — the frontend then subscribes to
 *   WS delegation_status events tagged with that projectId for live updates.
 *
 * composer.getProject
 *   Returns full project state: spec, files, test results, history.
 *   Used by the frontend on initial load to restore a previous session.
 *
 * composer.listProjects
 *   All composer projects for the authenticated user, most recent first.
 *
 * composer.deleteProject
 *   Soft-delete (marks isArchived = true).
 *
 * composer.getTemplates
 *   Returns all available Highrise bot templates for the template picker.
 *
 * composer.saveCredentials
 *   Saves the Highrise bot token into the encrypted vault.
 *   Token is encrypted with AES-256-GCM server-side and stored in MySQL.
 *   The raw token is NEVER returned after this call — only a vault reference.
 *
 * composer.getBotStatus
 *   Returns current bot lifecycle status (offline/connecting/online/crashed).
 *   Polls the runtime-manager for live bots, or returns stored last status.
 *
 * composer.controlBot
 *   Send start/stop/restart/broadcast to a deployed bot.
 *   Publishes to the bot_control:* Redis channel.
 *
 * composer.downloadProject
 *   Returns all generated project files as base64-encoded zip content.
 *   The client decodes and triggers a browser download.
 */

import { z }             from "zod";
import { eq, and, desc, notInArray } from "drizzle-orm";
import { TRPCError }     from "@trpc/server";
import { nanoid }        from "nanoid";
import { router, protectedProc } from "../../trpc.js";
import { resolveOrgId } from "../../utils/resolveOrgId.js"; // M-08/M-13: single canonical implementation
import { schema }        from "../../db/client.js";
import { createLogger }  from "../../utils/logger.js";
import { enqueue }       from "../../jobs/queues.js";
import { QUEUE_NAMES }   from "@kojyai/shared/constants";
import { encryptApiKey, decryptApiKey, signBotControlMessage } from "@kojyai/shared/crypto";
import { hasPermission } from "@kojyai/shared/permissions";
import { HIGHRISE_BOT_TEMPLATES } from "@kojyai/engine/highrise";
import { getRedisPublisher }      from "../../utils/redis.js";

const log = createLogger("composer-module");

// ─── Input validation ─────────────────────────────────────────────────────────

const RunInput = z.object({
  projectId:  z.string().optional(),
  botName:    z.string().min(1).max(100),
  language:   z.enum(["python", "javascript"]).default("python"),
  roomId:     z.string().max(200).default(""),
  userPrompt: z.string().min(3).max(4000),
  // L-11: accepted for backward compatibility with older clients but IGNORED.
  // Conversation history is taken from what the server itself stored for the
  // project; a client-supplied "assistant" turn can no longer be injected.
  history: z.array(z.object({
    role:    z.enum(["user", "assistant"]),
    content: z.string().max(8000),
  })).max(50).default([]),
});

/**
 * L-12: true only for a plain relative path with no traversal. Generated file
 * paths come from an LLM, so they are treated as untrusted before they are ever
 * handed to a client that may write them to disk / extract them.
 */
export function isSafeRelativePath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0 || p.length > 260) return false;
  if (p.includes("\0")) return false;
  if (p.startsWith("/") || p.startsWith("\\") || /^[a-zA-Z]:/.test(p)) return false; // absolute / UNC / drive letter
  if (p.includes("\\")) return false; // backslashes are a traversal vector on Windows extractors
  return !p.split("/").some((seg) => seg === ".." || seg === "." || seg === "");
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const composerRouter = router({

  // ── Run pipeline ────────────────────────────────────────────────────────────

  run: protectedProc
    .input(RunInput)
    .mutation(async ({ input, ctx }) => {
      const orgId = await resolveOrgId(ctx);

      let projectId = input.projectId;
      let dbProjectId: number;

      const BUSY_STAGES = ["spec", "codegen", "sandbox", "testing", "fixing", "deploying", "monitoring"] as const;

      if (projectId) {
        // Verify ownership
        const [existing] = await ctx.db
          .select({ id: schema.composerProjects.id, uuid: schema.composerProjects.uuid, stage: schema.composerProjects.stage })
          .from(schema.composerProjects)
          .where(and(
            eq(schema.composerProjects.uuid, projectId),
            eq(schema.composerProjects.userId, ctx.user.id),
          ))
          .limit(1);

        if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found." });

        // Guard: only one active pipeline run per project at a time.
        // Previously missing here (Delegation has the equivalent check for
        // its single session) — without it, a double-click, retry, or a
        // second open tab on the same project could fire two concurrent
        // runs, each updating the same composerProjects row mid-pipeline.
        if ((BUSY_STAGES as readonly string[]).includes(existing.stage)) {
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: `This project is currently ${existing.stage}. Please wait for the current run to finish.`,
          });
        }

        dbProjectId = existing.id;

        // Atomic guard: the busy-check and the stage transition happen in a
        // single conditional UPDATE, not a separate SELECT-then-UPDATE. A
        // live concurrent-load test (5 truly simultaneous requests on the
        // same project) proved the previous SELECT-then-UPDATE version had
        // a real race window: 2 of the 5 both read "not busy" and both got
        // queued, before either had written "spec" back. Row-level locking
        // on this single UPDATE's WHERE clause makes that impossible now —
        // only one concurrent request's UPDATE can match stage NOT IN (busy)
        // and return a row.
        const updateResult = await ctx.db.update(schema.composerProjects)
          .set({
            botName:    input.botName,
            language:   input.language,
            roomId:     input.roomId || null,
            stage:      "spec",
            activeTask: input.userPrompt.slice(0, 200),
            updatedAt:  new Date(),
          })
          .where(and(
            eq(schema.composerProjects.id, dbProjectId),
            notInArray(schema.composerProjects.stage, [...BUSY_STAGES]),
          ))
          .returning({ id: schema.composerProjects.id });

        if (updateResult.length === 0) {
          // Lost the race (or, extremely unlikely, the row vanished between
          // the ownership check above and here). Re-read to give a precise
          // error — safe to do here since we're on the reject path, not
          // proceeding to mutate anything further.
          const [current] = await ctx.db
            .select({ stage: schema.composerProjects.stage })
            .from(schema.composerProjects)
            .where(eq(schema.composerProjects.id, dbProjectId))
            .limit(1);
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: current
              ? `This project is currently ${current.stage}. Please wait for the current run to finish.`
              : "Project not found.",
          });
        }

      } else {
        // Create a new project
        projectId = nanoid(36).replace(/[^a-z0-9-]/gi, "-").slice(0, 36);
        const [created] = await ctx.db.insert(schema.composerProjects).values({
          uuid:       projectId,
          userId:     ctx.user.id,
          orgId,
          botName:    input.botName,
          language:   input.language,
          roomId:     input.roomId || "",
          stage:      "spec",
          activeTask: input.userPrompt.slice(0, 200),
          history:    [] as any,
          spec:       null,
          files:      [] as any,
          testResults: [] as any,
          logs:       [] as any,
        }).returning({ id: schema.composerProjects.id });
        dbProjectId = created!.id;
      }

      // Append user message to history in DB
      const [current] = await ctx.db
        .select({ history: schema.composerProjects.history })
        .from(schema.composerProjects)
        .where(eq(schema.composerProjects.id, dbProjectId))
        .limit(1);

      const existingHistory = (current?.history as any[]) ?? [];
      await ctx.db.update(schema.composerProjects)
        .set({
          history: [
            ...existingHistory,
            { role: "user", content: input.userPrompt, ts: Date.now() },
          ] as any,
        })
        .where(eq(schema.composerProjects.id, dbProjectId));

      // Enqueue the orchestrator job
      await enqueue(QUEUE_NAMES.COMPOSER_RUN, {
        projectId,
        dbProjectId,
        userId:     ctx.user.id,
        orgId,
        botName:    input.botName,
        language:   input.language,
        roomId:     input.roomId,
        userPrompt: input.userPrompt,
        // L-11: server-side history only — see RunInput. Same shape/limits the
        // worker has always received (<=50 turns, <=8000 chars each).
        history:    existingHistory
          .filter((h) => h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string")
          .slice(-50)
          .map((h) => ({ role: h.role as "user" | "assistant", content: String(h.content).slice(0, 8000) })),
      });

      log.info({
        projectId,
        userId: ctx.user.id,
        prompt: input.userPrompt.slice(0, 80),
      }, "Composer run enqueued");

      return { projectId, status: "queued" as const };
    }),

  // ── Get project ─────────────────────────────────────────────────────────────

  getProject: protectedProc
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input, ctx }) => {
      const [project] = await ctx.db
        .select()
        .from(schema.composerProjects)
        .where(and(
          eq(schema.composerProjects.uuid, input.projectId),
          eq(schema.composerProjects.userId, ctx.user.id),
        ))
        .limit(1);

      if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found." });

      return {
        id:          project.uuid,
        botName:     project.botName,
        language:    project.language,
        roomId:      project.roomId,
        stage:       project.stage,
        activeTask:  project.activeTask,
        history:     (project.history  as any[]) ?? [],
        spec:        project.spec       as any ?? null,
        files:       (project.files    as any[]) ?? [],
        testResults: (project.testResults as any[]) ?? [],
        logs:        (project.logs     as any[]) ?? [],
        botId:       project.botId,             // null until first successful deploy
        hasToken:    Boolean(project.tokenVault), // presence only — never expose the token itself
        createdAt:   project.createdAt,
        updatedAt:   project.updatedAt,
      };
    }),

  // ── List projects ────────────────────────────────────────────────────────────

  listProjects: protectedProc
    .input(z.object({
      limit:  z.number().min(1).max(50).default(20),
      offset: z.number().min(0).default(0),
    }))
    .query(async ({ input, ctx }) => {
      const projects = await ctx.db
        .select({
          uuid:      schema.composerProjects.uuid,
          botName:   schema.composerProjects.botName,
          language:  schema.composerProjects.language,
          stage:     schema.composerProjects.stage,
          createdAt: schema.composerProjects.createdAt,
          updatedAt: schema.composerProjects.updatedAt,
        })
        .from(schema.composerProjects)
        .where(eq(schema.composerProjects.userId, ctx.user.id))
        .orderBy(desc(schema.composerProjects.updatedAt))
        .limit(input.limit)
        .offset(input.offset);

      return projects;
    }),

  // ── Delete project ───────────────────────────────────────────────────────────

  deleteProject: protectedProc
    .input(z.object({ projectId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const [existing] = await ctx.db
        .select({ id: schema.composerProjects.id })
        .from(schema.composerProjects)
        .where(and(
          eq(schema.composerProjects.uuid, input.projectId),
          eq(schema.composerProjects.userId, ctx.user.id),
        ))
        .limit(1);

      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found." });

      await ctx.db.update(schema.composerProjects)
        .set({ isArchived: true, updatedAt: new Date() })
        .where(eq(schema.composerProjects.id, existing.id));

      return { success: true };
    }),

  // ── Get templates ────────────────────────────────────────────────────────────

  getTemplates: protectedProc
    .query(async () => {
      return HIGHRISE_BOT_TEMPLATES.map(t => ({
        id:          t.id,
        name:        t.name,
        description: t.description,
        difficulty:  t.difficulty,
        prompt:      t.prompt,
      }));
    }),

  // ── Save credentials to vault ────────────────────────────────────────────────

  saveCredentials: protectedProc
    .input(z.object({
      projectId: z.string(),
      token:     z.string().min(10).max(500),
      roomId:    z.string().max(200).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const [project] = await ctx.db
        .select({ id: schema.composerProjects.id })
        .from(schema.composerProjects)
        .where(and(
          eq(schema.composerProjects.uuid, input.projectId),
          eq(schema.composerProjects.userId, ctx.user.id),
        ))
        .limit(1);

      if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found." });

      let encryptedToken: string;
      try {
        encryptedToken = encryptApiKey(input.token);
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Server is not configured to store Highrise tokens securely (ENCRYPTION_KEY missing). Contact your administrator.",
        });
      }

      await ctx.db.update(schema.composerProjects)
        .set({
          tokenVault: encryptedToken,
          // Only touch roomId if the caller actually sent one — `roomId` is
          // optional precisely so a token can be rotated without requiring
          // the room ID again; treating "not provided" as "clear it" would
          // silently wipe an already-configured room.
          ...(input.roomId !== undefined ? { roomId: input.roomId } : {}),
          updatedAt:  new Date(),
        })
        .where(eq(schema.composerProjects.id, project.id));

      log.info({
        projectId: input.projectId,
        userId:    ctx.user.id,
      }, "Bot token saved to vault");

      return {
        success:   true,
        encrypted: true,
        message:   "Token saved and encrypted with AES-256-GCM",
      };
    }),

  // ── Get bot status ───────────────────────────────────────────────────────────

  getBotStatus: protectedProc
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input, ctx }) => {
      const [project] = await ctx.db
        .select({
          id:         schema.composerProjects.id,
          stage:      schema.composerProjects.stage,
          botId:      schema.composerProjects.botId,
          roomId:     schema.composerProjects.roomId,
          lastError:  schema.composerProjects.lastError,
          updatedAt:  schema.composerProjects.updatedAt,
        })
        .from(schema.composerProjects)
        .where(and(
          eq(schema.composerProjects.uuid, input.projectId),
          eq(schema.composerProjects.userId, ctx.user.id),
        ))
        .limit(1);

      if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found." });

      // No deployed bot yet — nothing to poll. This is the common case for a
      // project still in spec/codegen/testing, and is NOT the same thing as
      // "offline" (which implies a bot exists but isn't connected).
      if (!project.botId) {
        return {
          stage:            project.stage,
          lifecycleStatus:  "not_deployed" as const,
          botId:            null,
          healthScore:      null,
          lastHeartbeat:    null,
          roomId:           project.roomId,
          lastError:        project.lastError,
          lastUpdated:      project.updatedAt,
        };
      }

      // Real status lives on `bots`, actively maintained by runtime-manager.ts
      // (connect/disconnect/error/heartbeat) — not derivable from `stage`,
      // which only ever tracks the generation pipeline, never bot connectivity.
      const [bot] = await ctx.db
        .select({
          status:          schema.bots.status,
          healthScore:     schema.bots.healthScore,
          lastSeen:        schema.bots.lastSeen,
          connectionError: schema.bots.connectionError,
        })
        .from(schema.bots)
        .where(eq(schema.bots.id, project.botId))
        .limit(1);

      return {
        stage:            project.stage,
        lifecycleStatus:  bot?.status ?? "offline",
        botId:            project.botId,
        healthScore:      bot?.healthScore ?? null,
        lastHeartbeat:    bot?.lastSeen ?? null,
        roomId:           project.roomId,
        lastError:        bot?.connectionError ?? project.lastError,
        lastUpdated:      project.updatedAt,
      };
    }),

  // ── Control deployed bot ─────────────────────────────────────────────────────

  controlBot: protectedProc
    .input(z.object({
      projectId: z.string(),
      action:    z.enum(["start", "stop", "restart", "broadcast"]),
      message:   z.string().max(500).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      // Same permission the dashboard's equivalent endpoints enforce via
      // permittedProc() (bots/router.ts: start/restart/broadcastMessage all
      // require "bots:start", stop requires "bots:stop"). controlBot can't
      // use that static wrapper directly since one procedure here handles
      // all four actions dynamically — so the same check happens inline.
      // Found via a live cross-surface audit during the Phase 6 pentest:
      // this procedure previously only required protectedProc, meaning a
      // Composer-originated bot wasn't governed by the same authorization
      // as a dashboard-originated one, even though both go through the
      // identical bot_control:* signal afterward.
      const requiredPermission = input.action === "stop" ? "bots:stop" : "bots:start";
      if (!hasPermission(ctx.user.role, ctx.user.tier, requiredPermission)) {
        throw new TRPCError({ code: "FORBIDDEN", message: `Missing permission: ${requiredPermission}` });
      }

      const [project] = await ctx.db
        .select({
          id:    schema.composerProjects.id,
          uuid:  schema.composerProjects.uuid,
          botId: schema.composerProjects.botId,
        })
        .from(schema.composerProjects)
        .where(and(
          eq(schema.composerProjects.uuid, input.projectId),
          eq(schema.composerProjects.userId, ctx.user.id),
        ))
        .limit(1);

      if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found." });

      // A project only has a controllable bot once it has actually deployed
      // one (composerProjects.botId is set on first successful deploy).
      // Previously this published to composer_control:{project.uuid} — a
      // channel nothing has ever subscribed to — and returned
      // { success: true } unconditionally, regardless of whether a bot
      // existed. That made the Start/Stop/Restart/Broadcast buttons a
      // silent no-op. Report the real state instead.
      if (!project.botId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This project hasn't deployed a bot yet — nothing to control.",
        });
      }

      const [bot] = await ctx.db
        .select({ uuid: schema.bots.uuid })
        .from(schema.bots)
        .where(eq(schema.bots.id, project.botId))
        .limit(1);

      if (!bot) {
        // botId pointed at a bot row that no longer exists (deleted bot).
        throw new TRPCError({ code: "NOT_FOUND", message: "The deployed bot for this project no longer exists." });
      }

      const redis = getRedisPublisher();
      if (redis) {
        // Same bot_control:* channel — and same payload shape — that the
        // Bots dashboard and Delegation already use. runtime-manager.ts is
        // the one real subscriber; routing through it means Composer's
        // controls go through the identical start/stop/restart/broadcast
        // handling as every other bot on the platform, not a separate path.
        // SECURITY FIX (C-03): signed — runtime-manager.ts's subscriber now
        // verifies an HMAC (shared secret derived from ENCRYPTION_KEY, which
        // this process already requires) before acting on bot_control:*.
        await redis.publish(
          bot.uuid ? `bot_control:${bot.uuid}` : "",
          signBotControlMessage(
            bot.uuid,
            input.action,
            input.message ? { message: input.message } : undefined,
          ),
        );
      } else {
        log.warn({ projectId: input.projectId, action: input.action }, "No Redis publisher available — control command not sent");
        throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Bot control is temporarily unavailable." });
      }

      log.info({
        projectId: input.projectId,
        botUuid:   bot.uuid,
        action:    input.action,
        userId:    ctx.user.id,
      }, "Bot control command");

      return { success: true, action: input.action };
    }),

  // ── Download project files ───────────────────────────────────────────────────

  downloadProject: protectedProc
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input, ctx }) => {
      const [project] = await ctx.db
        .select({ files: schema.composerProjects.files, botName: schema.composerProjects.botName })
        .from(schema.composerProjects)
        .where(and(
          eq(schema.composerProjects.uuid, input.projectId),
          eq(schema.composerProjects.userId, ctx.user.id),
        ))
        .limit(1);

      if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found." });

      const files = (project.files as any[]) ?? [];
      if (files.length === 0) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No files generated yet." });

      // L-12: drop (and report) anything whose path isn't a plain relative path.
      const safe: Array<{ path: string; content: string; lang: string }> = [];
      let skipped = 0;
      for (const f of files) {
        if (f && isSafeRelativePath(f.path) && typeof f.content === "string") safe.push(f);
        else skipped++;
      }
      if (skipped > 0) log.warn({ projectId: input.projectId, skipped }, "downloadProject: dropped files with unsafe paths");
      if (safe.length === 0) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No downloadable files." });

      // Frontend handles zip creation or display
      return { botName: project.botName, files: safe, skippedUnsafePaths: skipped };
    }),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

