/**
 * Security Router
 * OWNERSHIP: apps/api/src/modules/security
 */
import { z }         from "zod";
import { eq, and, desc, gte } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, permittedProc } from "../../trpc.js";
import { emitAuditLog } from "../../events/audit.js";
import { tryResolveOrgId } from "../../utils/resolveOrgId.js"; // single canonical org resolution (M-08/M-13)
import { db, schema } from "../../db/client.js"; // FIX-2: schema re-exported from client.ts

export const securityRouter = router({

  getEvents: permittedProc("security:read_events")
    .input(z.object({ severity: z.enum(["low","medium","high","critical","all"]).default("all"), limit: z.number().min(1).max(200).default(50), cursor: z.number().optional() }))
    .query(async ({ input, ctx }) => {
      const conditions: any[] = [];
      if (input.severity !== "all") conditions.push(eq(schema.securityEvents.severity, input.severity));

      // SECURITY FIX (C-07): this procedure previously applied no org
      // scoping at all — any org's own admin-tier user could read every
      // other org's security events. A platform superadmin still sees
      // everything, by design; every other caller sees only their own
      // org's events. Events with a NULL orgId (pre-fix rows, or events
      // that genuinely have no org context — e.g. a login attempt for an
      // email that was never registered) are visible only to superadmin,
      // since they can't be safely attributed to any specific org.
      if (ctx.user!.role !== "superadmin") {
        // Honors the org the user actively switched to (was: first-joined org).
        const orgId = await tryResolveOrgId({ db: ctx.db, user: ctx.user!, session: ctx.session });
        conditions.push(eq(schema.securityEvents.orgId, orgId ?? -1)); // -1 = no org → matches nothing
      }

      const events = await ctx.db.select().from(schema.securityEvents)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(schema.securityEvents.createdAt))
        .limit(input.limit + 1).offset(input.cursor ?? 0);

      return { events: events.slice(0, input.limit), hasMore: events.length > input.limit };
    }),

  resolveEvent: permittedProc("security:manage")
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      // SECURITY FIX (L-16 + new finding): this used to update by bare numeric
      // id with no org scoping, no record of who resolved it, and no audit row —
      // any caller holding security:manage in ANY org could resolve another
      // org's events by incrementing ids. Now it applies the same visibility
      // rule as getEvents: a platform superadmin may resolve any event; every
      // other caller only events belonging to their own active org.
      const conditions: any[] = [eq(schema.securityEvents.id, input.id)];
      if (ctx.user!.role !== "superadmin") {
        const orgId = await tryResolveOrgId({ db: ctx.db, user: ctx.user!, session: ctx.session });
        conditions.push(eq(schema.securityEvents.orgId, orgId ?? -1)); // -1 = no org → matches nothing
      }

      const [event] = await ctx.db
        .select({ id: schema.securityEvents.id, orgId: schema.securityEvents.orgId, category: schema.securityEvents.category, severity: schema.securityEvents.severity, resolved: schema.securityEvents.resolved })
        .from(schema.securityEvents)
        .where(and(...conditions))
        .limit(1);

      // NOT_FOUND (not FORBIDDEN) for both "doesn't exist" and "not yours" so
      // the endpoint can't be used to probe which event ids exist in other orgs.
      if (!event) throw new TRPCError({ code: "NOT_FOUND", message: "Security event not found." });

      // Idempotent: don't overwrite the original resolvedAt of an already-resolved event.
      if (!event.resolved) {
        await ctx.db.update(schema.securityEvents)
          .set({ resolved: true, resolvedAt: new Date() })
          .where(and(eq(schema.securityEvents.id, event.id), eq(schema.securityEvents.resolved, false)));

        // securityEvents has no resolvedBy column (adding one needs a migration
        // across both duplicated schema files), so the audit row is the record
        // of who resolved it.
        await emitAuditLog(db, {
          orgId:        event.orgId,
          actorId:      ctx.user!.id,
          actorType:    "user",
          action:       "security.resolve_event",
          resourceType: "security_event",
          resourceId:   String(event.id),
          beforeState:  { resolved: false },
          afterState:   { resolved: true, category: event.category, severity: event.severity },
          ip:           ctx.ip,
          userAgent:    ctx.req.headers.get("user-agent"),
        });
      }

      return { success: true };
    }),

  getFeatureFlags: permittedProc("admin:feature_flags")
    .query(async ({ ctx }) => {
      return ctx.db.select().from(schema.featureFlags).orderBy(schema.featureFlags.key);
    }),

  updateFeatureFlag: permittedProc("admin:feature_flags")
    .input(z.object({ key: z.string().min(1).max(100), enabled: z.boolean(), rolloutPercentage: z.number().int().min(0).max(100).default(100) }))
    .mutation(async ({ input, ctx }) => {
      // SECURITY FIX (L-17): M-04's structural audit only wraps adminProc /
      // superadminProc, and this procedure is permittedProc — so a platform-wide
      // behavior change was never recorded. Capture the before-state and write
      // an explicit audit row.
      const [before] = await ctx.db
        .select({ enabled: schema.featureFlags.enabled, rolloutPercentage: schema.featureFlags.rolloutPercentage })
        .from(schema.featureFlags)
        .where(eq(schema.featureFlags.key, input.key))
        .limit(1);

      // Previously an unknown key was a silent no-op that still returned success.
      if (!before) throw new TRPCError({ code: "NOT_FOUND", message: `Feature flag "${input.key}" does not exist.` });

      await ctx.db.update(schema.featureFlags)
        .set({ enabled: input.enabled, rolloutPercentage: input.rolloutPercentage })
        .where(eq(schema.featureFlags.key, input.key));

      await emitAuditLog(db, {
        orgId:        ctx.session?.activeOrgId ?? null,
        actorId:      ctx.user!.id,
        actorType:    "user",
        action:       "security.update_feature_flag",
        resourceType: "feature_flag",
        resourceId:   input.key,
        beforeState:  { enabled: before.enabled, rolloutPercentage: before.rolloutPercentage },
        afterState:   { enabled: input.enabled, rolloutPercentage: input.rolloutPercentage },
        ip:           ctx.ip,
        userAgent:    ctx.req.headers.get("user-agent"),
      });

      return { success: true };
    }),
});
