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
import { askHighrise, highriseMessage, ownersRefusal, refusalAdvice, refusalKind, type HighriseAnswer } from "./roomDoctor.js";
import { PresenceTracker, SILENT_MS, parsePresence, type PresenceEvent } from "./presence.js";
import { lastException } from "./agent/autoFix.js";
import { isStartCommand, restoreKnownGood, saveKnownGood, startCommand } from "@kojyai/shared/projects";

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
/**
 * Past CRASH_LOOP_LIMIT crashes in a row a bot is never stopped for good: it
 * goes back to the code that last ran fine when the code changed since, and
 * otherwise is started less and less often while Kojy works on the cause.
 */
const SLOW_RETRY_S = [300, 900, 1800];
/** A problem only the owner can sort out is tried this often meanwhile — and right away when its secrets change. */
const OWNER_RETRY_S = 1800;
/** Highrise is asked about a bot (roomDoctor.askHighrise) at most this often. */
const ASK_EVERY_MS = 10 * 60_000;
/** Runs out of the room with the token and room fine, after which the code that last ran fine is put back (Kojy tries first). */
const ROLLBACK_AFTER_RUNS = 4;
/** A bot left in "error" (a failed start with no retry coming) is tried again after this long. */
const ERROR_RETRY_MS = 30 * 60_000;
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
  /**
   * Set by the coder AI: the bot keeps ending up out of its room although
   * Highrise lets KojyAI in with its token and room ID — its code is the
   * likely cause. `evidence` says what KojyAI found; `tail` is its console.
   */
  onRoomProblem?: (uuid: string, incident: Incident, evidence: string, tail: string[]) => void;
  /** Set by the coder AI: KojyAI put back the code that last ran fine (so the bot's chat says so). */
  onCodeRestored?: (uuid: string, note: string) => void;
  /** How KojyAI asks Highrise about a bot's token and room (a stand-in in tests). */
  askHighrise: (roomId: string, token: string) => Promise<HighriseAnswer> = (roomId, token) => askHighrise(roomId, token);
  /** What Highrise last said about each bot's token and room, and when. */
  private asked = new Map<string, { at: number; answer: HighriseAnswer }>();
  /** Bots whose next start is a fresh one: packages installed again (and on a bot host every file sent again). */
  private freshStart = new Set<string>();
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
        this.goodLater(uuid, project.id);
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
      ownerProblem: (uuid, project, summary, note) => void this.ownerProblem(uuid, project, summary, note).catch((err: unknown) => log.warn({ err, uuid }, "Could not keep the problem")),
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
      case "secrets_changed": return this.secretsChanged(uuid);
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
        return await this.hosts.start(project, reason, this.freshStart.delete(uuid));
      }
      const dir = path.join(PROJECTS_DIR, uuid);
      if (!existsSync(dir)) return this.setStatus(uuid, "error", "Project files are missing.");
      if (!project.entrypoint) return this.setStatus(uuid, "error", "Nothing to start yet: set the entrypoint (module.path:BotClass) or a start command (run: python main.py).");

      if (this.freshStart.delete(uuid)) {
        // Its packages are installed again from scratch (a broken or half-finished install can't stay behind).
        rmSync(path.join(VENVS_DIR, uuid), { recursive: true, force: true });
        this.console(uuid, "system", "Fresh start: installing its packages again from scratch");
      }
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
        this.goodLater(uuid, project.id);
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
   * A bot stopped by itself (here or on its bot host): it is counted and Kojy
   * is told (onCrash). It's never stopped for good: past CRASH_LOOP_LIMIT
   * crashes in a row it goes back to the code that last ran fine (when the
   * code changed since), else it's started less and less often while Kojy
   * keeps working on the cause. Returns when to start it again in seconds,
   * or null when the owner no longer wants it on (or Kojy's fix holds it).
   */
  private async crashed(uuid: string, project: RunProject, ranFor: number, how: string): Promise<number | null> {
    this.record(project, "crash");
    this.notGood(uuid);
    // Every exit is recorded, whatever happens next (a hold, the owner having stopped it).
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

    const [p] = await this.db.select({ desiredState: botProjects.desiredState, restartCount: botProjects.restartCount })
      .from(botProjects).where(eq(botProjects.uuid, uuid)).limit(1);
    if (p?.desiredState !== "running") {
      this.console(uuid, "system", `✖ Bot exited (${how}) after ${Math.round(ranFor / 1000)}s`);
      await this.setStatus(uuid, "stopped", null);
      return null;
    }

    const held = this.holds.get(uuid);
    if (held) {
      this.console(uuid, "system", `✖ Bot exited (${how}) after ${Math.round(ranFor / 1000)}s — not restarted until Kojy's fix is ready`);
      await this.setStatus(uuid, "crashed", held);
      this.onCrash?.(uuid, streak, tail, incident);
      return null;
    }
    if (streak >= CRASH_LOOP_LIMIT && this.fixingNow?.(uuid)) {
      // Kojy is on it: wait for the fix instead of restarting into the same crash.
      this.console(uuid, "system", `✖ Bot exited (${how}) after ${Math.round(ranFor / 1000)}s — not restarted until Kojy's fix is ready`);
      this.hold(uuid, `Crashed ${streak} times in a row — Kojy is fixing it, and the bot starts again with the fix`);
      this.onCrash?.(uuid, streak, tail, incident);
      return null;
    }
    let loop = false;
    if (streak >= CRASH_LOOP_LIMIT && !roomTrouble) {
      // (A bot that can't get into its room is handled below: the room doctor finds out why.)
      if (await this.rollBack(uuid, project, incident, `it crashed ${streak} times in a row${incident?.summary ? ` (${incident.summary})` : ""}`)) {
        this.crashStreak.delete(uuid);
        this.console(uuid, "system", `✖ Bot exited (${how}) after ${Math.round(ranFor / 1000)}s — starting it with the code that last ran fine`);
        await this.setStatus(uuid, "crashed", "Starting again with the code that last ran fine");
        return 3;
      }
      loop = true;
      delay = SLOW_RETRY_S[Math.min(streak - CRASH_LOOP_LIMIT, SLOW_RETRY_S.length - 1)] ?? OWNER_RETRY_S;
    }
    if (roomTrouble && outOfRoom >= OUT_OF_ROOM_ALERT_AFTER) delay = await this.outOfRoomAgain(uuid, project, incident, outOfRoom, delay, lines);

    this.console(uuid, "system", `✖ Bot exited (${how}) after ${Math.round(ranFor / 1000)}s — restarting in ${delay >= 120 ? `${Math.round(delay / 60)} min` : `${delay}s`}`);
    await this.db.update(botProjects).set({ restartCount: p.restartCount + 1 }).where(eq(botProjects.uuid, uuid));
    const status = loop
      ? `Crashed ${streak} times in a row${incident?.summary ? ` (${incident.summary})` : ""} — KojyAI keeps trying (next in ${Math.round(delay / 60)} min) while Kojy works on the cause`
      : `Exited with ${how}${incident?.summary ? ` (${incident.summary})` : ""}; restarting in ${delay >= 120 ? `${Math.round(delay / 60)} min` : `${delay}s`}`;
    await this.setStatus(uuid, "crashed", status.slice(0, 500));
    this.onCrash?.(uuid, streak, tail, incident);
    // The admins hear about a bot that keeps crashing; its owner isn't bothered with what Kojy is handling.
    if (streak >= 3 && !roomTrouble && !this.alerted.has(uuid)) {
      this.alerted.set(uuid, streak);
      const last = this.tail(uuid).filter((l) => l.trim()).slice(-1)[0] ?? "";
      void sendAlert(`⚠️ ${project.name} has crashed ${streak} times in a row and keeps restarting (Kojy is on it). Last output: ${last.slice(0, 200)}`);
    }
    return delay;
  }

  /**
   * Puts back the code the bot last ran fine with, when its code changed
   * since and automatic fixes are on (the newer code stays in Undo). The
   * owner is told — it's their code — but nothing is asked of them. True
   * when it did.
   */
  private async rollBack(uuid: string, project: RunProject, incident: Incident | null, why: string): Promise<boolean> {
    try {
      const [row] = await this.db.select({ autoFix: botProjects.autoFix }).from(botProjects).where(eq(botProjects.uuid, uuid)).limit(1);
      if (!row?.autoFix) return false;
      const back = restoreKnownGood(uuid, `Before KojyAI put back the code that last ran fine (${why})`.slice(0, 200));
      if (!back) return false;
      const when = new Date(back.savedAt).toISOString().slice(0, 16).replace("T", " ");
      const note = `KojyAI put back the code that last ran fine (kept ${when} UTC) because ${why}. The newer code is saved in Undo, so nothing is lost — Kojy can bring those changes back once they work.`;
      log.warn({ uuid }, "Put back the code that last ran fine");
      this.console(uuid, "system", `↩ ${note}`);
      await this.incidents.update(incident?.id, { state: "fixed", note }, "Put back the code that last ran fine");
      this.onCodeRestored?.(uuid, note);
      void notifyUser(this.db, project.ownerId, "bot_error", `${project.name} is running its last working code again`, note, `/studio/p/${uuid}`);
      void sendAlert(`↩ ${project.name}: ${note}`);
      return true;
    } catch (err) {
      log.warn({ err, uuid }, "Could not put back the code that last ran fine");
      return false;
    }
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

  /** The bot's next start is a fresh one: its packages installed again from scratch (on a bot host, every file sent again too). */
  startFresh(uuid: string): void {
    this.freshStart.add(uuid);
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

  /**
   * A run that goes KNOWN_GOOD_AFTER_MS without a crash or an error (and in
   * its room, when that's checked): its code is kept as known good, and the
   * problems a good run settles are closed (a secret the owner added, a host
   * that's back) — "needs you" never stays up once it's sorted out.
   */
  private goodLater(uuid: string, projectId: number): void {
    this.notGood(uuid);
    const since = new Date();
    const timer = setTimeout(() => {
      this.goodTimers.delete(uuid);
      if (!this.isRunning(uuid)) return;
      if (this.presence.get(uuid)?.inRoom === false) return; // running, but not where it should be: not "fine"
      try {
        if (saveKnownGood(uuid)) log.info({ uuid }, "Kept the code as the last version that ran fine");
      } catch (err) {
        log.warn({ err, uuid }, "Could not keep the code that ran fine");
      }
      void this.incidents.resolveAfterGoodRun(projectId, since);
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

  /** Something only the owner can sort out (their bot host suspended the server): kept as a problem, and the owner told once. */
  private async ownerProblem(uuid: string, project: RunProject, summary: string, note: string): Promise<void> {
    const incident = await this.incidents.record(project.id, {
      signature: `host:${summary.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`, category: "host_problem", phase: "startup", fatal: true,
      summary, example: summary, state: "needs_owner", note,
    }, "host");
    await this.alertOwner(project, uuid, incident, `${project.name}: ${summary.toLowerCase()}`, note);
  }

  /** Tells the owner about an incident once, until it's resolved (kept on the incident, so a restart doesn't repeat it). */
  private async alertOwner(project: RunProject, uuid: string, incident: Incident | null, title: string, body: string): Promise<void> {
    if (incident?.data?.alertedAt) return;
    await this.incidents.update(incident?.id, { alerted: true });
    void notifyUser(this.db, project.ownerId, "bot_error", title, body.slice(0, 900), `/studio/p/${uuid}`);
    void sendAlert(`⚠️ ${title}: ${body.slice(0, 300)}`);
  }

  /**
   * Runs keep ending with the bot out of its room. KojyAI finds out why
   * (diagnose) and acts on it: waits out Highrise, starts it fresh on its bot
   * host, has Kojy fix its code, puts back the code that last ran fine. The
   * owner is asked only when Highrise says it's their token, their room or
   * the bot's access to it (or only they can choose where it runs). Returns
   * when to start it again, in seconds.
   */
  private async outOfRoomAgain(uuid: string, project: RunProject, incident: Incident | null, runs: number, delay: number, lines: string[]): Promise<number> {
    const outage = this.outage();
    if (outage) {
      await this.incidents.update(incident?.id, { state: "open", note: `Most bots are out of their rooms right now (${outage.out} of ${outage.checked}): Highrise or the network seems to be down, not this bot. It keeps being started again until they're back.` });
      if (Date.now() - this.outageAlertedAt > 30 * 60_000) {
        this.outageAlertedAt = Date.now();
        void sendAlert(`🌐 ${outage.out} of ${outage.checked} bots can't get into their rooms — Highrise or the network looks down.`);
      }
      return delay;
    }
    const why = (incident?.summary ?? "it isn't getting into its room").replace(/\.$/, "");
    const owner = async (note: string) => {
      await this.incidents.update(incident?.id, { state: "needs_owner", note }, `${runs} runs in a row out of the room — only the owner can fix it`);
      this.console(uuid, "system", `⚠ ${note}`);
      await this.alertOwner(project, uuid, incident, `${project.name} can't get into its room`, note);
      return Math.max(delay, OWNER_RETRY_S);
    };
    const open = async (note: string, timeline?: string) => {
      await this.incidents.update(incident?.id, { state: "open", note }, timeline);
      this.console(uuid, "system", `… ${note}`);
    };
    const d = await this.diagnose(uuid, incident);
    if (d.kind === "owner") return owner(d.note);
    if (d.kind === "wait") { await open(d.note); return delay; }

    // Highrise let KojyAI in with the bot's token and room ID: the problem is where or how the bot runs.
    const [row] = await this.db.select({ hostId: botProjects.hostId, hostServer: botProjects.hostServer }).from(botProjects).where(eq(botProjects.uuid, uuid)).limit(1);
    const onHost = !!(row?.hostId && row.hostServer);
    const room = d.roomName ? ` (room “${d.roomName}”)` : "";
    if (onHost && incident?.category !== "not_in_room") {
      // It never got in from its bot host.
      if (runs <= OUT_OF_ROOM_ALERT_AFTER + 1) {
        this.freshStart.add(uuid);
        await open(`KojyAI got into the room${room} with the bot's token from its own server just now, so the token and room are fine — the bot host is where it fails. Starting it there again with a fresh copy of everything (its files and packages).`, "Fresh start on its bot host");
        return delay;
      }
      return owner(`The bot can't reach Highrise from its bot host, though KojyAI gets into the room${room} with the same token from its own server, even after fresh starts there. Only you can choose where it runs: move it to KojyAI's server (its Settings → Where it runs) or ask the host to let it reach highrise.game. KojyAI keeps trying meanwhile.`);
    }
    // Its code keeps it out (or drops it): Kojy looks at the code first; then the code that last ran fine goes back.
    const tried = (incident?.attempts ?? 0) > 0;
    if (runs >= ROLLBACK_AFTER_RUNS && (tried || !this.onRoomProblem)
      && await this.rollBack(uuid, project, incident, `it kept ending up out of its room (${runs} runs in a row: ${why}) while its token and room were fine`)) {
      this.outOfRoom.delete(uuid);
      return 3;
    }
    const evidence = `KojyAI connected with the bot's token and room ID from ${onHost ? "its own server" : "the server the bot runs on"} just now and Highrise let it in${room} — so the token, the room ID and Highrise are fine. ${runs} runs in a row ended without the bot in its room (${why}).`;
    await open(`${evidence} The bot's code is the likely cause: Kojy is looking into it, and if that doesn't help KojyAI puts back the code that last ran fine.`);
    if (incident) this.onRoomProblem?.(uuid, incident, evidence, lines);
    return delay;
  }

  /**
   * Why the bot isn't getting into its room: Highrise's own words from its
   * run when they settle it, else KojyAI asks Highrise itself with the bot's
   * token and room ID (roomDoctor.askHighrise, at most every ASK_EVERY_MS).
   */
  private async diagnose(uuid: string, incident: Incident | null): Promise<{ kind: "owner"; note: string } | { kind: "wait"; note: string } | { kind: "fine"; roomName: string | null }> {
    if (incident?.category === "highrise_refused") {
      const said = highriseMessage(incident.example) || incident.summary.replace(/^Highrise refused the bot:?\s*/, "");
      const kind = refusalKind(said);
      if (ownersRefusal(kind)) return { kind: "owner", note: refusalAdvice(kind, said) };
      if (kind === "busy") return { kind: "wait", note: `Highrise asked the bot to wait (“${said}”) — it's started again a little later.` };
    }
    // Not while the bot itself is up: connecting with its token would take its place.
    if (this.isRunning(uuid)) return { kind: "wait", note: "The bot is running again; KojyAI checks with Highrise if it drops out of its room again." };
    const [row] = await this.db.select().from(botProjects).where(eq(botProjects.uuid, uuid)).limit(1);
    if (!row) return { kind: "wait", note: "The bot is gone." };
    const secrets = await this.secrets(row).catch((): Record<string, string> => ({}));
    const roomId = secrets.HIGHRISE_ROOM_ID?.trim();
    const token = secrets.HIGHRISE_BOT_TOKEN?.trim();
    if (!roomId || !token) return { kind: "owner", note: "Add HIGHRISE_ROOM_ID and HIGHRISE_BOT_TOKEN in the bot's Secrets — only you have these values. KojyAI starts it by itself once they're saved." };
    const cached = this.asked.get(uuid);
    let answer: HighriseAnswer;
    if (cached && Date.now() - cached.at < ASK_EVERY_MS) answer = cached.answer;
    else {
      answer = await this.askHighrise(roomId, token);
      this.asked.set(uuid, { at: Date.now(), answer });
      log.info({ uuid, answer: answer.kind }, "Asked Highrise about a bot that isn't getting into its room");
    }
    if (answer.kind === "ok") return { kind: "fine", roomName: answer.roomName };
    if (answer.kind === "unreachable") {
      return { kind: "wait", note: `KojyAI couldn't get through to Highrise either (${answer.why}) — Highrise or the network is away, not the bot. It keeps being started again until Highrise answers.` };
    }
    // Refused on a clean connection too: that's Highrise's answer to this token and room.
    return { kind: "owner", note: `${refusalAdvice(answer.refusal, answer.message)} (KojyAI asked Highrise itself with the bot's token and room ID to make sure.)` };
  }

  /**
   * No room check from the bot for too long: KojyAI can't see it working, so
   * it's restarted — from the second time with a fresh install of everything
   * (packages, and on a bot host every file) — and KojyAI keeps at it. The
   * admins hear when it keeps happening; the owner isn't asked: it's
   * KojyAI's to sort out.
   */
  private async silent(uuid: string, why: string, times: number): Promise<void> {
    const [row] = await this.db.select().from(botProjects).where(eq(botProjects.uuid, uuid)).limit(1);
    if (!row || row.desiredState !== "running" || this.holds.has(uuid)) return;
    const fresh = times >= 2;
    this.console(uuid, "system", `■ ${why} — restarting it${fresh ? " with a fresh install" : ""}`);
    const incident = await this.incidents.record(row.id, {
      signature: "silent", category: "silent", phase: "in_room", fatal: true, summary: "No sign of life from the bot's room checks", example: why, state: "open",
      note: times === 1 ? `${why}; it was restarted.` : `${why}, ${times} times in a row; restarted with a fresh install of everything${times > 2 ? " each time — KojyAI keeps at it" : ""}.`,
    }, "no room checks");
    if (incident && incident.state === "needs_owner") await this.incidents.update(incident.id, { state: "open" });
    if (times >= 3 && !incident?.data?.alertedAt) {
      await this.incidents.update(incident?.id, { alerted: true });
      void sendAlert(`🔇 ${row.name} keeps going quiet: no room checks for ${Math.round(SILENT_MS / 60_000)}+ min, ${times} times in a row, even after fresh installs. KojyAI keeps restarting it.`);
    }
    if (fresh) this.freshStart.add(uuid);
    await this.handle(uuid, "restart");
  }

  /**
   * What the website shows against what really runs: a bot shown as running
   * (or starting) that KojyAI isn't running, one left "crashed" with no
   * restart coming, or one left with an error and no new try coming, is
   * started again — the page never stays wrong, and no bot stays down
   * because of a one-off.
   */
  async reconcile(): Promise<void> {
    const rows = await this.db.select({ uuid: botProjects.uuid, status: botProjects.status, desiredState: botProjects.desiredState, updatedAt: botProjects.updatedAt }).from(botProjects);
    const now = Date.now();
    for (const row of rows) {
      const uuid = row.uuid;
      if (this.isRunning(uuid) || this.busy.has(uuid) || this.hosts.isBusy(uuid) || this.restartTimers.has(uuid) || this.holds.has(uuid)) continue;
      const shownRunning = row.status === "running" || row.status === "starting";
      const stuck = row.status === "crashed" && now - row.updatedAt.getTime() > STUCK_AFTER_MS;
      const errored = row.status === "error" && row.desiredState === "running" && now - row.updatedAt.getTime() > ERROR_RETRY_MS;
      if (!shownRunning && !stuck && !errored) continue;
      if (row.desiredState !== "running") { await this.setStatus(uuid, "stopped", null); continue; }
      this.console(uuid, "system", shownRunning ? "KojyAI wasn't running this bot although its page said it was — starting it"
        : stuck ? "The bot was left crashed with no restart coming — starting it" : "The bot was left with an error and no new try coming — trying to start it again");
      log.warn({ uuid, status: row.status }, "Status didn't match what runs — starting the bot");
      void this.start(uuid, "KojyAI found it wasn't running");
    }
  }

  /** Its secrets changed: a bot that needs them (down, waiting to retry, out of its room, or with a problem only the owner could fix) starts again with them now. */
  private async secretsChanged(uuid: string): Promise<void> {
    const [row] = await this.db.select().from(botProjects).where(eq(botProjects.uuid, uuid)).limit(1);
    if (!row || row.desiredState !== "running") return;
    this.asked.delete(uuid);
    const ownerProblem = (await this.incidents.list(row.id, 20)).some((i) => i.state === "needs_owner");
    const running = this.isRunning(uuid);
    const needsIt = !running || this.restartTimers.has(uuid) || this.presence.get(uuid)?.inRoom === false || ownerProblem;
    if (!needsIt) return; // a healthy bot keeps running; the new values apply at its next start
    this.outOfRoom.delete(uuid);
    this.startFailures.delete(uuid);
    this.crashStreak.delete(uuid);
    this.console(uuid, "system", "Its secrets changed — starting the bot again with them");
    await this.handle(uuid, running ? "restart" : "start");
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

