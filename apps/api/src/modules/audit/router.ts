/**
 * Audit Router
 * OWNERSHIP: apps/api/src/modules/audit
 */

import { z }         from "zod";
import { eq, and, desc, gte } from "drizzle-orm";
import { router, permittedProc, adminProc, superadminProc } from "../../trpc.js";
import { tryResolveOrgId } from "../../utils/resolveOrgId.js"; // single canonical org resolution (M-08/M-13)
import { schema }    from "../../db/client.js"; // FIX-2: schema re-exported from client.ts
import { TRPCError } from "@trpc/server";

export const auditRouter = router({

  list: permittedProc("audit:read")
    .input(z.object({
      resourceType: z.string().optional(),
      actorId:      z.number().optional(),
      since:        z.string().optional(),
      limit:        z.number().min(1).max(200).default(50),
      cursor:       z.number().optional(),
    }))
    .query(async ({ input, ctx }) => {
      // Honors the org the user actively switched to (was: first-joined org,
      // so after auth.switchOrg this kept scoping the audit trail — a C-08
      // scoping fix — to the WRONG org). Superadmins with no org are still
      // allowed through: they see everything by design.
      const orgId = await tryResolveOrgId(ctx);
      if (orgId === null && ctx.user!.role !== "superadmin") throw new TRPCError({ code: "NOT_FOUND" });

      const conditions: any[] = [];
      if (input.resourceType) conditions.push(eq(schema.auditLogs.resourceType, input.resourceType));
      if (input.actorId)      conditions.push(eq(schema.auditLogs.actorId, input.actorId));
      if (input.since)        conditions.push(gte(schema.auditLogs.createdAt, new Date(input.since)));

      // SECURITY FIX (C-08): member.orgId was fetched for exactly this
      // purpose and never applied — any org's own admin-tier user could
      // read every other org's entire audit trail. A platform superadmin
      // still sees everything, by design; every other caller is scoped to
      // their own org (NULL-orgId rows — pre-fix history, or events with no
      // attributable org — are superadmin-only, same rationale as C-07).
      if (ctx.user!.role !== "superadmin") {
        conditions.push(eq(schema.auditLogs.orgId, orgId!));
      }

      const logs = await ctx.db
        .select()
        .from(schema.auditLogs)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(schema.auditLogs.createdAt))
        .limit(input.limit + 1)
        .offset(input.cursor ?? 0);

      return { logs: logs.slice(0, input.limit), hasMore: logs.length > input.limit, nextCursor: logs.length > input.limit ? (input.cursor ?? 0) + input.limit : undefined };
    }),
});
