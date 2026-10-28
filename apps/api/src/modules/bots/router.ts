/**
 * Bots Module Router
 *
 * OWNERSHIP: apps/api/src/modules/bots
 * LAYER: API — bot management and orchestration
 *
 * PROCEDURES:
 * - bots.list        — paginated bot list for the org
 * - bots.get         — single bot by ID
 * - bots.overview    — Mission Control aggregate view
 * - bots.create      — create new bot
 * - bots.update      — update bot config
 * - bots.delete      — soft-delete bot
 * - bots.start       — start bot process
 * - bots.stop        — stop bot process
 * - bots.restart     — restart bot process
 * - bots.stopAll     — stop all org bots
 * - bots.restartAll  — restart all org bots
 * - bots.healthCheckAll — trigger health check on all bots
 * - bots.getLogs     — paginated log history
 * - bots.broadcastMessage — send message via all specified bots
 * - bots.updatePersonality — update personality DNA
 * - bots.getMemories — paginated memory entries
 * - bots.getRelationships — relationship graph data
 *
 * SECURITY:
 * - All procedures: requireAuth + org membership check
 * - delete: requires "bots:delete"; start/restart/broadcastMessage: "bots:start"; stop/stopAll: "bots:stop"
 * - stopAll/restartAll use the SAME bots:stop/bots:start permission as single
 *   start/stop — NOT admin-only, despite what this comment used to claim.
 *   Any user-role member can bulk-stop/restart every bot in the org. If that's
 *   not the intended policy, gate these two behind adminProc instead — not
 *   changed here since narrowing authorization is a product decision, not a
 *   drive-by fix. (Found during the Phase 6 cross-surface audit.)
 * - Org isolation: WHERE orgId = ctx.user.orgId on every query
 */

import { z }           from "zod";
import { eq, and, desc, count, sql, inArray } from "drizzle-orm"; // FIX-14: inArray added
import { TRPCError }   from "@trpc/server";
import { nanoid }      from "nanoid";
import { router, protectedProc, permittedProc } from "../../trpc.js";
import { schema }      from "../../db/client.js"; // FIX-2: schema re-exported from client.ts
import { createLogger } from "../../utils/logger.js";
import { broadcastBotEvent, broadcastOrgEvent } from "../../websocket/gateway.js";
import { emitAuditLog } from "../../events/audit.js";
import { resolveOrgId } from "../../utils/resolveOrgId.js"; // M-08/M-13: single canonical implementation
import { enqueue }     from "../../jobs/queues.js";
import { QUEUE_NAMES } from "@kojyai/shared/constants";
import { buildPersonalityPrompt, createDefaultPersonalityProfile, validatePersonalityProfile } from "@kojyai/engine/personality";
import { encryptApiKey, decryptApiKey, migrateKey } from "@kojyai/shared/crypto";
import { validateHighriseCredentials } from "@kojyai/shared/highrise";
import { createBotRecord, BotQuotaExceededError } from "@kojyai/shared/highrise";
import { startBotLoop } from "./runtime-manager.js";

const log = createLogger("bots-module");

// ─── Output Sanitization ──────────────────────────────────────────────────────
//
// SECURITY FIX: bots.list and bots.get previously did `select()` (all columns)
// and returned the row straight to the client — including `highriseApiKey`,
// which holds the AES-encrypted Highrise credential. Even encrypted, this
// ciphertext should never leave the server (defense in depth: if ENCRYPTION_KEY
// is ever compromised, an attacker shouldn't also need DB access to get the
// ciphertext — and there's no legitimate frontend use case for it).
//
// sanitizeBot() strips it from any bot row before it's returned over tRPC.
function sanitizeBot<T extends Record<string, unknown> & {
  id: unknown; uuid: string; orgId: number; ownerId: number; personalityProfileId: number | null;
}>(
  bot: T,
): Omit<T, "highriseApiKey" | "id" | "orgId" | "ownerId" | "personalityProfileId">
  & { id: string; orgId: string; ownerId: string; personalityProfileId: string | null } {
  const { highriseApiKey: _highriseApiKey, id: _numericId, orgId, ownerId, personalityProfileId, ...safe } = bot;
  // The frontend's Bot type (routing, getBotById, getBotAvatarGradient,
  // WS subscriptions) all treat ids as strings and `id` as the UUID — the
  // numeric auto-increment primary keys are internal-only details.
  return {
    ...safe,
    id:      bot.uuid,
    orgId:   String(orgId),
    ownerId: String(ownerId),
    personalityProfileId: personalityProfileId === null ? null : String(personalityProfileId),
  };
}

type RelationshipRow = typeof schema.botRelationships.$inferSelect;

/** A relationship with public ids: bots by UUID, users by their id as a string. */
function toApiRelationship(r: RelationshipRow, uuidByBotId: Map<number, string>) {
  return {
    ...r,
    id:       String(r.id),
    botId:    uuidByBotId.get(r.botId) ?? String(r.botId),
    targetId: r.targetType === "bot" ? (uuidByBotId.get(r.targetId) ?? String(r.targetId)) : String(r.targetId),
    targetType: r.targetType as "bot" | "user",
  };
}

// ─── Input Schemas ────────────────────────────────────────────────────────────

const BotIdInput = z.object({ id: z.string() });

const CreateBotInput = z.object({
  name:            z.string().min(1).max(150),
  highriseApiKey:  z.string().min(10).max(600),
  activeRoomId:    z.string().min(1).max(200),
  greetMessage:    z.string().max(2000).optional(),
  personality:     z.string().max(5000).optional(),
  language:        z.string().length(2).default("en"),
  runtimeMode:     z.enum(["ai", "scripted", "hybrid"]).default("ai"),
  tags:            z.array(z.string().max(50)).max(20).default([]),
});

const UpdateBotInput = z.object({
  id:           z.string(),
  name:         z.string().min(1).max(150).optional(),
  greetMessage: z.string().max(2000).optional(),
  personality:  z.string().max(5000).optional(),
  language:     z.string().length(2).optional(),
  runtimeMode:  z.enum(["ai", "scripted", "hybrid"]).optional(),
  tags:         z.array(z.string().max(50)).max(20).optional(),
  isActive:     z.boolean().optional(),
  // Moving a bot or replacing its token: checked against Highrise first.
  highriseApiKey: z.string().min(10).max(600).optional(),
  activeRoomId:   z.string().min(1).max(200).optional(),
});

const GetLogsInput = z.object({
  botId:  z.string(),
  cursor: z.coerce.number().int().min(0).optional(),
  limit:  z.number().min(1).max(200).default(100),
});

const BroadcastInput = z.object({
  message: z.string().min(1).max(2000),
  botIds:  z.array(z.string()).min(1).max(50),
});

// ─── Router ───────────────────────────────────────────────────────────────────

// ─── Fleet-wide lifecycle actions ─────────────────────────────────────────────
//
// RELIABILITY FIX: stopAll / restartAll / healthCheckAll used to loop
// `await enqueue(...)` and only THEN write their audit row. Since enqueue()
// now throws on failure (M-11), a failure partway through (say bot 7 of 20)
// skipped the audit row entirely — so 6 bots had already been stopped with no
// record of who did it. Now every bot is attempted, the audit row is written
// in ALL cases (recording exactly which bots were queued and which failed),
// and only afterwards is a partial failure reported to the caller.
async function runFleetAction(
  ctx:         { db: Parameters<typeof emitAuditLog>[0]; user: { id: number }; ip: string },
  orgId:       number,
  bots:        Array<{ uuid: string }>,
  action:      "stop" | "restart" | "health_check",
  auditAction: string,
): Promise<{ queued: string[] }> {
  const queued: string[] = [];
  const failed: string[] = [];

  for (const bot of bots) {
    try {
      await enqueue(QUEUE_NAMES.BOT_LIFECYCLE, { action, botId: bot.uuid });
      queued.push(bot.uuid);
    } catch (err) {
      failed.push(bot.uuid);
      log.error({ err, botId: bot.uuid, action }, "Fleet action: could not queue bot");
    }
  }

  // One row per batch (not per bot): a single record a reviewer can find,
  // instead of N rows that bury who pressed the button.
  await emitAuditLog(ctx.db, {
    actorId:      ctx.user.id,
    actorType:    "user",
    orgId,
    action:       auditAction,
    resourceType: "organization",
    resourceId:   String(orgId),
    afterState:   { count: queued.length, botIds: queued, ...(failed.length ? { failedBotIds: failed } : {}) },
    ip:           ctx.ip,
  });

  if (failed.length > 0) {
    throw new TRPCError({
      code:    "INTERNAL_SERVER_ERROR",
      message: `Only ${queued.length} of ${bots.length} bots were queued (${failed.length} failed). Please try again.`,
    });
  }
  return { queued };
}

export const botsRouter = router({

  // ── List ───────────────────────────────────────────────────────────────────

  list: protectedProc
    .input(z.object({
      cursor: z.number().optional(),
      limit:  z.number().min(1).max(100).default(50),
      status: z.enum(["online","offline","connecting","error","suspended","all"]).default("all"),
    }))
    .query(async ({ input, ctx }) => {
      const orgId = await resolveOrgId(ctx);

      const conditions = [eq(schema.bots.orgId, orgId)];
      if (input.status !== "all") {
        conditions.push(eq(schema.bots.status, input.status));
      }

      const bots = await ctx.db
        .select()
        .from(schema.bots)
        .where(and(...conditions))
        .orderBy(desc(schema.bots.lastSeen))
        .limit(input.limit + 1)
        .offset(input.cursor ?? 0);

      const hasMore = bots.length > input.limit;
      const trimmed = hasMore ? bots.slice(0, -1) : bots;
      return {
        bots:    trimmed.map(sanitizeBot),
        hasMore,
        nextCursor: hasMore ? (input.cursor ?? 0) + input.limit : undefined,
      };
    }),

  // ── Get ────────────────────────────────────────────────────────────────────

  get: protectedProc
    .input(BotIdInput)
    .query(async ({ input, ctx }) => {
      const orgId = await resolveOrgId(ctx);
      const bot = await findBotByUuid(ctx.db, input.id, orgId);
      return sanitizeBot(bot);
    }),

  // ── Overview (Mission Control) ─────────────────────────────────────────────

  overview: protectedProc
    .query(async ({ ctx }) => {
      const orgId = await resolveOrgId(ctx);

      // Parallel queries for Mission Control aggregates
      const [bots, statsResult] = await Promise.all([
        ctx.db.select().from(schema.bots).where(eq(schema.bots.orgId, orgId)),
        ctx.db
          .select({
            total:   count(),
            online:  sql<number>`SUM(CASE WHEN ${schema.bots.status} = 'online' THEN 1 ELSE 0 END)`.mapWith(Number),
            offline: sql<number>`SUM(CASE WHEN ${schema.bots.status} = 'offline' THEN 1 ELSE 0 END)`.mapWith(Number),
            error:   sql<number>`SUM(CASE WHEN ${schema.bots.status} = 'error' THEN 1 ELSE 0 END)`.mapWith(Number),
          })
          .from(schema.bots)
          .where(eq(schema.bots.orgId, orgId)),
      ]);

      // FIX-14: botRelationships has no orgId column — filter through bot IDs
      // The previous query used schema.bots.orgId against botRelationships which is
      // referencing the wrong table and returns all or zero rows.
      const botIds = bots.map((b) => b.id);
      const relationships = botIds.length > 0
        ? await ctx.db
            .select()
            .from(schema.botRelationships)
            .where(inArray(schema.botRelationships.botId, botIds))
        : [];

      const stats = statsResult[0];
      const uuidByBotId = new Map(bots.map((b) => [b.id, b.uuid]));

      // Query today's message count from analytics snapshots
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const [msgSnapshot] = await ctx.db
        .select({ metricValue: schema.analyticsSnapshots.metricValue })
        .from(schema.analyticsSnapshots)
        .where(
          and(
            eq(schema.analyticsSnapshots.orgId, orgId),
            eq(schema.analyticsSnapshots.metricType, "messages"),
            eq(schema.analyticsSnapshots.period, "day"),
            sql`${schema.analyticsSnapshots.periodStart} >= ${todayStart}`,
          ),
        )
        .orderBy(desc(schema.analyticsSnapshots.periodStart))
        .limit(1);

      return {
        orgId:              String(orgId),
        bots:               bots.map(sanitizeBot),
        // Edges must use the same public ids as the bots they connect.
        relationships:      relationships.map((r) => toApiRelationship(r, uuidByBotId)),
        activeBotCount:     Number(stats?.online ?? 0),
        activeRoomCount:    bots.filter((b) => b.activeRoomId).length,
        totalMessagesToday: Number(msgSnapshot?.metricValue ?? 0),
        systemHealth:       calculateSystemHealth(bots),
      };
    }),

  // ── Create ─────────────────────────────────────────────────────────────────

  create: permittedProc("bots:create")
    .input(CreateBotInput)
    .mutation(async ({ input, ctx }) => {
      const orgId = await resolveOrgId(ctx);

      let created;
      try {
        created = await createBotRecord(
          {
            orgId,
            ownerId:        ctx.user.id,
            name:           input.name,
            highriseApiKey: input.highriseApiKey,
            activeRoomId:   input.activeRoomId ?? null,
            greetMessage:   input.greetMessage,
            personality:    input.personality,
            language:       input.language,
            runtimeMode:    input.runtimeMode,
            tags:           input.tags,
          },
          {
            db: ctx.db, schema, eq, and, count,
            makeUuid: () => nanoid(36).replace(/[^a-z0-9-]/gi, "-").slice(0, 36),
          },
        );
      } catch (err) {
        if (err instanceof BotQuotaExceededError) {
          throw new TRPCError({ code: "FORBIDDEN", message: err.message });
        }
        throw err;
      }

      const { botId, uuid } = created;

      await emitAuditLog(ctx.db, {
        actorId:      ctx.user.id,
        actorType:    "user",
        orgId,
        action:       "bot.create",
        resourceType: "bot",
        resourceId:   uuid,
        afterState:   { name: input.name, orgId },
        ip:           ctx.ip,
      });

      log.info({ botId, orgId, userId: ctx.user.id, highriseRoom: created.roomName }, "Bot created");

      // Auto-deploy: per the product requirement, a created bot should be
      // live in its room immediately, not sit offline until a separate
      // manual Start action. Run this after the response-fetching query
      // below so the caller's create response isn't blocked on a live
      // Highrise connection attempt; a deploy failure here doesn't fail bot
      // creation — it surfaces as a normal "error" bot_status WS event.
      startBotLoop(uuid, botId, orgId, input.highriseApiKey, input.activeRoomId).catch((err) => {
        log.error({ err }, `Auto-deploy failed for newly created bot ${uuid}`);
      });

      const [newBot] = await ctx.db
        .select()
        .from(schema.bots)
        .where(eq(schema.bots.id, botId))
        .limit(1);

      return sanitizeBot(newBot!);
    }),

  // ── Update ─────────────────────────────────────────────────────────────────

  update: permittedProc("bots:update")
    .input(UpdateBotInput)
    .mutation(async ({ input, ctx }) => {
      const orgId = await resolveOrgId(ctx);
      const bot = await findBotByUuid(ctx.db, input.id, orgId);

      const { id: _id, highriseApiKey: newKey, activeRoomId: newRoom, ...rawUpdates } = input;
      const updates: Record<string, unknown> = Object.fromEntries(
        Object.entries(rawUpdates).filter(([, v]) => v !== undefined),
      );

      // A new token or room must work together with the other half before
      // anything is saved — the same rule bots.create applies.
      if (newKey !== undefined || newRoom !== undefined) {
        const key  = newKey ?? decryptApiKey(bot.highriseApiKey);
        const room = newRoom ?? bot.activeRoomId ?? "";
        await validateHighriseCredentials(key, room);
        if (newKey !== undefined) updates.highriseApiKey = encryptApiKey(newKey);
        if (newRoom !== undefined) updates.activeRoomId = newRoom;
      }

      await ctx.db
        .update(schema.bots)
        .set(updates)
        .where(eq(schema.bots.id, bot.id));

      await emitAuditLog(ctx.db, {
        actorId:      ctx.user.id,
        actorType:    "user",
        orgId,
        action:       "bot.update",
        resourceType: "bot",
        resourceId:   input.id,
        // Never put the (encrypted) token into the audit trail.
        beforeState:  { ...bot, highriseApiKey: undefined },
        afterState:   { ...bot, ...updates, highriseApiKey: newKey !== undefined ? "(changed)" : undefined },
        ip:           ctx.ip,
      });

      return { success: true };
    }),

  // ── Delete ─────────────────────────────────────────────────────────────────

  delete: permittedProc("bots:delete")
    .input(BotIdInput)
    .mutation(async ({ input, ctx }) => {
      const orgId = await resolveOrgId(ctx);
      const bot = await findBotByUuid(ctx.db, input.id, orgId);

      // First stop the bot if running
      if (bot.status === "online") {
        await enqueue(QUEUE_NAMES.BOT_LIFECYCLE, { action: "stop", botId: bot.uuid });
      }

      // Soft delete
      await ctx.db
        .update(schema.bots)
        .set({ isActive: false, deletedAt: new Date() })
        .where(eq(schema.bots.id, bot.id));

      await emitAuditLog(ctx.db, {
        actorId:      ctx.user.id,
        actorType:    "user",
        orgId,
        action:       "bot.delete",
        resourceType: "bot",
        resourceId:   input.id,
        ip:           ctx.ip,
      });

      return { success: true };
    }),

  // ── Start / Stop / Restart ─────────────────────────────────────────────────

  start: permittedProc("bots:start")
    .input(BotIdInput)
    .mutation(async ({ input, ctx }) => {
      const orgId = await resolveOrgId(ctx);
      const bot = await findBotByUuid(ctx.db, input.id, orgId);

      await enqueue(QUEUE_NAMES.BOT_LIFECYCLE, {
        action:  "start",
        botId:   bot.uuid,
        orgId:   String(orgId),
      });

      // FIX-AUDIT: orgId here was a raw number, but broadcastOrgEvent's internal
      // check is `client.subscribedOrgs.has(orgId)` against a Set<string> —
      // strict equality means a number never matches a string key, so this
      // notification silently never reached any subscribed client.
      broadcastOrgEvent(String(orgId), {
        type:         "org_activity",
        orgId:        String(orgId),
        actorId:      ctx.user.uuid,
        action:       "bot.start",
        resourceType: "bot",
        resourceId:   bot.uuid,
        ts:           Date.now(),
      });

      await emitAuditLog(ctx.db, {
        actorId:      ctx.user.id,
        actorType:    "user",
        orgId,
        action:       "bot.start",
        resourceType: "bot",
        resourceId:   bot.uuid,
        ip:           ctx.ip,
      });

      return { success: true, message: "Bot start queued." };
    }),

  stop: permittedProc("bots:stop")
    .input(BotIdInput)
    .mutation(async ({ input, ctx }) => {
      const orgId = await resolveOrgId(ctx);
      const bot = await findBotByUuid(ctx.db, input.id, orgId);
      await enqueue(QUEUE_NAMES.BOT_LIFECYCLE, { action: "stop", botId: bot.uuid });
      await emitAuditLog(ctx.db, {
        actorId:      ctx.user.id,
        actorType:    "user",
        orgId,
        action:       "bot.stop",
        resourceType: "bot",
        resourceId:   bot.uuid,
        ip:           ctx.ip,
      });
      return { success: true };
    }),

  restart: permittedProc("bots:start")
    .input(BotIdInput)
    .mutation(async ({ input, ctx }) => {
      const orgId = await resolveOrgId(ctx);
      const bot = await findBotByUuid(ctx.db, input.id, orgId);
      await enqueue(QUEUE_NAMES.BOT_LIFECYCLE, { action: "restart", botId: bot.uuid });
      await emitAuditLog(ctx.db, {
        actorId:      ctx.user.id,
        actorType:    "user",
        orgId,
        action:       "bot.restart",
        resourceType: "bot",
        resourceId:   bot.uuid,
        ip:           ctx.ip,
      });
      return { success: true };
    }),

  stopAll: permittedProc("bots:stop")
    .mutation(async ({ ctx }) => {
      const orgId = await resolveOrgId(ctx);
      const bots = await ctx.db
        .select({ uuid: schema.bots.uuid })
        .from(schema.bots)
        .where(and(eq(schema.bots.orgId, orgId), eq(schema.bots.status, "online")));

      const { queued } = await runFleetAction(ctx, orgId, bots, "stop", "bot.stop_all");

      return { success: true, stopped: queued.length };
    }),

  restartAll: permittedProc("bots:start")
    .mutation(async ({ ctx }) => {
      const orgId = await resolveOrgId(ctx);
      const bots = await ctx.db
        .select({ uuid: schema.bots.uuid })
        .from(schema.bots)
        .where(eq(schema.bots.orgId, orgId));

      const { queued } = await runFleetAction(ctx, orgId, bots, "restart", "bot.restart_all");

      return { success: true, restarting: queued.length };
    }),

  healthCheckAll: protectedProc
    .mutation(async ({ ctx }) => {
      const orgId = await resolveOrgId(ctx);
      const bots = await ctx.db
        .select({ uuid: schema.bots.uuid })
        .from(schema.bots)
        .where(and(eq(schema.bots.orgId, orgId), eq(schema.bots.status, "online")));

      const { queued } = await runFleetAction(ctx, orgId, bots, "health_check", "bot.health_check_all");

      return { success: true, checked: queued.length };
    }),

  // ── Get Logs ───────────────────────────────────────────────────────────────
  // BUG-4 FIX: getLogs was documented in JSDoc and had an input schema (GetLogsInput)
  // but the actual route handler was never implemented. Frontend reads live logs
  // from the WS store; this procedure serves paginated historical log entries.

  getLogs: permittedProc("bots:read_logs")
    .input(GetLogsInput)
    .query(async ({ input, ctx }) => {
      const orgId = await resolveOrgId(ctx);
      const bot = await findBotByUuid(ctx.db, input.botId, orgId);

      // botLogs stores structured log entries written by the bot runtime.
      // Each row: { botId, level, source, message, metadata, createdAt }
      // We paginate newest-first and expose a cursor for infinite scroll.
      const logs = await ctx.db
        .select()
        .from(schema.botLogs)
        .where(eq(schema.botLogs.botId, bot.id))
        .orderBy(desc(schema.botLogs.createdAt))
        .limit(input.limit + 1)
        .offset(input.cursor ?? 0);

      const hasMore = logs.length > input.limit;
      return {
        logs:       hasMore ? logs.slice(0, -1) : logs,
        hasMore,
        nextCursor: hasMore ? (input.cursor ?? 0) + input.limit : undefined,
      };
    }),

  // ── Broadcast Message ──────────────────────────────────────────────────────

  broadcastMessage: permittedProc("bots:start")
    .input(BroadcastInput)
    .mutation(async ({ input, ctx }) => {
      const orgId = await resolveOrgId(ctx);

      // SECURITY FIX (C-01): this previously enqueued a broadcast job straight
      // off the raw botUuid the client sent, with zero check that the bot
      // belonged to the caller's org — any authenticated user could speak
      // live through any other org's bot. findBotByUuid is the same ownership
      // check every other procedure in this file already uses; it throws
      // NOT_FOUND (not FORBIDDEN) for a bot outside the caller's org, matching
      // this file's existing convention, so this can't be used to enumerate
      // which UUIDs belong to other orgs by comparing error responses.
      const bots = await Promise.all(
        input.botIds.map((botUuid) => findBotByUuid(ctx.db, botUuid, orgId)),
      );

      for (const bot of bots) {
        await enqueue(QUEUE_NAMES.BOT_LIFECYCLE, {
          action:  "broadcast",
          botId:   bot.uuid,
          payload: { message: input.message },
        });
      }

      await emitAuditLog(ctx.db, {
        actorId:      ctx.user.id,
        actorType:    "user",
        orgId,
        action:       "bot.broadcast",
        resourceType: "bot",
        resourceId:   bots.map((b) => b.uuid).join(","),
        afterState:   { message: input.message, botIds: bots.map((b) => b.uuid) },
        ip:           ctx.ip,
      });

      return { success: true, sent: bots.length };
    }),

  // ── Memories ───────────────────────────────────────────────────────────────

  getMemories: permittedProc("bots:read")
    .input(z.object({
      botId:  z.string(),
      cursor: z.number().optional(),
      limit:  z.number().min(1).max(100).default(50),
      type:   z.enum(["episodic","semantic","procedural","emotional","all"]).default("all"),
    }))
    .query(async ({ input, ctx }) => {
      const orgId = await resolveOrgId(ctx);
      const bot = await findBotByUuid(ctx.db, input.botId, orgId);

      const conditions: any[] = [eq(schema.botMemories.botId, bot.id)];
      if (input.type !== "all") {
        conditions.push(eq(schema.botMemories.type, input.type));
      }

      const memories = await ctx.db
        .select()
        .from(schema.botMemories)
        .where(and(...conditions))
        .orderBy(desc(schema.botMemories.createdAt))
        .limit(input.limit + 1)
        .offset(input.cursor ?? 0);

      return {
        memories: memories.slice(0, input.limit),
        hasMore:  memories.length > input.limit,
        nextCursor: memories.length > input.limit ? (input.cursor ?? 0) + input.limit : undefined,
      };
    }),

  // ── Relationships ──────────────────────────────────────────────────────────

  getRelationships: permittedProc("bots:read")
    .input(BotIdInput)
    .query(async ({ input, ctx }) => {
      const orgId = await resolveOrgId(ctx);
      const bot = await findBotByUuid(ctx.db, input.id, orgId);

      return ctx.db
        .select()
        .from(schema.botRelationships)
        .where(eq(schema.botRelationships.botId, bot.id));
    }),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────


async function findBotByUuid(db: any, uuid: string, orgId: number): Promise<any> {
  const [bot] = await db
    .select()
    .from(schema.bots)
    .where(and(eq(schema.bots.uuid, uuid), eq(schema.bots.orgId, orgId)))
    .limit(1);

  if (!bot) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Bot not found." });
  }
  return bot;
}

function calculateSystemHealth(bots: any[]): number {
  if (bots.length === 0) return 100;
  const errorCount = bots.filter((b) => b.status === "error").length;
  return Math.round(((bots.length - errorCount) / bots.length) * 100);
}

// ─── Crypto helpers (re-exported from @kojyai/shared/crypto) ─────────────────
export { encryptApiKey, decryptApiKey, migrateKey };
