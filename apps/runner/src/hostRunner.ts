/**
 * Bots that run on an outside bot host (a Pterodactyl-style panel such as
 * Silly Development, see @kojyai/shared/bothost) instead of as a process here.
 * OWNERSHIP: apps/runner
 *
 * The supervisor hands a project here when it has a host and a server. Its
 * live console is kept open and written into the same console log a local
 * bot has, so the website's console, get_logs and its connection report,
 * crash auto-fix and the watchdog's restarts all work the same way:
 *   start   upload what changed (the code, KojyAI's launcher with its freeze
 *           and room checks, the settings and secrets, the package list),
 *           point the server at kojy_start.py and power it on
 *   stop    power off (killed if it hasn't stopped after 25s)
 *   crash   the server went offline without KojyAI asking: the supervisor
 *           counts it, tells Kojy and starts it again with the usual backoff
 * A KojyAI restart leaves the bot running: on boot the console is reopened
 * and the output from the gap is filled in from the host's recent history.
 * The bot's data/ and database files go up once; after that they live on the
 * host and are copied back when the bot moves off it.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { Database } from "@kojyai/db";
import { botHosts, botProjects, type HostSync } from "@kojyai/db/schema";
import { decryptApiKey } from "@kojyai/shared/crypto";
import {
  BotHostClient, HostApiError, HostConsole, botHostProvider, pythonFileVariable, unseenLines,
  type BotHostProvider, type ConsoleOptions, type HostStats, type PowerState,
} from "@kojyai/shared/bothost";
import { isPersistentData, listFiles, projectDir, readLogs, resolveInside } from "@kojyai/shared/projects";
import { createLogger } from "./logger.js";
import { ROOM_RIGHTS_PREFIX } from "./agent/botHealth.js";

const log = createLogger("bot-host");

type ProjectRow = typeof botProjects.$inferSelect;
type Status = ProjectRow["status"];
export interface RunProject { id: number; orgId: number; ownerId: number; name: string }
export interface HostRef { hostId: number; server: string }

/** What the host runs, and KojyAI's own files next to the bot's code. */
export const START_FILE = "kojy_start.py";
/**
 * The Python version bots run on here (the runner image's). Newer ones break
 * the Highrise SDK: on 3.13 its pendulum 2.x dependency doesn't build
 * (2026-11-05, Japalo's first start on Silly Development).
 */
export const HOST_PYTHON = "3.11";
/** Points the panel's own requirements install at nothing: kojy_start.py installs the packages. */
const NO_REQUIREMENTS = "kojy-no-requirements.txt";
const LAUNCHER_FILE = "kojy_launcher.py";
const REQUIREMENTS_FILE = ".kojy/requirements.txt";
const ENV_FILE = ".kojy/env.json";
const KOJY_FILES = new Set([START_FILE, LAUNCHER_FILE, REQUIREMENTS_FILE, ENV_FILE]);
/** Marks room activity in a host's console (see launcher.py). */
export const ACTIVITY_PREFIX = "[kojy:activity] ";
const ACTIVITY_KINDS = new Set(["chat", "whisper", "reply", "join", "leave", "tip", "emote"]);

const MAX_SYNC_FILE_BYTES = 20 * 1024 * 1024;
const STOP_WAIT_MS = 25_000;
const HISTORY_WINDOW_MS = 2_000;
const RECENT_LINES = 60;

/** A line from the host itself rather than the bot, e.g. "[Pterodactyl Daemon]: Exit code: 3". */
const HOST_LINE = /^(?:\[[^\]]*(?:daemon|pterodactyl|wings|silly)[^\]]*\]:?|container@\S+~)\s*/i;

export interface HostHooks {
  console(uuid: string, stream: "stdout" | "stderr" | "stdin" | "system", line: string): void;
  setStatus(uuid: string, status: Status, message: string | null): Promise<void>;
  /** The bot came up on its host. */
  started(uuid: string, project: RunProject): void;
  /** It stopped because KojyAI asked. */
  stopped(uuid: string, project: RunProject): void;
  /** It stopped by itself: the supervisor counts it and schedules the next start. */
  crashed(uuid: string, project: RunProject, ranForMs: number, how: string, exitCode: number | null): void;
  /** Starting failed before the bot ran (the host unreachable, an upload refused…). */
  startFailed(uuid: string, message: string): Promise<void>;
  /** Try starting again in a while (the server is still being set up). */
  later(uuid: string, seconds: number): void;
  activity(project: RunProject, kind: string, actorId: string | null, actorName: string | null): void;
  roomRights(uuid: string, project: RunProject, line: string): void;
}

export interface HostRunnerOptions {
  launcherPath: string;
  starterPath: string;
  baseRequirements: string[];
  /** The bot's secrets, decrypted. */
  secrets(row: ProjectRow): Promise<Record<string, string>>;
  /** Tests: stand-ins for the panel client and the live console. */
  makeClient?: (provider: BotHostProvider, apiKey: string) => BotHostClient;
  makeConsole?: (options: ConsoleOptions) => HostConsole;
}

interface Session {
  uuid: string;
  project: RunProject;
  ref: HostRef;
  client: BotHostClient;
  origin: string;
  label: string;
  console: HostConsole | null;
  state: PowerState | "unknown";
  /** KojyAI powered it off or restarted it, so the next "offline" is no crash. */
  expectOffline: boolean;
  stopping: boolean;
  startedAt: number;
  /** "code 3", "out of memory": from the host's own lines when the bot exits. */
  exitNote: string;
  exitCode: number | null;
  /** Ask for the host's recent output once the console is up (KojyAI restarted meanwhile). */
  fillOnReady: boolean;
  /** The bot's own lines seen (not the host's), newest last, to tell where a gap in the log starts. */
  recent: string[];
  historyUntil: number;
  history: string[];
  stats: HostStats | null;
  memoryMb: number;
  node: string;
}

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

export class HostRunner {
  private sessions = new Map<string, Session>();
  private busy = new Set<string>();

  constructor(private db: Database, private hooks: HostHooks, private opts: HostRunnerOptions) {}

  has(uuid: string): boolean {
    return this.sessions.has(uuid);
  }

  isRunning(uuid: string): boolean {
    const s = this.sessions.get(uuid);
    return !!s && (s.state === "running" || s.state === "starting");
  }

  runningCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.state === "running" || s.state === "starting") n++;
    return n;
  }

  /** One line for get_logs: where the bot runs and its memory use. */
  note(uuid: string): string | null {
    const s = this.sessions.get(uuid);
    if (!s) return null;
    const used = s.stats ? `, ${Math.round(s.stats.memoryBytes / 1048576)} MB in use now` : "";
    return `Runs on ${s.label}${s.node ? ` (${s.node})` : ""}: ${s.memoryMb || "?"} MB memory${used}. Its data/ files live there; the copies here may be older.`;
  }

  // ── sessions ───────────────────────────────────────────────────────────────

  private async clientFor(hostId: number, orgId: number): Promise<{ client: BotHostClient; origin: string; label: string }> {
    const [host] = await this.db.select().from(botHosts).where(and(eq(botHosts.id, hostId), eq(botHosts.orgId, orgId))).limit(1);
    if (!host) throw new Error("The bot host this bot uses was disconnected. Pick where it runs in its settings.");
    const provider = botHostProvider(host.provider);
    if (!provider) throw new Error(`KojyAI no longer supports the bot host "${host.provider}".`);
    let apiKey: string;
    try { apiKey = decryptApiKey(host.apiKeyVault); } catch { throw new Error("The bot host's API key could not be decrypted (was ENCRYPTION_KEY changed?). Connect the host again."); }
    const client = this.opts.makeClient?.(provider, apiKey) ?? new BotHostClient({ provider, apiKey });
    return { client, origin: provider.origin, label: provider.label };
  }

  private async session(row: ProjectRow): Promise<Session> {
    if (!row.hostId || !row.hostServer) throw new Error("This bot has no bot host server.");
    const existing = this.sessions.get(row.uuid);
    if (existing && existing.ref.hostId === row.hostId && existing.ref.server === row.hostServer) return existing;
    if (existing) this.close(existing);
    const { client, origin, label } = await this.clientFor(row.hostId, row.orgId);
    const recent = readLogs(row.uuid, undefined, 64 * 1024).lines.filter((l) => l.stream === "stdout").map((l) => l.line).slice(-RECENT_LINES);
    const s: Session = {
      uuid: row.uuid, project: { id: row.id, orgId: row.orgId, ownerId: row.ownerId, name: row.name },
      ref: { hostId: row.hostId, server: row.hostServer }, client, origin, label: `${label}, server ${row.hostServer}`,
      console: null, state: "unknown", expectOffline: false, stopping: false, startedAt: 0, exitNote: "", exitCode: null,
      fillOnReady: false, recent, historyUntil: 0, history: [], stats: null, memoryMb: 0, node: "",
    };
    this.sessions.set(row.uuid, s);
    return s;
  }

  private close(s: Session): void {
    s.console?.close();
    s.console = null;
    if (this.sessions.get(s.uuid) === s) this.sessions.delete(s.uuid);
  }

  /** Runner stopping: let go of the consoles, but leave the bots running on their hosts. */
  detachAll(): void {
    for (const s of [...this.sessions.values()]) this.close(s);
  }

  // ── start / stop ───────────────────────────────────────────────────────────

  /**
   * Starts the bot on its host. Already running there (KojyAI restarted, or
   * the host restarted it after a crash): just watch it again.
   */
  async start(row: ProjectRow, reason?: string): Promise<void> {
    const uuid = row.uuid;
    if (this.busy.has(uuid)) return;
    this.busy.add(uuid);
    try {
      const s = await this.session(row);
      s.stopping = false;
      const server = await s.client.getServer(s.ref.server);
      s.memoryMb = server.memoryMb;
      s.node = server.node;
      if (server.suspended) {
        this.hooks.console(uuid, "system", `✖ ${s.label} is suspended by the host, so the bot can't start there.`);
        return await this.hooks.setStatus(uuid, "error", "The bot host suspended this server.");
      }
      if (server.installing || server.transferring) {
        await this.hooks.setStatus(uuid, "installing", `${s.client.provider.label} is still setting up the server…`);
        return this.hooks.later(uuid, 30);
      }
      this.watch(s);
      const { state, uptimeMs } = await s.client.resources(s.ref.server);
      if (state === "running" || state === "starting") {
        s.state = state;
        s.startedAt = Date.now() - uptimeMs;
        s.fillOnReady = true;
        if (s.console?.isReady) this.fillGap(s);
        return await this.hooks.setStatus(uuid, state, null);
      }
      if (!/python/i.test(server.dockerImage)) {
        throw new Error(`This server runs ${server.dockerImage || "something other than Python"}, not Python. Choose a Python server in the bot's settings.`);
      }

      await this.hooks.setStatus(uuid, "installing", `Uploading the bot to ${s.client.provider.label}…`);
      const sent = await this.upload(s, row);
      if (sent) this.hooks.console(uuid, "system", `Uploaded ${sent} changed file(s) to ${s.label}.`);
      const startup = await s.client.startup(s.ref.server);
      const variable = pythonFileVariable(startup);
      if (!variable) throw new Error("Couldn't find which Python file this server starts (its startup settings have none).");
      if (startup.variables.find((v) => v.env === variable)?.value !== START_FILE) await s.client.setStartupVariable(s.ref.server, variable, START_FILE);
      // The panel's own install would put the packages in twice on a small disk.
      for (const v of startup.variables) {
        if (v.editable && /REQUIREMENTS/i.test(v.env) && v.value !== NO_REQUIREMENTS) await s.client.setStartupVariable(s.ref.server, v.env, NO_REQUIREMENTS);
      }
      const python = Object.values(startup.dockerImages).find((image) => image.endsWith(`python_${HOST_PYTHON}`));
      if (python && server.dockerImage !== python) {
        await s.client.setDockerImage(s.ref.server, python);
        this.hooks.console(uuid, "system", `Switched ${s.label} to Python ${HOST_PYTHON}, the version KojyAI runs bots on.`);
      }

      this.hooks.console(uuid, "system", `▶ Starting ${row.entrypoint} on ${s.label}${reason ? ` (${reason})` : ""}`);
      await this.hooks.setStatus(uuid, "starting", `Starting on ${s.client.provider.label}…`);
      s.state = "offline";
      s.exitNote = "";
      s.exitCode = null;
      await s.client.power(s.ref.server, "start");
    } catch (err) {
      await this.hooks.startFailed(uuid, err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.delete(uuid);
    }
  }

  async stop(row: ProjectRow): Promise<void> {
    let s: Session;
    try {
      s = await this.session(row);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.hooks.console(row.uuid, "system", `✖ Couldn't reach the bot host to stop the bot: ${message}`);
      return this.hooks.setStatus(row.uuid, "error", message.slice(0, 450));
    }
    s.stopping = true;
    s.expectOffline = true;
    this.watch(s);
    this.hooks.console(row.uuid, "system", "■ Stopping");
    try {
      await s.client.power(s.ref.server, "stop");
      if (!(await this.offlineWithin(s, STOP_WAIT_MS))) {
        this.hooks.console(row.uuid, "system", "The bot didn't stop in time — killing it.");
        await s.client.power(s.ref.server, "kill");
        await this.offlineWithin(s, 10_000);
      }
    } catch (err) {
      this.hooks.console(row.uuid, "system", `✖ Couldn't stop it on ${s.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (s.stopping) {
      // The console didn't report it (or isn't connected): KojyAI asked, so it counts as stopped.
      s.stopping = false;
      s.expectOffline = false;
      s.state = "offline";
      this.hooks.stopped(row.uuid, s.project);
    }
    await this.hooks.setStatus(row.uuid, "stopped", null);
  }

  /** Types a line into the bot's console (its stdin). */
  async command(row: ProjectRow, text: string): Promise<void> {
    const s = await this.session(row);
    await s.client.command(s.ref.server, text);
    this.hooks.console(row.uuid, "stdin", text);
  }

  /** Waits for the console to report "offline" (or asks the panel every few seconds while the console is down). */
  private async offlineWithin(s: Session, ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    let nextPoll = 0;
    while (Date.now() < until) {
      if (s.state === "offline") return true;
      if (!s.console?.isReady && Date.now() >= nextPoll) {
        nextPoll = Date.now() + 2_500;
        try { if ((await s.client.resources(s.ref.server)).state === "offline") { s.state = "offline"; return true; } } catch { /* try again */ }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return s.state === "offline";
  }

  /**
   * Moving the bot off a host: stop it there, copy its data/ and database
   * files back here, and remove its settings (they hold its secrets) and the
   * packages KojyAI installed.
   */
  async release(uuid: string, orgId: number, from: HostRef): Promise<void> {
    const current = this.sessions.get(uuid);
    if (current) this.close(current);
    const { client, label } = await this.clientFor(from.hostId, orgId);
    const where = `${label}, server ${from.server}`;
    try {
      await client.power(from.server, "stop");
      for (let i = 0; i < 10; i++) {
        if ((await client.resources(from.server)).state === "offline") break;
        if (i === 6) await client.power(from.server, "kill");
        await new Promise((r) => setTimeout(r, 2_500));
      }
    } catch (err) {
      this.hooks.console(uuid, "system", `Couldn't stop the bot on ${where}: ${err instanceof Error ? err.message : String(err)}`);
    }
    let copied = 0;
    try {
      copied = await this.copyDataBack(uuid, client, from.server);
    } catch (err) {
      this.hooks.console(uuid, "system", `✖ Couldn't copy all of the bot's data back from ${where}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await client.deleteFiles(from.server, [".kojy", START_FILE, LAUNCHER_FILE]).catch(() => undefined);
    this.hooks.console(uuid, "system", `■ Moved off ${where}${copied ? `; copied ${copied} data file(s) back` : ""}.`);
  }

  /** The project was deleted: stop the bot on its host and remove its settings there. */
  async purge(uuid: string, orgId: number, from: HostRef): Promise<void> {
    const current = this.sessions.get(uuid);
    if (current) this.close(current);
    const { client } = await this.clientFor(from.hostId, orgId);
    await client.power(from.server, "kill").catch(() => undefined);
    await client.deleteFiles(from.server, [".kojy", START_FILE, LAUNCHER_FILE]).catch(() => undefined);
  }

  /**
   * For a bot waiting for a free server: make one if the host has room.
   * Returns its identifier, or null when the host is still full.
   */
  async createServerFor(row: ProjectRow): Promise<string | null> {
    if (!row.hostId) return null;
    const { client } = await this.clientFor(row.hostId, row.orgId);
    const options = await client.freeServerOptions();
    if (!options || options.full || !options.canCreate || !options.runtimes.includes("python")) return null;
    try {
      const server = await client.createFreeServer({ name: row.name.slice(0, 60), description: "Highrise bot run by KojyAI", runtime: "python" });
      return server.id;
    } catch (err) {
      if (err instanceof HostApiError && (err.status === 503 || err.status === 409)) return null;
      throw err;
    }
  }

  // ── files ──────────────────────────────────────────────────────────────────

  /** Uploads what changed since the last start; returns how many files went up (settings not counted). */
  private async upload(s: Session, row: ProjectRow): Promise<number> {
    const prev: HostSync | null = row.hostSync && row.hostSync.server === s.ref.server ? row.hostSync : null;
    const dir = projectDir(row.uuid);
    const files: Record<string, string> = {};
    const send: [string, Uint8Array | string][] = [];
    const add = (rel: string, content: Uint8Array | string, data = false) => {
      const hash = sha256(content);
      if (!data) files[rel] = hash;
      if (data || prev?.files[rel] !== hash) send.push([rel, content]);
    };

    let requirements = "";
    for (const f of listFiles(row.uuid)) {
      if (f.isDir || KOJY_FILES.has(f.path) || f.path.startsWith(".kojy/")) continue;
      const data = isPersistentData(f.path);
      if (data && prev?.dataUploaded) continue; // lives on the host now
      if (f.size > MAX_SYNC_FILE_BYTES) {
        this.hooks.console(row.uuid, "system", `Not uploaded (over ${MAX_SYNC_FILE_BYTES / 1048576} MB): ${f.path}`);
        continue;
      }
      const content = readFileSync(path.join(dir, f.path));
      if (f.path === "requirements.txt") requirements = content.toString("utf8");
      add(f.path, content, data);
    }
    add(START_FILE, readFileSync(this.opts.starterPath));
    add(LAUNCHER_FILE, readFileSync(this.opts.launcherPath));
    add(REQUIREMENTS_FILE, `${this.opts.baseRequirements.join("\n")}\n${requirements}`);

    for (const [rel, content] of send) await s.client.writeFile(s.ref.server, rel, content);
    // Settings and secrets: written on every start, never remembered anywhere else.
    const env: Record<string, string> = {
      ...(await this.opts.secrets(row)),
      KOJY_ENTRY: row.entrypoint, KOJY_ACTIVITY: "stdout", PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1",
      ...(process.env.HR_BOTAPI_URL ? { HR_BOTAPI_URL: process.env.HR_BOTAPI_URL } : {}),
    };
    await s.client.writeFile(s.ref.server, ENV_FILE, JSON.stringify(env));

    const removed = Object.keys(prev?.files ?? {}).filter((rel) => !(rel in files) && !isPersistentData(rel));
    if (removed.length) await s.client.deleteFiles(s.ref.server, removed);

    const sync: HostSync = { server: s.ref.server, files, dataUploaded: true };
    await this.db.update(botProjects).set({ hostSync: sync }).where(eq(botProjects.id, row.id));
    row.hostSync = sync;
    return send.length;
  }

  /** Copies data/ (up to 4 folders deep) and database files from the host into the project here. */
  private async copyDataBack(uuid: string, client: BotHostClient, server: string): Promise<number> {
    const wanted: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      for (const entry of await client.listDir(server, dir || "/")) {
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isFile) { if (isPersistentData(rel)) wanted.push(rel); }
        else if ((rel === "data" || rel.startsWith("data/")) && depth < 4) await walk(rel, depth + 1);
        if (wanted.length >= 500) return;
      }
    };
    await walk("", 0);
    for (const rel of wanted) {
      const bytes = await client.downloadFile(server, rel);
      const target = resolveInside(uuid, rel);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    return wanted.length;
  }

  // ── live console ───────────────────────────────────────────────────────────

  private watch(s: Session): void {
    if (s.console) return;
    const options: ConsoleOptions = {
      credentials: () => s.client.consoleCredentials(s.ref.server),
      origin: s.origin,
      events: {
        line: (text) => this.onLine(s, text),
        status: (state) => this.onStatus(s, state),
        stats: (stats) => { s.stats = stats; },
        daemon: (text) => { if (text.trim()) this.hooks.console(s.uuid, "system", `Host: ${text.trim()}`); },
        ready: (again) => { if (again || s.fillOnReady) this.fillGap(s); },
        problem: (text) => log.warn({ uuid: s.uuid, problem: text }, "Bot host console"),
        ended: (why) => {
          s.console = null;
          this.hooks.console(s.uuid, "system", `✖ Lost the live console of ${s.label}: ${why}`);
          void this.hooks.setStatus(s.uuid, "error", why.slice(0, 450));
        },
      },
    };
    s.console = this.opts.makeConsole?.(options) ?? new HostConsole(options);
    s.console.start();
  }

  /** After a gap (KojyAI restarted, the connection dropped): add the host's recent output not yet saved. */
  private fillGap(s: Session): void {
    s.fillOnReady = false;
    s.history = [];
    s.historyUntil = Date.now() + HISTORY_WINDOW_MS;
    s.console?.requestLogs();
    setTimeout(() => {
      s.historyUntil = 0;
      // Only the bot's own lines are compared and added (the saved log has the host's lines reworded).
      const lines = s.history.filter((l) => !l.startsWith(ACTIVITY_PREFIX) && !HOST_LINE.test(l));
      s.history = [];
      for (const line of unseenLines(lines, s.recent)) this.take(s, line);
    }, HISTORY_WINDOW_MS + 100).unref();
  }

  private onLine(s: Session, text: string): void {
    if (s.historyUntil && Date.now() < s.historyUntil) { s.history.push(text); return; }
    this.take(s, text);
  }

  private take(s: Session, text: string): void {
    if (text.startsWith(ACTIVITY_PREFIX)) {
      try {
        const e = JSON.parse(text.slice(ACTIVITY_PREFIX.length)) as { k?: string; id?: string | null; n?: string | null };
        if (e.k && ACTIVITY_KINDS.has(e.k)) this.hooks.activity(s.project, e.k, e.id ?? null, e.n ?? null);
      } catch { /* not ours */ }
      return;
    }
    const host = HOST_LINE.exec(text);
    if (host) {
      const said = text.slice(host[0].length).trim();
      const code = /\bExit code:\s*(-?\d+)/i.exec(said);
      if (code) { s.exitCode = Number(code[1]); s.exitNote = `code ${code[1]}${s.exitNote.includes("memory") ? ", out of memory" : ""}`; }
      if (/\bOut of memory:\s*true/i.test(said)) s.exitNote = `${s.exitNote || "killed"}, out of memory (${s.memoryMb || "?"} MB limit)`;
      if (said) this.hooks.console(s.uuid, "system", `Host: ${said}`);
      return;
    }
    s.recent.push(text);
    if (s.recent.length > RECENT_LINES) s.recent.shift();
    this.hooks.console(s.uuid, "stdout", text);
    if (text.startsWith(ROOM_RIGHTS_PREFIX)) this.hooks.roomRights(s.uuid, s.project, text);
  }

  private onStatus(s: Session, state: PowerState): void {
    const prev = s.state;
    s.state = state;
    if (state === prev) return;
    if (state === "starting") {
      void this.hooks.setStatus(s.uuid, "starting", null);
    } else if (state === "running") {
      s.exitNote = "";
      s.exitCode = null;
      if (prev === "unknown") {
        // Just connected to a bot that was already running (KojyAI restarted): not a new start.
        s.startedAt ||= Date.now();
        void this.hooks.setStatus(s.uuid, "running", null);
        return;
      }
      s.startedAt = Date.now();
      this.hooks.started(s.uuid, s.project);
      void this.hooks.setStatus(s.uuid, "running", null);
    } else if (state === "offline") {
      if (s.expectOffline) {
        s.expectOffline = false;
        if (s.stopping) {
          s.stopping = false;
          this.hooks.stopped(s.uuid, s.project);
          void this.hooks.setStatus(s.uuid, "stopped", null);
        }
        return;
      }
      if (prev === "unknown") return; // first report after connecting: nothing happened
      const ranFor = s.startedAt ? Date.now() - s.startedAt : 0;
      s.startedAt = 0;
      // The host's "Exit code" line can arrive just after the status: give it a moment.
      setTimeout(() => this.hooks.crashed(s.uuid, s.project, ranFor, s.exitNote || "stopped on its host", s.exitCode), 1_500).unref();
    }
  }
}
