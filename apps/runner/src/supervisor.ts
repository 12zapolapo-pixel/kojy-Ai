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
 *
 * A project with a bot host and a server there runs on that host instead
 * (hostRunner.ts): the same start/stop/restart, console log, crash policy and
 * Kojy's fixes, but the process lives on the host.
 */

import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, renameSync, appendFileSync, rmSync } from "node:fs";
import path from "node:path";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { Database } from "@kojyai/db";
import { botProjects, projectSecrets } from "@kojyai/db/schema";
import { decryptApiKey } from "@kojyai/shared/crypto";
import { ActivityRecorder, notifyUser, sendAlert } from "@kojyai/db";
import { createLogger } from "./logger.js";
import { grantDir, grantDirOnce, sandboxUid, spawnAs, type Sandboxed } from "./sandbox.js";
import { CONNECTED_PREFIX, NOT_MODERATOR_MARK, PLATFORM_RESTART_LINE, ROOM_RIGHTS_PREFIX } from "./agent/botHealth.js";
import { DISCORD_CONNECTED } from "./agent/discord.js";
import { HostRunner, type HostRef, type HostRunnerOptions, type RunProject } from "./hostRunner.js";
import { IncidentLedger, ROOM_TROUBLE, classifyExit, parseReport, reportToTail, type CrashReport, type Incident, type IncidentCategory } from "./incidents.js";
import { PresenceTracker, SILENT_MS, parsePresence, type PresenceEvent } from "./presence.js";
import { lastException } from "./agent/autoFix.js";
import { isStartCommand, saveKnownGood, startCommand } from "@kojyai/shared/projects";

const log = createLogger("supervisor");

export const PROJECTS_DIR = process.env.PROJECTS_DIR ?? "/app/projects";
export const VENVS_DIR = process.env.VENVS_DIR ?? "/app/venvs";
const PYTHON_BIN  = process.env.PYTHON_BIN ?? "python3";
export const LAUNCHER = path.join(path.dirname(new URL(import.meta.url).pathname), "launcher.py");
/** check_code's loader check (see botcheck.py). */
export const BOTCHECK = path.join(path.dirname(new URL(import.meta.url).pathname), "botcheck.py");
/** What a bot host runs (uploaded as kojy_start.py, see hoststart.py). */
export const HOSTSTART = path.join(path.dirname(new URL(import.meta.url).pathname), "hoststart.py");
const LOG_DIR     = path.join(PROJECTS_DIR, ".logs");
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const RESTART_DELAYS_S = [5, 15, 30, 60];
/** A start that failed before the bot ran (pip, network, database): try again, slower. */
const START_RETRY_DELAYS_S = [30, 120, 600, 1800];
const HEALTHY_RUN_MS = 120_000;
/**
 * A run this long without a crash or an error keeps its code as "the last
 * version that ran fine" — what a crash fix compares the code with.
 */
const KNOWN_GOOD_AFTER_MS = Number(process.env.KNOWN_GOOD_AFTER_MS ?? 10 * 60_000);
/**
 * Short runs in a row after which a bot stops being restarted: it's in a
 * crash loop (about 8 minutes of restarts with the delays above), and
 * restarting it forever only fills the log and keeps knocking on Highrise.
 */
export const CRASH_LOOP_LIMIT = Math.max(3, Number(process.env.CRASH_LOOP_LIMIT ?? 10));
export const CRASH_LOOP_STATUS = `Paused after ${CRASH_LOOP_LIMIT} crashes in a row. Fix the error (or ask Kojy), then press Start.`;
const STOP_GRACE_MS = 10_000;
const NO_MODERATOR_STATUS = "Not a moderator in its room: commands that move, kick, mute or ban people won't work";
/** How often the room checks are looked at (a bot whose checks stop coming is restarted). */
const PRESENCE_TICK_MS = 60_000;
/** How often what the website shows is compared with what really runs. */
const RECONCILE_EVERY_MS = 5 * 60_000;
/** Runs in a row that ended out of the room before the owner is told what to check. */
const OUT_OF_ROOM_ALERT_AFTER = 2;
/** Highrise refusing the bot again and again: try less often (it can't help until a secret changes). */
const REFUSED_RETRY_S = [120, 300, 900, 1800];
/** This many bots, most of them, out of their rooms at once: Highrise or the network, not each bot. */
const OUTAGE_MIN_BOTS = 3;
const OUTAGE_SHARE = 0.75;
/** How often the bot's code is checked as running (a status left "crashed" with nothing coming is stuck). */
const STUCK_AFTER_MS = 10 * 60_000;
/** How often bots waiting for a free server on their bot host try again. */
const PENDING_HOST_EVERY_MS = 30 * 60_000;

/** Always installed next to the project's own requirements.txt. */
const BASE_REQUIREMENTS = ["highrise-bot-sdk==25.1.0", "setuptools<82"];

type ProjectRow = typeof botProjects.$inferSelect;
type Status = ProjectRow["status"];

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

/** {hostId, server} from a control message (moving a bot or deleting it). */
function hostRef(v: unknown): HostRef | null {
  if (!v || typeof v !== "object") return null;
  const { hostId, server } = v as { hostId?: unknown; server?: unknown };
  return typeof hostId === "number" && Number.isInteger(hostId) && typeof server === "string" && /^[A-Za-z0-9-]{4,64}$/.test(server)
    ? { hostId, server } : null;
}

interface Running {
  child: ChildProcess;
  /** Signals the bot (works when it runs as its own sandbox user). */
  signal: Sandboxed["kill"];
  startedAt: number;
  stopping: boolean;
  project: RunProject;
}

const ACTIVITY_KINDS = new Set(["chat", "whisper", "reply", "join", "leave", "tip", "emote"]);

export class Supervisor {
  private procs = new Map<string, Running>();
  private restartTimers = new Map<string, NodeJS.Timeout>();
  private crashStreak = new Map<string, number>();
  /** Starts in a row that failed before the bot ran. */
  private startFailures = new Map<string, number>();
  private busy = new Set<string>();
  private tails = new Map<string, string[]>();
  /** Set by the coder AI: called when a bot crashes on its own (not stopped), with the incident it was recorded as. */
  onCrash?: (uuid: string, streak: number, tail: string[], incident: Incident | null) => void;
  /** Set by the coder AI: an error the bot survived (it kept running), with its incident. */
  onBotError?: (uuid: string, tail: string[], incident: Incident | null, report: CrashReport) => void;
  /** Every problem the bots had (bot_incidents). */
  readonly incidents: IncidentLedger;
  /** The launcher's crash report from each bot's current run (see launcher.py). */
  private reports = new Map<string, CrashReport>();
  /**
   * Bots not restarted automatically while Kojy fixes a crash that restarting
   * can't help (it fails while loading or starting): why, for the status line.
   * An explicit start (the owner, Kojy, the fix finishing) ends the hold.
   */
  private holds = new Map<string, string>();
  /** Set by the coder AI: whether it's fixing (or about to fix) this bot's crash right now. */
  fixingNow?: (uuid: string) => boolean;
  /** Runs that may still turn out fine: when the timer ends with no crash or error, their code is kept as known good. */
  private goodTimers = new Map<string, NodeJS.Timeout>();
  /** Whether each bot is really in its room (the launcher's checks). */
  readonly presence: PresenceTracker;
  /** Runs in a row that ended without the bot being in its room. */
  private outOfRoom = new Map<string, number>();
  /** When a Highrise-wide outage was last reported to the admins. */
  private outageAlertedAt = 0;
  private presenceTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  /** A Discord bot connected to Discord (once per start; see agent/discord.ts). */
  onDiscordConnected?: (uuid: string) => void;

  private activity: ActivityRecorder;
  /** Crash streak at which the owner was last told, so they hear once per streak. */
  private alerted = new Map<string, number>();
  /** Bots whose owner was told the bot isn't a moderator in its room (once per runner run). */
  private rightsWarned = new Set<string>();
  /** Bots whose Discord connection was already reported since they last started. */
  private discordSeen = new Set<string>();
  /** Bots running on an outside bot host. */
  private hosts: HostRunner;
  private pendingTimer: NodeJS.Timeout | null = null;

  constructor(private db: Database, hostTesting?: Pick<HostRunnerOptions, "makeClient" | "makeConsole">) {
    this.activity = new ActivityRecorder(db, 5000, (err) => log.warn({ err }, "Could not save bot activity"));
    this.incidents = new IncidentLedger(db);
    this.presence = new PresenceTracker(db, {
      isRunning: (uuid) => this.isRunning(uuid),
      backInRoom: (uuid, projectId) => this.backInRoom(uuid, projectId),
      silent: (uuid, why, times) => void this.silent(uuid, why, times).catch((err: unknown) => log.warn({ err, uuid }, "Could not restart a silent bot")),
    });
    mkdirSync(LOG_DIR, { recursive: true });
    mkdirSync(VENVS_DIR, { recursive: true });
    this.hosts = new HostRunner(db, {
      console: (uuid, stream, line) => this.console(uuid, stream, line),
      setStatus: (uuid, status, message) => this.setStatus(uuid, status, message),
      started: (uuid, project) => {
        this.startFailures.delete(uuid);
        this.tails.set(uuid, this.tails.get(uuid) ?? []);
        this.goodLater(uuid);
        this.presence.started(uuid, project.id, true);
        this.record(project, "start");
        void this.db.update(botProjects).set({ lastStartedAt: new Date() }).where(eq(botProjects.uuid, uuid));
      },
      stopped: (_uuid, project) => this.record(project, "stop"),
      crashed: (uuid, project, ranFor, how, exitCode) => void this.hostCrashed(uuid, project, ranFor, how, exitCode),
      startFailed: (uuid, message) => this.startFailed(uuid, message),
      later: (uuid, seconds) => this.startLater(uuid, seconds),
      activity: (project, kind, actorId, actorName, extra) => this.record(project, kind, actorId, actorName, extra),
      roomRights: (uuid, project, line) => this.onRoomRights(uuid, project, line),
      report: (uuid, project, raw) => this.onReport(uuid, project, raw),
    }, {
      launcherPath: LAUNCHER, starterPath: HOSTSTART, baseRequirements: BASE_REQUIREMENTS,
      secrets: (row) => this.secrets(row), ...hostTesting,
    });
  }

  /** On boot: start everything the owner left running. */
  async restoreAll(): Promise<void> {
    const rows = await this.db.select({ uuid: botProjects.uuid }).from(botProjects)
      .where(eq(botProjects.desiredState, "running"));
    log.info({ count: rows.length }, "Restoring running projects");
    // Bots on a bot host kept running: start() only reattaches to them. A bot
    // held for Kojy's fix (its crash would only happen again) starts with the fix.
    for (const { uuid } of rows) if (!this.holds.has(uuid)) void this.start(uuid, "back after a KojyAI restart");
    if (!this.pendingTimer) {
      this.pendingTimer = setInterval(() => void this.sweepPendingHosts(), PENDING_HOST_EVERY_MS);
      this.pendingTimer.unref();
      setTimeout(() => void this.sweepPendingHosts(), 60_000).unref();
    }
    if (!this.presenceTimer) {
      this.presenceTimer = setInterval(() => this.presence.tick(), PRESENCE_TICK_MS);
      this.presenceTimer.unref();
      this.reconcileTimer = setInterval(() => void this.reconcile().catch((err: unknown) => log.warn({ err }, "Could not compare the bots with what runs")), RECONCILE_EVERY_MS);
      this.reconcileTimer.unref();
    }
  }

  async handle(uuid: string, action: string, payload?: Record<string, unknown>): Promise<void> {
    switch (action) {
      case "start":   return this.start(uuid);
      case "stop":    return this.stop(uuid);
      case "restart": await this.stop(uuid); return this.start(uuid);
      case "stdin":   return this.stdin(uuid, String(payload?.["text"] ?? ""));
      case "purge":   return this.purge(uuid, payload);
      case "rehost":  return this.rehost(uuid, payload);
      default:        log.warn({ uuid, action }, "Unknown control action");
    }
  }

  /** Runner stopping: bots stop too, but stay "running" as desired so they come back on boot. */
  async shutdown(): Promise<void> {
    for (const t of this.restartTimers.values()) clearTimeout(t);
    if (this.pendingTimer) clearInterval(this.pendingTimer);
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    // Bots on a bot host keep running there; only their live consoles close.
    this.hosts.detachAll();
    const uuids = [...this.procs.keys()];
    // Says why in each bot's console, so the owner and Kojy don't hunt for a bug.
    for (const uuid of uuids) { this.console(uuid, "system", PLATFORM_RESTART_LINE); this.presence.stopped(uuid); }
    await Promise.all(uuids.map((uuid) => this.kill(uuid)));
    await Promise.allSettled(uuids.map((uuid) => this.setStatus(uuid, "stopped", "Runner restarting — the bot starts again when it's back")));
    await this.activity.stop();
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  private async start(uuid: string, reason?: string): Promise<void> {
    if (this.procs.has(uuid) || this.busy.has(uuid)) return;
    this.holds.delete(uuid);
    this.clearRestart(uuid);
    this.busy.add(uuid);
    try {
      const [project] = await this.db.select().from(botProjects).where(eq(botProjects.uuid, uuid)).limit(1);
      if (!project) return;
      if (project.hostId && project.hostServer) {
        if (isStartCommand(project.entrypoint)) return this.setStatus(uuid, "error", "Start commands (run: …) only run on KojyAI's own server. Move the bot back in Settings → Where it runs.");
        // A fresh run's output only: an old traceback left here would be taken
        // for the cause of the next exit (one without a traceback of its own).
        this.tails.set(uuid, []);
        this.reports.delete(uuid);
        this.busy.delete(uuid);
        // Watched from now (also when only reattaching to a bot that kept running there).
        this.presence.started(uuid, project.id, true);
        return await this.hosts.start(project, reason);
      }
      const dir = path.join(PROJECTS_DIR, uuid);
      if (!existsSync(dir)) return this.setStatus(uuid, "error", "Project files are missing.");
      if (!project.entrypoint) return this.setStatus(uuid, "error", "Nothing to start yet: set the entrypoint (module.path:BotClass) or a start command (run: python main.py).");

      await this.setStatus(uuid, "installing", "Installing Python packages…");
      const python = await this.ensureVenv(uuid, dir, project.id);

      const env = await this.botEnv(project, python, dir);
      const uid = sandboxUid(project.id); // ensureVenv already granted it the folders

      await this.setStatus(uuid, "starting", "Starting…");
      this.console(uuid, "system", `▶ Starting ${project.entrypoint}${reason ? ` (${reason})` : ""}`);
      // fd 3: the launcher's activity reports (chat, join, tip… as JSON lines).
      // A start command (not a Highrise bot) runs with bash -c; for a single
      // command bash replaces itself with it, so stop/restart signal the program.
      const { child, kill: signal } = isStartCommand(project.entrypoint)
        ? spawnAs(uid, "/bin/bash", ["-c", startCommand(project.entrypoint)], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe", "pipe"] })
        : spawnAs(uid, python, [LAUNCHER], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe", "pipe"] });
      const run: Running = { child, signal, startedAt: Date.now(), stopping: false, project: { id: project.id, orgId: project.orgId, ownerId: project.ownerId, name: project.name } };
      this.reports.delete(uuid);
      this.readActivity(uuid, run);
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
        this.startFailures.delete(uuid);
        this.goodLater(uuid);
        this.presence.started(uuid, project.id, !isStartCommand(project.entrypoint));
        this.record(run.project, "start");
        void this.setStatus(uuid, "running", null);
        void this.db.update(botProjects).set({ lastStartedAt: new Date() }).where(eq(botProjects.uuid, uuid));
      });
      // The crash report (fd 3) and the traceback (stderr) are the last things a
      // crashing bot writes: wait for its pipes to be read out before judging
      // the exit — but not forever (a program it started can hold them open).
      child.once("exit", (code, signal) => {
        // Gone now: a stop or restart mustn't see it as running while its pipes drain
        // (a program it started can hold them open long after it exited).
        if (this.procs.get(uuid) === run) this.procs.delete(uuid);
        let done = false;
        const go = () => { if (!done) { done = true; void this.onExit(uuid, run, code, signal); } };
        child.once("close", go);
        setTimeout(go, 2000).unref();
      });
    } catch (err) {
      await this.startFailed(uuid, err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.delete(uuid);
    }
  }

  /**
   * A start that failed before the bot ran. Usually passing (PyPI, the network
   * or the bot host unreachable, the database busy right after a restart): try
   * again with backoff while the owner wants it running, instead of leaving the
   * bot offline until someone presses Start.
   */
  private async startFailed(uuid: string, message: string): Promise<void> {
    const failures = (this.startFailures.get(uuid) ?? 0) + 1;
    this.startFailures.set(uuid, failures);
    const delay = START_RETRY_DELAYS_S[Math.min(failures - 1, START_RETRY_DELAYS_S.length - 1)]!;
    let retry = true;
    try {
      const [p] = await this.db.select({ desiredState: botProjects.desiredState }).from(botProjects).where(eq(botProjects.uuid, uuid)).limit(1);
      retry = p?.desiredState === "running";
    } catch { /* database unreachable: keep trying */ }
    const note = retry ? ` — trying again in ${delay}s` : "";
    this.console(uuid, "system", `✖ ${message}${note}`);
    await this.setStatus(uuid, "error", `${message.slice(0, 450)}${note}`).catch(() => undefined);
    if (retry) this.startLater(uuid, delay);
  }

  /** Start again after `seconds` (after a crash, a failed start, a server still being set up). */
  private startLater(uuid: string, seconds: number): void {
    this.clearRestart(uuid);
    this.restartTimers.set(uuid, setTimeout(() => { this.restartTimers.delete(uuid); void this.start(uuid); }, seconds * 1000));
  }

  /** Environment for the bot's process: its secrets plus Python settings. */
  async botEnv(project: ProjectRow, python: string, dir: string): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(),
      PATH: `${path.dirname(python)}:${process.env.PATH ?? ""}`,
      HOME: dir,
      PYTHONUNBUFFERED: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      VIRTUAL_ENV: path.dirname(path.dirname(python)),
      KOJY_ENTRY: project.entrypoint,
      // Highrise was seen listing this bot in its room: the launcher may count it missing from that list.
      KOJY_EXPECT_LISTED: project.roomListsBot ? "1" : "0",
      ...(process.env.HR_BOTAPI_URL ? { HR_BOTAPI_URL: process.env.HR_BOTAPI_URL } : {}),
    };
    return Object.assign(env, await this.secrets(project));
  }

  /** The bot's secrets, decrypted; one that can't be is left out, with a note in its console. */
  async secrets(project: ProjectRow): Promise<Record<string, string>> {
    const rows = await this.db.select().from(projectSecrets).where(eq(projectSecrets.projectId, project.id));
    const out: Record<string, string> = {};
    for (const s of rows) {
      try { out[s.key] = decryptApiKey(s.valueVault); }
      catch { this.console(project.uuid, "system", `Secret ${s.key} could not be decrypted (was ENCRYPTION_KEY changed?).`); }
    }
    return out;
  }

  private record(project: Pick<RunProject, "id" | "orgId">, kind: string, actorId?: string | null, actorName?: string | null, extra?: { amount?: number | null; detail?: string | null }): void {
    this.activity.record({
      orgId: project.orgId, source: "project", sourceId: project.id, kind, actorId: actorId ?? null, actorName: actorName ?? null,
      amount: kind === "tip" && typeof extra?.amount === "number" ? extra.amount : null,
      detail: (kind === "chat" || kind === "whisper") && typeof extra?.detail === "string" && /^[!/][a-z][a-z0-9_-]{0,30}$/.test(extra.detail) ? extra.detail : null,
    });
  }

  private readActivity(uuid: string, run: Running): void {
    const stream = run.child.stdio[3] as NodeJS.ReadableStream | undefined;
    if (!stream) return;
    let partial = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const e = JSON.parse(line) as { k?: string; id?: string | null; n?: string | null; a?: number; d?: string };
          if (e.k && ACTIVITY_KINDS.has(e.k)) this.record(run.project, e.k, e.id, e.n, { amount: e.a ?? null, detail: e.d ?? null });
          else if (e.k === "crash" || e.k === "error" || e.k === "presence") this.onReport(uuid, run.project, e);
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
    return this.procs.size + this.hosts.runningCount();
  }

  isRunning(uuid: string): boolean {
    return this.procs.has(uuid) || this.hosts.isRunning(uuid);
  }

  /** Where a bot on a bot host runs (for get_logs); null for a bot running here. */
  hostNote(uuid: string): string | null {
    return this.hosts.note(uuid);
  }

  /** The project's row when it runs on a bot host. */
  private async remoteRow(uuid: string): Promise<ProjectRow | null> {
    const [row] = await this.db.select().from(botProjects).where(eq(botProjects.uuid, uuid)).limit(1);
    return row?.hostId && row.hostServer ? row : null;
  }

  private async stop(uuid: string): Promise<void> {
    this.holds.delete(uuid);
    this.notGood(uuid);
    this.presence.stopped(uuid);
    this.outOfRoom.delete(uuid);
    this.clearRestart(uuid);
    this.crashStreak.delete(uuid);
    this.startFailures.delete(uuid);
    if (this.procs.has(uuid)) {
      this.console(uuid, "system", "■ Stopping");
      await this.kill(uuid);
    }
    const remote = await this.remoteRow(uuid);
    if (remote) return this.hosts.stop(remote);
    await this.setStatus(uuid, "stopped", null);
  }

  /**
   * The owner moved the bot: onto a bot host, back here, or to another
   * server. It stops where it ran (a host's data/ files are copied back),
   * then starts in its new place if the owner wants it running.
   */
  private async rehost(uuid: string, payload?: Record<string, unknown>): Promise<void> {
    const from = hostRef(payload?.["from"]);
    this.presence.stopped(uuid);
    this.clearRestart(uuid);
    this.crashStreak.delete(uuid);
    this.startFailures.delete(uuid);
    const [row] = await this.db.select().from(botProjects).where(eq(botProjects.uuid, uuid)).limit(1);
    if (!row) return;
    if (this.procs.has(uuid)) {
      this.console(uuid, "system", "■ Stopping here to move the bot");
      await this.kill(uuid);
    }
    if (from && !(row.hostId === from.hostId && row.hostServer === from.server)) {
      await this.hosts.release(uuid, row.orgId, from).catch((err: unknown) =>
        this.console(uuid, "system", `✖ Couldn't finish moving off the old bot host: ${err instanceof Error ? err.message : String(err)}`));
    }
    if (row.desiredState === "running") await this.start(uuid, row.hostId && row.hostServer ? "moved to its bot host" : "moved back to KojyAI");
    else await this.setStatus(uuid, "stopped", null);
  }

  /** Bots waiting for a free server on their bot host: make one once the host has room, then move them there. */
  private async sweepPendingHosts(): Promise<void> {
    let rows: ProjectRow[];
    try {
      rows = await this.db.select().from(botProjects).where(and(isNotNull(botProjects.hostId), isNull(botProjects.hostServer)));
    } catch { return; }
    for (const row of rows) {
      try {
        const server = await this.hosts.createServerFor(row);
        if (!server) continue;
        await this.db.update(botProjects).set({ hostServer: server, hostSync: null })
          .where(and(eq(botProjects.id, row.id), isNull(botProjects.hostServer)));
        this.console(row.uuid, "system", `The bot host had room again and made a free server (${server}) for this bot — moving it there.`);
        void notifyUser(this.db, row.ownerId, "system", `${row.name} got its free server`,
          `The bot host made a free server for ${row.name}, and KojyAI is moving the bot there now.`, `/studio/p/${row.uuid}`);
        await this.rehost(row.uuid, {});
      } catch (err) {
        log.warn({ err, uuid: row.uuid }, "Couldn't make a free server on the bot host");
      }
    }
  }

  /** Project deleted: stop it (here or on its bot host) and remove its Python environment. */
  private async purge(uuid: string, payload?: Record<string, unknown>): Promise<void> {
    this.presence.stopped(uuid);
    this.outOfRoom.delete(uuid);
    this.clearRestart(uuid);
    this.crashStreak.delete(uuid);
    this.startFailures.delete(uuid);
    const host = hostRef(payload?.["host"]);
    const orgId = payload?.["orgId"];
    if (host && typeof orgId === "number") {
      await this.hosts.purge(uuid, orgId, host).catch((err: unknown) => log.warn({ err, uuid }, "Couldn't clean up the bot on its bot host"));
    }
    await this.kill(uuid);
    const venv = path.join(VENVS_DIR, uuid);
    try {
      rmSync(venv, { recursive: true, force: true });
    } catch (err) {
      // Files the bot's own user made unwritable: remove them as that user.
      const marker = path.join(venv, ".kojy-sandbox-uid");
      const uid = existsSync(marker) ? Number(readFileSync(marker, "utf8").trim()) : NaN;
      if (!Number.isInteger(uid)) { log.warn({ err, uuid }, "Could not remove the Python environment"); return; }
      await new Promise<void>((resolve) => {
        const { child } = spawnAs(uid, "rm", ["-rf", "--", venv], { stdio: "ignore", env: baseEnv() });
        child.once("exit", () => resolve());
        child.once("error", () => resolve());
      });
      rmSync(venv, { recursive: true, force: true });
    }
  }

  private kill(uuid: string): Promise<void> {
    const run = this.procs.get(uuid);
    if (!run) return Promise.resolve();
    run.stopping = true;
    return new Promise((resolve) => {
      const force = setTimeout(() => run.signal("SIGKILL"), STOP_GRACE_MS);
      run.child.once("exit", () => { clearTimeout(force); resolve(); });
      run.signal("SIGTERM");
    });
  }

  private async stdin(uuid: string, text: string): Promise<void> {
    const run = this.procs.get(uuid);
    if (run?.child.stdin?.writable) {
      run.child.stdin.write(text.endsWith("\n") ? text : `${text}\n`);
      this.console(uuid, "stdin", text);
      return;
    }
    const remote = this.hosts.has(uuid) ? await this.remoteRow(uuid) : null;
    if (remote) await this.hosts.command(remote, text);
  }

  private async onExit(uuid: string, run: Running, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.procs.get(uuid) === run) this.procs.delete(uuid);
    await this.db.update(botProjects).set({ lastExitCode: code }).where(eq(botProjects.uuid, uuid));
    if (run.stopping) { this.record(run.project, "stop"); return; }
    const delay = await this.crashed(uuid, run.project, Date.now() - run.startedAt, signal ?? `code ${code}`);
    if (delay !== null) this.startLater(uuid, delay);
  }

  /** A bot on its bot host stopped by itself. */
  private async hostCrashed(uuid: string, project: RunProject, ranFor: number, how: string, exitCode: number | null): Promise<void> {
    if (exitCode !== null) await this.db.update(botProjects).set({ lastExitCode: exitCode }).where(eq(botProjects.uuid, uuid)).catch(() => undefined);
    const delay = await this.crashed(uuid, project, ranFor, how);
    if (delay !== null) this.startLater(uuid, delay);
  }

  /**
   * A bot stopped by itself (here or on its bot host): it is counted, Kojy is
   * told (onCrash), and so is the owner after 3 in a row. Returns when to
   * start it again in seconds, or null when the owner no longer wants it on.
   */
  private async crashed(uuid: string, project: RunProject, ranFor: number, how: string): Promise<number | null> {
    this.record(project, "crash");
    this.notGood(uuid);
    // Every exit is recorded, whatever happens next (a pause, the owner having stopped it).
    const report = this.reports.get(uuid) ?? null;
    this.reports.delete(uuid);
    const incident = await this.incidents.record(project.id, classifyExit({ tail: this.tail(uuid), how, ranForMs: ranFor, report }), how, report);
    // What Kojy is shown: the console's own traceback when it's there (it has every step), else the report's.
    const lines = this.tail(uuid);
    const tail = report?.line && lastException(lines) !== report.line ? reportToTail(report) : lines;
    const streak = ranFor >= HEALTHY_RUN_MS ? 1 : (this.crashStreak.get(uuid) ?? 0) + 1;
    if (streak === 1) this.alerted.delete(uuid);
    this.crashStreak.set(uuid, streak);
    // Not being in its room is counted by runs, however long each lasted: a bot
    // restarted every few minutes because it can't get in has "healthy" long
    // runs, so the crash streak above never sees it.
    const everInRoom = this.presence.everInRoom(uuid) || report?.connected === true || lines.some((l) => l.startsWith(CONNECTED_PREFIX));
    this.presence.exited(uuid);
    const roomTrouble = !!incident && ROOM_TROUBLE.includes(incident.category as IncidentCategory);
    const outOfRoom = roomTrouble ? (this.outOfRoom.get(uuid) ?? 0) + 1 : 0;
    if (roomTrouble) this.outOfRoom.set(uuid, outOfRoom);
    else if (everInRoom) this.outOfRoom.delete(uuid);
    const refused = incident?.category === "highrise_refused";
    let delay = RESTART_DELAYS_S[Math.min(streak - 1, RESTART_DELAYS_S.length - 1)]!;
    if (refused && outOfRoom >= OUT_OF_ROOM_ALERT_AFTER) delay = REFUSED_RETRY_S[Math.min(outOfRoom - OUT_OF_ROOM_ALERT_AFTER, REFUSED_RETRY_S.length - 1)]!;
    const held = this.holds.get(uuid);
    this.console(uuid, "system", `✖ Bot exited (${how}) after ${Math.round(ranFor / 1000)}s — ${held ? "not restarted until Kojy's fix is ready" : `restarting in ${delay}s`}`);

    const [p] = await this.db.select({ desiredState: botProjects.desiredState, restartCount: botProjects.restartCount })
      .from(botProjects).where(eq(botProjects.uuid, uuid)).limit(1);
    if (p?.desiredState !== "running") { await this.setStatus(uuid, "stopped", null); return null; }

    if (held) {
      await this.setStatus(uuid, "crashed", held);
      this.onCrash?.(uuid, streak, tail, incident);
      return null;
    }
    if (streak >= CRASH_LOOP_LIMIT && this.fixingNow?.(uuid)) {
      // Kojy is on it: wait for the fix instead of pausing the bot for good.
      this.hold(uuid, `Crashed ${streak} times in a row — Kojy is fixing it, and the bot starts again with the fix`);
      this.onCrash?.(uuid, streak, tail, incident);
      return null;
    }
    if (streak >= CRASH_LOOP_LIMIT && !roomTrouble) {
      // (A bot that can't get into its room keeps being tried — less often — instead: it can't be fixed in its code.)
      await this.pauseCrashLoop(uuid, project, streak);
      await this.incidents.update(incident?.id, {}, `Paused after ${streak} crashes in a row`);
      return null;
    }
    await this.db.update(botProjects).set({ restartCount: p.restartCount + 1 }).where(eq(botProjects.uuid, uuid));
    await this.setStatus(uuid, "crashed", `Exited with ${how}${incident?.summary ? ` (${incident.summary})` : ""}; restarting in ${delay}s`.slice(0, 500));
    this.onCrash?.(uuid, streak, tail, incident);
    if (roomTrouble && outOfRoom >= OUT_OF_ROOM_ALERT_AFTER) {
      await this.outOfRoomAgain(uuid, project, incident, outOfRoom, delay);
      return delay;
    }
    if (streak >= 3 && !roomTrouble && this.alerted.get(uuid) !== streak && !this.alerted.has(uuid)) {
      this.alerted.set(uuid, streak);
      const last = this.tail(uuid).filter((l) => l.trim()).slice(-1)[0] ?? "";
      const body = `${project.name} has crashed ${streak} times in a row and keeps restarting. Last output: ${last.slice(0, 200)}`;
      void notifyUser(this.db, project.ownerId, "bot_error", `${project.name} keeps crashing`, body, `/studio/p/${uuid}`);
      void sendAlert(`⚠️ ${body}`);
    }
    return delay;
  }

  /**
   * A crash loop: stop restarting, keep the bot stopped until someone starts
   * it again (Start, or Kojy's bot_control), and tell the owner once.
   */
  private async pauseCrashLoop(uuid: string, project: RunProject, streak: number): Promise<void> {
    this.crashStreak.delete(uuid);
    this.console(uuid, "system", `⏸ ${streak} crashes in a row — not restarting any more. ${CRASH_LOOP_STATUS}`);
    await this.db.update(botProjects).set({ desiredState: "stopped", status: "error", statusMessage: CRASH_LOOP_STATUS }).where(eq(botProjects.uuid, uuid));
    const last = this.tail(uuid).filter((l) => l.trim()).slice(-1)[0] ?? "";
    const body = `${project.name} crashed ${streak} times in a row, so it was paused instead of restarting forever. Last output: ${last.slice(0, 200)}. Open its chat and ask Kojy to fix it, then press Start.`;
    void notifyUser(this.db, project.ownerId, "bot_error", `${project.name} was paused (crash loop)`, body, `/studio/p/${uuid}`);
    void sendAlert(`⏸ ${body}`);
  }

  /**
   * Don't restart the bot by itself until the hold ends (Kojy is fixing a
   * crash that would only happen again). `why` goes on the status line.
   */
  hold(uuid: string, why: string): void {
    const first = !this.holds.has(uuid);
    this.holds.set(uuid, why);
    this.clearRestart(uuid);
    if (first) this.console(uuid, "system", `⏸ Not restarting until Kojy's fix is ready: ${why}`);
    if (!this.isRunning(uuid)) void this.setStatus(uuid, "crashed", why.slice(0, 500)).catch(() => undefined);
  }

  isHeld(uuid: string): boolean {
    return this.holds.has(uuid);
  }

  /** Ends a hold: the bot starts again (with whatever code it has now) if the owner still wants it running. */
  async release(uuid: string, reason = "after Kojy's fix"): Promise<void> {
    if (!this.holds.delete(uuid)) return;
    if (this.isRunning(uuid)) return;
    const [p] = await this.db.select({ desiredState: botProjects.desiredState }).from(botProjects).where(eq(botProjects.uuid, uuid)).limit(1);
    if (p?.desiredState === "running") await this.start(uuid, reason);
  }

  /** Keeps this run's code as known good if it runs KNOWN_GOOD_AFTER_MS without a crash or an error. */
  private goodLater(uuid: string): void {
    this.notGood(uuid);
    const timer = setTimeout(() => {
      this.goodTimers.delete(uuid);
      if (!this.isRunning(uuid)) return;
      try {
        if (saveKnownGood(uuid)) log.info({ uuid }, "Kept the code as the last version that ran fine");
      } catch (err) {
        log.warn({ err, uuid }, "Could not keep the code that ran fine");
      }
    }, KNOWN_GOOD_AFTER_MS);
    timer.unref();
    this.goodTimers.set(uuid, timer);
  }

  private notGood(uuid: string): void {
    const t = this.goodTimers.get(uuid);
    if (t) { clearTimeout(t); this.goodTimers.delete(uuid); }
  }

  // ── in the room or not ─────────────────────────────────────────────────────

  /** The bot got into its room (again): its "not in the room" problems are closed. */
  private backInRoom(uuid: string, projectId: number): void {
    this.outOfRoom.delete(uuid);
    void this.incidents.resolveRoomTrouble(projectId);
  }

  /**
   * Most bots out of their rooms at once: Highrise or the network is down —
   * not each bot's fault, so their owners aren't each told to check secrets.
   */
  private outage(): { out: number; checked: number } | null {
    const { checked, out } = this.presence.counts();
    const failing = new Set([...out, ...[...this.outOfRoom.keys()]]);
    const total = Math.max(checked, failing.size);
    return failing.size >= OUTAGE_MIN_BOTS && failing.size / total >= OUTAGE_SHARE ? { out: failing.size, checked: total } : null;
  }

  /** Tells the owner about an incident once, until it's resolved (kept on the incident, so a restart doesn't repeat it). */
  private async alertOwner(project: RunProject, uuid: string, incident: Incident | null, title: string, body: string): Promise<void> {
    if (incident?.data?.alertedAt) return;
    await this.incidents.update(incident?.id, { alerted: true });
    void notifyUser(this.db, project.ownerId, "bot_error", title, body.slice(0, 900), `/studio/p/${uuid}`);
    void sendAlert(`⚠️ ${title}: ${body.slice(0, 300)}`);
  }

  /**
   * Runs keep ending with the bot out of its room. Unless Highrise is down
   * for everyone, the owner is told — once — what to check, and the incident
   * says so ("needs you"). A refusal is tried less and less often.
   */
  private async outOfRoomAgain(uuid: string, project: RunProject, incident: Incident | null, runs: number, delay: number): Promise<void> {
    const outage = this.outage();
    if (outage) {
      await this.incidents.update(incident?.id, { state: "open", note: `Most bots are out of their rooms right now (${outage.out} of ${outage.checked}): Highrise or the network seems to be down, not this bot. It keeps being started again until they're back.` });
      if (Date.now() - this.outageAlertedAt > 30 * 60_000) {
        this.outageAlertedAt = Date.now();
        void sendAlert(`🌐 ${outage.out} of ${outage.checked} bots can't get into their rooms — Highrise or the network looks down.`);
      }
      return;
    }
    const why = incident?.note?.replace(/,? so it was started again\.?$/, "").replace(/^It /, "") ?? "it isn't getting into its room";
    const advice = roomAdvice(incident);
    const note = `${runs} runs in a row ended without the bot in its room (${why.replace(/\.$/, "")}). ${advice}${delay >= 120 ? ` KojyAI tries again every ${Math.round(delay / 60)} min.` : ""}`;
    await this.incidents.update(incident?.id, { state: "needs_owner", note }, `${runs} runs in a row out of the room`);
    this.console(uuid, "system", `⚠ ${note}`);
    await this.alertOwner(project, uuid, incident, `${project.name} isn't getting into its room`, note);
  }

  /** No room check from the bot for too long: KojyAI can't see it working, so it's restarted (and the owner told if it keeps happening). */
  private async silent(uuid: string, why: string, times: number): Promise<void> {
    const [row] = await this.db.select().from(botProjects).where(eq(botProjects.uuid, uuid)).limit(1);
    if (!row || row.desiredState !== "running" || this.holds.has(uuid)) return;
    this.console(uuid, "system", `■ ${why} — restarting it`);
    const incident = await this.incidents.record(row.id, {
      signature: "silent", category: "silent", phase: "in_room", fatal: true, summary: "No sign of life from the bot's room checks", example: why,
      state: times >= 2 ? "needs_owner" : "open",
      note: times >= 2 ? `${why}, ${times} times in a row; restarting didn't help. If it runs on a bot host, check the server there.` : `${why}; it was restarted.`,
    }, "no room checks");
    if (times >= 2) {
      await this.alertOwner({ id: row.id, orgId: row.orgId, ownerId: row.ownerId, name: row.name }, uuid, incident,
        `${row.name} keeps going quiet`, `KojyAI got no room checks from ${row.name} for over ${Math.round(SILENT_MS / 60_000)} minutes, ${times} times in a row, and restarted it each time. If it runs on a bot host, check the server there.`);
    }
    await this.handle(uuid, "restart");
  }

  /**
   * What the website shows against what really runs: a bot shown as running
   * (or starting) that KojyAI isn't running, or one left "crashed" with no
   * restart coming, is started again — the page never stays wrong.
   */
  async reconcile(): Promise<void> {
    const rows = await this.db.select({ uuid: botProjects.uuid, status: botProjects.status, desiredState: botProjects.desiredState, updatedAt: botProjects.updatedAt }).from(botProjects);
    const now = Date.now();
    for (const row of rows) {
      const uuid = row.uuid;
      if (this.isRunning(uuid) || this.busy.has(uuid) || this.hosts.isBusy(uuid) || this.restartTimers.has(uuid) || this.holds.has(uuid)) continue;
      const shownRunning = row.status === "running" || row.status === "starting";
      const stuck = row.status === "crashed" && now - row.updatedAt.getTime() > STUCK_AFTER_MS;
      if (!shownRunning && !stuck) continue;
      if (row.desiredState !== "running") { await this.setStatus(uuid, "stopped", null); continue; }
      this.console(uuid, "system", shownRunning ? "KojyAI wasn't running this bot although its page said it was — starting it" : "The bot was left crashed with no restart coming — starting it");
      log.warn({ uuid, status: row.status }, "Status didn't match what runs — starting the bot");
      void this.start(uuid, "KojyAI found it wasn't running");
    }
  }

  /** A room check from the launcher. */
  private onPresence(uuid: string, ev: PresenceEvent): void {
    void this.presence.report(uuid, ev).catch((err: unknown) => log.warn({ err, uuid }, "Could not keep the room check"));
  }

  /** A report from the launcher: a crash (kept for when the exit comes), an error the bot survived, or a room check. */
  private onReport(uuid: string, project: RunProject, raw: unknown): void {
    const presence = parsePresence(raw);
    if (presence) { this.onPresence(uuid, presence); return; }
    const report = parseReport(raw);
    if (!report) return;
    if (report.fatal) { this.reports.set(uuid, report); return; }
    void this.botError(uuid, project, report).catch((err: unknown) => log.warn({ err, uuid }, "Could not handle an error the bot survived"));
  }

  /** The bot survived an error (in one of its handlers): recorded, and Kojy fixes it — the bot keeps running. */
  private async botError(uuid: string, project: RunProject, report: CrashReport): Promise<void> {
    this.notGood(uuid);
    const incident = await this.incidents.record(project.id, classifyExit({ tail: this.tail(uuid), how: "kept running", ranForMs: 0, report }), "kept running", report, report.times ?? 1);
    // Shown on the bot's page until it next (re)starts.
    const where = `${report.event?.handler ?? "a handler"}${report.event?.command ? ` (the ${report.event.command} command)` : ""}`;
    void this.db.update(botProjects).set({ statusMessage: `Running, but it hit an error in ${where}; it kept running` })
      .where(and(eq(botProjects.uuid, uuid), eq(botProjects.status, "running"))).catch(() => undefined);
    this.onBotError?.(uuid, reportToTail(report), incident, report);
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
  async ensureVenv(uuid: string, dir: string, projectId: number): Promise<string> {
    const venv = path.join(VENVS_DIR, uuid);
    const python = path.join(venv, "bin", "python");
    // The project's own user creates the venv and runs pip (setup.py scripts
    // run there), so it needs its folder; requirements.txt lives in `dir`.
    const uid = sandboxUid(projectId);
    mkdirSync(venv, { recursive: true });
    grantDirOnce(venv, uid);
    grantDir(dir, uid);
    if (!existsSync(python)) {
      this.console(uuid, "system", "Creating Python environment…");
      await this.exec(uuid, uid, PYTHON_BIN, ["-m", "venv", venv], dir);
    }
    const reqFile = path.join(dir, "requirements.txt");
    const reqText = existsSync(reqFile) ? readFileSync(reqFile, "utf8") : "";
    const hash = createHash("sha256").update(BASE_REQUIREMENTS.join("\n") + "\n" + reqText).digest("hex");
    const marker = path.join(venv, ".kojy-requirements");
    if (existsSync(marker) && readFileSync(marker, "utf8") === hash) return python;

    this.console(uuid, "system", "Installing packages (first run or requirements.txt changed)…");
    const args = ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", ...BASE_REQUIREMENTS];
    if (reqText.trim()) args.push("-r", reqFile);
    await this.exec(uuid, uid, python, args, dir);
    writeFileSync(marker, hash);
    return python;
  }

  private exec(uuid: string, uid: number, cmd: string, args: string[], cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Per-project pip cache: a shared one would let one project's install
      // plant files another project's install picks up.
      const venv = path.join(VENVS_DIR, uuid);
      const { child } = spawnAs(uid, cmd, args, { cwd, env: { ...baseEnv(), HOME: cwd, PIP_CACHE_DIR: path.join(venv, ".pip-cache") }, stdio: ["ignore", "pipe", "pipe"] });
      this.pipe(uuid, child);
      child.once("error", reject);
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} ${args.slice(0, 3).join(" ")} failed (exit ${code})`))));
    });
  }

  /**
   * The launcher checked the bot's rights in its room. Without moderator
   * rights Highrise refuses teleports, kicks, mutes and bans: say so on the
   * bot's page and tell the owner (once), since no code change can fix it.
   */
  private onRoomRights(uuid: string, project: RunProject, line: string): void {
    const missing = line.includes(NOT_MODERATOR_MARK);
    void this.db.update(botProjects).set({ statusMessage: missing ? NO_MODERATOR_STATUS : null })
      .where(and(eq(botProjects.uuid, uuid), eq(botProjects.status, "running")))
      .catch((err: unknown) => log.warn({ err, uuid }, "Could not save the room-rights note"));
    if (!missing) { this.rightsWarned.delete(uuid); return; }
    if (this.rightsWarned.has(uuid)) return;
    this.rightsWarned.add(uuid);
    void notifyUser(this.db, project.ownerId, "bot_error", `${project.name} isn't a moderator in its room`,
      "Commands that move, kick, mute or ban people (like !tp and !bring) can't work until you make the bot a moderator in the Highrise room's settings.",
      `/studio/p/${uuid}`);
  }

  // ── console + status ───────────────────────────────────────────────────────

  private pipe(uuid: string, child: ChildProcess): void {
    for (const [stream, src] of [["stdout", child.stdout], ["stderr", child.stderr]] as const) {
      let partial = "";
      src?.setEncoding("utf8");
      src?.on("data", (chunk: string) => {
        const lines = (partial + chunk).split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) {
          this.console(uuid, stream, line);
          const run = stream === "stdout" && line.startsWith(ROOM_RIGHTS_PREFIX) ? this.procs.get(uuid) : undefined;
          if (run) this.onRoomRights(uuid, run.project, line);
        }
      });
      src?.on("end", () => { if (partial) this.console(uuid, stream, partial); });
    }
  }

  /** Appends one line to the project's console log (rotated at 2 MB). */
  console(uuid: string, stream: "stdout" | "stderr" | "stdin" | "system", line: string): void {
    if (stream === "stdout" || stream === "stderr") {
      this.presence.output(uuid);
      const t = this.tails.get(uuid);
      if (t) { t.push(line.slice(0, 500)); if (t.length > 80) t.shift(); }
      // Here and on a bot host alike (its lines come through here too).
      if (!this.discordSeen.has(uuid) && DISCORD_CONNECTED.test(line)) {
        this.discordSeen.add(uuid);
        this.onDiscordConnected?.(uuid);
      }
    } else if (stream === "system" && line.startsWith("▶ Starting")) {
      this.discordSeen.delete(uuid);
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

/** What the owner can check when the bot keeps ending up out of its room. */
export function roomAdvice(incident: Pick<Incident, "category" | "signature"> | null): string {
  if (incident?.category === "highrise_refused") return "Check HIGHRISE_BOT_TOKEN and HIGHRISE_ROOM_ID in its Secrets, and that the bot is still added to that room.";
  if (incident?.signature === "watchdog:missing-from-list") return "Highrise doesn't list the bot among the room's users: it may have been removed or banned from the room, or HIGHRISE_ROOM_ID points to another room.";
  if (incident?.category === "network") return "Highrise keeps ending its session; if other bots are fine, check that the bot's token isn't also used somewhere else (a second copy of the bot running).";
  return "If other bots are fine, check HIGHRISE_BOT_TOKEN and HIGHRISE_ROOM_ID in its Secrets, that the bot is still added to the room, and that no second copy of it runs elsewhere.";
}
