/**
 * Supervisor — keeps each bot project's Python process matching what its
 * owner asked for (running / stopped).
 * OWNERSHIP: apps/runner
 *
 * Per project:
 *   PROJECTS_DIR/<uuid>/            the code (written by the API)
 *   VENVS_DIR/<uuid>/               its own Python virtualenv
 *   PROJECTS_DIR/.logs/<uuid>.log   console output (read by the API)
 *
 * Restarts a crashed bot with backoff (5s, 15s, 30s, 60s, then every 60s); a
 * run that lasted 2+ minutes resets the backoff — the same policy Japalo's
 * own main.py used on Replit.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, renameSync, appendFileSync, rmSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Database } from "@kojyai/db";
import { botProjects, projectSecrets } from "@kojyai/db/schema";
import { decryptApiKey } from "@kojyai/shared/crypto";
import { ActivityRecorder, notifyUser, sendAlert } from "@kojyai/db";
import { createLogger } from "./logger.js";

const log = createLogger("supervisor");

export const PROJECTS_DIR = process.env.PROJECTS_DIR ?? "/app/projects";
const VENVS_DIR   = process.env.VENVS_DIR ?? "/app/venvs";
const PYTHON_BIN  = process.env.PYTHON_BIN ?? "python3";
export const LAUNCHER = path.join(path.dirname(new URL(import.meta.url).pathname), "launcher.py");
const LOG_DIR     = path.join(PROJECTS_DIR, ".logs");
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const RESTART_DELAYS_S = [5, 15, 30, 60];
const HEALTHY_RUN_MS = 120_000;
const STOP_GRACE_MS = 10_000;

/** Always installed next to the project's own requirements.txt. */
const BASE_REQUIREMENTS = ["highrise-bot-sdk==25.1.0", "setuptools<82"];

type Status = typeof botProjects.$inferSelect["status"];

/**
 * Host settings passed through to bots and pip (proxies, CA bundles). Nothing
 * else from the runner's own environment is: it holds DATABASE_URL and
 * ENCRYPTION_KEY, and pip runs third-party install scripts.
 */
const PASSTHROUGH = /^(HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|PIP_\w+|TZ)$/;

function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" };
  for (const [k, v] of Object.entries(process.env)) if (PASSTHROUGH.test(k)) env[k] = v;
  return env;
}

interface Running {
  child: ChildProcess;
  startedAt: number;
  stopping: boolean;
  project: { id: number; orgId: number; ownerId: number; name: string };
}

const ACTIVITY_KINDS = new Set(["chat", "whisper", "reply", "join", "leave", "tip", "emote"]);

export class Supervisor {
  private procs = new Map<string, Running>();
  private restartTimers = new Map<string, NodeJS.Timeout>();
  private crashStreak = new Map<string, number>();
  private busy = new Set<string>();
  private tails = new Map<string, string[]>();
  /** Set by the coder AI: called when a bot crashes on its own (not stopped). */
  onCrash?: (uuid: string, streak: number, tail: string[]) => void;

  private activity: ActivityRecorder;
  /** Crash streak at which the owner was last told, so they hear once per streak. */
  private alerted = new Map<string, number>();

  constructor(private db: Database) {
    this.activity = new ActivityRecorder(db, 5000, (err) => log.warn({ err }, "Could not save bot activity"));
    mkdirSync(LOG_DIR, { recursive: true });
    mkdirSync(VENVS_DIR, { recursive: true });
  }

  /** On boot: start everything the owner left running. */
  async restoreAll(): Promise<void> {
    const rows = await this.db.select({ uuid: botProjects.uuid }).from(botProjects)
      .where(eq(botProjects.desiredState, "running"));
    log.info({ count: rows.length }, "Restoring running projects");
    for (const { uuid } of rows) void this.start(uuid);
  }

  async handle(uuid: string, action: string, payload?: Record<string, unknown>): Promise<void> {
    switch (action) {
      case "start":   return this.start(uuid);
      case "stop":    return this.stop(uuid);
      case "restart": await this.stop(uuid); return this.start(uuid);
      case "stdin":   return this.stdin(uuid, String(payload?.["text"] ?? ""));
      case "purge":   return this.purge(uuid);
      default:        log.warn({ uuid, action }, "Unknown control action");
    }
  }

  /** Runner stopping: bots stop too, but stay "running" as desired so they come back on boot. */
  async shutdown(): Promise<void> {
    for (const t of this.restartTimers.values()) clearTimeout(t);
    const uuids = [...this.procs.keys()];
    await Promise.all(uuids.map((uuid) => this.kill(uuid)));
    await Promise.allSettled(uuids.map((uuid) => this.setStatus(uuid, "stopped", "Runner restarting — the bot starts again when it's back")));
    await this.activity.stop();
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  private async start(uuid: string): Promise<void> {
    if (this.procs.has(uuid) || this.busy.has(uuid)) return;
    this.clearRestart(uuid);
    this.busy.add(uuid);
    try {
      const [project] = await this.db.select().from(botProjects).where(eq(botProjects.uuid, uuid)).limit(1);
      if (!project) return;
      const dir = path.join(PROJECTS_DIR, uuid);
      if (!existsSync(dir)) return this.setStatus(uuid, "error", "Project files are missing.");
      if (!project.entrypoint) return this.setStatus(uuid, "error", "No bot entrypoint set (module.path:BotClass).");

      await this.setStatus(uuid, "installing", "Installing Python packages…");
      const python = await this.ensureVenv(uuid, dir);

      const env = await this.botEnv(project, python, dir);

      await this.setStatus(uuid, "starting", "Starting…");
      this.console(uuid, "system", `▶ Starting ${project.entrypoint}`);
      // fd 3: the launcher's activity reports (chat, join, tip… as JSON lines).
      const child = spawn(python, [LAUNCHER], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe", "pipe"] });
      const run: Running = { child, startedAt: Date.now(), stopping: false, project: { id: project.id, orgId: project.orgId, ownerId: project.ownerId, name: project.name } };
      this.readActivity(run);
      this.tails.set(uuid, []);
      this.procs.set(uuid, run);
      this.pipe(uuid, child);
      child.stdin?.on("error", () => undefined); // EPIPE when the bot has exited
      child.once("error", (err) => {
        // Couldn't start at all (e.g. python missing); "exit" may never come.
        if (this.procs.get(uuid) === run) this.procs.delete(uuid);
        this.console(uuid, "system", `✖ ${err.message}`);
        void this.setStatus(uuid, "error", err.message.slice(0, 500));
      });

      child.once("spawn", () => {
        this.record(run, "start");
        void this.setStatus(uuid, "running", null);
        void this.db.update(botProjects).set({ lastStartedAt: new Date() }).where(eq(botProjects.uuid, uuid));
      });
      child.once("exit", (code, signal) => void this.onExit(uuid, run, code, signal));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.console(uuid, "system", `✖ ${message}`);
      await this.setStatus(uuid, "error", message.slice(0, 500));
    } finally {
      this.busy.delete(uuid);
    }
  }

  /** Environment for the bot's process: its secrets plus Python settings. */
  async botEnv(project: typeof botProjects.$inferSelect, python: string, dir: string): Promise<NodeJS.ProcessEnv> {
    const secrets = await this.db.select().from(projectSecrets).where(eq(projectSecrets.projectId, project.id));
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(),
      PATH: `${path.dirname(python)}:${process.env.PATH ?? ""}`,
      HOME: dir,
      PYTHONUNBUFFERED: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      VIRTUAL_ENV: path.dirname(path.dirname(python)),
      KOJY_ENTRY: project.entrypoint,
      ...(process.env.HR_BOTAPI_URL ? { HR_BOTAPI_URL: process.env.HR_BOTAPI_URL } : {}),
    };
    for (const s of secrets) {
      try { env[s.key] = decryptApiKey(s.valueVault); }
      catch { this.console(project.uuid, "system", `Secret ${s.key} could not be decrypted (was ENCRYPTION_KEY changed?).`); }
    }
    return env;
  }

  private record(run: Running, kind: string, actorId?: string | null, actorName?: string | null): void {
    this.activity.record({ orgId: run.project.orgId, source: "project", sourceId: run.project.id, kind, actorId: actorId ?? null, actorName: actorName ?? null });
  }

  private readActivity(run: Running): void {
    const stream = run.child.stdio[3] as NodeJS.ReadableStream | undefined;
    if (!stream) return;
    let partial = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const e = JSON.parse(line) as { k?: string; id?: string | null; n?: string | null };
          if (e.k && ACTIVITY_KINDS.has(e.k)) this.record(run, e.k, e.id, e.n);
        } catch { /* not ours */ }
      }
    });
    stream.on("error", () => undefined);
  }

  /** The last ~80 console lines of the bot's current/last run. */
  tail(uuid: string): string[] {
    return [...(this.tails.get(uuid) ?? [])];
  }

  runningCount(): number {
    return this.procs.size;
  }

  isRunning(uuid: string): boolean {
    return this.procs.has(uuid);
  }

  private async stop(uuid: string): Promise<void> {
    this.clearRestart(uuid);
    this.crashStreak.delete(uuid);
    if (this.procs.has(uuid)) {
      this.console(uuid, "system", "■ Stopping");
      await this.kill(uuid);
    }
    await this.setStatus(uuid, "stopped", null);
  }

  /** Project deleted: stop it and remove its Python environment. */
  private async purge(uuid: string): Promise<void> {
    this.clearRestart(uuid);
    this.crashStreak.delete(uuid);
    await this.kill(uuid);
    rmSync(path.join(VENVS_DIR, uuid), { recursive: true, force: true });
  }

  private kill(uuid: string): Promise<void> {
    const run = this.procs.get(uuid);
    if (!run) return Promise.resolve();
    run.stopping = true;
    return new Promise((resolve) => {
      const force = setTimeout(() => run.child.kill("SIGKILL"), STOP_GRACE_MS);
      run.child.once("exit", () => { clearTimeout(force); resolve(); });
      run.child.kill("SIGTERM");
    });
  }

  private stdin(uuid: string, text: string): void {
    const run = this.procs.get(uuid);
    if (!run?.child.stdin?.writable) return;
    run.child.stdin.write(text.endsWith("\n") ? text : `${text}\n`);
    this.console(uuid, "stdin", text);
  }

  private async onExit(uuid: string, run: Running, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.procs.get(uuid) === run) this.procs.delete(uuid);
    await this.db.update(botProjects).set({ lastExitCode: code }).where(eq(botProjects.uuid, uuid));
    if (run.stopping) { this.record(run, "stop"); return; }
    this.record(run, "crash");

    const ranFor = Date.now() - run.startedAt;
    const streak = ranFor >= HEALTHY_RUN_MS ? 1 : (this.crashStreak.get(uuid) ?? 0) + 1;
    if (streak === 1) this.alerted.delete(uuid);
    this.crashStreak.set(uuid, streak);
    const delay = RESTART_DELAYS_S[Math.min(streak - 1, RESTART_DELAYS_S.length - 1)]!;
    this.console(uuid, "system", `✖ Bot exited (${signal ?? `code ${code}`}) after ${Math.round(ranFor / 1000)}s — restarting in ${delay}s`);

    const [project] = await this.db.select({ desiredState: botProjects.desiredState, restartCount: botProjects.restartCount })
      .from(botProjects).where(eq(botProjects.uuid, uuid)).limit(1);
    if (project?.desiredState !== "running") return this.setStatus(uuid, "stopped", null);

    await this.db.update(botProjects).set({ restartCount: project.restartCount + 1 }).where(eq(botProjects.uuid, uuid));
    await this.setStatus(uuid, "crashed", `Exited with ${signal ?? `code ${code}`}; restarting in ${delay}s`);
    this.onCrash?.(uuid, streak, this.tail(uuid));
    if (streak >= 3 && this.alerted.get(uuid) !== streak && !this.alerted.has(uuid)) {
      this.alerted.set(uuid, streak);
      const last = this.tail(uuid).filter((l) => l.trim()).slice(-1)[0] ?? "";
      const body = `${run.project.name} has crashed ${streak} times in a row and keeps restarting. Last output: ${last.slice(0, 200)}`;
      void notifyUser(this.db, run.project.ownerId, "bot_error", `${run.project.name} keeps crashing`, body, `/projects/${uuid}`);
      void sendAlert(`⚠️ ${body}`);
    }
    this.restartTimers.set(uuid, setTimeout(() => { this.restartTimers.delete(uuid); void this.start(uuid); }, delay * 1000));
  }

  private clearRestart(uuid: string): void {
    const t = this.restartTimers.get(uuid);
    if (t) { clearTimeout(t); this.restartTimers.delete(uuid); }
  }

  // ── python environment ─────────────────────────────────────────────────────

  /**
   * One venv per project. Packages are reinstalled only when requirements.txt
   * changes (its hash is stored in the venv).
   */
  async ensureVenv(uuid: string, dir: string): Promise<string> {
    const venv = path.join(VENVS_DIR, uuid);
    const python = path.join(venv, "bin", "python");
    if (!existsSync(python)) {
      this.console(uuid, "system", "Creating Python environment…");
      await this.exec(uuid, PYTHON_BIN, ["-m", "venv", venv], dir);
    }
    const reqFile = path.join(dir, "requirements.txt");
    const reqText = existsSync(reqFile) ? readFileSync(reqFile, "utf8") : "";
    const hash = createHash("sha256").update(BASE_REQUIREMENTS.join("\n") + "\n" + reqText).digest("hex");
    const marker = path.join(venv, ".kojy-requirements");
    if (existsSync(marker) && readFileSync(marker, "utf8") === hash) return python;

    this.console(uuid, "system", "Installing packages (first run or requirements.txt changed)…");
    const args = ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", ...BASE_REQUIREMENTS];
    if (reqText.trim()) args.push("-r", reqFile);
    await this.exec(uuid, python, args, dir);
    writeFileSync(marker, hash);
    return python;
  }

  private exec(uuid: string, cmd: string, args: string[], cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd, env: { ...baseEnv(), HOME: cwd, PIP_CACHE_DIR: path.join(VENVS_DIR, ".pip-cache") }, stdio: ["ignore", "pipe", "pipe"] });
      this.pipe(uuid, child);
      child.once("error", reject);
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} ${args.slice(0, 3).join(" ")} failed (exit ${code})`))));
    });
  }

  // ── console + status ───────────────────────────────────────────────────────

  private pipe(uuid: string, child: ChildProcess): void {
    for (const [stream, src] of [["stdout", child.stdout], ["stderr", child.stderr]] as const) {
      let partial = "";
      src?.setEncoding("utf8");
      src?.on("data", (chunk: string) => {
        const lines = (partial + chunk).split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) this.console(uuid, stream, line);
      });
      src?.on("end", () => { if (partial) this.console(uuid, stream, partial); });
    }
  }

  /** Appends one line to the project's console log (rotated at 2 MB). */
  console(uuid: string, stream: "stdout" | "stderr" | "stdin" | "system", line: string): void {
    if (stream === "stdout" || stream === "stderr") {
      const t = this.tails.get(uuid);
      if (t) { t.push(line.slice(0, 500)); if (t.length > 80) t.shift(); }
    }
    const file = path.join(LOG_DIR, `${uuid}.log`);
    try {
      if (existsSync(file) && statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.1`);
      appendFileSync(file, JSON.stringify({ ts: Date.now(), stream, line: line.slice(0, 4000) }) + "\n");
    } catch (err) {
      log.warn({ err, uuid }, "Could not write console log");
    }
  }

  private async setStatus(uuid: string, status: Status, message: string | null): Promise<void> {
    await this.db.update(botProjects).set({ status, statusMessage: message }).where(eq(botProjects.uuid, uuid));
  }
}
