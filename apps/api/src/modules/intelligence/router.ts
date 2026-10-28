/**
 * Intelligence Module Router
 * OWNERSHIP: apps/api/src/modules/intelligence
 */

import { z }         from "zod";
import { eq, and, desc, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, protectedProc, permittedProc } from "../../trpc.js";
import { resolveOrgId } from "../../utils/resolveOrgId.js"; // single canonical org resolution (M-08/M-13)
import { schema }    from "../../db/client.js"; // FIX-2: schema re-exported from client.ts
import { emitAuditLog } from "../../events/audit.js";
import { enqueue }   from "../../jobs/queues.js";
import { QUEUE_NAMES } from "@kojyai/shared/constants";
import { createDefaultPersonalityProfile, buildPersonalityPrompt } from "@kojyai/engine/personality";
import { evaluatePersonalityPolicy, checkInjection } from "@kojyai/shared/policy";

const PersonalityUpdateInput = z.object({
  botId: z.string(),
  traits: z.object({
    openness: z.number().min(0).max(1), conscientiousness: z.number().min(0).max(1),
    extraversion: z.number().min(0).max(1), agreeableness: z.number().min(0).max(1),
    neuroticism: z.number().min(0).max(1), humor: z.number().min(0).max(1),
    empathy: z.number().min(0).max(1), assertiveness: z.number().min(0).max(1),
    creativity: z.number().min(0).max(1),
  }),
  voice: z.object({
    tone:            z.enum(["formal","casual","playful","mysterious","warm","sharp"]),
    pace:            z.enum(["slow","normal","fast"]),
    verbosity:       z.enum(["terse","normal","verbose"]),
    useEmoji:        z.boolean(),
    signaturePhrase: z.string().max(200).nullable(),
  }),
  behaviorRules: z.array(z.object({
    trigger:  z.string().max(200),
    action:   z.string().max(500),
    priority: z.number().min(1).max(10),
    isActive: z.boolean(),
  })).max(50),
});

export const intelligenceRouter = router({

  getPersonality: permittedProc("intelligence:read")
    .input(z.object({ botId: z.string() }))
    .query(async ({ input, ctx }) => {
      const orgId = await resolveOrgId(ctx);

      const [bot] = await ctx.db.select({ id: schema.bots.id }).from(schema.bots)
        .where(and(eq(schema.bots.uuid, input.botId), eq(schema.bots.orgId, orgId))).limit(1);
      if (!bot) throw new TRPCError({ code: "NOT_FOUND" });

      const [profile] = await ctx.db.select().from(schema.botPersonalityProfiles)
        .where(and(eq(schema.botPersonalityProfiles.botId, bot.id), eq(schema.botPersonalityProfiles.isActive, true))).limit(1);

      return profile ?? createDefaultPersonalityProfile(input.botId);
    }),

  updatePersonality: permittedProc("bots:manage_personality")
    .input(PersonalityUpdateInput)
    .mutation(async ({ input, ctx }) => {
      // SECURITY FIX (H-18): validatePersonalityProfile()'s injection check
      // was an 8-phrase static substring blocklist (containsInjectionPattern
      // in packages/engine/src/personality/PersonalityEngine.ts) — easily
      // bypassed by minor rephrasing. packages/shared/src/policy/PolicyEngine.ts
      // is a genuinely thorough, already-written, already-tested injection
      // defense (homoglyph detection, invisible/directional Unicode chars,
      // structural JSON-role-poisoning detection that regex alone can't
      // catch) that was never actually wired to the one place in the
      // product where prompt-injection on user-supplied bot personality
      // content matters most. Swapped in below for traits + behaviorRules.
      const policyResult = evaluatePersonalityPolicy({ traits: input.traits, behaviorRules: input.behaviorRules });

      // ADJACENT GAP (found while implementing H-18, not previously flagged):
      // signaturePhrase is free-text (zod only constrains it to max 200
      // chars) and reaches the bot's actual system prompt via
      // buildPersonalityPrompt() below — but neither the old validator NOR
      // PolicyEngine's evaluatePersonalityPolicy() ever checked it (the
      // latter only covers traits/behaviorRules). Checked explicitly here
      // rather than silently leaving a free-text field with zero injection
      // screening right next to the ones that do get checked.
      const signaturePhraseViolations = input.voice.signaturePhrase
        ? checkInjection(input.voice.signaturePhrase, "voice.signaturePhrase")
        : [];

      const allViolations = [...policyResult.violations, ...signaturePhraseViolations];
      if (allViolations.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: allViolations.map((v) => v.message).join(", "),
        });
      }

      const orgId = await resolveOrgId(ctx);

      const [bot] = await ctx.db.select().from(schema.bots)
        .where(and(eq(schema.bots.uuid, input.botId), eq(schema.bots.orgId, orgId))).limit(1);
      if (!bot) throw new TRPCError({ code: "NOT_FOUND" });

      // Get current version
      const [current] = await ctx.db.select({ version: schema.botPersonalityProfiles.version }).from(schema.botPersonalityProfiles)
        .where(and(eq(schema.botPersonalityProfiles.botId, bot.id), eq(schema.botPersonalityProfiles.isActive, true))).limit(1);

      const nextVersion = (current?.version ?? 0) + 1;

      // Deactivate old
      await ctx.db.update(schema.botPersonalityProfiles).set({ isActive: false }).where(eq(schema.botPersonalityProfiles.botId, bot.id));

      // Create new version
      await ctx.db.insert(schema.botPersonalityProfiles).values({
        botId:              bot.id,
        version:            nextVersion,
        isActive:           true,
        openness:           input.traits.openness,
        conscientiousness:  input.traits.conscientiousness,
        extraversion:       input.traits.extraversion,
        agreeableness:      input.traits.agreeableness,
        neuroticism:        input.traits.neuroticism,
        humor:              input.traits.humor,
        empathy:            input.traits.empathy,
        assertiveness:      input.traits.assertiveness,
        creativity:         input.traits.creativity,
        tone:               input.voice.tone,
        verbosity:          input.voice.verbosity,
        useEmoji:           input.voice.useEmoji,
        signaturePhrase:    input.voice.signaturePhrase,
        behaviorRules:      input.behaviorRules,
        evolvedState:       {},
      });

      await emitAuditLog(ctx.db, { orgId: orgId, actorId: ctx.user.id, actorType: "user", action: "personality.update", resourceType: "bot", resourceId: input.botId, ip: ctx.ip });

      return { success: true, version: nextVersion };
    }),

  getOrgIntelligence: permittedProc("intelligence:read")
    .query(async ({ ctx }) => {
      const orgId = await resolveOrgId(ctx);

      const [memStats] = await ctx.db
        .select({
          total:      sql<number>`COUNT(*)`.mapWith(Number),
          raw:        sql<number>`SUM(CASE WHEN ${schema.botMemories.compressionState} = 'raw' THEN 1 ELSE 0 END)`.mapWith(Number),
          compressed: sql<number>`SUM(CASE WHEN ${schema.botMemories.compressionState} = 'compressed' THEN 1 ELSE 0 END)`.mapWith(Number),
        })
        .from(schema.botMemories)
        .where(eq(schema.botMemories.orgId, orgId));

      // SECURITY/CORRECTNESS FIX (H-10): botRelationships has a botId FK but
      // no orgId column of its own — this query used to filter on
      // schema.bots.orgId while selecting from schema.botRelationships with
      // no join connecting the two tables at all, which the DB would reject
      // outright (unknown table reference) on every single call. Added the
      // missing join; explicit column selection keeps the result shape flat
      // (a join without one returns nested {botRelationships, bots} objects,
      // which would have broken the .affinity access below).
      const relationships = await ctx.db
        .select({
          id:               schema.botRelationships.id,
          botId:            schema.botRelationships.botId,
          targetType:       schema.botRelationships.targetType,
          targetId:         schema.botRelationships.targetId,
          type:             schema.botRelationships.type,
          trust:            schema.botRelationships.trust,
          loyalty:          schema.botRelationships.loyalty,
          affinity:         schema.botRelationships.affinity,
          interactionCount: schema.botRelationships.interactionCount,
          lastUpdated:      schema.botRelationships.lastUpdated,
        })
        .from(schema.botRelationships)
        .innerJoin(schema.bots, eq(schema.botRelationships.botId, schema.bots.id))
        .where(eq(schema.bots.orgId, orgId))
        .limit(100);

      return {
        memoryStats:   memStats,
        relationships: relationships.length,
        topRelationships: relationships.sort((a, b) => Math.abs(b.affinity) - Math.abs(a.affinity)).slice(0, 10),
      };
    }),

  triggerMemoryCompression: permittedProc("intelligence:configure")
    .input(z.object({ botId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await enqueue(QUEUE_NAMES.MEMORY_COMPRESSION, { botId: input.botId, type: "manual" });
      return { success: true, message: "Memory compression queued" };
    }),

  getChurnPredictions: permittedProc("intelligence:read")
    .input(z.object({ botId: z.string(), limit: z.number().min(1).max(100).default(20) }))
    .query(async ({ input, ctx }) => {
      // L-22: no churn model or sweep job exists yet, so there are never any
      // predictions. Say so explicitly instead of returning an empty result that
      // looks like "we checked and nobody is at risk".
      return {
        available:   false as const,
        reason:      "Churn prediction is not implemented yet — no predictions are being generated.",
        predictions: [] as Array<{ playerId: string; riskScore: number }>,
        generatedAt: null,
      };
    }),
});
