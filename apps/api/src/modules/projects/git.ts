/**
 * Git + GitHub — the Git panel for Python bots.
 * OWNERSHIP: apps/api/src/modules/projects
 *
 *   github.*   the org's GitHub account (a personal access token): connect,
 *              disconnect, list repositories, create one.
 *   git.*      one bot's repository: status, connect a repo, pull, commit,
 *              push, commit & push. Also used by projects.create to import a
 *              bot from GitHub.
 *
 * The git commands themselves run on the runner as the project's sandbox
 * user (apps/runner/src/git.ts), never here: a project's .git/config is the
 * owner's to edit and can make git run commands. The API only sends a
 * signed request and waits for the runner's reply.
 *
 * The token is checked with GitHub, then stored encrypted with
 * ENCRYPTION_KEY; it's never sent back to the browser. The API only ever
 * calls api.github.com with it; the runner only github.com.
 */

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { randomUUID } from "node:crypto";
import { router, permittedProc } from "../../trpc.js";
import { schema } from "../../db/client.js";
import { resolveOrgId } from "../../utils/resolveOrgId.js";
import { getRedis, getRedisPublisher, listenChannel } from "../../utils/redis.js";
import { checkRateLimit, RATE_LIMITS } from "@kojyai/security";
import { emitAuditLog } from "../../events/audit.js";
import { decryptApiKey, encryptApiKey, signBotControlMessage } from "@kojyai/shared/crypto";
import {
  RUNNER_REPLY_PREFIX, ProjectFileError, detectEntrypoint, isSafeBranch, normalizeGitHubUrl, snapshotUnlessRecent,
  type GitReply, type GitRequest,
} from "@kojyai/shared/projects";
import { noteOwnerEdit } from "./chat.js";

const { botProjects, gitConnections } = schema;

type Ctx = Parameters<typeof resolveOrgId>[0] & { db: any };
type ProjectRow = typeof botProjects.$inferSelect;

const GITHUB_API = "https://api.github.com";
const TOKEN = /^(ghp_|gho_|ghu_|ghs_|github_pat_)[A-Za-z0-9_]{20,255}$/;
const RUNNER_TIMEOUT_MS = 150_000;

const projectId = z.object({ id: z.string().uuid() });
const repoUrl = z.string().trim().min(3).max(300);
const branch = z.string().trim().max(100).refine((b) => b === "" || isSafeBranch(b), "Not a valid branch name").optional();

// ── runner request/reply ──────────────────────────────────────────────────────

/** Sends a git command to the runner and waits for its answer. */
export async function runGit(uuid: string, req: Omit<GitRequest, "requestId">, timeoutMs = RUNNER_TIMEOUT_MS): Promise<GitReply> {
  const pub = getRedisPublisher();
  if (!pub) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "The bot runner can't be reached right now (Redis is down)." });
  const requestId = randomUUID();
  let stop: (() => void) | null = null;
  try {
    return await new Promise<GitReply>((resolve, reject) => {
      const timer = setTimeout(() => reject(new TRPCError({ code: "TIMEOUT", message: "The bot runner didn't answer. Is it running?" })), timeoutMs);
      listenChannel(`${RUNNER_REPLY_PREFIX}${requestId}`, (raw) => {
        clearTimeout(timer);
        try { resolve(JSON.parse(raw) as GitReply); } catch { reject(new Error("Bad reply from the runner")); }
      }).then((s) => {
        stop = s;
        return pub.publish(`project_control:${uuid}`, signBotControlMessage(uuid, "git", { ...req, requestId }));
      }).catch((err: unknown) => { clearTimeout(timer); reject(err instanceof Error ? err : new Error(String(err))); });
    });
  } finally {
    (stop as (() => void) | null)?.();
  }
}

/** A failed reply as a 400 with the runner's message (already written for the owner). */
function unwrap(reply: GitReply): Extract<GitReply, { ok: true }> {
  if (!reply.ok) throw new TRPCError({ code: "BAD_REQUEST", message: reply.message });
  return reply;
}

async function loadProject(ctx: Ctx, uuid: string): Promise<ProjectRow> {
  const orgId = await resolveOrgId(ctx);
  const [project] = await ctx.db.select().from(botProjects).where(and(eq(botProjects.uuid, uuid), eq(botProjects.orgId, orgId))).limit(1);
  if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
  return project as ProjectRow;
}

async function remoteThrottle(userId: number): Promise<void> {
  const limit = await checkRateLimit(getRedis(), String(userId), RATE_LIMITS.GIT_REMOTE);
  if (!limit.allowed) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `Too many GitHub requests — try again in ${limit.retryAfter ?? 60}s.` });
}

function snapshot(uuid: string, reason: string): void {
  try { snapshotUnlessRecent(uuid, reason, 0); }
  catch (err) { if (!(err instanceof ProjectFileError)) throw err; }
}

/** After git changed the bot's files: entrypoint, timestamps and a note for Kojy. */
export async function afterFilesChanged(db: any, project: ProjectRow, what: string): Promise<string | null> {
  let entrypoint = project.entrypoint || null;
  if (!entrypoint) {
    entrypoint = detectEntrypoint(project.uuid);
    if (entrypoint) await db.update(botProjects).set({ entrypoint }).where(eq(botProjects.id, project.id));
  }
  await db.update(botProjects).set({ updatedAt: new Date() }).where(eq(botProjects.id, project.id));
  await noteOwnerEdit(db, project.id, `${what} Files you read before may have changed: read them again.`);
  return entrypoint;
}

/** Imports a GitHub repository into a new, empty project (projects.create). */
export async function importRepo(db: any, project: ProjectRow, url: string, branchName?: string): Promise<{ ok: boolean; message: string; entrypoint: string | null }> {
  const reply = await runGit(project.uuid, { op: "import", url, ...(branchName ? { branch: branchName } : {}) });
  if (!reply.ok) return { ok: false, message: reply.message, entrypoint: null };
  const entrypoint = await afterFilesChanged(db, project, `The owner imported this bot from GitHub (${url.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "")}).`);
  return { ok: true, message: reply.message, entrypoint };
}

// ── GitHub account ────────────────────────────────────────────────────────────

async function github<T>(token: string, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "KojyAI", ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: "GitHub couldn't be reached. Try again in a minute." });
  }
  if (res.status === 401) throw new TRPCError({ code: "BAD_REQUEST", message: "GitHub didn't accept that token. It may be wrong, expired or revoked." });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string; errors?: { message?: string }[] };
    const detail = body.errors?.[0]?.message ?? body.message ?? `HTTP ${res.status}`;
    if (res.status === 403) throw new TRPCError({ code: "FORBIDDEN", message: `GitHub refused: ${detail}. Check the token's permissions.` });
    throw new TRPCError({ code: "BAD_REQUEST", message: `GitHub: ${detail}` });
  }
  return await res.json() as T;
}

async function connectionToken(ctx: Ctx): Promise<{ token: string; login: string }> {
  const orgId = await resolveOrgId(ctx);
  const [conn] = await ctx.db.select().from(gitConnections).where(and(eq(gitConnections.orgId, orgId), eq(gitConnections.provider, "github"))).limit(1);
  if (!conn) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Connect your GitHub account first." });
  try { return { token: decryptApiKey(conn.tokenVault), login: conn.login }; }
  catch { throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The saved GitHub token can't be read any more. Connect GitHub again." }); }
}

export const githubRouter = router({
  /** Whether the org has a GitHub account connected (never the token). */
  status: permittedProc("bots:read").query(async ({ ctx }) => {
    const orgId = await resolveOrgId(ctx);
    const [conn] = await ctx.db.select({ login: gitConnections.login, name: gitConnections.name, createdAt: gitConnections.createdAt })
      .from(gitConnections).where(and(eq(gitConnections.orgId, orgId), eq(gitConnections.provider, "github"))).limit(1);
    return conn ? { connected: true as const, login: conn.login, name: conn.name, since: conn.createdAt } : { connected: false as const };
  }),

  connect: permittedProc("bots:update")
    .input(z.object({ token: z.string().trim().min(20).max(300) }))
    .mutation(async ({ ctx, input }) => {
      const limit = await checkRateLimit(getRedis(), String(ctx.user.id), RATE_LIMITS.GIT_CONNECT);
      if (!limit.allowed) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many tries — wait a while before connecting again." });
      if (!TOKEN.test(input.token)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "That doesn't look like a GitHub token. Make one at github.com → Settings → Developer settings → Personal access tokens." });
      }
      const me = await github<{ id: number; login: string; name: string | null }>(input.token, "/user");
      const orgId = await resolveOrgId(ctx);
      const values = {
        orgId, createdBy: ctx.user.id, provider: "github", login: me.login.slice(0, 100), name: (me.name ?? "").slice(0, 200),
        email: `${me.id}+${me.login}@users.noreply.github.com`.slice(0, 200), tokenVault: encryptApiKey(input.token),
      };
      await ctx.db.insert(gitConnections).values(values).onConflictDoUpdate({
        target: [gitConnections.orgId, gitConnections.provider],
        set: { login: values.login, name: values.name, email: values.email, tokenVault: values.tokenVault, createdBy: ctx.user.id, updatedAt: new Date() },
      });
      await emitAuditLog(ctx.db, { orgId, actorId: ctx.user.id, actorType: "user", action: "github.connect", resourceType: "org", resourceId: String(orgId), afterState: { login: me.login } });
      return { login: me.login };
    }),

  disconnect: permittedProc("bots:update").mutation(async ({ ctx }) => {
    const orgId = await resolveOrgId(ctx);
    await ctx.db.delete(gitConnections).where(and(eq(gitConnections.orgId, orgId), eq(gitConnections.provider, "github")));
    await emitAuditLog(ctx.db, { orgId, actorId: ctx.user.id, actorType: "user", action: "github.disconnect", resourceType: "org", resourceId: String(orgId) });
    return { success: true };
  }),

  /** The account's repositories, most recently pushed first (for the "pick a repo" list). */
  repos: permittedProc("bots:read").query(async ({ ctx }) => {
    const { token } = await connectionToken(ctx);
    const rows = await github<{ full_name: string; private: boolean; default_branch: string; html_url: string; description: string | null; pushed_at: string | null }[]>(
      token, "/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member");
    return rows.map((r) => ({ fullName: r.full_name, private: r.private, defaultBranch: r.default_branch, url: r.html_url, description: r.description, pushedAt: r.pushed_at }));
  }),

  /** A new, empty repository on the connected account. */
  createRepo: permittedProc("bots:update")
    .input(z.object({ name: z.string().trim().regex(/^[A-Za-z0-9._-]{1,100}$/, "Letters, numbers, . _ and - only"), private: z.boolean().default(true), description: z.string().max(300).optional() }))
    .mutation(async ({ ctx, input }) => {
      await remoteThrottle(ctx.user.id);
      const { token } = await connectionToken(ctx);
      const repo = await github<{ full_name: string; html_url: string; default_branch: string | null }>(token, "/user/repos", {
        method: "POST", body: { name: input.name, private: input.private, description: input.description ?? "Highrise bot made with KojyAI", auto_init: false },
      });
      return { fullName: repo.full_name, url: repo.html_url };
    }),
});

// ── one bot's repository ───────────────────────────────────────────────────────

export const gitRouter = router({
  status: permittedProc("bots:read").input(projectId).query(async ({ ctx, input }) => {
    const project = await loadProject(ctx, input.id);
    return unwrap(await runGit(project.uuid, { op: "status" }, 30_000)).status;
  }),

  /** Links the bot to a GitHub repository (git init if needed). Changes no files except a default .gitignore. */
  connect: permittedProc("bots:update")
    .input(projectId.extend({ url: repoUrl, branch }))
    .mutation(async ({ ctx, input }) => {
      const project = await loadProject(ctx, input.id);
      const url = normalizeGitHubUrl(input.url);
      if (!url) throw new TRPCError({ code: "BAD_REQUEST", message: "Use a GitHub repository address like https://github.com/you/your-bot." });
      const reply = unwrap(await runGit(project.uuid, { op: "connect", url, ...(input.branch ? { branch: input.branch } : {}) }));
      await emitAuditLog(ctx.db, { orgId: project.orgId, actorId: ctx.user.id, actorType: "user", action: "project.git_connect", resourceType: "project", resourceId: project.uuid, afterState: { url } });
      return reply;
    }),

  /** GitHub → bot. Keeps a snapshot first, so it can be undone from History. */
  pull: permittedProc("bots:update").input(projectId.extend({ branch })).mutation(async ({ ctx, input }) => {
    const project = await loadProject(ctx, input.id);
    await remoteThrottle(ctx.user.id);
    snapshot(project.uuid, "Before pulling from GitHub");
    const reply = unwrap(await runGit(project.uuid, { op: "pull", ...(input.branch ? { branch: input.branch } : {}) }));
    const entrypoint = await afterFilesChanged(ctx.db, project, "The owner pulled the latest code from GitHub.");
    return { ...reply, entrypoint };
  }),

  commit: permittedProc("bots:update").input(projectId.extend({ message: z.string().trim().min(1).max(2000) })).mutation(async ({ ctx, input }) => {
    const project = await loadProject(ctx, input.id);
    return unwrap(await runGit(project.uuid, { op: "commit", message: input.message }));
  }),

  push: permittedProc("bots:update").input(projectId).mutation(async ({ ctx, input }) => {
    const project = await loadProject(ctx, input.id);
    await remoteThrottle(ctx.user.id);
    const reply = unwrap(await runGit(project.uuid, { op: "push" }));
    await emitAuditLog(ctx.db, { orgId: project.orgId, actorId: ctx.user.id, actorType: "user", action: "project.git_push", resourceType: "project", resourceId: project.uuid });
    return reply;
  }),

  /** The usual button: commit everything (if anything changed), then push. */
  commitAndPush: permittedProc("bots:update").input(projectId.extend({ message: z.string().trim().max(2000) })).mutation(async ({ ctx, input }) => {
    const project = await loadProject(ctx, input.id);
    await remoteThrottle(ctx.user.id);
    let committed: string | null = null;
    if (input.message) {
      const c = await runGit(project.uuid, { op: "commit", message: input.message });
      if (!c.ok && !/Nothing to commit/i.test(c.message)) throw new TRPCError({ code: "BAD_REQUEST", message: c.message });
      if (c.ok) committed = c.message;
    }
    const reply = unwrap(await runGit(project.uuid, { op: "push" }));
    await emitAuditLog(ctx.db, { orgId: project.orgId, actorId: ctx.user.id, actorType: "user", action: "project.git_push", resourceType: "project", resourceId: project.uuid });
    return { ...reply, message: committed ? `${committed.replace(/\.$/, "")} and ${reply.message.charAt(0).toLowerCase()}${reply.message.slice(1)}` : reply.message };
  }),
});
