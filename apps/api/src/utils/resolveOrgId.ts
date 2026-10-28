/**
 * resolveOrgId — the ONE canonical "which organization is this request for?"
 * OWNERSHIP: apps/api/src/utils
 *
 * SECURITY FIX (M-08 / M-13): this logic used to be copy-pasted per router,
 * and the copies drifted. bots/ and delegation/ correctly honoured the org the
 * user actively switched to (auth.switchOrg → session.activeOrgId), but
 * composer/ ignored it entirely, and billing/ had three more inline copies
 * that ignored it AND had no ORDER BY (so which org a multi-org user got was
 * undefined). The result: a user who switched org could read/act on one org's
 * bots while billing and composer silently operated on a different org.
 *
 * Every router must import THIS function. Do not re-inline it.
 *
 * Resolution order:
 *   1. session.activeOrgId — but only if the user is STILL a member of it
 *      (membership can be revoked while a session is live).
 *   2. Otherwise the user's earliest-joined org (deterministic via joinedAt).
 *   3. Otherwise NOT_FOUND.
 */

import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";

export interface OrgResolvableContext {
  db:      typeof db;
  user:    { id: number };
  session: { activeOrgId: number | null } | null;
}

/**
 * Non-throwing variant: resolves to the org id, or null if the user belongs to
 * no organization. For procedures whose no-org behavior is to return an empty
 * result (or something else) rather than an error. Same resolution logic as
 * resolveOrgId — that function is built on this one, so there is still exactly
 * one implementation.
 */
export async function tryResolveOrgId(ctx: OrgResolvableContext): Promise<number | null> {
  const activeOrgId = ctx.session?.activeOrgId;

  if (activeOrgId) {
    const [member] = await ctx.db
      .select({ orgId: schema.orgMembers.orgId })
      .from(schema.orgMembers)
      .where(
        and(
          eq(schema.orgMembers.userId, ctx.user.id),
          eq(schema.orgMembers.orgId, activeOrgId),
        ),
      )
      .limit(1);

    if (member) return member.orgId;
    // Active org is no longer a valid membership — fall through to the default.
  }

  const [member] = await ctx.db
    .select({ orgId: schema.orgMembers.orgId })
    .from(schema.orgMembers)
    .where(eq(schema.orgMembers.userId, ctx.user.id))
    .orderBy(schema.orgMembers.joinedAt) // orgMembers uses joinedAt, not createdAt
    .limit(1);

  return member?.orgId ?? null;
}

export async function resolveOrgId(ctx: OrgResolvableContext): Promise<number> {
  const orgId = await tryResolveOrgId(ctx);
  if (orgId === null) {
    throw new TRPCError({ code: "NOT_FOUND", message: "No organization found for this user." });
  }
  return orgId;
}
