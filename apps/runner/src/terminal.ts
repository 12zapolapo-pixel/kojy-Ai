/**
 * Terminals — the owner's shell in a bot's folder (Studio → Shell).
 * OWNERSHIP: apps/runner
 *
 * Each shell is kojy_shell.py (a real PTY running bash) started as the project's own
 * sandbox user, exactly like the bot itself: it can see and change that
 * project's files and Python environment, and nothing else. The bot's
 * secrets are in its environment, as they are for the bot.
 *
 * Without a working sandbox a shell would run as the runner's user, which can
 * read the runner's own secrets (ENCRYPTION_KEY, DATABASE_URL): shells are
 * refused then, unless RUNNER_TERMINAL_UNSANDBOXED=true (local development).
 *
 * Transport: see @kojyai/shared/projects (shell.ts). Output is coalesced into
 * ~16 ms batches; if Redis falls behind, reading from the shell pauses (real
 * backpressure through the pipe and the PTY) instead of buffering forever.
 */

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { and, eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import type { Database } from "@kojyai/db";
import { botProjects, gitConnections } from "@kojyai/db/schema";
import { verifyBotControlMessage } from "@kojyai/shared/crypto";
import { TERM_IDLE_MS, TERM_OUT_PREFIX, TERM_STALE_MS, type TermOut } from "@kojyai/shared/projects";
import { createLogger } from "./logger.js";
import { grantDir, grantDirOnce, sandboxStatus, sandboxUid, spawnAs, type Sandboxed } from "./sandbox.js";
import { PROJECTS_DIR, VENVS_DIR, type Supervisor } from "./supervisor.js";

const log = createLogger("terminal");

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const PTY_HELPER = path.join(HERE, "kojy_shell.py");
export const SHELL_RC = path.join(HERE, "shellrc.sh");
const PYTHON_BIN = process.env.PYTHON_BIN ?? "python3";

const MAX_TOTAL = Math.max(1, Number(process.env.RUNNER_TERMINAL_MAX ?? 12));
const MAX_PER_PROJECT = 3;
const FLUSH_MS = 16;
const MAX_BATCH_BYTES = 256 * 1024;
/** Output batches Redis hasn't taken yet, above which reading from the shell pauses. */
const MAX_INFLIGHT = 8;
const SID = /^[0-9a-f-]{36}$/;

interface Session {
  sid: string;
  uuid: string;
  proc: Sandboxed;
  lastSeen: number;
  lastInput: number;
  pending: Buffer[];
  pendingBytes: number;
  flushTimer: NodeJS.Timeout | null;
  /** Output batches sent to Redis and not yet acknowledged. */
  inflight: number;
  closed: boolean;
}

export function terminalsAllowed(): { ok: boolean; reason: string } {
  const s = sandboxStatus();
  if (s.enabled) return { ok: true, reason: s.reason };
  if (process.env.RUNNER_TERMINAL_UNSANDBOXED === "true") return { ok: true, reason: "RUNNER_TERMINAL_UNSANDBOXED=true" };
  return { ok: false, reason: `The shell needs the bot sandbox, which isn't working on this server (${s.reason}). See docs/SECURITY_RUNNER.md.` };
}

export class Terminals {
  private sessions = new Map<string, Session>();
  private sweeper: NodeJS.Timeout;

  constructor(private db: Database, private supervisor: Supervisor, private redis: Redis) {
    this.sweeper = setInterval(() => this.sweep(), 15_000);
    this.sweeper.unref();
  }

  count(): number {
    return this.sessions.size;
  }

  /** `terminal_open` control message (already verified) for project `uuid`. */
  async open(uuid: string, payload: Record<string, unknown> | undefined): Promise<void> {
    const sid = String(payload?.["sid"] ?? "");
    if (!SID.test(sid) || this.sessions.has(sid)) return;
    const cols = clampInt(payload?.["cols"], 10, 500, 80);
    const rows = clampInt(payload?.["rows"], 3, 200, 24);
    const fail = (m: string) => this.send(sid, { t: "err", m });

    const allowed = terminalsAllowed();
    if (!allowed.ok) return fail(allowed.reason);
    if (this.sessions.size >= MAX_TOTAL) return fail("Too many shells are open on this server right now. Close one and try again.");
    if ([...this.sessions.values()].filter((s) => s.uuid === uuid).length >= MAX_PER_PROJECT) {
      return fail(`A bot can have up to ${MAX_PER_PROJECT} shells open at once. Close one first.`);
    }

    const [project] = await this.db.select().from(botProjects).where(eq(botProjects.uuid, uuid)).limit(1);
    if (!project) return fail("That bot no longer exists.");
    const dir = path.join(PROJECTS_DIR, uuid);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const uid = sandboxUid(project.id);
    const venv = path.join(VENVS_DIR, uuid);
    let proc: Sandboxed;
    try {
      mkdirSync(venv, { recursive: true });
      grantDirOnce(venv, uid);
      grantDir(dir, uid);
      const python = path.join(venv, "bin", "python");
      if (!existsSync(python)) {
        this.output(sid, "\x1b[2mSetting up this bot's Python environment…\x1b[0m\r\n");
        await this.run(uid, PYTHON_BIN, ["-m", "venv", venv], dir);
      }
      const env = await this.supervisor.botEnv(project, python, dir);
      Object.assign(env, {
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        HISTFILE: path.join(venv, ".bash_history"),
        LESSHISTFILE: "-", // less (git's pager) would leave .lesshst in the bot's files
        KOJY_BOT_NAME: project.name.replace(/[^\w .-]+/g, "").slice(0, 40) || "bot",
        PIP_CACHE_DIR: path.join(venv, ".pip-cache"),
        // git in the shell: `git config --global` lives next to the venv, not
        // in the bot's files; the folder is trusted although the runner owns it.
        GIT_CONFIG_GLOBAL: path.join(venv, ".gitconfig"),
        ...(await this.gitIdentity(project.orgId, dir)),
      });
      delete env.KOJY_ENTRY; // only the launcher uses it
      proc = spawnAs(uid, PYTHON_BIN, [PTY_HELPER, String(cols), String(rows), SHELL_RC], {
        cwd: dir, env, stdio: ["pipe", "pipe", "pipe", "pipe"],
      });
    } catch (err) {
      log.warn({ err, uuid }, "Could not open a shell");
      return fail(`The shell couldn't start: ${(err as Error).message}`);
    }

    const now = Date.now();
    const session: Session = { sid, uuid, proc, lastSeen: now, lastInput: now, pending: [], pendingBytes: 0, flushTimer: null, inflight: 0, closed: false };
    this.sessions.set(sid, session);
    const { child } = proc;
    child.stdin?.on("error", () => undefined);
    (child.stdio[3] as Writable | undefined)?.on("error", () => undefined);
    const out = child.stdout as Readable;
    out.on("data", (chunk: Buffer) => this.queue(session, chunk));
    // kojy_shell.py's own errors (it never writes the shell's stderr here).
    child.stderr?.on("data", (chunk: Buffer) => log.warn({ uuid, err: chunk.toString("utf8").slice(0, 500) }, "Shell helper error"));
    child.once("error", (err) => { void this.finish(session, null, `The shell couldn't start: ${err.message}`); });
    child.once("exit", (code) => { void this.finish(session, code); });
    child.once("spawn", () => this.send(sid, { t: "ready" }));
    log.info({ uuid, sid, open: this.sessions.size }, "Shell opened");
  }

  /** A message on term_in:<sid>. */
  input(sid: string, raw: string): void {
    const session = this.sessions.get(sid);
    if (!session || session.closed) return;
    const v = verifyBotControlMessage(sid, raw);
    if (!v.ok) { log.warn({ sid, reason: v.reason }, "Rejected shell input"); return; }
    session.lastSeen = Date.now();
    switch (v.action) {
      case "in": {
        const data = typeof v.payload?.["d"] === "string" ? v.payload["d"] : "";
        if (!data) return;
        session.lastInput = session.lastSeen;
        session.proc.child.stdin?.write(Buffer.from(data, "utf8"));
        return;
      }
      case "resize": {
        const cols = clampInt(v.payload?.["cols"], 10, 500, 80);
        const rows = clampInt(v.payload?.["rows"], 3, 200, 24);
        (session.proc.child.stdio[3] as Writable | undefined)?.write(`${JSON.stringify({ cols, rows })}\n`);
        return;
      }
      case "ping":
        return;
      case "close":
        this.close(session);
        return;
    }
  }

  /** The bot was deleted, or the runner is stopping. */
  closeProject(uuid: string): void {
    for (const s of this.sessions.values()) if (s.uuid === uuid) this.close(s);
  }

  closeAll(): void {
    clearInterval(this.sweeper);
    for (const s of this.sessions.values()) this.close(s);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private close(session: Session): void {
    if (session.closed) return;
    // kojy_shell.py hangs the shell up when its stdin closes; SIGKILL if it doesn't.
    session.proc.child.stdin?.end();
    setTimeout(() => { if (!session.closed) session.proc.kill("SIGKILL"); }, 5000).unref();
  }

  private async finish(session: Session, code: number | null, error?: string): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    this.flush(session);
    if (session.flushTimer) clearTimeout(session.flushTimer);
    this.sessions.delete(session.sid);
    if (error) this.send(session.sid, { t: "err", m: error });
    this.send(session.sid, { t: "exit", code });
    log.info({ uuid: session.uuid, sid: session.sid, code }, "Shell closed");
  }

  private sweep(): void {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (now - s.lastSeen > TERM_STALE_MS) { log.info({ sid: s.sid }, "Shell's browser is gone — closing it"); this.close(s); }
      else if (now - s.lastInput > TERM_IDLE_MS) {
        this.output(s.sid, "\r\n\x1b[2mClosed after an hour without typing.\x1b[0m\r\n");
        this.close(s);
      }
    }
  }

  private queue(session: Session, chunk: Buffer): void {
    session.pending.push(chunk);
    session.pendingBytes += chunk.length;
    if (session.pendingBytes >= MAX_BATCH_BYTES) this.flush(session);
    else if (!session.flushTimer) session.flushTimer = setTimeout(() => this.flush(session), FLUSH_MS);
  }

  private flush(session: Session): void {
    if (session.flushTimer) { clearTimeout(session.flushTimer); session.flushTimer = null; }
    if (!session.pendingBytes) return;
    const data = Buffer.concat(session.pending);
    session.pending = [];
    session.pendingBytes = 0;
    const out = session.proc.child.stdout;
    session.inflight++;
    // Backpressure: stop reading from the shell while Redis is behind; the
    // shell then blocks on its own output instead of us buffering it.
    if (out && session.inflight >= MAX_INFLIGHT) out.pause();
    this.send(session.sid, { t: "o", d: data.toString("base64") }, () => {
      session.inflight--;
      if (out && out.isPaused() && session.inflight < MAX_INFLIGHT / 2) out.resume();
    });
  }

  private output(sid: string, text: string): void {
    this.send(sid, { t: "o", d: Buffer.from(text, "utf8").toString("base64") });
  }

  private send(sid: string, msg: TermOut, done?: () => void): void {
    this.redis.publish(`${TERM_OUT_PREFIX}${sid}`, JSON.stringify(msg))
      .catch((err: unknown) => log.warn({ err, sid }, "Could not send shell output"))
      .finally(() => done?.());
  }

  /** safe.directory for the bot folder, and the connected GitHub account as the commit author (never its token). */
  private async gitIdentity(orgId: number, dir: string): Promise<NodeJS.ProcessEnv> {
    const pairs: [string, string][] = [["safe.directory", dir]];
    try {
      const [conn] = await this.db.select({ login: gitConnections.login, name: gitConnections.name, email: gitConnections.email })
        .from(gitConnections).where(and(eq(gitConnections.orgId, orgId), eq(gitConnections.provider, "github"))).limit(1);
      if (conn) pairs.push(["user.name", conn.name || conn.login], ["user.email", conn.email]);
    } catch (err) { log.warn({ err }, "Could not read the GitHub account for the shell"); }
    const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(pairs.length) };
    pairs.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
    return env;
  }

  private run(uid: number, cmd: string, args: string[], cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const { child } = spawnAs(uid, cmd, args, { cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, LANG: "C.UTF-8" }, stdio: "ignore" });
      child.once("error", reject);
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} ${args.join(" ")} failed (exit ${code})`))));
    });
  }
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === "number" ? Math.floor(v) : Number.NaN;
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
}

