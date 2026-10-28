/**
 * Admin Router — Superadmin only
 * OWNERSHIP: apps/api/src/modules/admin
 */
import { z }            from "zod";
import { eq, desc, sql, count } from "drizzle-orm";
import { TRPCError }    from "@trpc/server";
import { router, superadminProc } from "../../trpc.js";
import { schema }       from "../../db/client.js"; // FIX-2: schema re-exported from client.ts
import { getGatewayStats } from "../../websocket/gateway.js";
import { emitAuditLog } from "../../events/audit.js";

export const adminRouter = router({

  platformStats: superadminProc
    .query(async ({ ctx }) => {
      const [[userCount], [orgCount], [botCount], [simCount]] = await Promise.all([
        ctx.db.select({ total: count() }).from(schema.users),
        ctx.db.select({ total: count() }).from(schema.organizations),
        ctx.db.select({ total: count() }).from(schema.bots),
        ctx.db.select({ total: count() }).from(schema.simulations),
      ]);

      const wsStats = getGatewayStats();

      return {
        users:       Number(userCount?.total ?? 0),
        orgs:        Number(orgCount?.total  ?? 0),
        bots:        Number(botCount?.total  ?? 0),
        simulations: Number(simCount?.total  ?? 0),
        wsClients:   wsStats.totalClients,
        wsAuthed:    wsStats.authenticatedClients,
        wsUniqueUsers: wsStats.uniqueUsers,
      };
    }),

  listUsers: superadminProc
    .input(z.object({ limit: z.number().min(1).max(100).default(50), cursor: z.number().optional(), search: z.string().optional() }))
    .query(async ({ input, ctx }) => {
      const users = await ctx.db
        .select({ id: schema.users.id, uuid: schema.users.uuid, email: schema.users.email, username: schema.users.username, role: schema.users.role, tier: schema.users.tier, status: schema.users.status, createdAt: schema.users.createdAt })
        .from(schema.users)
        .orderBy(desc(schema.users.createdAt))
        .limit(input.limit + 1)
        .offset(input.cursor ?? 0);

      return { users: users.slice(0, input.limit), hasMore: users.length > input.limit };
    }),

  updateUserTier: superadminProc
    .input(z.object({ userId: z.number().int().positive(), tier: z.enum(["free","starter","pro","elite","enterprise","dev"]), confirmed: z.boolean().optional() }))
    .mutation(async ({ input, ctx }) => {
      const [target] = await ctx.db
        .select({ id: schema.users.id, role: schema.users.role, tier: schema.users.tier, email: schema.users.email })
        .from(schema.users).where(eq(schema.users.id, input.userId)).limit(1);
      if (!target) throw new TRPCError({ code: "NOT_FOUND" });

      // SECURITY FIX (H-15): acting on another superadmin's account requires
      // an additional, distinctly-logged confirmation step — see this
      // finding's own rationale: a single compromised superadmin credential
      // should not be able to silently affect other superadmin accounts.
      const targetsAnotherSuperadmin = target.role === "superadmin" && target.id !== ctx.user.id;
      if (targetsAnotherSuperadmin && !input.confirmed) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Changing another superadmin's tier requires explicit confirmation. Retry with confirmed: true.",
        });
      }

      await ctx.db.update(schema.users).set({ tier: input.tier }).where(eq(schema.users.id, input.userId));

      // SECURITY FIX (H-15): this procedure previously called no audit
      // logging function at all — one of the most consequential single
      // actions on the platform had zero forensic trail.
      await emitAuditLog(ctx.db, {
        orgId:        null,
        actorId:      ctx.user.id,
        actorType:    "user",
        action:       targetsAnotherSuperadmin ? "admin.update_user_tier.superadmin_target_confirmed" : "admin.update_user_tier",
        resourceType: "user",
        resourceId:   String(target.id),
        beforeState:  { tier: target.tier },
        afterState:   { tier: input.tier, targetEmail: target.email },
        ip:           ctx.ip ?? null,
        userAgent:    ctx.req.headers.get("user-agent") ?? null,
      });

      return { success: true };
    }),

  updateUserStatus: superadminProc
    .input(z.object({ userId: z.number().int().positive(), status: z.enum(["active","suspended","deleted"]), confirmed: z.boolean().optional() }))
    .mutation(async ({ input, ctx }) => {
      const [target] = await ctx.db
        .select({ id: schema.users.id, role: schema.users.role, status: schema.users.status, email: schema.users.email })
        .from(schema.users).where(eq(schema.users.id, input.userId)).limit(1);
      if (!target) throw new TRPCError({ code: "NOT_FOUND" });

      const isDeactivating = input.status === "suspended" || input.status === "deleted";

      // SECURITY FIX (H-15): structurally refuse to let the platform reach
      // a state with zero active superadmin accounts — a compromised or
      // malicious superadmin credential should not be able to lock out
      // every legitimate operator, including itself, in one call sequence.
      if (isDeactivating && target.role === "superadmin" && target.status === "active") {
        const [superadminCount] = await ctx.db
          .select({ activeSuperadmins: sql<number>`COUNT(*)`.mapWith(Number) })
          .from(schema.users)
          .where(sql`${schema.users.role} = 'superadmin' AND ${schema.users.status} = 'active'`);

        // COUNT(*) always returns a row, but fail closed (treat as "last
        // superadmin") rather than assume it if the driver ever returns none.
        if (Number(superadminCount?.activeSuperadmins ?? 0) <= 1) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Cannot suspend or delete the last active superadmin account — the platform would be left with zero active superadmins.",
          });
        }
      }

      // SECURITY FIX (H-15): same confirmation requirement as updateUserTier
      // above, for acting on another superadmin's status specifically.
      const targetsAnotherSuperadmin = target.role === "superadmin" && target.id !== ctx.user.id;
      if (targetsAnotherSuperadmin && !input.confirmed) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Changing another superadmin's status requires explicit confirmation. Retry with confirmed: true.",
        });
      }

      await ctx.db.update(schema.users).set({ status: input.status }).where(eq(schema.users.id, input.userId));

      await emitAuditLog(ctx.db, {
        orgId:        null,
        actorId:      ctx.user.id,
        actorType:    "user",
        action:       targetsAnotherSuperadmin ? "admin.update_user_status.superadmin_target_confirmed" : "admin.update_user_status",
        resourceType: "user",
        resourceId:   String(target.id),
        beforeState:  { status: target.status },
        afterState:   { status: input.status, targetEmail: target.email },
        ip:           ctx.ip ?? null,
        userAgent:    ctx.req.headers.get("user-agent") ?? null,
      });

      return { success: true };
    }),

  listOrgs: superadminProc
    .input(z.object({ limit: z.number().default(50), cursor: z.number().optional() }))
    .query(async ({ input, ctx }) => {
      const orgs = await ctx.db.select().from(schema.organizations)
        .orderBy(desc(schema.organizations.createdAt))
        .limit(input.limit + 1).offset(input.cursor ?? 0);
      return { orgs: orgs.slice(0, input.limit), hasMore: orgs.length > input.limit };
    }),

  createFeatureFlag: superadminProc
    .input(z.object({ key: z.string().min(1).max(100), enabled: z.boolean().default(false), description: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      await ctx.db.insert(schema.featureFlags).values({ key: input.key, enabled: input.enabled, rolloutPercentage: 0, audience: {}, description: input.description ?? null });
      return { success: true };
    }),
});
