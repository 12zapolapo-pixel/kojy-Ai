/**
 * Git — the Git panel's commands (status, connect a repo, pull, commit, push,
 * import from GitHub), run in a bot's folder.
 * OWNERSHIP: apps/runner
 *
 * Every git command runs as the project's own sandbox user (like the bot and
 * its shell), never as the runner or the API: a project's .git/config is the
 * owner's to edit (from the shell), and settings in it such as core.fsmonitor
 * or core.sshCommand run commands.
 *
 * The org's GitHub token (git_connections) is decrypted here and handed to
 * git only through environment variables, as an http.extraHeader scoped to
 * https://github.com/ — it never lands in .git/config, on a command line
 * (readable by other users in /proc), or in a reply. Only https remotes are
 * allowed (no file://, ssh:// or ext:: transports).
 *
 * One operation at a time per project. Replies go to runner_reply:<requestId>.
 */

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import type { Database } from "@kojyai/db";
import { botProjects, gitConnections } from "@kojyai/db/schema";
import { decryptApiKey } from "@kojyai/shared/crypto";
import {
  RUNNER_REPLY_PREFIX, isSafeBranch, normalizeGitHubUrl,
  type GitChange, type GitCommit, type GitReply, type GitRequest, type GitStatus,
} from "@kojyai/shared/projects";
import { createLogger } from "./logger.js";
import { grantDir, sandboxUid, spawnAs } from "./sandbox.js";
import { PROJECTS_DIR } from "./supervisor.js";

const log = createLogger("git");

const GIT_BIN = process.env.GIT_BIN ?? "git";
const NET_TIMEOUT_MS = 120_000;
const LOCAL_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 512 * 1024;

/** Added when a repo is connected and the bot has no .gitignore: its data and local files stay out of git. */
export const DEFAULT_GITIGNORE = `# Added by KojyAI: the bot's saved data and local files stay out of git
__pycache__/
*.pyc
data/
*.db
*.db-*
*.sqlite
*.sqlite3
.env
.bash_history
`;

export class GitUserError extends Error {}

interface RunResult { code: number | null; stdout: string; stderr: string }
interface Ctx {
  uid: number;
  dir: string;
  env: NodeJS.ProcessEnv;
  hasToken: boolean;
}

export class GitService {
  private locks = new Map<string, Promise<unknown>>();

  constructor(private db: Database, private redis: Redis) {}

  /** `git` control message (already verified) for project `uuid`. */
  async handle(uuid: string, payload: Record<string, unknown> | undefined): Promise<void> {
    const req = payload as Partial<GitRequest> | undefined;
    const requestId = typeof req?.requestId === "string" && /^[0-9a-f-]{36}$/.test(req.requestId) ? req.requestId : null;
    if (!requestId || !req?.op) return;
    const prev = this.locks.get(uuid) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => this.run(uuid, req as GitRequest));
    this.locks.set(uuid, run);
    let reply: GitReply;
    try {
      reply = await run;
    } catch (err) {
      if (!(err instanceof GitUserError)) log.warn({ err, uuid, op: req.op }, "Git command failed");
      reply = { ok: false, message: err instanceof Error ? err.message : String(err) };
    } finally {
      if (this.locks.get(uuid) === run) this.locks.delete(uuid);
    }
    await this.redis.publish(`${RUNNER_REPLY_PREFIX}${requestId}`, JSON.stringify(reply)).catch((err: unknown) => log.warn({ err }, "Could not send a git reply"));
  }

  private async run(uuid: string, req: GitRequest): Promise<GitReply> {
    const ctx = await this.context(uuid);
    switch (req.op) {
      case "status":
        return { ok: true, message: "", status: await this.status(ctx) };
      case "connect": {
        const url = this.url(req.url);
        const branch = this.branch(req.branch, "main");
        await this.connect(ctx, url, branch);
        return { ok: true, message: `Connected to ${shortRepo(url)}.`, status: await this.status(ctx) };
      }
      case "import": {
        const url = this.url(req.url);
        await this.connect(ctx, url, "main");
        const message = await this.pull(ctx, req.branch);
        return { ok: true, message, status: await this.status(ctx), changedFiles: true };
      }
      case "pull": {
        const message = await this.pull(ctx, req.branch);
        return { ok: true, message, status: await this.status(ctx), changedFiles: true };
      }
      case "commit": {
        const message = await this.commit(ctx, req.message);
        return { ok: true, message, status: await this.status(ctx) };
      }
      case "push": {
        const message = await this.push(ctx);
        return { ok: true, message, status: await this.status(ctx) };
      }
      default:
        throw new GitUserError("Unknown git command.");
    }
  }

  // ── operations ─────────────────────────────────────────────────────────────

  private async status(ctx: Ctx): Promise<GitStatus> {
    const empty: GitStatus = { repo: false, branch: null, remote: null, ahead: 0, behind: 0, tracking: false, changes: [], commits: [] };
    if (!existsSync(path.join(ctx.dir, ".git"))) return empty;
    const st = await this.git(ctx, ["status", "--porcelain=v1", "-b", "-uall", "-z"]);
    if (st.code !== 0) throw new GitUserError(`git status failed: ${clean(st.stderr)}`);
    const entries = st.stdout.split("\0").filter(Boolean);
    const head = entries[0]?.startsWith("## ") ? entries.shift()!.slice(3) : "";
    const parsed = parseBranchLine(head);
    const changes: GitChange[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      const code = e.slice(0, 2);
      changes.push({ status: describe(code), path: e.slice(3) });
      if (code[0] === "R" || code[0] === "C") i++; // the next entry is the old name
      if (changes.length >= 500) break;
    }
    const remote = await this.git(ctx, ["remote", "get-url", "origin"]);
    const logOut = await this.git(ctx, ["log", "-n", "20", "--format=%H%x1f%an%x1f%at%x1f%s"]);
    const commits: GitCommit[] = logOut.code !== 0 ? [] : logOut.stdout.split("\n").filter(Boolean).map((line) => {
      const [hash = "", author = "", at = "0", subject = ""] = line.split("\x1f");
      return { hash, author, at: Number(at) * 1000, subject };
    });
    return {
      repo: true, branch: parsed.branch, remote: remote.code === 0 ? redact(remote.stdout.trim()) : null,
      ahead: parsed.ahead, behind: parsed.behind, tracking: parsed.tracking, changes, commits,
    };
  }

  private async connect(ctx: Ctx, url: string, branch: string): Promise<void> {
    if (!existsSync(path.join(ctx.dir, ".git"))) {
      await this.must(ctx, ["init", "-q", "-b", branch], "git init");
    }
    const gitignore = path.join(ctx.dir, ".gitignore");
    if (!existsSync(gitignore)) writeFileSync(gitignore, DEFAULT_GITIGNORE);
    const has = await this.git(ctx, ["remote", "get-url", "origin"]);
    await this.must(ctx, has.code === 0 ? ["remote", "set-url", "origin", url] : ["remote", "add", "origin", url], "Setting the remote");
  }

  private async pull(ctx: Ctx, wanted?: string): Promise<string> {
    await this.requireRemote(ctx);
    const remoteBranch = wanted ? this.branch(wanted, "main") : await this.remoteDefault(ctx);
    const fetched = await this.git(ctx, ["fetch", "--prune", "origin"], NET_TIMEOUT_MS);
    if (fetched.code !== 0) throw new GitUserError(netError("Fetching from GitHub", fetched.stderr, ctx.hasToken));
    const exists = await this.git(ctx, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${remoteBranch}`]);
    if (exists.code !== 0) throw new GitUserError(`GitHub has no branch "${remoteBranch}" in this repository yet. Commit and push to create it.`);

    const hasHead = (await this.git(ctx, ["rev-parse", "--verify", "-q", "HEAD"])).code === 0;
    if (!hasHead) {
      // Nothing committed here yet: take GitHub's version (local files with
      // the same names are replaced; KojyAI kept a snapshot to undo).
      await this.must(ctx, ["checkout", "-q", "-f", "-B", remoteBranch, "--track", `origin/${remoteBranch}`], "Checking out");
      return `Got ${remoteBranch} from GitHub.`;
    }
    const current = (await this.git(ctx, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim();
    if (current !== remoteBranch) {
      throw new GitUserError(`You're on branch "${current}", not "${remoteBranch}". Switch branches in the shell (git switch ${remoteBranch}) and pull again.`);
    }
    const dirty = await this.git(ctx, ["status", "--porcelain", "-uno"]);
    if (dirty.stdout.trim()) throw new GitUserError("You have changes that aren't committed. Commit them first (or discard them in the shell), then pull.");
    const merge = await this.git(ctx, ["merge", "--no-edit", "--allow-unrelated-histories", `origin/${remoteBranch}`]);
    if (merge.code !== 0) {
      const conflicts = (await this.git(ctx, ["diff", "--name-only", "--diff-filter=U"])).stdout.trim().split("\n").filter(Boolean);
      await this.git(ctx, ["merge", "--abort"]);
      if (conflicts.length) {
        throw new GitUserError(`Your changes and GitHub's both changed ${conflicts.slice(0, 5).join(", ")}${conflicts.length > 5 ? "…" : ""}. Nothing was changed. Merge them in the shell (git pull), or ask Kojy.`);
      }
      throw new GitUserError(`Pull failed: ${clean(merge.stderr || merge.stdout)}`);
    }
    await this.git(ctx, ["branch", "-q", `--set-upstream-to=origin/${remoteBranch}`]);
    return /Already up to date/i.test(merge.stdout) ? "Already up to date." : `Pulled the latest ${remoteBranch} from GitHub.`;
  }

  private async commit(ctx: Ctx, message?: string): Promise<string> {
    await this.requireRepo(ctx);
    const text = (message ?? "").trim().slice(0, 2000);
    if (!text) throw new GitUserError("Write a short message saying what changed.");
    await this.must(ctx, ["add", "-A"], "Staging files");
    const staged = await this.git(ctx, ["diff", "--cached", "--quiet"]);
    if (staged.code === 0) throw new GitUserError("Nothing to commit — no files changed.");
    await this.must(ctx, ["commit", "-q", "-m", text], "Committing");
    const n = (await this.git(ctx, ["show", "--stat", "--format=", "HEAD"])).stdout.trim().split("\n").filter(Boolean).length;
    return `Committed${n > 1 ? ` (${n - 1} file${n - 1 === 1 ? "" : "s"})` : ""}.`;
  }

  private async push(ctx: Ctx): Promise<string> {
    await this.requireRemote(ctx);
    if (!ctx.hasToken) throw new GitUserError("Connect your GitHub account first (Git panel → Connect GitHub), so KojyAI can push for you.");
    if ((await this.git(ctx, ["rev-parse", "--verify", "-q", "HEAD"])).code !== 0) throw new GitUserError("Nothing to push yet — commit first.");
    const branch = (await this.git(ctx, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim();
    if (!branch || !isSafeBranch(branch)) throw new GitUserError("You're not on a branch (detached HEAD). Switch to one in the shell first.");
    const r = await this.git(ctx, ["push", "-u", "origin", `HEAD:refs/heads/${branch}`], NET_TIMEOUT_MS);
    if (r.code !== 0) {
      if (/\[rejected\]|non-fast-forward|fetch first/i.test(r.stderr)) throw new GitUserError("GitHub has commits you don't have yet. Pull first, then push.");
      throw new GitUserError(netError("Pushing to GitHub", r.stderr, ctx.hasToken));
    }
    return /Everything up-to-date/i.test(r.stderr) ? "GitHub already has everything." : `Pushed ${branch} to GitHub.`;
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async context(uuid: string): Promise<Ctx> {
    const [project] = await this.db.select().from(botProjects).where(eq(botProjects.uuid, uuid)).limit(1);
    if (!project) throw new GitUserError("That bot no longer exists.");
    const dir = path.join(PROJECTS_DIR, uuid);
    if (!existsSync(dir)) throw new GitUserError("The bot's files are missing.");
    const uid = sandboxUid(project.id);
    grantDir(dir, uid);
    const [conn] = await this.db.select().from(gitConnections)
      .where(and(eq(gitConnections.orgId, project.orgId), eq(gitConnections.provider, "github"))).limit(1);
    let token: string | null = null;
    if (conn) {
      try { token = decryptApiKey(conn.tokenVault); }
      catch { log.warn({ orgId: project.orgId }, "GitHub token can't be decrypted (ENCRYPTION_KEY changed?)"); }
    }
    return { uid, dir, env: gitEnv(dir, conn ? { name: conn.name || conn.login, email: conn.email } : null, token), hasToken: !!token };
  }

  private url(input?: string): string {
    const url = input ? normalizeGitHubUrl(input) : null;
    if (!url) throw new GitUserError("Use a GitHub repository address like https://github.com/you/your-bot.");
    return url;
  }

  private branch(input: string | undefined, dflt: string): string {
    const b = (input ?? "").trim() || dflt;
    if (!isSafeBranch(b)) throw new GitUserError(`"${b}" isn't a valid branch name.`);
    return b;
  }

  private async requireRepo(ctx: Ctx): Promise<void> {
    if (!existsSync(path.join(ctx.dir, ".git"))) throw new GitUserError("This bot isn't connected to a repository yet.");
  }

  private async requireRemote(ctx: Ctx): Promise<void> {
    await this.requireRepo(ctx);
    const r = await this.git(ctx, ["remote", "get-url", "origin"]);
    if (r.code !== 0) throw new GitUserError("This bot's repository has no GitHub remote. Connect one in the Git panel.");
    if (!normalizeGitHubUrl(r.stdout.trim())) throw new GitUserError("The remote isn't a GitHub https address. Set it again in the Git panel.");
  }

  /** The remote's default branch (what "HEAD" points to on GitHub). */
  private async remoteDefault(ctx: Ctx): Promise<string> {
    const r = await this.git(ctx, ["ls-remote", "--symref", "origin", "HEAD"], NET_TIMEOUT_MS);
    if (r.code !== 0) throw new GitUserError(netError("Reaching GitHub", r.stderr, ctx.hasToken));
    const m = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(r.stdout);
    if (m && isSafeBranch(m[1]!)) return m[1]!;
    const current = (await this.git(ctx, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim();
    if (current && isSafeBranch(current)) return current;
    throw new GitUserError("This GitHub repository is empty. Commit and push to fill it.");
  }

  private async must(ctx: Ctx, args: string[], what: string): Promise<RunResult> {
    const r = await this.git(ctx, args);
    if (r.code !== 0) throw new GitUserError(`${what} failed: ${clean(r.stderr || r.stdout)}`);
    return r;
  }

  private git(ctx: Ctx, args: string[], timeoutMs = LOCAL_TIMEOUT_MS): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const { child, kill } = spawnAs(ctx.uid, GIT_BIN, args, { cwd: ctx.dir, env: ctx.env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8").on("data", (c: string) => { if (stdout.length < MAX_OUTPUT) stdout += c; });
      child.stderr?.setEncoding("utf8").on("data", (c: string) => { if (stderr.length < MAX_OUTPUT) stderr += c; });
      const timer = setTimeout(() => { kill("SIGKILL"); }, timeoutMs);
      child.once("error", (err) => {
        clearTimeout(timer);
        reject((err as NodeJS.ErrnoException).code === "ENOENT" ? new GitUserError("git isn't installed on this server.") : err);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        if (signal === "SIGKILL") stderr += `\n(stopped after ${Math.round(timeoutMs / 1000)}s)`;
        resolve({ code, stdout, stderr });
      });
    });
  }
}

/**
 * git's environment: no system/global config, no prompts, https only, the
 * commit identity, the bot folder trusted although another user owns it, and
 * the token as a header for github.com only.
 */
export function gitEnv(dir: string, who: { name: string; email: string } | null, token: string | null): NodeJS.ProcessEnv {
  const config: [string, string][] = [
    ["safe.directory", dir],
    ["protocol.allow", "never"],
    ["protocol.https.allow", "always"],
    ["credential.helper", ""],
    ["init.defaultBranch", "main"],
    ["advice.detachedHead", "false"],
    ["core.quotePath", "false"],
  ];
  if (who) config.push(["user.name", who.name], ["user.email", who.email]);
  else config.push(["user.name", "KojyAI"], ["user.email", "bot@kojyai.local"]);
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
    config.push(["http.https://github.com/.extraHeader", `Authorization: Basic ${basic}`]);
  }
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: dir,
    LANG: "C.UTF-8",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ASKPASS: "/bin/false",
    GIT_CONFIG_COUNT: String(config.length),
  };
  config.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "GIT_SSL_CAINFO"]) {
    if (process.env[k]) env[k] = process.env[k];
  }
  return env;
}

export function parseBranchLine(line: string): { branch: string | null; tracking: boolean; ahead: number; behind: number } {
  // "main...origin/main [ahead 1, behind 2]" · "No commits yet on main" · "HEAD (no branch)"
  const noCommits = /^No commits yet on (.+)$/.exec(line);
  if (noCommits) return { branch: noCommits[1]!, tracking: false, ahead: 0, behind: 0 };
  if (line.startsWith("HEAD (no branch)")) return { branch: null, tracking: false, ahead: 0, behind: 0 };
  const m = /^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(line);
  if (!m) return { branch: null, tracking: false, ahead: 0, behind: 0 };
  const info = m[3] ?? "";
  return {
    branch: m[1] ?? null,
    tracking: !!m[2] && !info.includes("gone"),
    ahead: Number(/ahead (\d+)/.exec(info)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(info)?.[1] ?? 0),
  };
}

function describe(code: string): string {
  if (code === "??") return "new";
  if (code.includes("U") || code === "AA" || code === "DD") return "conflict";
  if (code.includes("D")) return "deleted";
  if (code.includes("R")) return "renamed";
  if (code.includes("A")) return "added";
  return "modified";
}

/** Strips credentials someone may have put into a remote URL. */
function redact(url: string): string {
  return url.replace(/\/\/[^/@]+@/, "//");
}

function shortRepo(url: string): string {
  return url.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
}

function clean(s: string): string {
  return redact(s.replace(/\s+/g, " ").trim()).slice(0, 400) || "unknown error";
}

function netError(what: string, stderr: string, hasToken: boolean): string {
  if (/Authentication failed|could not read Username|403|401|Repository not found|not found/i.test(stderr)) {
    return hasToken
      ? `${what} failed: GitHub refused access. Check the repository address, and that your token can read (and, to push, write) this repository.`
      : `${what} failed: GitHub refused access. For a private repository, connect your GitHub account in the Git panel first.`;
  }
  if (/Could not resolve host|timed out|Connection refused|unable to access/i.test(stderr)) return `${what} failed: GitHub couldn't be reached from the server. Try again in a minute.`;
  return `${what} failed: ${clean(stderr)}`;
}

