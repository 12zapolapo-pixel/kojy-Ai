/**
 * Projects Router — hosted Python bots (upload, edit, secrets, run).
 * OWNERSHIP: apps/api/src/modules/projects
 *
 * The API owns the files (files.ts) and the database rows; the runner service
 * owns the processes. Start/stop/restart/console input are sent to the runner
 * as signed messages on `project_control:<uuid>`, and the runner writes the
 * status back to bot_projects and the console to PROJECTS_DIR/.logs.
 *
 * Org isolation: every query is scoped to the caller's org.
 */

import { z } from "zod";
import { and, asc, desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { randomUUID } from "node:crypto";
import { router, permittedProc, adminProc } from "../../trpc.js";
import { readAiUsage } from "./aiUsage.js";
import { schema } from "../../db/client.js";
import { resolveOrgId } from "../../utils/resolveOrgId.js";
import { getRedis, getRedisPublisher } from "../../utils/redis.js";
import { checkRateLimit, RATE_LIMITS } from "@kojyai/security";
import { emitAuditLog } from "../../events/audit.js";
import { encryptApiKey, signBotControlMessage } from "@kojyai/shared/crypto";
import {
  ProjectFileError, MAX_UPLOAD_BYTES, ensureProjectDir, removeProjectDir, listFiles, readProjectFile,
  writeProjectFile, deleteProjectPath, extractZip, zipProject, detectEntrypoint, readLogs, cleanRelPath, removeSnapshots, listSnapshots, restoreSnapshot, BOT_TEMPLATES,
} from "@kojyai/shared/projects";
import { listDatabases, describeDatabase, readTable } from "./data.js";
import { listThread, addToThread, agentProgress } from "./chat.js";
import { hostError, loadHost } from "./hosts.js";
import { HostApiError, botHostProvider } from "@kojyai/shared/bothost";

const { botProjects, projectSecrets, projectMessages, botHosts } = schema;

const MAX_PROJECTS_PER_ORG = 20;
/** Set by the runner itself — a secret with one of these names would break the bot's environment. */
const RESERVED_KEYS = /^(PATH|HOME|LANG|VIRTUAL_ENV|PYTHON\w*|LD_\w+|KOJY_\w+)$/;

const projectId = z.object({ id: z.string().uuid() });
const relPath = z.string().min(1).max(500);
const entrypoint = z.string().trim().max(300)
  .regex(/^[A-Za-z_][\w.]*:[A-Za-z_]\w*$/, "Use module.path:ClassName, e.g. highrise_bot.bot:MyBot");

type Ctx = Parameters<typeof resolveOrgId>[0] & { db: any; user?: { id: number } | null };

async function loadProject(ctx: Ctx, uuid: string) {
  const orgId = await resolveOrgId(ctx);
  const [project] = await ctx.db.select().from(botProjects)
    .where(and(eq(botProjects.uuid, uuid), eq(botProjects.orgId, orgId))).limit(1);
  if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
  return project as typeof botProjects.$inferSelect;
}

async function control(uuid: string, action: string, payload?: Record<string, unknown>) {
  const redis = getRedisPublisher();
  if (!redis) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "The bot runner can't be reached right now (Redis is down)." });
  await redis.publish(`project_control:${uuid}`, signBotControlMessage(uuid, action, payload));
}

/** Turns file errors into a 400 with the message, so the UI can show it. */
function files<T>(fn: () => T): T {
  try { return fn(); }
  catch (err) {
    if (err instanceof ProjectFileError) throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
    throw err;
  }
}

async function filesAsync<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (err) {
    if (err instanceof ProjectFileError) throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
    throw err;
  }
}

/**
 * SECURITY FIX (V-04): zip upload, download and snapshot restore each pack or
 * unpack up to 200 MB. The general 300/min API limit let a few accounts keep
 * the API busy; these get their own small per-user budget.
 */
async function zipThrottle(userId: number): Promise<void> {
  const limit = await checkRateLimit(getRedis(), String(userId), RATE_LIMITS.PROJECT_ZIP);
  if (!limit.allowed) {
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `Too many uploads or downloads — try again in ${limit.retryAfter ?? 60}s.` });
  }
}

const publicProject = (p: typeof botProjects.$inferSelect) => ({
  id: p.uuid, name: p.name, entrypoint: p.entrypoint, desiredState: p.desiredState, status: p.status,
  statusMessage: p.statusMessage, lastExitCode: p.lastExitCode, restartCount: p.restartCount,
  lastStartedAt: p.lastStartedAt, agentState: p.agentState, autoFix: p.autoFix, dailyCheckup: p.dailyCheckup, lastCheckupAt: p.lastCheckupAt, createdAt: p.createdAt, updatedAt: p.updatedAt,
  // Where it runs: no hostId = KojyAI's server; a hostId without a server = waiting for a free one.
  hostId: p.hostId, hostServer: p.hostServer,
});

/** Where the bot ran before a move, for the runner to stop it there. */
const placement = (p: typeof botProjects.$inferSelect) => (p.hostId && p.hostServer ? { hostId: p.hostId, server: p.hostServer } : null);

async function saveSecret(db: any, projectId: number, key: string, value: string) {
  const valueVault = encryptApiKey(value);
  await db.insert(projectSecrets).values({ projectId, key, valueVault })
    .onConflictDoUpdate({ target: [projectSecrets.projectId, projectSecrets.key], set: { valueVault, updatedAt: new Date() } });
}

const secretKey = z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/, "Letters, numbers and _ only")
  .refine((k) => !RESERVED_KEYS.test(k), "That name is set by KojyAI and can't be a secret.");

export const projectsRouter = router({
  list: permittedProc("bots:read").query(async ({ ctx }) => {
    const orgId = await resolveOrgId(ctx);
    const rows = await ctx.db.select().from(botProjects).where(eq(botProjects.orgId, orgId)).orderBy(desc(botProjects.updatedAt));
    return rows.map(publicProject);
  }),

  get: permittedProc("bots:read").input(projectId).query(async ({ ctx, input }) => {
    const project = await loadProject(ctx, input.id);
    const secrets = await ctx.db.select({ key: projectSecrets.key, updatedAt: projectSecrets.updatedAt })
      .from(projectSecrets).where(eq(projectSecrets.projectId, project.id)).orderBy(asc(projectSecrets.key));
    let host: { id: number; provider: string; label: string; account: string; server: string | null } | null = null;
    if (project.hostId) {
      const [h] = await ctx.db.select({ id: botHosts.id, provider: botHosts.provider, account: botHosts.account }).from(botHosts)
        .where(and(eq(botHosts.id, project.hostId), eq(botHosts.orgId, project.orgId))).limit(1);
      if (h) host = { ...h, label: botHostProvider(h.provider)?.label ?? h.provider, server: project.hostServer };
    }
    return { ...publicProject(project), secrets, host };
  }),

  /** Starter bots for the Studio's "New bot" page. */
  templates: permittedProc("bots:read").query(() =>
    BOT_TEMPLATES.map((t) => ({ id: t.id, name: t.name, emoji: t.emoji, description: t.description }))),

  /**
   * New Python bot. Optionally from a template (ready to run once its secrets
   * are in) and/or a description — then Kojy starts building or setting it up
   * in the bot's chat right away (what Bot Composer used to do).
   */
  create: permittedProc("bots:create")
    .input(z.object({
      name: z.string().trim().min(1).max(150),
      templateId: z.string().max(40).optional(),
      description: z.string().trim().max(4000).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const orgId = await resolveOrgId(ctx);
      const existing = await ctx.db.select({ id: botProjects.id }).from(botProjects).where(eq(botProjects.orgId, orgId));
      if (existing.length >= MAX_PROJECTS_PER_ORG) {
        throw new TRPCError({ code: "FORBIDDEN", message: `You can have up to ${MAX_PROJECTS_PER_ORG} projects.` });
      }
      const template = input.templateId ? BOT_TEMPLATES.find((t) => t.id === input.templateId) : undefined;
      if (input.templateId && !template) throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown template" });

      const uuid = randomUUID();
      const [row] = await ctx.db.insert(botProjects)
        .values({ uuid, orgId, ownerId: ctx.user.id, name: input.name, entrypoint: template?.entrypoint ?? "" }).returning();
      ensureProjectDir(uuid);
      if (template) for (const [file, content] of Object.entries(template.files)) writeProjectFile(uuid, file, content);

      const asks = input.description?.trim();
      if (template || asks) {
        const intro = template
          ? `This bot was created from the ${template.name} template (${template.description}).${asks ? ` I'd like these changes: ${asks}` : ""} Briefly tell me what it does, ${asks ? "make the changes (plan first if they're big), " : ""}test it in the fake room (try: ${template.tryChat.join(", ")}), then ask me for the secrets it needs.`
          : `Build a new Highrise bot called "${input.name}": ${asks}\n\nStart small: write a working first version (Python, highrise-bot-sdk), set the entrypoint, check it and test it in the fake room. Then ask me for the secrets it needs (at least HIGHRISE_ROOM_ID and HIGHRISE_BOT_TOKEN).`;
        await addToThread(ctx.db, `project:${row!.id}`, row!.id, "user", "text", intro);
        await control(uuid, "agent").catch(() => undefined); // no runner/Redis: the chat waits
      }
      await emitAuditLog(ctx.db, { orgId, actorId: ctx.user.id, actorType: "user", action: "project.create", resourceType: "project", resourceId: uuid, afterState: { template: template?.id ?? null } });
      return publicProject(row!);
    }),

  update: permittedProc("bots:update")
    .input(projectId.extend({ name: z.string().trim().min(1).max(150).optional(), entrypoint: entrypoint.or(z.literal("")).optional() }))
    .mutation(async ({ ctx, input }) => {
      const project = await loadProject(ctx, input.id);
      const [row] = await ctx.db.update(botProjects)
        .set({ ...(input.name !== undefined && { name: input.name }), ...(input.entrypoint !== undefined && { entrypoint: input.entrypoint }) })
        .where(eq(botProjects.id, project.id)).returning();
      return publicProject(row!);
    }),

  delete: permittedProc("bots:delete").input(projectId).mutation(async ({ ctx, input }) => {
    const project = await loadProject(ctx, input.id);
    // Stops the bot (here or on its bot host) and removes its Python environment on the runner.
    const where = placement(project);
    await control(project.uuid, "purge", where ? { host: where, orgId: project.orgId } : undefined).catch(() => undefined);
    await ctx.db.delete(projectSecrets).where(eq(projectSecrets.projectId, project.id));
    await ctx.db.delete(projectMessages).where(eq(projectMessages.projectId, project.id));
    await ctx.db.delete(schema.agentMemories).where(eq(schema.agentMemories.projectId, project.id));
    await ctx.db.delete(schema.agentWorkLog).where(eq(schema.agentWorkLog.thread, `project:${project.id}`));
    await ctx.db.delete(botProjects).where(eq(botProjects.id, project.id));
    removeProjectDir(project.uuid);
    removeSnapshots(project.uuid);
    await emitAuditLog(ctx.db, { orgId: project.orgId, actorId: ctx.user.id, actorType: "user", action: "project.delete", resourceType: "project", resourceId: project.uuid });
    return { success: true };
  }),

  // ── files ──────────────────────────────────────────────────────────────────

  /** Upload a zip of the bot (base64). Keeps the bot's existing data/ and *.db files. */
  uploadZip: permittedProc("bots:update")
    .input(projectId.extend({ zipBase64: z.string().min(1).max(Math.ceil(MAX_UPLOAD_BYTES * 4 / 3) + 4) }))
    .mutation(async ({ ctx, input }) => {
      const project = await loadProject(ctx, input.id);
      await zipThrottle(ctx.user.id);
      const result = await filesAsync(() => extractZip(project.uuid, Buffer.from(input.zipBase64, "base64")));
      let detected: string | null = null;
      if (!project.entrypoint) {
        detected = detectEntrypoint(project.uuid);
        if (detected) await ctx.db.update(botProjects).set({ entrypoint: detected }).where(eq(botProjects.id, project.id));
      } else {
        await ctx.db.update(botProjects).set({ updatedAt: new Date() }).where(eq(botProjects.id, project.id));
      }
      return { ...result, entrypoint: detected ?? project.entrypoint };
    }),

  listFiles: permittedProc("bots:read").input(projectId).query(async ({ ctx, input }) => {
    const project = await loadProject(ctx, input.id);
    return files(() => listFiles(project.uuid));
  }),

  readFile: permittedProc("bots:read").input(projectId.extend({ path: relPath })).query(async ({ ctx, input }) => {
    const project = await loadProject(ctx, input.id);
    return files(() => readProjectFile(project.uuid, input.path));
  }),

  writeFile: permittedProc("bots:update")
    .input(projectId.extend({ path: relPath, content: z.string().max(1024 * 1024) }))
    .mutation(async ({ ctx, input }) => {
      const project = await loadProject(ctx, input.id);
      files(() => writeProjectFile(project.uuid, input.path, input.content));
      await ctx.db.update(botProjects).set({ updatedAt: new Date() }).where(eq(botProjects.id, project.id));
      return { success: true, path: cleanRelPath(input.path) };
    }),

  deleteFile: permittedProc("bots:update").input(projectId.extend({ path: relPath })).mutation(async ({ ctx, input }) => {
    const project = await loadProject(ctx, input.id);
    files(() => deleteProjectPath(project.uuid, input.path));
    return { success: true };
  }),

  /** Whole project as a base64 zip. */
  download: permittedProc("bots:read").input(projectId).query(async ({ ctx, input }) => {
    const project = await loadProject(ctx, input.id);
    await zipThrottle(ctx.user.id);
    const zip = await filesAsync(() => zipProject(project.uuid));
    return { filename: `${project.name.replace(/[^\w.-]+/g, "_") || "project"}.zip`, zipBase64: Buffer.from(zip).toString("base64") };
  }),

  detectEntrypoint: permittedProc("bots:read").input(projectId).query(async ({ ctx, input }) => {
    const project = await loadProject(ctx, input.id);
    return { entrypoint: files(() => detectEntrypoint(project.uuid)) };
  }),

  // ── secrets ────────────────────────────────────────────────────────────────

  setSecret: permittedProc("bots:update")
    .input(projectId.extend({
      key: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/, "Letters, numbers and _ only"),
      value: z.string().max(10_000),
    }))
    .mutation(async ({ ctx, input }) => {
      if (RESERVED_KEYS.test(input.key)) throw new TRPCError({ code: "BAD_REQUEST", message: `${input.key} is set by KojyAI and can't be a secret.` });
      const project = await loadProject(ctx, input.id);
      await saveSecret(ctx.db, project.id, input.key, input.value);
      // Key only — never the value.
      await emitAuditLog(ctx.db, { orgId: project.orgId, actorId: ctx.user.id, actorType: "user", action: "project.secret_set", resourceType: "project", resourceId: project.uuid, afterState: { key: input.key } });
      return { success: true };
    }),

  deleteSecret: permittedProc("bots:update").input(projectId.extend({ key: z.string().max(100) })).mutation(async ({ ctx, input }) => {
    const project = await loadProject(ctx, input.id);
    await ctx.db.delete(projectSecrets).where(and(eq(projectSecrets.projectId, project.id), eq(projectSecrets.key, input.key)));
    return { success: true };
  }),

  // ── chat with the coder AI ─────────────────────────────────────────────────

  /** Messages after `afterId` (poll it), what the AI is doing now, and its state. */
  chatList: permittedProc("bots:read").input(projectId.extend({ afterId: z.number().int().min(0).optional() }))
    .query(async ({ ctx, input }) => {
      const project = await loadProject(ctx, input.id);
      const thread = await listThread(ctx.db, `project:${project.id}`, input.afterId);
      return {
        agentState: project.agentState,
        progress: project.agentState === "working" ? await agentProgress(project.uuid) : null,
        ...thread,
      };
    }),

  chatSend: permittedProc("bots:update").input(projectId.extend({ text: z.string().trim().min(1).max(8000) }))
    .mutation(async ({ ctx, input }) => {
      const project = await loadProject(ctx, input.id);
      await addToThread(ctx.db, `project:${project.id}`, project.id, "user", "text", input.text);
      await control(project.uuid, "agent");
      return { success: true };
    }),

  /** The owner filled in the AI's "add these secrets" card. */
  chatSubmitSecrets: permittedProc("bots:update")
    .input(projectId.extend({ messageId: z.number().int(), values: z.record(secretKey, z.string().max(10_000)) }))
    .mutation(async ({ ctx, input }) => {
      const project = await loadProject(ctx, input.id);
      const [row] = await ctx.db.select().from(projectMessages)
        .where(and(eq(projectMessages.id, input.messageId), eq(projectMessages.projectId, project.id), eq(projectMessages.kind, "secret_request"))).limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "That request is gone" });
      const data = (row.data ?? {}) as { card?: { secrets: { name: string }[]; resolved: boolean } };
      const asked = new Set((data.card?.secrets ?? []).map((x) => x.name));
      const entries = Object.entries(input.values).filter(([k, v]) => asked.has(k) && v.trim() !== "");
      if (!entries.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Fill in at least one value." });
      for (const [k, v] of entries) await saveSecret(ctx.db, project.id, k, v.trim());
      const saved = entries.map(([k]) => k);
      await ctx.db.update(projectMessages).set({ data: { ...data, card: { ...data.card, resolved: true, saved } } }).where(eq(projectMessages.id, row.id));
      await ctx.db.insert(projectMessages).values({
        thread: `project:${project.id}`, projectId: project.id, role: "user", kind: "event",
        content: `The owner saved these secrets: ${saved.join(", ")}. Test them (test_secrets) and continue.`,
      });
      await emitAuditLog(ctx.db, { orgId: project.orgId, actorId: ctx.user.id, actorType: "user", action: "project.secret_set", resourceType: "project", resourceId: project.uuid, afterState: { keys: saved } });
      await control(project.uuid, "agent");
      return { success: true, saved };
    }),

  /** The owner approved Kojy's plan card: mark it and let Kojy carry on. */
  chatApprovePlan: permittedProc("bots:update").input(projectId.extend({ messageId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const project = await loadProject(ctx, input.id);
      const [row] = await ctx.db.select().from(projectMessages)
        .where(and(eq(projectMessages.id, input.messageId), eq(projectMessages.thread, `project:${project.id}`), eq(projectMessages.kind, "plan"))).limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "That plan is gone" });
      const data = (row.data ?? {}) as { card?: { title?: string; resolved?: boolean } };
      if (data.card?.resolved) return { success: true };
      await ctx.db.update(projectMessages).set({ data: { ...data, card: { ...data.card, resolved: true } } }).where(eq(projectMessages.id, row.id));
      await addToThread(ctx.db, `project:${project.id}`, project.id, "user", "event", `The owner approved the plan "${data.card?.title ?? ""}". Go ahead and build it.`);
      await control(project.uuid, "agent");
      return { success: true };
    }),

  /**
   * The coder AI's models and what each used today (the chat's "AI models"
   * circle). Platform-wide, so admins only. Counts come from the runner.
   */
  aiUsage: adminProc.query(async () => readAiUsage(getRedis())),

  /**
   * Kojy's work log for this bot, newest first: each request, how it ended,
   * the files it changed and its result. Kept when the chat is cleared.
   */
  workLog: permittedProc("bots:read").input(projectId).query(async ({ ctx, input }) => {
    const project = await loadProject(ctx, input.id);
    const rows = await ctx.db.select().from(schema.agentWorkLog)
      .where(eq(schema.agentWorkLog.thread, `project:${project.id}`))
      .orderBy(desc(schema.agentWorkLog.updatedAt)).limit(50);
    return rows.map((r) => ({
      id: r.id, request: r.request, status: r.status, summary: r.summary, files: r.files,
      steps: r.actions.length, failed: r.failed, startedAt: r.startedAt, updatedAt: r.updatedAt,
    }));
  }),

  chatStop: permittedProc("bots:update").input(projectId).mutation(async ({ ctx, input }) => {
    const project = await loadProject(ctx, input.id);
    await control(project.uuid, "agent_stop");
    return { success: true };
  }),

  /** Starts a fresh conversation (what the AI learned is kept). */
  chatClear: permittedProc("bots:update").input(projectId).mutation(async ({ ctx, input }) => {
    const project = await loadProject(ctx, input.id);
    if (project.agentState === "working") throw new TRPCError({ code: "CONFLICT", message: "Stop the AI first." });
    await ctx.db.delete(projectMessages).where(eq(projectMessages.thread, `project:${project.id}`));
    await ctx.db.update(botProjects).set({ agentState: "idle" }).where(eq(botProjects.id, project.id));
    return { success: true };
  }),

  setDailyCheckup: permittedProc("bots:update").input(projectId.extend({ dailyCheckup: z.boolean() })).mutation(async ({ ctx, input }) => {
    const project = await loadProject(ctx, input.id);
    // Switching it on runs the first check-up within the hour.
    await ctx.db.update(botProjects).set({ dailyCheckup: input.dailyCheckup, ...(input.dailyCheckup ? { lastCheckupAt: null } : {}) }).where(eq(botProjects.id, project.id));
    return { success: true };
  }),

  setAutoFix: permittedProc("bots:update").input(projectId.extend({ autoFix: z.boolean() })).mutation(async ({ ctx, input }) => {
    const project = await loadProject(ctx, input.id);
    await ctx.db.update(botProjects).set({ autoFix: input.autoFix }).where(eq(botProjects.id, project.id));
    return { success: true };
  }),

  /** Code versions saved before each AI change. */
  snapshots: permittedProc("bots:read").input(projectId).query(async ({ ctx, input }) => {
    const project = await loadProject(ctx, input.id);
    return files(() => listSnapshots(project.uuid));
  }),

  restoreSnapshot: permittedProc("bots:update").input(projectId.extend({ snapshotId: z.string().regex(/^\d+$/) }))
    .mutation(async ({ ctx, input }) => {
      const project = await loadProject(ctx, input.id);
      if (project.agentState === "working") throw new TRPCError({ code: "CONFLICT", message: "Stop the AI first." });
      await zipThrottle(ctx.user.id);
      const count = files(() => restoreSnapshot(project.uuid, input.snapshotId));
      const when = new Date(Number(input.snapshotId)).toISOString().replace("T", " ").slice(0, 16);
      await ctx.db.insert(projectMessages).values({
        thread: `project:${project.id}`, projectId: project.id, role: "user", kind: "event",
        content: `The owner undid code changes: the code is back to how it was at ${when} UTC (${count} files). Restart the bot to use it.`,
      });
      return { success: true, files: count };
    }),

  // ── where it runs ──────────────────────────────────────────────────────────

  /**
   * Moves the bot: back to KojyAI's own server (hostId null), or onto a
   * server of a connected bot host — an existing Python server, or "new" for
   * a free one. With no free server left, a bot running here keeps running
   * here and KojyAI makes the server and moves it once the host has room.
   * The runner stops the bot where it was (copying a host's data/ files back)
   * and starts it in the new place if it was running.
   */
  setHost: permittedProc("bots:deploy")
    .input(projectId.extend({
      hostId: z.number().int().positive().nullable(),
      // A server's identifier, or "new" for a free one.
      server: z.string().regex(/^(new|[A-Za-z0-9-]{4,64})$/).nullable(),
    }))
    .mutation(async ({ ctx, input }) => {
      const project = await loadProject(ctx, input.id);
      const from = placement(project);
      if (input.hostId === null) {
        if (!project.hostId) return { moved: "kojyai" as const, waiting: false, message: "The bot already runs on KojyAI." };
        await ctx.db.update(botProjects).set({ hostId: null, hostServer: null, hostSync: null }).where(eq(botProjects.id, project.id));
        if (from) await control(project.uuid, "rehost", { from });
        await emitAuditLog(ctx.db, { orgId: project.orgId, actorId: ctx.user.id, actorType: "user", action: "project.move", resourceType: "project", resourceId: project.uuid, afterState: { to: "kojyai" } });
        return { moved: "kojyai" as const, waiting: false, message: from ? "Moving the bot back to KojyAI; its data is copied back from the host." : "The bot stays on KojyAI." };
      }
      if (!input.server) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a server, or make a free one." });
      const { host, provider, client } = await loadHost(ctx, input.hostId);
      let server = input.server;
      try {
        if (server === "new") {
          if (!provider.freeServers) throw new TRPCError({ code: "BAD_REQUEST", message: `${provider.label} doesn't make free servers through KojyAI. Pick one of your servers.` });
          try {
            server = (await client.createFreeServer({ name: project.name.slice(0, 60), description: "Highrise bot run by KojyAI", runtime: "python" })).id;
          } catch (err) {
            const full = err instanceof HostApiError && (err.status === 503 || err.status === 409);
            if (!full) throw err;
            if (from) throw new TRPCError({ code: "CONFLICT", message: `${provider.label} has no free servers right now (${err.message}) Try again later.` });
            await ctx.db.update(botProjects).set({ hostId: host.id, hostServer: null, hostSync: null }).where(eq(botProjects.id, project.id));
            return {
              moved: "waiting" as const, waiting: true,
              message: `${provider.label} has no free servers right now. The bot keeps running on KojyAI; KojyAI checks every 30 minutes, makes the server as soon as there's room and moves the bot there.`,
            };
          }
        } else {
          const found = await client.getServer(server);
          if (!/python/i.test(found.dockerImage)) throw new TRPCError({ code: "BAD_REQUEST", message: `That server runs ${found.dockerImage || "something else"}, not Python. Pick a Python server.` });
          if (found.suspended) throw new TRPCError({ code: "BAD_REQUEST", message: "That server is suspended by the host." });
          server = found.id;
        }
      } catch (err) {
        throw hostError(err);
      }
      if (from && from.hostId === host.id && from.server === server) return { moved: "host" as const, waiting: false, message: "The bot already runs there." };
      const [other] = await ctx.db.select({ name: botProjects.name }).from(botProjects)
        .where(and(eq(botProjects.hostId, host.id), eq(botProjects.hostServer, server))).limit(1);
      if (other) throw new TRPCError({ code: "CONFLICT", message: `${other.name} already runs on that server.` });
      await ctx.db.update(botProjects).set({ hostId: host.id, hostServer: server, hostSync: null }).where(eq(botProjects.id, project.id));
      await control(project.uuid, "rehost", { from });
      await emitAuditLog(ctx.db, { orgId: project.orgId, actorId: ctx.user.id, actorType: "user", action: "project.move", resourceType: "project", resourceId: project.uuid, afterState: { to: provider.id, server } });
      return {
        moved: "host" as const, waiting: false, server,
        message: project.desiredState === "running"
          ? `Moving the bot to ${provider.label} (server ${server}). The first start there installs its packages, which takes a minute or two.`
          : `The bot will run on ${provider.label} (server ${server}) the next time you start it.`,
      };
    }),

  // ── run control ────────────────────────────────────────────────────────────

  start: permittedProc("bots:start").input(projectId).mutation(async ({ ctx, input }) => {
    const project = await loadProject(ctx, input.id);
    if (!project.entrypoint) throw new TRPCError({ code: "BAD_REQUEST", message: "Set the bot entrypoint (module.path:ClassName) first." });
    await ctx.db.update(botProjects).set({ desiredState: "running", restartCount: 0, statusMessage: "Queued" }).where(eq(botProjects.id, project.id));
    await control(project.uuid, "start");
    return { success: true };
  }),

  stop: permittedProc("bots:stop").input(projectId).mutation(async ({ ctx, input }) => {
    const project = await loadProject(ctx, input.id);
    await ctx.db.update(botProjects).set({ desiredState: "stopped" }).where(eq(botProjects.id, project.id));
    await control(project.uuid, "stop");
    return { success: true };
  }),

  restart: permittedProc("bots:start").input(projectId).mutation(async ({ ctx, input }) => {
    const project = await loadProject(ctx, input.id);
    if (!project.entrypoint) throw new TRPCError({ code: "BAD_REQUEST", message: "Set the bot entrypoint (module.path:ClassName) first." });
    await ctx.db.update(botProjects).set({ desiredState: "running", restartCount: 0 }).where(eq(botProjects.id, project.id));
    await control(project.uuid, "restart");
    return { success: true };
  }),

  /** Types a line into the bot's console (its stdin). */
  sendInput: permittedProc("bots:update").input(projectId.extend({ text: z.string().max(2000) })).mutation(async ({ ctx, input }) => {
    const project = await loadProject(ctx, input.id);
    await control(project.uuid, "stdin", { text: input.text });
    return { success: true };
  }),

  // ── bot data (read-only) ───────────────────────────────────────────────────

  dataSources: permittedProc("bots:read").input(projectId).query(async ({ ctx, input }) => {
    const project = await loadProject(ctx, input.id);
    return files(() => listDatabases(project.uuid));
  }),

  dataTables: permittedProc("bots:read").input(projectId.extend({ db: relPath })).query(async ({ ctx, input }) => {
    const project = await loadProject(ctx, input.id);
    return files(() => describeDatabase(project.uuid, input.db));
  }),

  dataRows: permittedProc("bots:read")
    .input(projectId.extend({
      db: relPath, table: z.string().min(1).max(200),
      offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(50),
      search: z.string().max(200).optional(),
    }))
    .query(async ({ ctx, input }) => {
      const project = await loadProject(ctx, input.id);
      return files(() => readTable(project.uuid, input.db, input.table, input.offset, input.limit, input.search?.trim() || undefined));
    }),

  /** Console output after `cursor` (a byte offset from the previous call). Poll it. */
  getLogs: permittedProc("bots:read_logs")
    .input(projectId.extend({ cursor: z.number().int().min(0).optional() }))
    .query(async ({ ctx, input }) => {
      const project = await loadProject(ctx, input.id);
      return { ...readLogs(project.uuid, input.cursor), status: project.status, statusMessage: project.statusMessage, desiredState: project.desiredState };
    }),
});
