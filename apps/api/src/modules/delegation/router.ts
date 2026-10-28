/**
 * Delegation Module Router
 * OWNERSHIP: apps/api/src/modules/delegation
 *
 * PROCEDURES:
 * - delegation.getSession   — get/create user's delegation session
 * - delegation.sendMessage  — send a message to the Delegation agent
 * - delegation.getScripts   — get all bot_scripts for a given bot
 * - delegation.getEmotes    — get the emote catalog from SQLite
 * - delegation.refreshEmotes — force-refresh the emote catalog
 * - delegation.getMemories  — get delegation memories for the user
 *
 * SECURITY:
 * - All procedures: requireAuth
 * - sendMessage: rate-limited (max 1 concurrent agent run per user)
 * - getScripts: org-scoped (user can only see scripts for their bots)
 */

import { z }             from "zod";
import { eq, and, desc, inArray } from "drizzle-orm";
import { TRPCError }     from "@trpc/server";
import { nanoid }        from "nanoid";
import { router, protectedProc } from "../../trpc.js";
import { resolveOrgId } from "../../utils/resolveOrgId.js"; // M-08/M-13: single canonical implementation
import { schema }        from "../../db/client.js";
import { createLogger }  from "../../utils/logger.js";
import { enqueue }       from "../../jobs/queues.js";
import { QUEUE_NAMES }   from "@kojyai/shared/constants";
import { recall }        from "../../db/memoryStore.js";
import { readEmoteCatalog } from "./emoteReader.js";

const log = createLogger("delegation-module");

// ─── Router ───────────────────────────────────────────────────────────────────

export const delegationRouter = router({

  // ── Get or create session ─────────────────────────────────────────────────

  getSession: protectedProc
    .query(async ({ ctx }) => {
      const orgId = await resolveOrgId(ctx);

      // Each user has exactly one delegation session (enforced by unique index)
      const [existing] = await ctx.db
        .select()
        .from(schema.delegationSessions)
        .where(eq(schema.delegationSessions.userId, ctx.user.id))
        .limit(1);

      if (existing) {
        return {
          uuid:       existing.uuid,
          messages:   (existing.messages as SessionMessage[]) ?? [],
          memory:     existing.memory ?? {},
          taskStatus: existing.taskStatus,
          activeTask: existing.activeTask,
        };
      }

      // Create a fresh session
      const uuid = nanoid(36).replace(/[^a-z0-9-]/gi, "-").slice(0, 36);
      const welcomeMessage: SessionMessage = {
        role:    "assistant",
        content: "👋 Hi! I'm your Delegation agent. Describe a bot feature in plain English and I'll code, test, and deploy it for you.\n\nExamples:\n• \"Let people emote by typing a number 1–200 (rare and epic emotes only)\"\n• \"Auto-kick anyone who sends 10+ messages in a row\"\n• \"Greet every new user with their username and a wave\"",
        ts:      Date.now(),
        status:  "done",
        scriptName: null,
      };

      await ctx.db.insert(schema.delegationSessions).values({
        uuid,
        userId:    ctx.user.id,
        orgId,
        messages:  [welcomeMessage] as any,
        memory:    {} as any,
        taskStatus: "idle",
      });

      return {
        uuid,
        messages:   [welcomeMessage],
        memory:     {},
        taskStatus: "idle" as const,
        activeTask: null,
      };
    }),

  // ── Send a message to the Delegation agent ────────────────────────────────

  sendMessage: protectedProc
    .input(z.object({
      message: z.string().min(1).max(2000),
      botId:   z.string(), // UUID of the bot to target
    }))
    .mutation(async ({ input, ctx }) => {
      const orgId = await resolveOrgId(ctx);

      // Verify the bot exists and belongs to the user's org
      const [bot] = await ctx.db
        .select({ id: schema.bots.id, uuid: schema.bots.uuid, name: schema.bots.name, activeRoomId: schema.bots.activeRoomId })
        .from(schema.bots)
        .where(and(eq(schema.bots.uuid, input.botId), eq(schema.bots.orgId, orgId)))
        .limit(1);

      if (!bot) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Bot not found." });
      }

      // Get/create delegation session
      let [session] = await ctx.db
        .select()
        .from(schema.delegationSessions)
        .where(eq(schema.delegationSessions.userId, ctx.user.id))
        .limit(1);

      if (!session) {
        const uuid = nanoid(36).replace(/[^a-z0-9-]/gi, "-").slice(0, 36);
        await ctx.db.insert(schema.delegationSessions).values({
          uuid,
          userId: ctx.user.id,
          orgId,
          messages:  [] as any,
          memory:    {} as any,
          taskStatus: "idle",
        });
        [session] = await ctx.db
          .select()
          .from(schema.delegationSessions)
          .where(eq(schema.delegationSessions.userId, ctx.user.id))
          .limit(1);
      }

      if (!session) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to create delegation session." });
      }

      // Guard: only one active run at a time per user
      if (session.taskStatus !== "idle" && session.taskStatus !== "done" && session.taskStatus !== "failed") {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: `Agent is currently ${session.taskStatus}. Please wait for the current task to complete.`,
        });
      }

      // Append the user's message to history
      const existingMessages = (session.messages as SessionMessage[]) ?? [];
      const userMessage: SessionMessage = {
        role:       "user",
        content:    input.message,
        ts:         Date.now(),
        status:     null,
        scriptName: null,
      };

      // SECURITY FIX (M-14 / M-25): the guard above is a read-then-write, so
      // two concurrent sendMessage calls could both read "idle" and both start
      // an agent run (double execution / double spend). The read stays as a
      // fast path for a friendly error; THIS conditional UPDATE is the real
      // guard — the WHERE clause only matches while the session is still
      // startable, so exactly one caller wins and the rest get no row back.
      const claimed = await ctx.db.update(schema.delegationSessions)
        .set({
          messages:   [...existingMessages, userMessage] as any,
          taskStatus: "planning",
          activeTask: input.message,
        })
        .where(and(
          eq(schema.delegationSessions.id, session.id),
          inArray(schema.delegationSessions.taskStatus, ["idle", "done", "failed"]),
        ))
        .returning({ id: schema.delegationSessions.id });

      if (claimed.length === 0) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Agent is already working on a task. Please wait for it to complete.",
        });
      }

      // Recall similar past requests from pgvector memory
      let pastContext: string[] = [];
      try {
        const memories = await recall(ctx.user.id, input.message, 5);
        pastContext = memories.map((m) => m.summary);
      } catch {
        // Memory recall is non-critical — continue without it
      }

      // Enqueue the delegation run job
      await enqueue(QUEUE_NAMES.DELEGATION_RUN, {
        delegationSessionId: session.id,
        sessionUuid:         session.uuid,
        userId:              ctx.user.id,
        orgId,
        botId:               bot.id,
        botUuid:             bot.uuid,
        botName:             bot.name,
        roomId:              bot.activeRoomId ?? "",
        userRequest:         input.message,
        pastContext,
      });

      log.info({
        sessionUuid: session.uuid,
        userId: ctx.user.id,
        botUuid: bot.uuid,
      }, "Delegation job enqueued");

      return {
        sessionUuid: session.uuid,
        status:      "planning" as const,
        message:     "Agent is planning your request…",
      };
    }),

  // ── Get scripts for a bot ─────────────────────────────────────────────────

  getScripts: protectedProc
    .input(z.object({ botId: z.string() }))
    .query(async ({ input, ctx }) => {
      const orgId = await resolveOrgId(ctx);

      const [bot] = await ctx.db
        .select({ id: schema.bots.id })
        .from(schema.bots)
        .where(and(eq(schema.bots.uuid, input.botId), eq(schema.bots.orgId, orgId)))
        .limit(1);

      if (!bot) throw new TRPCError({ code: "NOT_FOUND", message: "Bot not found." });

      const scripts = await ctx.db
        .select({
          uuid:            schema.botScripts.uuid,
          name:            schema.botScripts.name,
          description:     schema.botScripts.description,
          version:         schema.botScripts.version,
          isActive:        schema.botScripts.isActive,
          lastTestStatus:  schema.botScripts.lastTestStatus,
          lastTestOutput:  schema.botScripts.lastTestOutput,
          lastTestedAt:    schema.botScripts.lastTestedAt,
          code:            schema.botScripts.code,
          createdAt:       schema.botScripts.createdAt,
        })
        .from(schema.botScripts)
        .where(eq(schema.botScripts.botId, bot.id))
        .orderBy(desc(schema.botScripts.createdAt));

      return scripts;
    }),

  // ── Delete a script ───────────────────────────────────────────────────────

  deleteScript: protectedProc
    .input(z.object({ scriptUuid: z.string(), botId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const orgId = await resolveOrgId(ctx);

      const [bot] = await ctx.db
        .select({ id: schema.bots.id })
        .from(schema.bots)
        .where(and(eq(schema.bots.uuid, input.botId), eq(schema.bots.orgId, orgId)))
        .limit(1);

      if (!bot) throw new TRPCError({ code: "NOT_FOUND", message: "Bot not found." });

      await ctx.db
        .update(schema.botScripts)
        .set({ isActive: false })
        .where(
          and(
            eq(schema.botScripts.uuid, input.scriptUuid),
            eq(schema.botScripts.botId, bot.id),
          ),
        );

      return { success: true };
    }),

  // ── Get emote catalog ─────────────────────────────────────────────────────

  getEmotes: protectedProc
    .input(z.object({
      rarity: z.enum(["common", "rare", "epic", "all"]).default("all"),
    }))
    .query(async ({ input }) => {
      return readEmoteCatalog(input.rarity); // L-32: filter is now actually applied
    }),

  // ── Force-refresh emote catalog ───────────────────────────────────────────

  refreshEmotes: protectedProc
    .mutation(async () => {
      // Enqueue a force refresh job — returns immediately
      await enqueue(QUEUE_NAMES.EMOTE_CATALOG_REFRESH, { force: true });
      return { message: "Emote catalog refresh queued — check back in a moment." };
    }),

  // ── Get delegation memories ───────────────────────────────────────────────

  getMemories: protectedProc
    .input(z.object({
      query: z.string().min(1).max(500).optional(),
      limit: z.number().min(1).max(50).default(20),
    }))
    .query(async ({ input, ctx }) => {
      try {
        const memories = await recall(ctx.user.id, input.query ?? "recent delegation work", input.limit);
        return memories;
      } catch {
        return [];
      }
    }),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

export interface SessionMessage {
  role:       "user" | "assistant";
  content:    string;
  ts:         number;
  status:     "done" | "failed" | null;
  scriptName: string | null;
  scriptUuid?: string;
}

