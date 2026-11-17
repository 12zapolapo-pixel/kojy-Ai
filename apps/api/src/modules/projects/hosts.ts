/**
 * Bot hosts — outside servers (Pterodactyl-style panels such as Silly
 * Development) where an org's Python bots can run instead of on KojyAI's own
 * server. Moving a bot between them is projects.setHost.
 * OWNERSHIP: apps/api/src/modules/projects
 *
 * A panel API key is checked with the host first, then stored encrypted with
 * ENCRYPTION_KEY; it is never sent back to the browser. Only panels KojyAI
 * knows (@kojyai/shared/bothost) can be connected, so a key can't make
 * KojyAI call some other address.
 */

import { z } from "zod";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, permittedProc } from "../../trpc.js";
import { schema } from "../../db/client.js";
import { resolveOrgId } from "../../utils/resolveOrgId.js";
import { getRedis } from "../../utils/redis.js";
import { checkRateLimit, RATE_LIMITS } from "@kojyai/security";
import { emitAuditLog } from "../../events/audit.js";
import { decryptApiKey, encryptApiKey } from "@kojyai/shared/crypto";
import { BotHostClient, HostApiError, botHostProvider, botHostProviders, type BotHostProvider } from "@kojyai/shared/bothost";

const { botHosts, botProjects } = schema;

type Ctx = Parameters<typeof resolveOrgId>[0] & { db: any; user: { id: number } };
export type BotHostRow = typeof botHosts.$inferSelect;

/** The host's own message for the owner, as a tRPC error. */
export function hostError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof HostApiError) {
    const code = err.status === 429 ? "TOO_MANY_REQUESTS" : err.status === 409 ? "CONFLICT" : err.status === 404 ? "NOT_FOUND" : "BAD_REQUEST";
    return new TRPCError({ code, message: err.message });
  }
  return new TRPCError({ code: "BAD_REQUEST", message: `The bot host couldn't be reached: ${err instanceof Error ? err.message : String(err)}` });
}

/** An org's connected host, with a client for its panel. */
export async function loadHost(ctx: Ctx, hostId: number): Promise<{ host: BotHostRow; provider: BotHostProvider; client: BotHostClient }> {
  const orgId = await resolveOrgId(ctx);
  const [host] = await ctx.db.select().from(botHosts).where(and(eq(botHosts.id, hostId), eq(botHosts.orgId, orgId))).limit(1);
  if (!host) throw new TRPCError({ code: "NOT_FOUND", message: "That bot host isn't connected." });
  const provider = botHostProvider((host as BotHostRow).provider);
  if (!provider) throw new TRPCError({ code: "BAD_REQUEST", message: "KojyAI no longer supports that bot host." });
  let apiKey: string;
  try { apiKey = decryptApiKey((host as BotHostRow).apiKeyVault); }
  catch { throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The host's API key can't be read any more. Connect the host again." }); }
  return { host: host as BotHostRow, provider, client: new BotHostClient({ provider, apiKey }) };
}

export const botHostsRouter = router({
  /** Hosts KojyAI can run bots on. */
  providers: permittedProc("bots:read").query(() =>
    botHostProviders().map((p) => ({ id: p.id, label: p.label, keyHelp: p.keyHelp, freeServers: p.freeServers }))),

  /** The org's connected hosts and which bots use each. */
  list: permittedProc("bots:read").query(async ({ ctx }) => {
    const orgId = await resolveOrgId(ctx);
    const rows: BotHostRow[] = await ctx.db.select().from(botHosts).where(eq(botHosts.orgId, orgId)).orderBy(asc(botHosts.id));
    const used: { hostId: number | null; uuid: string; name: string; server: string | null }[] = await ctx.db
      .select({ hostId: botProjects.hostId, uuid: botProjects.uuid, name: botProjects.name, server: botProjects.hostServer })
      .from(botProjects).where(and(eq(botProjects.orgId, orgId), isNotNull(botProjects.hostId)));
    return rows.map((h) => ({
      id: h.id, provider: h.provider, label: botHostProvider(h.provider)?.label ?? h.provider, account: h.account, keyHint: h.keyHint,
      createdAt: h.createdAt, bots: used.filter((u) => u.hostId === h.id).map((u) => ({ id: u.uuid, name: u.name, server: u.server })),
    }));
  }),

  /** Connect a host with an API key made in its panel (the same account again just replaces the key). */
  connect: permittedProc("org:update")
    .input(z.object({ provider: z.string().max(32), apiKey: z.string().trim().min(10).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const limit = await checkRateLimit(getRedis(), String(ctx.user.id), RATE_LIMITS.BOT_HOST);
      if (!limit.allowed) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many tries — wait a while before connecting again." });
      const provider = botHostProvider(input.provider);
      if (!provider) throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown bot host." });
      if (!provider.keyPattern.test(input.apiKey)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `That doesn't look like a ${provider.label} API key. ${provider.keyHelp}` });
      }
      const client = new BotHostClient({ provider, apiKey: input.apiKey });
      let account: { username: string };
      try {
        account = await client.account();
        await client.listServers(); // the key must be able to see and run servers
      } catch (err) {
        throw hostError(err);
      }
      const orgId = await resolveOrgId(ctx);
      const apiKeyVault = encryptApiKey(input.apiKey);
      const keyHint = `${input.apiKey.slice(0, 12)}…`;
      const [same] = await ctx.db.select({ id: botHosts.id }).from(botHosts)
        .where(and(eq(botHosts.orgId, orgId), eq(botHosts.provider, provider.id), eq(botHosts.account, account.username.slice(0, 120)))).limit(1);
      let id: number;
      if (same) {
        await ctx.db.update(botHosts).set({ apiKeyVault, keyHint }).where(eq(botHosts.id, same.id));
        id = same.id;
      } else {
        const [row] = await ctx.db.insert(botHosts).values({ orgId, createdBy: ctx.user.id, provider: provider.id, account: account.username.slice(0, 120), apiKeyVault, keyHint }).returning({ id: botHosts.id });
        id = row!.id;
      }
      // Which host and account only — never the key.
      await emitAuditLog(ctx.db, { orgId, actorId: ctx.user.id, actorType: "user", action: "bot_host.connect", resourceType: "bot_host", resourceId: String(id), afterState: { provider: provider.id, account: account.username } });
      return { id, account: account.username, replaced: !!same };
    }),

  /** Disconnect a host (only when no bot uses it any more). */
  remove: permittedProc("org:update").input(z.object({ hostId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const orgId = await resolveOrgId(ctx);
    const [host] = await ctx.db.select({ id: botHosts.id, provider: botHosts.provider }).from(botHosts)
      .where(and(eq(botHosts.id, input.hostId), eq(botHosts.orgId, orgId))).limit(1);
    if (!host) throw new TRPCError({ code: "NOT_FOUND", message: "That bot host isn't connected." });
    const users: { name: string }[] = await ctx.db.select({ name: botProjects.name }).from(botProjects)
      .where(and(eq(botProjects.orgId, orgId), eq(botProjects.hostId, input.hostId)));
    if (users.length) {
      throw new TRPCError({ code: "CONFLICT", message: `Move ${users.map((u) => u.name).join(", ")} back to KojyAI first.` });
    }
    await ctx.db.delete(botHosts).where(eq(botHosts.id, input.hostId));
    await emitAuditLog(ctx.db, { orgId, actorId: ctx.user.id, actorType: "user", action: "bot_host.remove", resourceType: "bot_host", resourceId: String(input.hostId), afterState: { provider: host.provider } });
    return { success: true };
  }),

  /** The servers on a connected host, which bot uses each, and whether a free one can be made. */
  servers: permittedProc("bots:read").input(z.object({ hostId: z.number().int().positive() })).query(async ({ ctx, input }) => {
    const { host, provider, client } = await loadHost(ctx, input.hostId);
    let servers;
    let free;
    try {
      [servers, free] = await Promise.all([client.listServers(), client.freeServerOptions()]);
    } catch (err) {
      throw hostError(err);
    }
    const used: { uuid: string; name: string; server: string | null }[] = await ctx.db
      .select({ uuid: botProjects.uuid, name: botProjects.name, server: botProjects.hostServer })
      .from(botProjects).where(and(eq(botProjects.orgId, host.orgId), eq(botProjects.hostId, host.id)));
    return {
      provider: provider.id, label: provider.label,
      servers: servers.map((s) => ({
        id: s.id, name: s.name, node: s.node, memoryMb: s.memoryMb, diskMb: s.diskMb, python: /python/i.test(s.dockerImage),
        installing: s.installing, suspended: s.suspended, usedBy: used.find((u) => u.server === s.id) ?? null,
      })),
      free: free ? { canCreate: free.canCreate && !free.full, full: free.full, owned: free.owned, limit: free.limit } : null,
    };
  }),
});
