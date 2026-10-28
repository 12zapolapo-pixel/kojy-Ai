/**
 * Studio Router — the one-page Bot Studio: every bot in one list, and the
 * Studio chat with Kojy about all of them.
 * OWNERSHIP: apps/api/src/modules/studio
 *
 * A bot's own chat lives in projects.chat* (Python bots). The Studio chat is
 * thread "studio:<org id>"; the runner answers it when it gets "agent" on
 * project_control:studio-<org id>.
 */

import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, permittedProc } from "../../trpc.js";
import { schema } from "../../db/client.js";
import { resolveOrgId } from "../../utils/resolveOrgId.js";
import { getRedis, getRedisPublisher } from "../../utils/redis.js";
import { signBotControlMessage } from "@kojyai/shared/crypto";
import { listThread, addToThread, agentProgress } from "../projects/chat.js";

const { botProjects, bots, projectMessages, agentMemories } = schema;
const studioKey = (orgId: number) => `studio-${orgId}`;

async function control(key: string, action: string) {
  const redis = getRedisPublisher();
  if (!redis) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "The bot runner can't be reached right now (Redis is down)." });
  await redis.publish(`project_control:${key}`, signBotControlMessage(key, action));
}

async function studioState(orgId: number): Promise<string> {
  try { return (await getRedis()?.get(`agent_state:${studioKey(orgId)}`)) ?? "idle"; } catch { return "idle"; }
}

async function loadJsBot(ctx: any, uuid: string) {
  const orgId = await resolveOrgId(ctx);
  const [bot] = await ctx.db.select({ id: bots.id, uuid: bots.uuid }).from(bots)
    .where(and(eq(bots.uuid, uuid), eq(bots.orgId, orgId), isNull(bots.deletedAt))).limit(1);
  if (!bot) throw new TRPCError({ code: "NOT_FOUND", message: "Bot not found" });
  return bot as { id: number; uuid: string };
}

async function stateOf(key: string): Promise<string> {
  try { return (await getRedis()?.get(`agent_state:${key}`)) ?? "idle"; } catch { return "idle"; }
}

const jsId = z.object({ id: z.string().min(1).max(128) });

export const studioRouter = router({
  /** Every bot, Python and JavaScript, for the Studio's left column. */
  bots: permittedProc("bots:read").query(async ({ ctx }) => {
    const orgId = await resolveOrgId(ctx);
    const [py, js] = await Promise.all([
      ctx.db.select({ uuid: botProjects.uuid, name: botProjects.name, status: botProjects.status, agentState: botProjects.agentState,
        desiredState: botProjects.desiredState, updatedAt: botProjects.updatedAt }).from(botProjects).where(eq(botProjects.orgId, orgId)),
      ctx.db.select({ uuid: bots.uuid, name: bots.name, status: bots.status, updatedAt: bots.updatedAt }).from(bots)
        .where(and(eq(bots.orgId, orgId), isNull(bots.deletedAt))),
    ]);
    const live = (s: string) => s === "running" || s === "online";
    return [
      ...py.map((p) => ({ kind: "python" as const, id: p.uuid, name: p.name, status: p.status, live: live(p.status), working: p.agentState === "working", updatedAt: p.updatedAt })),
      ...js.map((b) => ({ kind: "javascript" as const, id: b.uuid, name: b.name, status: b.status as string, live: live(b.status), working: false, updatedAt: b.updatedAt })),
    ].sort((a, b) => a.name.localeCompare(b.name));
  }),

  chatList: permittedProc("bots:read").input(z.object({ afterId: z.number().int().min(0).optional() })).query(async ({ ctx, input }) => {
    const orgId = await resolveOrgId(ctx);
    const agentState = await studioState(orgId);
    return {
      agentState,
      progress: agentState === "working" ? await agentProgress(studioKey(orgId)) : null,
      ...(await listThread(ctx.db, `studio:${orgId}`, input.afterId)),
    };
  }),

  chatSend: permittedProc("bots:update").input(z.object({ text: z.string().trim().min(1).max(8000) })).mutation(async ({ ctx, input }) => {
    const orgId = await resolveOrgId(ctx);
    await addToThread(ctx.db, `studio:${orgId}`, 0, "user", "text", input.text);
    await control(studioKey(orgId), "agent");
    return { success: true };
  }),

  chatStop: permittedProc("bots:update").mutation(async ({ ctx }) => {
    await control(studioKey(await resolveOrgId(ctx)), "agent_stop");
    return { success: true };
  }),

  // ── what Kojy knows (agent_memories) ──

  memories: permittedProc("bots:read").query(async ({ ctx }) => {
    const orgId = await resolveOrgId(ctx);
    const rows = await ctx.db.select({ id: agentMemories.id, content: agentMemories.content, projectId: agentMemories.projectId, createdAt: agentMemories.createdAt, bot: botProjects.name })
      .from(agentMemories).leftJoin(botProjects, eq(botProjects.id, agentMemories.projectId))
      .where(eq(agentMemories.orgId, orgId)).orderBy(desc(agentMemories.id)).limit(300);
    return rows.map((r) => ({ id: r.id, content: r.content, bot: r.projectId ? (r.bot ?? "(deleted bot)") : null, createdAt: r.createdAt }));
  }),

  addMemory: permittedProc("bots:update").input(z.object({ content: z.string().trim().min(1).max(300) })).mutation(async ({ ctx, input }) => {
    const orgId = await resolveOrgId(ctx);
    await ctx.db.insert(agentMemories).values({ orgId, projectId: null, content: input.content });
    return { success: true };
  }),

  deleteMemory: permittedProc("bots:update").input(z.object({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
    const orgId = await resolveOrgId(ctx);
    await ctx.db.delete(agentMemories).where(and(eq(agentMemories.id, input.id), eq(agentMemories.orgId, orgId)));
    return { success: true };
  }),

  // ── a JavaScript bot's own chat (thread "bot:<id>", key "jsbot-<uuid>") ──

  jsChatList: permittedProc("bots:read").input(jsId.extend({ afterId: z.number().int().min(0).optional() })).query(async ({ ctx, input }) => {
    const bot = await loadJsBot(ctx, input.id);
    const key = `jsbot-${bot.uuid}`;
    const agentState = await stateOf(key);
    return { agentState, progress: agentState === "working" ? await agentProgress(key) : null, ...(await listThread(ctx.db, `bot:${bot.id}`, input.afterId)) };
  }),

  jsChatSend: permittedProc("bots:update").input(jsId.extend({ text: z.string().trim().min(1).max(8000) })).mutation(async ({ ctx, input }) => {
    const bot = await loadJsBot(ctx, input.id);
    await addToThread(ctx.db, `bot:${bot.id}`, 0, "user", "text", input.text);
    await control(`jsbot-${bot.uuid}`, "agent");
    return { success: true };
  }),

  jsChatStop: permittedProc("bots:update").input(jsId).mutation(async ({ ctx, input }) => {
    const bot = await loadJsBot(ctx, input.id);
    await control(`jsbot-${bot.uuid}`, "agent_stop");
    return { success: true };
  }),

  jsChatClear: permittedProc("bots:update").input(jsId).mutation(async ({ ctx, input }) => {
    const bot = await loadJsBot(ctx, input.id);
    if (await stateOf(`jsbot-${bot.uuid}`) === "working") throw new TRPCError({ code: "CONFLICT", message: "Stop the AI first." });
    await ctx.db.delete(projectMessages).where(eq(projectMessages.thread, `bot:${bot.id}`));
    return { success: true };
  }),

  chatClear: permittedProc("bots:update").mutation(async ({ ctx }) => {
    const orgId = await resolveOrgId(ctx);
    if (await studioState(orgId) === "working") throw new TRPCError({ code: "CONFLICT", message: "Stop the AI first." });
    await ctx.db.delete(projectMessages).where(eq(projectMessages.thread, `studio:${orgId}`));
    return { success: true };
  }),
});
