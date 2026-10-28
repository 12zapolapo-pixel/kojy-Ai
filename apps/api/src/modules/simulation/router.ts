/**
 * Simulation Module Router
 * OWNERSHIP: apps/api/src/modules/simulation
 */

import { z }          from "zod";
import { eq, and, desc } from "drizzle-orm";
import { TRPCError }  from "@trpc/server";
import { nanoid }     from "nanoid";
import { router, protectedProc, permittedProc } from "../../trpc.js";
import { resolveOrgId } from "../../utils/resolveOrgId.js"; // single canonical org resolution (M-08/M-13)
import { schema }     from "../../db/client.js"; // FIX-2: schema re-exported from client.ts
import { enqueue }    from "../../jobs/queues.js";
import { broadcastSimEvent } from "../../websocket/gateway.js";
import { emitAuditLog }     from "../../events/audit.js";
import type { SimulationConfig, SimulationResult } from "@kojyai/shared/types";

type SimulationRow = typeof schema.simulations.$inferSelect;

/**
 * Public shape of a simulation: `id` is the UUID every other procedure here
 * looks simulations up by (the numeric key is internal), org id as a string.
 */
function toApiSimulation(sim: SimulationRow) {
  const { id: _numericId, ...rest } = sim;
  return {
    ...rest,
    id:     sim.uuid,
    orgId:  String(sim.orgId),
    config: sim.config as SimulationConfig,
    result: sim.result as SimulationResult | null,
  };
}
import { getRedis }   from "../../utils/redis.js";
import { QUEUE_NAMES, REDIS_KEYS } from "@kojyai/shared/constants";

const SimCreateInput = z.object({
  name:     z.string().min(1).max(200),
  scenario: z.enum(["social","economy","moderation","churn","chaos","custom"]).default("social"),
  config:   z.object({
    botIds:          z.array(z.string()).min(1).max(20),
    roomId:          z.string().optional(),
    speedMultiplier: z.number().min(1).max(10).default(1),
    durationSeconds: z.number().min(10).max(3600).default(60),
    fakePlayers:     z.number().min(0).max(100).default(0),
    injectedEvents:  z.array(z.object({ atSecond: z.number(), type: z.string(), payload: z.record(z.unknown()) })).default([]),
    chaosEnabled:    z.boolean().default(false),
  }),
});

export const simulationsRouter = router({

  list: permittedProc("simulations:read")
    .query(async ({ ctx }) => {
      const orgId = await resolveOrgId(ctx);

      const sims = await ctx.db
        .select()
        .from(schema.simulations)
        .where(eq(schema.simulations.orgId, orgId))
        .orderBy(desc(schema.simulations.createdAt))
        .limit(50);
      return sims.map(toApiSimulation);
    }),

  get: permittedProc("simulations:read")
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const orgId = await resolveOrgId(ctx);

      const [sim] = await ctx.db
        .select()
        .from(schema.simulations)
        .where(and(eq(schema.simulations.uuid, input.id), eq(schema.simulations.orgId, orgId)))
        .limit(1);
      if (!sim) throw new TRPCError({ code: "NOT_FOUND", message: "Simulation not found" });
      return toApiSimulation(sim);
    }),

  create: permittedProc("simulations:create")
    .input(SimCreateInput)
    .mutation(async ({ input, ctx }) => {
      const orgId = await resolveOrgId(ctx);

      const uuid = nanoid(36).replace(/[^a-z0-9-]/gi, "-").slice(0, 36);
      const [sim] = await ctx.db.insert(schema.simulations).values({
        uuid,
        orgId:     orgId,
        name:      input.name,
        scenario:  input.scenario,
        status:    "draft",
        config:    input.config,
        createdBy: ctx.user.id,
      }).returning();

      return toApiSimulation(sim!);
    }),

  start: permittedProc("simulations:run")
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const orgId = await resolveOrgId(ctx);

      const [sim] = await ctx.db.select().from(schema.simulations)
        .where(and(eq(schema.simulations.uuid, input.id), eq(schema.simulations.orgId, orgId))).limit(1);
      if (!sim) throw new TRPCError({ code: "NOT_FOUND" });
      if (sim.status === "running") throw new TRPCError({ code: "CONFLICT", message: "Simulation already running" });

      await enqueue(QUEUE_NAMES.SIMULATION_RUN, {
        simulationId: sim.uuid,
        orgId:        String(sim.orgId),
        config:       sim.config,
      });

      await emitAuditLog(ctx.db, { orgId: orgId, actorId: ctx.user.id, actorType: "user", action: "simulation.start", resourceType: "simulation", resourceId: sim.uuid, ip: ctx.ip });

      return { success: true, message: "Simulation queued" };
    }),

  stop: permittedProc("simulations:stop")
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const orgId = await resolveOrgId(ctx);

      await ctx.db.update(schema.simulations).set({ status: "paused" })
        .where(and(eq(schema.simulations.uuid, input.id), eq(schema.simulations.orgId, orgId)));

      // FIX-15: input.id is a string UUID — parseInt(UUID) produces NaN and breaks fan-out
      broadcastSimEvent(input.id, { type: "sim_status", simulationId: input.id, status: "paused", progress: 0, ts: Date.now() });
      return { success: true };
    }),

  export: permittedProc("analytics:export")
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      // L-23: this used to return "you'll receive a download link shortly" and
      // never produce anything. Return the real export synchronously — the
      // client turns it into a file download.
      const orgId = await resolveOrgId(ctx);
      const [sim] = await ctx.db
        .select()
        .from(schema.simulations)
        .where(and(eq(schema.simulations.uuid, input.id), eq(schema.simulations.orgId, orgId)))
        .limit(1);
      if (!sim) throw new TRPCError({ code: "NOT_FOUND", message: "Simulation not found" });

      const { id: _internalId, orgId: _orgId, ...exportable } = sim as Record<string, unknown>;
      const content = JSON.stringify({ exportedAt: new Date().toISOString(), simulation: exportable }, null, 2);

      await emitAuditLog(ctx.db, { orgId, actorId: ctx.user.id, actorType: "user", action: "simulation.export", resourceType: "simulation", resourceId: input.id, ip: ctx.ip });

      return {
        success:  true as const,
        filename: `simulation-${String(input.id).replace(/[^a-zA-Z0-9-]/g, "_").slice(0, 60)}.json`,
        mimeType: "application/json",
        content,
      };
    }),

  // ── Chaos Engineering: live event injection ───────────────────────────────
  //
  // Pushes a chaos/event payload onto a per-simulation Redis queue. The
  // worker's SimulationRunner drains this queue every tick (see
  // apps/worker/src/processors/simulationRun.ts) and applies each event via
  // processInjectedEvent() at the current simulation second — independent of
  // any `injectedEvents` baked into the sim's config at creation time.
  injectEvent: permittedProc("simulations:run")
    .input(z.object({
      id:        z.string(),
      eventType: z.string().min(1).max(100),
      payload:   z.record(z.unknown()).default({}),
    }))
    .mutation(async ({ input, ctx }) => {
      const orgId = await resolveOrgId(ctx);

      const [sim] = await ctx.db.select().from(schema.simulations)
        .where(and(eq(schema.simulations.uuid, input.id), eq(schema.simulations.orgId, orgId))).limit(1);
      if (!sim) throw new TRPCError({ code: "NOT_FOUND", message: "Simulation not found" });
      if (sim.status !== "running") {
        throw new TRPCError({ code: "CONFLICT", message: "Simulation is not running — start it before injecting chaos events." });
      }

      const redis = getRedis();
      if (!redis) {
        throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Event queue unavailable — Redis is offline." });
      }

      await redis.rpush(REDIS_KEYS.SIM_INJECT_QUEUE(sim.uuid), JSON.stringify({
        type:    input.eventType,
        payload: input.payload,
        ts:      Date.now(),
      }));

      await emitAuditLog(ctx.db, {
        orgId:        orgId,
        actorId:      ctx.user.id,
        actorType:    "user",
        action:       "simulation.inject_event",
        resourceType: "simulation",
        resourceId:   sim.uuid,
        afterState:   { eventType: input.eventType, payload: input.payload },
        ip:           ctx.ip,
      });

      return { success: true, message: `Injected '${input.eventType}' — applied on the next tick` };
    }),
});
