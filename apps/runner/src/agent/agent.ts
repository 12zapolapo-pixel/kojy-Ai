/**
 * Coder AI (Kojy) — runs inside the runner (it has the files, Python and the
 * bot processes).
 * OWNERSHIP: apps/runner/src/agent
 *
 * Conversations ("threads", see project_messages.thread):
 *   project:<id>   a Python bot's chat — key on the wire: the bot's uuid
 *   studio:<org>   the Studio chat about all bots — key: "studio-<org>"
 * Each has its own tools and instructions (a Scope), so a request only
 * carries the tools it can use — that keeps it inside Groq's free limits.
 *
 * The API stores the owner's message and sends "agent" on
 * project_control:<key>; this loop answers: model → tool calls → tool
 * results → model … until it replies without tools, asks for secrets, or hits
 * the step limit. Every step is written to project_messages, which is both
 * the chat the page shows and the model's history.
 *
 * Stabilizer: when a bot crashes with a Python traceback (or the launcher's
 * watchdog finds its code frozen), the supervisor calls onCrash and, if the
 * project allows auto-fix, Kojy fixes it by itself right away — edits, tests,
 * restarts — within the limits in autoFix.ts. There's no daily limit: every
 * crash is worked on, after the request Kojy is busy with if there is one.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { Redis } from "ioredis";
import { notifyUser, sendAlert, type Database } from "@kojyai/db";
import { agentMemories, botHosts, botProjects, bots, projectMessages, projectSecrets } from "@kojyai/db/schema";
import { botHostProvider } from "@kojyai/shared/bothost";
import { codeFingerprint, compareSnapshot, deleteSnapshot, extractSnapshot, lineDiff, fingerprintChanges, isStartCommand, listFiles, normalizeNote, projectDir, readLogs, resolveInside, restoreSnapshot, snapshotProject } from "@kojyai/shared/projects";
import type { Supervisor } from "../supervisor.js";
import { createLogger } from "../logger.js";
import { aiReadyAt, chat, configuredLanes, historyBudget, estimateTokens, AiUnavailableError, RequestTooLargeError, type ChatMessage, type ChatResult, type ToolCall, type ToolSpec } from "./groq.js";
import type { GitService } from "../git.js";
import { TOOL_SPECS, runTool, loadMemories, loadSecrets, projectCodeFiles, discordSecrets, type ToolContext, type ToolResult } from "./tools.js";
import { diagnoseDiscord, isDiscordSetupError, type DiscordDiagnosis } from "./discord.js";
import { systemPrompt, fixPrompt, studioPrompt, jsBotPrompt, untrusted } from "./prompt.js";
import { taskMemory, taskMemoryPrompt, continuesAutomatically, requestIndex, announcesNextStep, deniesCapability, MAX_NUDGES, MAX_DENIALS, NUDGE, CAPABILITY_NUDGE, STUDIO_CAPABILITY_NUDGE, APP_NOTE_KINDS, type PartOutcome } from "./taskMemory.js";
import { MEMORY_TOOL_NAMES, MEMORY_TOOL_SPECS, recentWork, recentWorkPrompt, recordWork, runMemoryTool, type WorkStatus } from "./workLog.js";
import { STUDIO_TOOL_SPECS, runStudioTool, studioSnapshot, type StudioContext } from "./studioTools.js";
import { JS_TOOL_SPECS, runJsTool, type JsContext } from "./jsTools.js";
import { runCheckups } from "./checkup.js";
import { FIXABLE, IncidentLedger, type Incident, type IncidentCategory, type IncidentPatch } from "../incidents.js";
import { addRequirement, hasRequirement, isLocalModule, packageFor } from "../packages.js";
import { checkFix, saveRegressionTest, type FixCheck, type FixEvent } from "./verifyFix.js";
import { projectMap } from "./projectMap.js";
import { CONNECTED_PREFIX } from "./botHealth.js";
import { changesSinceGood, codeAround } from "./crashContext.js";
import { AUTOMATED_KINDS, automaticRefusal, automaticTools, crashExcerpt, crashLocation, crashSignature, isNetworkFailure, lastException, normalizeError, type AutomatedKind } from "./autoFix.js";

const log = createLogger("agent");

const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS ?? 24);
/** How many parts of MAX_STEPS one request may take before it asks the owner to continue. */
const AUTO_PARTS = Number(process.env.AGENT_AUTO_PARTS ?? 8);
/**
 * History sent with each step. At 3000 one file read pushed the previous one
 * out and Kojy kept re-reading the same file; much more than 8000 and
 * Mistral's free plan (20,000 tokens a minute) takes one step a minute at
 * best. A request too big for the AI that's free (Groq) is retried smaller.
 */
const HISTORY_TOKENS = Number(process.env.AGENT_HISTORY_TOKENS ?? 8000);
/** History sent when the AI that answers first has no per-minute token limit (Gemini, most gateways): it can take far more, so Kojy forgets less on long tasks. */
const HISTORY_TOKENS_LARGE = Number(process.env.AGENT_HISTORY_TOKENS_LARGE ?? 24_000);
/** A request cut off by a runner restart picks up again this long after boot (bots are back by then). */
const RESUME_DELAY_MS = 20_000;
/** …if it was still active this recently. */
const RESUME_WITHIN_MS = 30 * 60_000;

/** Tools that only look at something: an older result is outdated once the same look is repeated. */
const LOOK_TOOLS = new Set(["read_file", "list_files", "search_code", "get_logs", "find_emotes", "find_env_vars", "check_code", "work_log", "search_chat", "query_data", "room_activity"]);
/** …and these, whatever their arguments: the newest always says more. */
const NEWEST_WINS = new Set(["get_logs", "check_code"]);

function canonicalArgs(args: string): string {
  try {
    const v = JSON.parse(args || "{}") as Record<string, unknown>;
    return JSON.stringify(Object.keys(v).sort().map((k) => [k, v[k]]));
  } catch {
    return args;
  }
}

/**
 * Row ids of tool results made obsolete by a newer identical call (the same
 * file range read again, the logs fetched again). They go into the history as
 * their one-line summary, so reading something twice doesn't cost twice.
 * `rows` oldest first.
 */
export function supersededResults(rows: { id: number; role: string; data: unknown }[]): Set<number> {
  const keyOf = new Map<string, string>();
  for (const r of rows) {
    if (r.role !== "assistant") continue;
    for (const c of (r.data as { toolCalls?: ToolCall[] } | null)?.toolCalls ?? []) {
      const name = c.function.name;
      if (LOOK_TOOLS.has(name)) keyOf.set(c.id, NEWEST_WINS.has(name) ? name : `${name}:${canonicalArgs(c.function.arguments)}`);
    }
  }
  const seen = new Set<string>();
  const out = new Set<number>();
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.role !== "tool") continue;
    const key = keyOf.get((r.data as { toolCallId?: string } | null)?.toolCallId ?? "");
    if (!key) continue;
    if (seen.has(key)) out.add(r.id);
    else seen.add(key);
  }
  return out;
}

type Row = typeof projectMessages.$inferSelect;
type ProjectRow = typeof botProjects.$inferSelect;

/** How a call to Agent.run ended. */
export interface RunResult {
  /** "busy": another request was running for this chat; this one runs right after it. */
  outcome: PartOutcome | "busy";
  ended: "error" | "stopped" | null;
  /** It ended because no AI could take the request (every key at its limit, or too big for the free ones). */
  aiUnavailable: boolean;
}

/** A crash an automatic fix is working on. */
interface CrashFix {
  signature: string;
  /** The console lines it came with (to start over if the fix is undone). */
  tail: string[];
  /** The undo point taken right before the fix (null if it couldn't be taken). */
  snapshotId: string | null;
  /** The "crash" message in the chat that the fix answers. */
  requestId: number;
  /** "a crash" / "a freeze", for messages. */
  what: string;
  /** Its row in bot_incidents (null when it couldn't be recorded). */
  incidentId: number | null;
  /** Set when it was an error the bot survived, not a crash. */
  survived?: { handler: string; command?: string } | undefined;
  /** The handler (and chat command) that was running when it failed — replayed in a test room to check the fix. */
  event?: FixEvent | undefined;
  /** When it failed: while loading, starting, or in the room. */
  phase?: string | undefined;
}

/** What onCrash knows besides the console lines. */
interface CrashContext {
  /** The incident the supervisor recorded it as. */
  incident?: (Pick<Incident, "id" | "category"> & Partial<Pick<Incident, "phase" | "summary" | "state" | "attempts" | "lastAttemptAt" | "data">>) | null;
  /** Why an earlier automatic fix for this crash was undone. */
  earlier?: string;
  /** Not a crash: an error the bot survived (it kept running) — in this handler, for this chat command. */
  survived?: { handler: string; command?: string };
}

/** One conversation: where its messages live, its tools and its instructions. */
interface Scope {
  key: string;
  thread: string;
  projectId: number;
  /** The owner's org: chat updates are announced on its WebSocket channel. */
  orgId: number;
  tools: ToolSpec[];
  runTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  system(): Promise<string>;
  /** The shorter instructions for an automatic fix (bot chats only). */
  fixSystem?(): Promise<string>;
  setState(state: "idle" | "working" | "waiting"): Promise<void>;
  /** What the current request is, for undo labels (bot chats only). */
  setLabel?(label: string): void;
  /** Said to Kojy after a false "I can't" in this chat (none: such replies aren't checked). */
  capabilityNudge?: string;
  /** Before the owner's request is called done: what Kojy changed in it, to review once (null: nothing to review, or already reviewed). */
  review?(): string | null;
}

export const STUDIO_PREFIX = "studio-";
/** Key for a JS bot's chat: "jsbot-<bots.uuid>". */
export const JSBOT_PREFIX = "jsbot-";

export class Agent {
  private active = new Map<string, AbortController>();
  /**
   * Automatic fixes being watched: the snapshot from before the fix, the crash
   * it was for, and the code right after it (a rollback never overwrites
   * changes made since).
   */
  private watching = new Map<string, { snapshotId: string; signature: string; tail: string[]; files: Record<string, string>; incidentId: number | null; survived?: CrashFix["survived"]; timer: NodeJS.Timeout }>();
  private again = new Set<string>();
  /** Per running request: whether its undo snapshot was taken (shared by all its parts). */
  private runShared = new Map<string, { snapshotted: boolean; snapshotId?: string | undefined; reviewed?: boolean }>();
  /** Crashes that came in while Kojy was busy with the bot, by signature; fixed as soon as it's free. */
  private queuedCrash = new Map<string, Map<string, { streak: number; tail: string[]; context: CrashContext }>>();
  /** Every problem the bots had (shared with the supervisor). */
  private incidents: IncidentLedger;
  /** The signature of the crash an automatic fix is working on right now. */
  private fixing = new Map<string, string>();
  /** Automatic fixes waiting for an AI to be free again. */
  private retryTimers = new Map<string, NodeJS.Timeout>();
  /** Crashes whose next automatic fix waits a little ("uuid|signature"): the last attempt didn't fix it. */
  private deferred = new Map<string, NodeJS.Timeout>();
  /** Packages ("uuid|package") already installed again from scratch because they wouldn't import. */
  private freshInstalls = new Set<string>();
  /** Fixes in a row that failed KojyAI's checks, per "uuid|signature". */
  private failedChecks = new Map<string, number>();
  /** The checks an automatic fix has to pass (swapped in tests). */
  checkFix: (ctx: ToolContext, fix: Parameters<typeof checkFix>[1]) => Promise<FixCheck> = (ctx, fix) => checkFix(ctx, fix);
  /** What the owner was last told about a Discord bot's setup (so it's said once, not on every restart). */
  private discordWarned = new Map<string, string>();

  /** The Git panel's operations, for Kojy's git tool (set by boot.ts). */
  git?: GitService;

  constructor(private db: Database, private supervisor: Supervisor, private redis: Redis | null) {
    this.incidents = (supervisor as { incidents?: IncidentLedger }).incidents ?? new IncidentLedger(db);
    supervisor.onCrash = (uuid, streak, tail, incident) => void this.onCrash(uuid, streak, tail, { incident });
    supervisor.fixingNow = (uuid) => this.fixingNow(uuid);
    // An error the bot survived is fixed the same way: the bot kept running, but that part of it is broken.
    supervisor.onBotError = (uuid, tail, incident, report) => void this.onCrash(uuid, 1, tail, {
      incident, survived: { handler: report.event?.handler ?? "a handler", ...(report.event?.command ? { command: report.event.command } : {}) },
    });
    supervisor.onDiscordConnected = (uuid) => void this.onDiscordConnected(uuid).catch((err) => log.warn({ err, uuid }, "Discord check failed"));
    // Out of its room with the token and room fine: the code is the likely cause.
    supervisor.onRoomProblem = (uuid, incident, evidence, tail) => void this.fixRoomProblem(uuid, incident, evidence, tail).catch((err) => log.warn({ err, uuid }, "Room problem fix failed"));
    supervisor.onCodeRestored = (uuid, note) => void this.codeRestored(uuid, note).catch((err) => log.warn({ err, uuid }, "Could not note the restored code"));
    // Daily check-ups: look every hour for bots that are due.
    const tick = () => {
      void runCheckups(this.db, (uuid) => void this.run(uuid), this.incidents).catch((err) => log.warn({ err }, "Check-ups failed"));
      void this.incidents.prune();
    };
    setTimeout(tick, 60_000).unref();
    setInterval(tick, 3600_000).unref();
  }

  /** Control messages from the API: "agent" (new message) and "agent_stop". */
  async handle(key: string, action: string): Promise<void> {
    if (action === "agent_stop") { this.active.get(key)?.abort(); return; }
    if (action === "agent") await this.run(key);
  }

  /**
   * After a runner restart nobody is working any more. A bot chat that was in
   * the middle of a request (a platform update restarts the runner) picks it
   * up again by itself — once per request, so a request that keeps getting
   * cut off doesn't loop — or says it was interrupted.
   */
  async resetStates(): Promise<void> {
    // Automatic fixes first: the ones they pick up themselves aren't resumed twice below.
    const resumed = await this.resumeIncidents().catch((err: unknown) => { log.warn({ err }, "Could not pick up automatic fixes"); return new Set<string>(); });
    const cut = await this.db.select({ id: botProjects.id, uuid: botProjects.uuid }).from(botProjects).where(eq(botProjects.agentState, "working"));
    await this.db.update(botProjects).set({ agentState: "idle" }).where(eq(botProjects.agentState, "working"));
    for (const p of cut) {
      if (resumed.has(p.uuid)) continue;
      try {
        await this.resumeAfterRestart(p.uuid, p.id);
      } catch (err) {
        log.warn({ err, uuid: p.uuid }, "Could not pick up a request cut off by the restart");
      }
    }
  }

  private async resumeAfterRestart(uuid: string, projectId: number): Promise<void> {
    const scope = { thread: `project:${projectId}`, projectId };
    const rows = (await this.db.select({ id: projectMessages.id, role: projectMessages.role, kind: projectMessages.kind, content: projectMessages.content, createdAt: projectMessages.createdAt })
      .from(projectMessages).where(eq(projectMessages.thread, scope.thread)).orderBy(desc(projectMessages.id)).limit(300)).reverse();
    const request = rows[requestIndex(rows)];
    const lastActive = rows[rows.length - 1]?.createdAt.getTime() ?? 0;
    if (!request || Date.now() - lastActive > RESUME_WITHIN_MS) return;
    let first = false;
    try {
      first = (await this.redis?.set(`agent_resumed:${scope.thread}:${request.id}`, "1", "EX", 86_400, "NX")) === "OK";
    } catch { /* without Redis, don't risk resuming twice */ }
    if (first) {
      await this.add(scope, "assistant", "KojyAI restarted while I was working on this — picking up where I left off.", "event");
      await recordWork(this.db, scope.thread, projectId, "in_progress");
      log.info({ uuid }, "Picking up a request cut off by the restart");
      setTimeout(() => void this.run(uuid), RESUME_DELAY_MS).unref();
    } else {
      await this.add(scope, "assistant", "KojyAI restarted while I was working on this. Send “continue” and I'll pick up from my notes on this request.", "event");
      await recordWork(this.db, scope.thread, projectId, "paused");
    }
  }

  private async progress(uuid: string, text: string | null, orgId?: number): Promise<void> {
    if (!this.redis) return;
    try {
      if (text) await this.redis.set(`agent_progress:${uuid}`, text, "EX", 180);
      else await this.redis.del(`agent_progress:${uuid}`);
    } catch { /* progress is cosmetic */ }
    if (orgId) this.nudge(orgId, uuid);
  }

  /**
   * Tells the owner's open chat that something changed, over the WebSocket
   * (org channel). No content: the page fetches the messages as usual. The
   * page still polls slowly in case the WebSocket is down.
   */
  private nudge(orgId: number, key: string): void {
    if (!this.redis || !orgId) return;
    this.redis.publish(`org:${orgId}`, JSON.stringify({ type: "chat_update", thread: key, ts: Date.now() })).catch(() => undefined);
  }

  private async add(scope: Pick<Scope, "thread" | "projectId"> & Partial<Pick<Scope, "key" | "orgId">>, role: string, content: string, kind = "text", data?: Record<string, unknown>): Promise<Row> {
    const [row] = await this.db.insert(projectMessages).values({ thread: scope.thread, projectId: scope.projectId, role, kind, content, data: data ?? null }).returning();
    if (scope.key && scope.orgId) this.nudge(scope.orgId, scope.key);
    return row!;
  }

  /** The conversation behind a control-message key, or null if it's gone. */
  private async scopeFor(key: string): Promise<Scope | null> {
    if (key.startsWith(STUDIO_PREFIX)) {
      const orgId = Number(key.slice(STUDIO_PREFIX.length));
      if (!Number.isInteger(orgId) || orgId <= 0) return null;
      const ctx: StudioContext = { db: this.db, supervisor: this.supervisor, redis: this.redis, orgId, startBotChat: (uuid) => void this.run(uuid) };
      return {
        key, thread: `studio:${orgId}`, projectId: 0, orgId, tools: STUDIO_TOOL_SPECS, capabilityNudge: STUDIO_CAPABILITY_NUDGE,
        runTool: (name, args) => runStudioTool(name, args, ctx),
        system: async () => studioPrompt(await studioSnapshot(ctx), await loadMemories(this.db, { orgId, id: -1 })),
        setState: async (state) => {
          try {
            if (state === "idle") await this.redis?.del(`agent_state:${key}`);
            else await this.redis?.set(`agent_state:${key}`, state, "EX", 3600);
          } catch { /* cosmetic */ }
        },
      };
    }
    if (key.startsWith(JSBOT_PREFIX)) {
      const [bot] = await this.db.select().from(bots).where(eq(bots.uuid, key.slice(JSBOT_PREFIX.length))).limit(1);
      if (!bot) return null;
      const ctx: JsContext = { db: this.db, redis: this.redis, bot, startBotChat: (uuid) => void this.run(uuid) };
      return {
        key, thread: `bot:${bot.id}`, projectId: 0, orgId: bot.orgId, tools: JS_TOOL_SPECS,
        runTool: (name, args) => runJsTool(name, args, ctx),
        system: async () => jsBotPrompt(bot.name, bot.status, await loadMemories(this.db, { orgId: bot.orgId, id: -1 })),
        setState: async (state) => {
          try {
            if (state === "idle") await this.redis?.del(`agent_state:${key}`);
            else await this.redis?.set(`agent_state:${key}`, state, "EX", 3600);
          } catch { /* cosmetic */ }
        },
      };
    }
    const [project] = await this.db.select().from(botProjects).where(eq(botProjects.uuid, key)).limit(1);
    if (!project) return null;
    // One undo snapshot per request, shared by all its parts (an automatic fix takes it before the run).
    const shared = this.runShared.get(key) ?? { snapshotted: false };
    const ctx: ToolContext = {
      db: this.db, supervisor: this.supervisor, project, changedFiles: new Set(), git: this.git,
      get snapshotted() { return shared.snapshotted; },
      set snapshotted(v: boolean) { shared.snapshotted = v; },
      get snapshotId() { return shared.snapshotId; },
      set snapshotId(v: string | undefined) { shared.snapshotId = v; },
    };
    // What both the chat's and an automatic fix's instructions say about the project.
    const promptInput = async (): Promise<Parameters<typeof systemPrompt>[0]> => {
      const [secrets, memories] = await Promise.all([
        this.db.select({ key: projectSecrets.key }).from(projectSecrets).where(eq(projectSecrets.projectId, project.id)),
        loadMemories(this.db, project),
      ]);
      const [where] = await this.db.select({ hostId: botProjects.hostId, hostServer: botProjects.hostServer, provider: botHosts.provider })
        .from(botProjects).leftJoin(botHosts, eq(botHosts.id, botProjects.hostId)).where(eq(botProjects.id, project.id)).limit(1);
      const runsOn = where?.hostServer ? `${botHostProvider(where.provider ?? "")?.label ?? "a bot host"} (server ${where.hostServer})` : null;
      return {
        projectName: project.name, entrypoint: ctx.project.entrypoint, status: project.status, runsOn,
        secrets: secrets.map((x) => x.key), memories, fileCount: listFiles(project.uuid).filter((f) => !f.isDir).length,
        map: projectMap(project.uuid),
      };
    };
    return {
      key, thread: `project:${project.id}`, projectId: project.id, orgId: project.orgId, tools: TOOL_SPECS, capabilityNudge: CAPABILITY_NUDGE,
      runTool: (name, args) => runTool(name, args, ctx),
      system: async () => systemPrompt(await promptInput()),
      fixSystem: async () => fixPrompt(await promptInput()),
      setState: async (state) => { await this.db.update(botProjects).set({ agentState: state }).where(eq(botProjects.id, project.id)); },
      setLabel: (label) => { ctx.label = label; },
      review: () => {
        if (!shared.snapshotId || shared.reviewed) return null;
        shared.reviewed = true;
        return reviewText(project.uuid, shared.snapshotId);
      },
    };
  }

  /**
   * Answers the newest request in a chat. `snapshotted`: its undo snapshot was
   * already taken (an automatic fix takes its own first). `automatic`: started
   * by a crash — the crash queue is then handled by the fix itself.
   */
  async run(uuid: string, opts: { snapshotted?: boolean; automatic?: boolean } = {}): Promise<RunResult> {
    if (this.active.has(uuid)) { this.again.add(uuid); return { outcome: "busy", ended: null, aiUnavailable: false }; }
    // New work on the bot: a crash after this is no longer the automatic fix's doing.
    this.clearWatch(uuid);
    const abort = new AbortController();
    this.active.set(uuid, abort);
    this.runShared.set(uuid, { snapshotted: opts.snapshotted ?? false });
    let last: RunResult = { outcome: "done", ended: null, aiUnavailable: false };
    try {
      // A long request runs in parts of MAX_STEPS. When a part runs out of steps
      // the next one starts by itself, so the owner doesn't have to type "continue".
      let part = 0;
      for (;;) {
        this.again.delete(uuid);
        last = await this.runOnce(uuid, abort.signal, part);
        if (continuesAutomatically(last.outcome as PartOutcome, part, AUTO_PARTS, abort.signal.aborted)) { part++; continue; }
        part = 0;
        if (!this.again.has(uuid) || abort.signal.aborted) break;
        this.runShared.set(uuid, { snapshotted: false }); // the next request gets its own undo point
      }
    } finally {
      this.active.delete(uuid);
      this.runShared.delete(uuid);
      await this.progress(uuid, null);
      if (!opts.automatic) this.drainCrashQueue(uuid);
    }
    return last;
  }

  private async runOnce(uuid: string, signal: AbortSignal, part: number): Promise<RunResult> {
    const scope = await this.scopeFor(uuid);
    if (!scope) return { outcome: "done", ended: null, aiUnavailable: false };
    const automated = await this.automatedKind(scope.thread);
    /** A file's current text, for the crash-fix limits ("" when it doesn't exist). */
    const currentText = (rel: string) => { try { return readFileSync(resolveInside(uuid, rel), "utf8"); } catch { return ""; } };
    await scope.setState("working");
    let finalState: "idle" | "waiting" | "working" = "idle";
    let outcome: PartOutcome = "limit";
    let ended: "error" | "stopped" | null = null;
    let aiUnavailable = false;
    // Every chat can look back at its own work log and earlier messages. An
    // automatic fix gets only the tools fixing code takes (smaller requests).
    const tools = automated ? automaticTools([...scope.tools, ...MEMORY_TOOL_SPECS]) : [...scope.tools, ...MEMORY_TOOL_SPECS];
    const runTool = (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
      MEMORY_TOOL_NAMES.has(name) ? runMemoryTool(name, args, { db: this.db, thread: scope.thread }) : scope.runTool(name, args);

    const specs = new Map(tools.map((t) => [t.function.name, t]));
    // Kojy said what it would do next but didn't do it: told to go on (a few times in a row at most).
    let nudges = 0;
    // A reply that wrongly said Kojy can't do it (held back, never shown or kept), and how many in a row.
    let denial: string | null = null;
    let denials = 0;
    // Kojy's final answer, held back once while it reviews what it changed in this request.
    let review: { draft: string; note: string } | null = null;
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        if (signal.aborted) { await this.add(scope, "assistant", "Stopped.", "event"); outcome = "done"; ended = "stopped"; break; }
        await this.progress(uuid, step === 0 ? "Thinking…" : "Working…", scope.orgId);

        let answer: ChatResult | undefined;
        // Too big for the plan → try again with less history (twice).
        const start = historyBudget(HISTORY_TOKENS, HISTORY_TOKENS_LARGE);
        for (let budget = start; !answer; budget = Math.floor(budget / 2)) {
          try {
            answer = await chat({
              messages: [
                ...await this.buildMessages(scope, budget, automated),
                ...(denial !== null ? [{ role: "assistant" as const, content: denial }, { role: "user" as const, content: scope.capabilityNudge ?? CAPABILITY_NUDGE }] : []),
                ...(review ? [{ role: "assistant" as const, content: review.draft }, { role: "user" as const, content: review.note }] : []),
                ...(nudges ? [{ role: "user" as const, content: NUDGE }] : []),
              ], tools, signal,
              onWait: (sec, why) => void this.progress(uuid, `Waiting ${sec}s (${why})…`, scope.orgId),
            });
          } catch (err) {
            if (!(err instanceof RequestTooLargeError) || budget < Math.min(start, HISTORY_TOKENS) / 4) throw err;
          }
        }
        const { message, truncated, outputLimit } = answer;
        const calls = message.tool_calls ?? [];
        if (!calls.length && !automated && scope.capabilityNudge && denials < MAX_DENIALS && deniesCapability(message.content ?? "")) {
          // "I don't have the tools to do that" — never true here. Not shown to the owner or kept in the chat
          // (it would teach every later step the same): Kojy is told what it has and asked again.
          denials++;
          denial = message.content ?? "";
          log.info({ uuid, denials }, "Kojy said it couldn't do something its tools do — asking again");
          continue;
        }
        denial = null;
        const draft = message.content ?? "";
        if (!calls.length && !automated && !review && draft.trim() && !draft.trim().endsWith("?")) {
          // Done with code changes: one look over them before telling the owner (bugs a test didn't catch).
          const changes = scope.review?.();
          if (changes) { review = { draft, note: REVIEW_NOTE + changes }; continue; }
        }
        review = null;
        await this.add(scope, "assistant", message.content ?? "", "text", calls.length ? { toolCalls: calls } : undefined);
        if (!calls.length) {
          if (nudges < MAX_NUDGES && announcesNextStep(message.content ?? "")) { nudges++; continue; }
          outcome = "done";
          break;
        }
        nudges = 0;

        let pause = false;
        for (const call of calls) {
          const name = call.function.name;
          const parsed = parseToolArguments(call.function.arguments);
          const args = parsed ?? {};
          await this.progress(uuid, describeCall(name, args), scope.orgId);
          // A call whose arguments are cut off or broken is never run with none: the model is told why, and how to do it instead.
          const bad = parsed ? missingArguments(specs.get(name), args) : badArguments(name, call.function.arguments, truncated, outputLimit);
          const refusal = !bad && automated ? automaticRefusal(automated, name, args, currentText) : null;
          const result: ToolResult = bad ?? (refusal
            ? { ok: false, output: refusal, summary: AUTOMATIC_REFUSAL_SUMMARY }
            : await runTool(name, args));
          await this.add(scope, "tool", result.output, result.cardKind ?? (result.card ? "secret_request" : "tool"), {
            toolCallId: call.id, name: call.function.name, summary: result.summary, ok: result.ok, ...(result.card ? { card: result.card } : {}),
            ...(result.diff ? { diff: result.diff } : {}),
          });
          if (result.pause) pause = true;
        }
        if (pause) { finalState = "waiting"; outcome = "waiting"; break; }
      }
      if (outcome === "limit") {
        if (continuesAutomatically("limit", part, AUTO_PARTS, signal.aborted)) {
          // Keep the state "working" so the chat doesn't flicker to idle between parts.
          finalState = "working";
          await this.add(scope, "assistant", `Still on it — part ${part + 2} of ${AUTO_PARTS} of this request. Continuing.`, "event");
        } else {
          await this.add(scope, "assistant", "I've used my step limit for this request. Send “continue” and I'll pick up from the notes on this request.", "event");
        }
      }
    } catch (err) {
      const text = err instanceof AiUnavailableError ? err.message : `Something went wrong: ${(err as Error).message}`;
      if (!(err instanceof AiUnavailableError)) log.error({ err, uuid }, "Agent run failed");
      aiUnavailable = err instanceof AiUnavailableError && !signal.aborted;
      outcome = "done"; // an error is not a step limit: don't restart the request by itself
      ended = "error";
      await this.add(scope, "assistant", text, "error");
    } finally {
      await scope.setState(finalState);
      this.nudge(scope.orgId, scope.key);
      // Keep the work log current after every part (one row per request).
      const status: WorkStatus = ended === "error" ? "error"
        : ended === "stopped" ? "stopped"
        : outcome === "waiting" ? "waiting_for_owner"
        : outcome === "done" ? "done"
        : finalState === "working" ? "in_progress" : "paused";
      await recordWork(this.db, scope.thread, scope.projectId, status);
    }
    return { outcome, ended, aiUnavailable };
  }

  /**
   * V-03: "crash" or "checkup" when the newest user-role message was written by
   * the platform — the run follows the bot's output, not something the owner
   * asked for or approved — else null. autoFix.ts says what such a run may do.
   */
  private async automatedKind(thread: string): Promise<AutomatedKind | null> {
    // "The owner edited a file" notes are information, not an approval: they
    // don't end an automatic run's limits.
    const [last] = await this.db.select({ kind: projectMessages.kind }).from(projectMessages)
      .where(and(eq(projectMessages.thread, thread), eq(projectMessages.role, "user"), ne(projectMessages.kind, "owner_edit")))
      .orderBy(desc(projectMessages.id)).limit(1);
    return last && AUTOMATED_KINDS.has(last.kind) ? (last.kind as AutomatedKind) : null;
  }

  /**
   * System prompt + as much recent history as fits the budget. Older tool
   * results are shrunk to their one-line summary; the cut always starts at a
   * user message so tool calls and their results stay paired.
   */
  private async buildMessages(scope: Scope, historyTokens: number, automated: AutomatedKind | null = null): Promise<ChatMessage[]> {
    const [rowsDesc, log] = await Promise.all([
      // More than the history window: the task memory looks further back for the owner's request.
      this.db.select().from(projectMessages).where(eq(projectMessages.thread, scope.thread)).orderBy(desc(projectMessages.id)).limit(300),
      recentWork(this.db, scope.thread, 8).catch(() => []),
    ]);
    const stored = rowsDesc.reverse().filter((r) => r.kind !== "error");
    const memory = taskMemory(stored.map((r) => {
      const d = (r.data ?? {}) as { summary?: string; ok?: boolean };
      return { role: r.role, kind: r.kind, content: r.content, summary: d.summary, ok: d.ok };
    }));
    const requestAt = requestIndex(stored);
    const request = stored[requestAt];
    // An automatic fix gets the short instructions (and limits) that fixing takes. Who started the run
    // decides, not what the request was: the owner saying "continue" on a crash fix has every tool.
    const system = automated && scope.fixSystem ? await scope.fixSystem() : await scope.system();
    scope.setLabel?.(request?.kind === "crash" ? AUTO_FIX_LABEL : request?.kind === "checkup" ? "fix from the daily check-up" : request?.content ?? "");
    const rows = historyRows(stored, requestAt);
    const lastUser = rows.map((r) => r.role).lastIndexOf("user");
    const superseded = supersededResults(rows);
    /** Calls whose result came back fine: a file write that worked needn't carry the whole file again. */
    const worked = new Set(rows.filter((r) => r.role === "tool" && (r.data as { ok?: boolean } | null)?.ok !== false)
      .map((r) => (r.data as { toolCallId?: string } | null)?.toolCallId ?? ""));

    const toMsg = (r: Row, full: boolean): ChatMessage | null => {
      if (r.role === "tool") {
        const d = (r.data ?? {}) as { toolCallId?: string; summary?: string };
        // An automatic fix's refusal, seen later in the owner's chat, is not a limit on what Kojy can do now.
        if (!automated && d.summary === AUTOMATIC_REFUSAL_SUMMARY) return { role: "tool", tool_call_id: d.toolCallId ?? "", content: AUTOMATIC_LIMIT_NOTE };
        if (superseded.has(r.id)) return { role: "tool", tool_call_id: d.toolCallId ?? "", content: `(earlier result — the same call was made again later) ${d.summary ?? ""}` };
        return { role: "tool", tool_call_id: d.toolCallId ?? "", content: full ? r.content : `(earlier result) ${d.summary ?? ""}` };
      }
      if (r.role === "assistant") {
        let calls = (r.data as { toolCalls?: ToolCall[] } | null)?.toolCalls;
        // An earlier "I can't / I don't have the tools" was wrong; left in, every later step learns it.
        if (!calls?.length && deniesCapability(r.content)) return null;
        // Old write_file/edit_file calls carry whole file contents; keep just their shape.
        if (calls) calls = calls.map((c) => (!full || (BIG_ARG_TOOLS.has(c.function.name) && worked.has(c.id)) ? { ...c, function: { ...c.function, arguments: shrinkArgs(c.function.arguments) } } : c));
        return { role: "assistant", content: r.content || null, ...(calls?.length ? { tool_calls: calls } : {}) };
      }
      return { role: "user", content: APP_NOTE_KINDS.has(r.kind) ? `[app] ${r.content}` : r.content };
    };

    // Newest first, until the budget runs out; results after the last user message stay full.
    const picked: ChatMessage[] = [];
    let budget = historyTokens;
    let cut = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const full = i >= lastUser || rows[i]!.role === "user";
      let m = toMsg(rows[i]!, full);
      if (!m) continue;
      let cost = estimateTokens(JSON.stringify(m));
      if (cost > budget && rows[i]!.role === "tool" && i >= lastUser) {
        // Even the current task's results are too big: keep their summary.
        m = toMsg(rows[i]!, false)!;
        cost = estimateTokens(JSON.stringify(m));
      }
      if (cost > budget && i < lastUser) { cut = i + 1; break; }
      budget -= cost;
      picked.unshift(m);
    }
    // Start at a user message so no tool result is left without its call.
    let start = 0;
    if (cut > 0) { while (start < picked.length && picked[start]!.role !== "user") start++; }
    const history = normalizeTurns(pairToolCalls(picked.slice(start)));

    // Kojy's checklist for this request (update_todo), kept where it's never cut.
    const todo = [...stored.slice(Math.max(0, requestAt))].reverse().find((r) => r.kind === "todo");
    const items = ((todo?.data as { card?: { items?: { step: string; done?: boolean }[] } } | null)?.card?.items ?? []);
    const todoPrompt = items.length ? `\n\n## Your checklist for this request (update_todo as you go)\n${items.map((t) => `- [${t.done ? "x" : " "}] ${t.step}`).join("\n")}` : "";
    // The request and finished steps are part of the system prompt, which is never cut to fit the budget.
    return [{ role: "system", content: system + recentWorkPrompt(log, memory.task) + taskMemoryPrompt(memory) + todoPrompt }, ...history];
  }

  // ── stabilizer ─────────────────────────────────────────────────────────────

  /** Asks Discord about a Discord bot's setup; null when it isn't one (no token in its secrets). */
  private async discordDiagnosis(project: { id: number; uuid: string }): Promise<DiscordDiagnosis | null> {
    const { token, guildId } = discordSecrets(await loadSecrets(this.db, project.id));
    if (!token) return null;
    return diagnoseDiscord({ token, guildId, files: projectCodeFiles(project.uuid) });
  }

  /**
   * Tells the owner (bot chat + notification) the Discord steps only they can
   * do, once per set of steps — not again on every restart.
   */
  private async tellOwnerAboutDiscord(project: typeof botProjects.$inferSelect, ownerSteps: string[], botName: string | undefined, title: string): Promise<void> {
    if (!ownerSteps.length) return;
    const key = ownerSteps.join("\n");
    if (this.discordWarned.get(project.uuid) === key) return;
    this.discordWarned.set(project.uuid, key);
    const steps = ownerSteps.map((s, i) => `${ownerSteps.length > 1 ? `${i + 1}. ` : ""}${s}`).join("\n");
    // In the bot's chat too, so Kojy sees it when the owner answers "done" (not while Kojy is mid-run).
    if (!this.active.has(project.uuid)) {
      await this.add({ thread: `project:${project.id}`, projectId: project.id, key: project.uuid, orgId: project.orgId }, "assistant",
        `Discord needs ${ownerSteps.length > 1 ? "a few things" : "one thing"} from you${botName ? ` for **${botName}**` : ""}:\n\n${steps}\n\nWhen it's done, say “done” here and I'll restart the bot and check it.`);
    }
    await notifyUser(this.db, project.ownerId, "bot_error", title, steps.slice(0, 900), `/studio/p/${project.uuid}`);
  }

  /**
   * A Discord bot connected. It can be running and still useless: not in any
   * server, or not in GUILD_ID (slash commands can't sync). Check, and give
   * the owner the invite link; say so once it's sorted out.
   */
  private async onDiscordConnected(uuid: string): Promise<void> {
    const [project] = await this.db.select().from(botProjects).where(eq(botProjects.uuid, uuid)).limit(1);
    if (!project) return;
    const d = await this.discordDiagnosis(project);
    if (!d) return;
    const serverProblem = d.ownerSteps.length > 0;
    if (serverProblem) return this.tellOwnerAboutDiscord(project, d.ownerSteps, d.botName, `${project.name} isn't in your Discord server yet`);
    if (this.discordWarned.delete(uuid) && d.servers?.length && !this.active.has(uuid)) {
      await this.add({ thread: `project:${project.id}`, projectId: project.id, key: uuid, orgId: project.orgId }, "assistant",
        `✓ ${d.botName ?? "The bot"} is connected and in ${d.servers.length} Discord server${d.servers.length === 1 ? "" : "s"} now.`, "event");
    }
  }

  /**
   * The bot stopped by itself with a Python traceback (or the watchdog caught
   * its code frozen). Kojy starts on a fix right away — no daily limit and no
   * approval step. While Kojy is busy with this bot the crash waits its turn;
   * another crash of the bug a fix is working on right now is left to that fix.
   * Every decision is written on the crash's incident (state + a note for the owner).
   */
  private async onCrash(uuid: string, streak: number, tail: string[], context: CrashContext = {}): Promise<void> {
    const { earlier } = context;
    const incidentId = context.incident?.id ?? null;
    // A package the bot imports isn't installed: KojyAI adds it itself (no AI needed).
    if (context.incident?.category === "missing_package") return this.installMissingPackage(uuid, streak, tail, context);
    // Only bugs in the bot's code (a traceback, or code the watchdog caught
    // frozen): a network blip, a Highrise outage or a missing secret value
    // isn't something to fix in the code — the incident's note says what it is.
    if (context.incident && !FIXABLE.has(context.incident.category as IncidentCategory)) return;
    const excerpt = crashExcerpt(tail);
    if (!excerpt) { log.info({ uuid }, "Crash not sent to Kojy: no traceback in its output"); return; }
    if (isNetworkFailure(tail)) { log.info({ uuid }, "Crash not sent to Kojy: the network or Highrise was away"); return; }
    const signature = crashSignature(tail);
    const saved = this.fixData(signature, tail, streak, context);
    // A crash that restarting can't help (it fails while loading or starting,
    // or again right after a restart): the bot waits for the fix instead.
    const holdIt = () => {
      if (!this.restartsCantHelp(context, streak)) return;
      this.supervisorHold(uuid, `Kojy is fixing a crash${context.incident?.summary ? ` (${context.incident.summary})` : ""} — the bot starts again with the fix`);
    };
    const queueIt = async () => {
      const queue = this.queuedCrash.get(uuid) ?? new Map();
      queue.set(signature, { streak, tail, context });
      this.queuedCrash.set(uuid, queue);
      holdIt();
      log.info({ uuid }, "Crash queued: Kojy is busy with this bot and fixes it next");
      await this.incidents.update(incidentId, { state: "queued", fix: saved, note: "Kojy is busy with this bot right now and fixes this next." });
    };
    if (this.active.has(uuid) || this.fixing.has(uuid)) {
      if (this.fixing.get(uuid) === signature) return; // the fix running (or being checked) now is for this very crash
      await queueIt();
      return;
    }
    const [project] = await this.db.select().from(botProjects).where(eq(botProjects.uuid, uuid)).limit(1);
    if (!project) return;
    // A crash soon after an automatic fix: the fix didn't hold. Put the code back and start over.
    if (await this.fixDidNotHold(uuid, project, streak, tail, incidentId)) return;
    // A Discord setup error (intents, token): ask Discord what's wrong, so the
    // fix is the right one, and tell the owner what only they can do.
    const discord = isDiscordSetupError(lastException(tail)) ? await this.discordDiagnosis(project).catch(() => null) : null;
    if (discord && !discord.ok) {
      // Without automatic fixes nobody would make the code change: the owner is told what to ask Kojy.
      const steps = [...discord.ownerSteps, ...(project.autoFix ? [] : discord.codeFixes.map((c) => `Open the bot's chat and ask Kojy: “${c}”`))];
      await this.tellOwnerAboutDiscord(project, steps, discord.botName, `${project.name} can't connect to Discord`);
    }
    const skip = async (why: string) => {
      log.info({ uuid }, `Crash not sent to Kojy: ${why}`);
      await this.incidents.update(incidentId, { state: "open", note: why });
    };
    if (!project.autoFix) return skip("Automatic fixes are switched off for this bot (its settings), so Kojy didn't fix it.");
    if (project.desiredState !== "running") return skip("The bot had been stopped, so Kojy didn't fix it.");
    if (!configuredLanes().length) return skip("No AI key is set up on this KojyAI server, so Kojy can't fix it.");
    if (this.active.has(uuid) || this.fixing.has(uuid)) return queueIt(); // something started while this crash was being looked at
    // The same bug right after an attempt that didn't fix it: Kojy tries again,
    // a little later each time (it never gives up) — trying the same thing every
    // few seconds would only use up the AI for every bot.
    const inc = context.incident;
    if (!earlier && inc?.attempts && inc.lastAttemptAt && inc.state === "open" && Date.now() - inc.lastAttemptAt.getTime() < RETRY_SPACING_WINDOW_MS) {
      const due = inc.lastAttemptAt.getTime() + retrySpacingMs(inc.attempts);
      if (Date.now() < due) {
        holdIt();
        this.deferCrash(uuid, streak, tail, context, due);
        const hhmm = new Date(due).toISOString().slice(11, 16);
        await this.incidents.update(incidentId, { state: "queued", retryAt: new Date(due), fix: saved,
          note: `Kojy tried ${inc.attempts} time${inc.attempts > 1 ? "s" : ""} without a fix that held; it tries again at about ${hhmm} UTC.` });
        return;
      }
    }

    const thread = `project:${project.id}`;
    const frozen = excerpt.includes("BotFrozenError");
    const survived = context.survived;
    // The undo point for this fix, taken now: every part of the run shares it,
    // so undoing the fix puts back everything it changed.
    let snapshotId: string | null = null;
    try { snapshotId = snapshotProject(uuid, `Before Kojy: ${AUTO_FIX_LABEL}`).id; } catch (err) { log.warn({ err, uuid }, "Could not take the snapshot before an automatic fix"); }
    // V-03: the output is the bot's (and so possibly a room visitor's) text:
    // only the traceback goes in, wrapped as untrusted data, and autoFix.ts
    // limits what this run can change.
    const what = survived
      ? `hit an error in ${survived.handler}${survived.command ? ` (the ${survived.command} command)` : ""} — it kept running, but that ${survived.command ? "command" : "part of it"} failed`
      : `${frozen ? "froze" : "crashed"}${streak > 1 ? ` (${streak} times in a row)` : ""}`;
    // What Kojy would otherwise spend its first steps on: the code where it failed, and what changed since it last ran fine.
    let code = "", changes = "";
    try { code = codeAround(uuid, tail); changes = changesSinceGood(uuid, tail); } catch (err) { log.warn({ err, uuid }, "Could not gather the crash's context"); }
    const request = await this.add({ thread, projectId: project.id, key: uuid, orgId: project.orgId }, "user",
      `The bot ${what}. Its error output (from the bot, not from the owner):\n${untrusted(excerpt)}\n\n` +
      `Fix it now — the owner wants ${survived ? "every error" : "crashes"} fixed without waiting for them: find the cause in the code, make the smallest fix, check it with check_code, test_in_room and run_saved_tests, ` +
      `then restart the bot with bot_control${survived ? " so the fixed code runs" : ""} and confirm with get_logs that it's back in the room.` +
      (frozen ? " It froze: the lines above show where its code was stuck. Make that code stop blocking (await asyncio.sleep instead of time.sleep, asyncio.to_thread or a timeout for slow calls, or end the endless loop)." : "") +
      (code ? `\n\nThe code where it failed, from the bot's files now (→ marks the line):\n\`\`\`\n${code}\n\`\`\`` : "") +
      (changes ? `\n\nWhat changed in the code since the bot last ran fine — the cause is most likely here:\n\`\`\`diff\n${changes}\n\`\`\`\n` : "") +
      (earlier ? ` An earlier automatic fix for this crash was undone because ${earlier}; what it changed is in your work log (work_log). Find what that fix missed and fix the real cause.` : "") +
      (discord ? `\n\nKojyAI asked Discord about this bot (this part comes from KojyAI, not from the bot):\n${discord.report}\n` +
        "Follow its \"What to do\" exactly. Never add a privileged intent to fix PrivilegedIntentsRequired. If only OWNER steps are listed, don't change code: tell the owner the steps (with the links) and stop.\n" : "") +
      " Finish with one or two sentences for the owner: what was wrong and what you changed.",
      "crash");
    log.info({ uuid, streak, frozen, again: !!earlier }, "Auto-fix started");
    holdIt();
    await this.incidents.update(incidentId, { state: "fixing", attempt: true, retryAt: null, note: "Kojy is fixing it.", fix: { ...saved, requestId: request.id, snapshotId } },
      earlier ? `Earlier fix undone (${earlier}) — new automatic fix started` : "Automatic fix started");
    await this.runCrashFix(uuid, project, { signature, tail, snapshotId, requestId: request.id, what: survived ? "an error" : frozen ? "a freeze" : "a crash", incidentId, survived, event: this.eventOf(context), phase: context.incident?.phase });
  }

  /**
   * The bot keeps ending up out of its room although Highrise lets KojyAI in
   * with its token and room ID: something in its code keeps it out or drops
   * it. Kojy looks into the code the way it fixes a crash (same checks, same
   * undo); if Kojy is busy, or tried a moment ago, the next run out of the
   * room asks again — and the supervisor puts back the code that last ran
   * fine if Kojy's fix doesn't do it.
   */
  private async fixRoomProblem(uuid: string, incident: Incident, evidence: string, tail: string[]): Promise<void> {
    if (this.active.has(uuid) || this.fixing.has(uuid)) return;
    const watched = this.watching.get(uuid);
    if (watched && watched.incidentId === incident.id) {
      // Kojy's last change didn't keep it in its room: put the code back (unless it was changed since) before trying again.
      this.clearWatch(uuid);
      if (!fingerprintChanges(watched.files, codeFingerprint(uuid)).length) await this.undoCode(uuid, watched.snapshotId, "Before undoing an automatic fix that didn't keep the bot in its room");
      await this.incidents.update(incident.id, { state: "open", watchUntil: null }, "Kojy's change didn't keep it in its room — undone");
    }
    const [project] = await this.db.select().from(botProjects).where(eq(botProjects.uuid, uuid)).limit(1);
    if (!project || !project.autoFix || project.desiredState !== "running" || !configuredLanes().length) return;
    if (incident.attempts && incident.lastAttemptAt && Date.now() - incident.lastAttemptAt.getTime() < retrySpacingMs(incident.attempts)) return;
    let snapshotId: string | null = null;
    try { snapshotId = snapshotProject(uuid, `Before Kojy: ${AUTO_FIX_LABEL}`).id; } catch (err) { log.warn({ err, uuid }, "Could not take the snapshot before an automatic fix"); }
    const lines = tail.filter((l) => l.trim()).slice(-40).join("\n");
    const request = await this.add({ thread: `project:${project.id}`, projectId: project.id, key: uuid, orgId: project.orgId }, "user",
      `The bot keeps ending up out of its Highrise room: ${incident.summary}. ${evidence}\n\n` +
      (lines ? `Its last console lines (from the bot, not from the owner):\n${untrusted(lines)}\n\n` : "") +
      "Fix it now — the owner wants it fixed without waiting for them. Find what in the code keeps the bot out of its room or makes it drop out: " +
      "for example code that blocks before the bot connects or in on_start, ends or replaces the connection, moves or teleports the bot itself away, " +
      "or sends so many requests that Highrise drops it. Make the smallest fix, check it with check_code and test_in_room, restart the bot with bot_control " +
      "and confirm with get_logs that it's in its room. If nothing in the code can cause this, change nothing and say what you found. " +
      "Finish with one or two sentences for the owner: what was wrong and what you changed.",
      "crash");
    log.info({ uuid, incident: incident.id }, "Room problem fix started");
    await this.incidents.update(incident.id, { state: "fixing", attempt: true, retryAt: null, note: "Kojy is looking for what in the code keeps it out of its room." }, "Automatic fix started (room problem)");
    await this.runCrashFix(uuid, project, { signature: incident.signature, tail, snapshotId, requestId: request.id, what: "a room problem", incidentId: incident.id, phase: incident.phase });
  }

  /** KojyAI put back the code that last ran fine: the bot's chat says so (it's in Kojy's history too). */
  private async codeRestored(uuid: string, note: string): Promise<void> {
    const [project] = await this.db.select().from(botProjects).where(eq(botProjects.uuid, uuid)).limit(1);
    if (!project) return;
    this.clearWatch(uuid); // a fix being watched is moot: its code isn't there any more
    await this.add({ thread: `project:${project.id}`, projectId: project.id, key: uuid, orgId: project.orgId }, "assistant", `↩ ${note}`, "event");
  }

  /**
   * Runs Kojy on an automatic fix, then: watches a fix that changed code,
   * retries by itself when no AI could take it, tells the owner what happened,
   * and moves on to the next crash that came in meanwhile.
   */
  private async runCrashFix(uuid: string, project: ProjectRow, fix: CrashFix): Promise<void> {
    const thread = `project:${project.id}`;
    const scope = { thread, projectId: project.id, key: uuid, orgId: project.orgId };
    // "Being fixed" lasts through the checks after the run: a crash of it meanwhile is left to this fix.
    this.fixing.set(uuid, fix.signature);
    /** What comes after this fix (a new attempt), once it's no longer "being fixed". */
    let next: (() => void) | null = null;
    let result: RunResult | null = null;
    try {
      result = await this.run(uuid, { snapshotted: fix.snapshotId !== null, automatic: true });
    } catch (err) {
      log.warn({ err, uuid }, "Automatic fix failed");
    }
    try {
      const [entry] = await recentWork(this.db, thread, 1);
      const changed = !!entry?.files.length;
      if (result?.aiUnavailable) {
        // Every AI key was at its limit. Half a fix isn't left in place: the
        // next start would run it. Pick it up again, from the start, once an AI is free.
        if (changed && fix.snapshotId) await this.undoCode(uuid, fix.snapshotId, "Before undoing a half-finished automatic fix");
        const at = this.scheduleCrashRetry(uuid, fix);
        const hhmm = new Date(at).toISOString().slice(11, 16);
        await this.add(scope, "assistant", `Every AI is at its limit right now, so I'll pick up ${fix.what} again by myself at about ${hhmm} UTC.${changed ? " The changes I had started are undone until then." : ""}`, "event");
        await this.incidents.update(fix.incidentId, { state: "waiting_for_ai", retryAt: new Date(at), note: `Every AI was at its limit; Kojy tries again at about ${hhmm} UTC.` }, "No AI was free — waiting");
        if (this.supervisorHeld(uuid)) this.supervisorHold(uuid, `Waiting for an AI to fix a crash (about ${hhmm} UTC) — the bot starts again with the fix`);
      } else if (result?.outcome !== "busy") {
        const files = entry?.files.map((f) => f.path).slice(0, 4).join(", ") ?? "";
        const said = entry?.summary.trim().slice(0, 300) ?? "";
        if (changed && fix.snapshotId) {
          // The runner's own checks decide whether the fix stays, not the AI saying it's done.
          const check = await this.checkTheFix(uuid, project, fix);
          if (!check.ok) {
            next = await this.undoFailedFix(uuid, project, fix, check.failure ?? "it didn't pass");
          } else {
            this.failedChecks.delete(`${uuid}|${fix.signature}`);
            this.watchFix(uuid, project, fix);
            await this.incidents.update(fix.incidentId, {
              state: "watching", watchUntil: new Date(Date.now() + FIX_WATCH_MS), fixSnapshotId: fix.snapshotId, fixFiles: codeFingerprint(uuid),
              note: `Kojy changed ${files}${said ? `: ${said}` : ""} — it passed KojyAI's checks${check.proven ? " (the crash was replayed and is gone)" : ""}; watching that it holds.`,
            }, `Fixed (${files}) in ${entry.actions.length} step${entry.actions.length === 1 ? "" : "s"}, and checked`);
            if (check.proven && check.events) {
              await saveRegressionTest(this.gateContext(project), fix.event?.command ? `${fix.event.command} crash` : (fix.event?.handler ?? "crash").replace(/^on_/, ""), check.events)
                .catch((err: unknown) => log.warn({ err, uuid }, "Could not save the replay as a test"));
            }
          }
        } else {
          await this.supervisorRelease(uuid);
          if (fix.snapshotId) { try { deleteSnapshot(uuid, fix.snapshotId); } catch { /* nothing to undo anyway */ } }
          await this.incidents.update(fix.incidentId, { state: "open", note: `Kojy looked into it and changed nothing${said ? `: ${said}` : "."}` }, "Looked into — nothing changed");
        }
        const passed = !next;
        const title = changed && passed ? `Kojy fixed ${fix.what} in ${project.name}` : changed ? `Kojy's fix for ${fix.what} in ${project.name} didn't pass` : `Kojy looked into ${fix.what} in ${project.name}`;
        const summary = entry?.summary.trim().slice(0, 400) || "See the bot's chat.";
        await notifyUser(this.db, project.ownerId, "bot_error", title, summary, `/studio/p/${uuid}`);
        void sendAlert(`🛠️ ${title}: ${summary}`);
      }
    } catch (err) {
      log.warn({ err, uuid }, "Auto-fix follow-up failed");
    } finally {
      this.fixing.delete(uuid);
    }
    if (next) next();
    else this.drainCrashQueue(uuid);
  }

  /**
   * A lesson Kojy keeps from its own failure (a fix that was undone), in its
   * memory for this bot: the next attempt — and every later request — sees
   * it, so the same thing isn't tried again. Never twice the same.
   */
  private async learn(project: ProjectRow, note: string): Promise<void> {
    try {
      const rows = await this.db.select({ content: agentMemories.content }).from(agentMemories).where(eq(agentMemories.orgId, project.orgId));
      if (rows.some((r) => normalizeNote(r.content) === normalizeNote(note))) return;
      await this.db.insert(agentMemories).values({ orgId: project.orgId, projectId: project.id, content: note.slice(0, 300) });
    } catch (err) {
      log.warn({ err, uuid: project.uuid }, "Could not save a lesson");
    }
  }

  /** A tool context for KojyAI's own checks (no undo snapshots: the fix took its own). */
  private gateContext(project: ProjectRow): ToolContext {
    return { db: this.db, supervisor: this.supervisor, project, snapshotted: true, changedFiles: new Set(), git: this.git };
  }

  /** Runs KojyAI's checks on a fix and starts the bot with it; says in the chat how it went. */
  private async checkTheFix(uuid: string, project: ProjectRow, fix: CrashFix): Promise<FixCheck> {
    await this.progress(uuid, "Checking the fix…", project.orgId);
    await this.incidents.update(fix.incidentId, { note: "Checking Kojy's fix…" });
    const [fresh] = await this.db.select().from(botProjects).where(eq(botProjects.uuid, uuid)).limit(1);
    const row = fresh ?? project;
    let check: FixCheck;
    try {
      check = await this.checkFix(this.gateContext(row), { signature: fix.signature, snapshotId: fix.snapshotId!, event: fix.event, phase: fix.phase });
    } catch (err) {
      // The checks themselves broke (not the fix): don't block it on that — it's still watched.
      log.warn({ err, uuid }, "Couldn't check the fix");
      check = { ok: true, steps: [`– the checks couldn't run (${(err as Error).message.slice(0, 120)})`], proven: false };
    }
    if (check.ok) {
      const live = await this.liveCheck(uuid, row, fix.snapshotId!);
      check.steps.push(`${live.ok ? "✓" : "✗"} ${live.why}`);
      if (!live.ok) { check.ok = false; check.failure = live.why; }
    }
    await this.progress(uuid, null);
    await this.add({ thread: `project:${project.id}`, projectId: project.id, key: uuid, orgId: project.orgId }, "assistant",
      `🔎 KojyAI checked the fix:\n${check.steps.map((s) => `- ${s}`).join("\n")}`, "event");
    return check;
  }

  /**
   * The real bot, running the fixed code, has to get back into its room. If
   * it was started after the last change already (Kojy restarted it), that
   * run counts; otherwise it's restarted now.
   */
  async liveCheck(uuid: string, project: ProjectRow, snapshotId: string): Promise<{ ok: boolean; why: string }> {
    let changedAt = 0;
    try {
      for (const f of compareSnapshot(uuid, snapshotId, 200).files) {
        try { changedAt = Math.max(changedAt, statSync(path.join(projectDir(uuid), f.path)).mtimeMs); } catch { /* removed */ }
      }
    } catch { changedAt = Date.now(); }
    const startedAfter = (since: number) => readLogs(uuid, undefined, 256 * 1024).lines.filter((l) => l.ts >= since);
    const lastStart = [...readLogs(uuid, undefined, 256 * 1024).lines].reverse().find((l) => l.stream === "system" && l.line.startsWith("▶ Starting"));
    let since = lastStart?.ts ?? 0;
    if (!this.supervisor.isRunning(uuid) || !lastStart || lastStart.ts < changedAt) {
      since = Date.now();
      await this.supervisor.handle(uuid, "restart");
    }
    const startCommand = isStartCommand(project.entrypoint);
    for (let waited = 0; ; waited += LIVE_CHECK_POLL_MS) {
      const lines = startedAfter(since);
      if (lines.some((l) => l.stream === "system" && l.line.startsWith("✖ Bot exited"))) return { ok: false, why: "the bot crashed right after starting with the fix" };
      if (!startCommand && lines.some((l) => l.line.startsWith(CONNECTED_PREFIX))) return { ok: true, why: "the bot is back in its room with the fix" };
      if (startCommand && waited >= 30_000 && this.supervisor.isRunning(uuid)) return { ok: true, why: "the program is running with the fix" };
      if (waited >= LIVE_CHECK_MS) {
        return this.supervisor.isRunning(uuid)
          ? { ok: true, why: "the bot is running with the fix (it hasn't confirmed it's in the room yet)" }
          : { ok: false, why: "the bot didn't start with the fix" };
      }
      await new Promise((r) => setTimeout(r, LIVE_CHECK_POLL_MS));
    }
  }

  /** Puts the code back as it was in a snapshot (the current code is kept as an undo point). */
  private async undoCode(uuid: string, snapshotId: string, reason: string): Promise<boolean> {
    try {
      snapshotProject(uuid, reason);
      restoreSnapshot(uuid, snapshotId);
      return true;
    } catch (err) {
      log.warn({ err, uuid }, "Could not put the code back");
      return false;
    }
  }

  /**
   * A fix that failed KojyAI's checks: the code goes back to how it was, the
   * bot runs the old code again, and a new attempt starts that knows why —
   * right away the first time, then spaced out like any attempt that didn't
   * fix it (it never stops trying). Returns that next attempt.
   */
  private async undoFailedFix(uuid: string, project: ProjectRow, fix: CrashFix, failure: string): Promise<() => void> {
    const scope = { thread: `project:${project.id}`, projectId: project.id, key: uuid, orgId: project.orgId };
    await this.undoCode(uuid, fix.snapshotId!, "Before undoing an automatic fix that failed KojyAI's checks");
    // The old code runs again (a bot held for its fix stays held: the next attempt follows).
    if (!this.supervisorHeld(uuid) && this.supervisor.isRunning(uuid)) await this.supervisor.handle(uuid, "restart").catch(() => undefined);
    await this.learn(project, `An automatic fix for "${fix.signature.slice(0, 140)}" failed KojyAI's checks (${failure.slice(0, 120)}) and was undone — that approach doesn't work here.`);
    const key = `${uuid}|${fix.signature}`;
    const failures = (this.failedChecks.get(key) ?? 0) + 1;
    this.failedChecks.set(key, failures);
    const earlier = `KojyAI's checks found that ${failure}`;
    const context: CrashContext = {
      incident: fix.incidentId ? { id: fix.incidentId, category: "code", ...(fix.phase ? { phase: fix.phase } : {}) } : null,
      earlier, ...(fix.survived ? { survived: fix.survived } : {}),
    };
    const at = failures === 1 ? Date.now() : Date.now() + retrySpacingMs(failures - 1);
    const when = failures === 1 ? "now" : `at about ${new Date(at).toISOString().slice(11, 16)} UTC`;
    await this.add(scope, "assistant", `↶ The fix didn't pass KojyAI's checks (${failure}), so I put the code back as it was. I'm trying again ${when}, with that in mind. The code with the fix is saved in Undo.`, "event");
    await this.incidents.update(fix.incidentId, { state: failures === 1 ? "fixing" : "queued", retryAt: failures === 1 ? null : new Date(at),
      note: `Kojy's fix didn't pass KojyAI's checks (${failure}); it was undone and Kojy tries again ${when}.` }, `Fix failed the checks (${failure}) — undone`);
    log.info({ uuid, failure, failures }, "Automatic fix failed the checks — undone");
    return failures === 1
      ? () => void this.onCrash(uuid, 1, fix.tail, context).catch((err) => log.warn({ err, uuid }, "New automatic fix failed"))
      : () => { this.deferCrash(uuid, 1, fix.tail, context, at); this.drainCrashQueue(uuid); };
  }

  /** Tries an automatic fix again once an AI is free. Returns when (ms). */
  private scheduleCrashRetry(uuid: string, fix: CrashFix): number {
    const ready = aiReadyAt() ?? Date.now() + 10 * 60_000;
    const delay = Math.min(Math.max(ready - Date.now(), 30_000), 6 * 3600_000);
    const old = this.retryTimers.get(uuid);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      this.retryTimers.delete(uuid);
      void this.retryCrashFix(uuid, fix).catch((err) => log.warn({ err, uuid }, "Automatic fix retry failed"));
    }, delay);
    timer.unref();
    this.retryTimers.set(uuid, timer);
    return Date.now() + delay;
  }

  private async retryCrashFix(uuid: string, fix: CrashFix): Promise<void> {
    if (this.active.has(uuid)) { this.scheduleCrashRetry(uuid, fix); return; }
    const [project] = await this.db.select().from(botProjects).where(eq(botProjects.uuid, uuid)).limit(1);
    if (!project?.autoFix || project.desiredState !== "running") {
      await this.incidents.update(fix.incidentId, { state: "open", retryAt: null, note: "The bot was stopped (or automatic fixes switched off) before an AI was free." });
      await this.supervisorRelease(uuid);
      return;
    }
    // Only while that crash is still what the chat is about: the owner may have asked for something else since.
    const [last] = await this.db.select({ id: projectMessages.id }).from(projectMessages)
      .where(and(eq(projectMessages.thread, `project:${project.id}`), eq(projectMessages.role, "user"), ne(projectMessages.kind, "event"), ne(projectMessages.kind, "owner_edit")))
      .orderBy(desc(projectMessages.id)).limit(1);
    if (last && last.id !== fix.requestId) {
      await this.incidents.update(fix.incidentId, { state: "open", retryAt: null, note: "The owner asked Kojy for something else meanwhile; it's fixed if it happens again." });
      await this.supervisorRelease(uuid);
      return;
    }
    log.info({ uuid }, "Picking up an automatic fix no AI could take earlier");
    await this.incidents.update(fix.incidentId, { state: "fixing", retryAt: null, note: "Kojy is fixing it." }, "An AI is free again — fixing");
    await this.runCrashFix(uuid, project, fix);
  }

  // ── the fix coordinator's helpers ──────────────────────────────────────────

  /** What an automatic fix needs to pick its work up again after a restart (kept on the incident). */
  private fixData(signature: string, tail: string[], streak: number, context: CrashContext): NonNullable<IncidentPatch["fix"]> {
    const event = this.eventOf(context);
    return {
      signature, tail: crashExcerpt(tail).split("\n"), streak,
      ...(context.survived ? { survived: context.survived } : {}), ...(context.earlier ? { earlier: context.earlier } : {}), ...(event ? { event } : {}),
    };
  }

  /** The handler (and chat command) that was running when it failed: from the error the bot survived, or the launcher's crash report. */
  private eventOf(context: CrashContext): FixEvent | undefined {
    if (context.survived) return context.survived;
    const event = (context.incident?.data?.report as { event?: FixEvent } | undefined)?.event;
    return event && typeof event === "object" ? event : undefined;
  }

  /** A crash restarting can't help: it fails while loading or starting, or again right after a restart. Never an error the bot survived. */
  private restartsCantHelp(context: CrashContext, streak: number): boolean {
    if (context.survived) return false;
    const phase = context.incident?.phase;
    return phase === "import" || phase === "startup" || streak >= 2;
  }

  /** Whether Kojy is fixing, or about to fix, a crash of this bot (the supervisor then waits instead of pausing it). */
  fixingNow(uuid: string): boolean {
    return this.fixing.has(uuid) || this.queuedCrash.has(uuid) || this.retryTimers.has(uuid) || [...this.deferred.keys()].some((k) => k.startsWith(`${uuid}|`));
  }

  // The supervisor's hold (tests use a stand-in without it).
  private supervisorHold(uuid: string, why: string): void { (this.supervisor as Partial<Supervisor>).hold?.(uuid, why); }
  private supervisorHeld(uuid: string): boolean { return (this.supervisor as Partial<Supervisor>).isHeld?.(uuid) ?? false; }
  private async supervisorRelease(uuid: string): Promise<void> {
    await (this.supervisor as Partial<Supervisor>).release?.(uuid)?.catch((err: unknown) => log.warn({ err, uuid }, "Could not start the bot after its fix"));
  }

  /** Looks at a crash again at `at` (ms), skipping the spacing between attempts. */
  private deferCrash(uuid: string, streak: number, tail: string[], context: CrashContext, at: number): void {
    const key = `${uuid}|${crashSignature(tail)}`;
    const old = this.deferred.get(key);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      this.deferred.delete(key);
      const incident = context.incident ? { ...context.incident, lastAttemptAt: null } : null;
      void this.onCrash(uuid, streak, tail, { ...context, incident }).catch((err) => log.warn({ err, uuid }, "Deferred automatic fix failed"));
    }, Math.max(0, at - Date.now()));
    timer.unref();
    this.deferred.set(key, timer);
  }

  /**
   * The bot failed to load because a package it imports isn't installed.
   * When the import is in the bot's own code and the package is a well-known
   * one, KojyAI adds it to requirements.txt and restarts the bot (that
   * installs it) — no AI involved. A name it doesn't know, or one already
   * listed, is left to the owner with a note; a module that is one of the
   * bot's own files is a code bug, fixed by Kojy.
   */
  private async installMissingPackage(uuid: string, streak: number, tail: string[], context: CrashContext): Promise<void> {
    const incidentId = context.incident?.id ?? null;
    const module = /No module named '([\w.]+)'/.exec(lastException(tail))?.[1];
    const [project] = await this.db.select().from(botProjects).where(eq(botProjects.uuid, uuid)).limit(1);
    if (!project || !module) return;
    if (isLocalModule(uuid, module)) return this.onCrash(uuid, streak, tail, { ...context, incident: context.incident ? { ...context.incident, category: "code" } : null });
    if (!project.autoFix || project.desiredState !== "running") {
      await this.incidents.update(incidentId, { note: `The bot imports "${module}", which isn't installed${project.autoFix ? "" : " (automatic fixes are off, so it wasn't added)"}.` });
      return;
    }
    const top = module.split(".")[0]!;
    // The import has to be in the bot's own code — never a name built from something a visitor typed.
    const imported = tail.some((l) => new RegExp(`^\\s*(?:from\\s+${top}(?:[.\\s]|$)|import\\s+(?:[\\w.]+\\s*,\\s*)*${top}(?:[.\\s,]|$))`).test(l));
    const pip = packageFor(module);
    if (!pip || !imported) {
      await this.incidents.update(incidentId, { state: "needs_owner",
        note: `The bot imports "${module}", which isn't installed, and KojyAI only installs well-known packages by itself (a name that's slightly off can belong to someone else). Add the package that provides it to requirements.txt.` });
      return;
    }
    if (hasRequirement(uuid, pip)) {
      // Listed but not importable: a broken or half-finished install, most likely. Installed again from scratch once first.
      const key = `${uuid}|${pip}`;
      const fresh = (this.supervisor as Partial<Supervisor>).startFresh;
      if (fresh && !this.freshInstalls.has(key)) {
        this.freshInstalls.add(key);
        fresh.call(this.supervisor, uuid);
        await this.incidents.update(incidentId, { state: "open", note: `${pip} is in requirements.txt, but "${module}" couldn't be imported — KojyAI installs its packages again from scratch at its next start.` }, "Fresh install of its packages");
        return;
      }
      await this.incidents.update(incidentId, { state: "needs_owner",
        note: `${pip} is in requirements.txt, but "${module}" still can't be imported — its install may have failed (see the console), or the code needs a different version.` });
      return;
    }
    try {
      snapshotProject(uuid, `Before KojyAI added the package ${pip}`);
      addRequirement(uuid, pip);
    } catch (err) {
      log.warn({ err, uuid }, "Could not add the missing package");
      return;
    }
    log.info({ uuid, pip }, "Added a missing package");
    const scope = { thread: `project:${project.id}`, projectId: project.id, key: uuid, orgId: project.orgId };
    await this.add(scope, "assistant", `📦 The bot imports \`${module}\`, but the package **${pip}** wasn't installed. I added it to requirements.txt and I'm starting the bot again — that installs it. (It's in Undo if you don't want it.)`, "event");
    await this.incidents.update(incidentId, { state: "watching", watchUntil: new Date(Date.now() + FIX_WATCH_MS), note: `KojyAI added ${pip} to requirements.txt and started the bot again.` }, `Added the package ${pip}`);
    await notifyUser(this.db, project.ownerId, "bot_error", `KojyAI added ${pip} to ${project.name}`, `The bot imports ${module}, which wasn't installed. KojyAI added ${pip} to requirements.txt and started it again.`, `/studio/p/${uuid}`);
    await this.supervisor.handle(uuid, "restart");
    const timer = setTimeout(() => {
      void this.incidents.update(incidentId, this.supervisor.isRunning(uuid)
        ? { state: "fixed", watchUntil: null, note: `Fixed: KojyAI added ${pip} and the bot runs.` }
        : { state: "open", watchUntil: null, note: `KojyAI added ${pip}, but the bot isn't running.` });
    }, FIX_WATCH_MS);
    timer.unref();
  }

  /**
   * After a KojyAI restart: automatic fixes pick up where they were. A fix that
   * was running resumes (once — a restart loop can't loop it), one waiting for
   * an AI or for its turn is tried again, and a fix being watched is watched to
   * the end. Bots whose crash only happens again wait for their fix (held)
   * instead of starting. Returns the bots whose chat request is resumed here.
   */
  private async resumeIncidents(): Promise<Set<string>> {
    const resumed = new Set<string>();
    const rows = await this.incidents.inProgress();
    if (!rows.length) return resumed;
    const projects = await this.db.select().from(botProjects).where(inArray(botProjects.id, [...new Set(rows.map((r) => r.projectId))]));
    const byId = new Map(projects.map((p) => [p.id, p]));
    const now = Date.now();
    for (const row of rows) {
      const project = byId.get(row.projectId);
      const fix = row.data?.fix;
      const lost = () => this.incidents.update(row.id, { state: "open", retryAt: null, watchUntil: null, fix: null,
        note: "KojyAI restarted while Kojy was working on this; it's fixed again when it happens again." });
      if (!project || !fix) { await lost(); continue; }
      const uuid = project.uuid;
      const context: CrashContext = { incident: { id: row.id, category: row.category, phase: row.phase, summary: row.summary }, ...(fix.survived ? { survived: fix.survived } : {}), ...(fix.earlier ? { earlier: fix.earlier } : {}) };
      if (row.state === "watching") {
        const left = (row.watchUntil?.getTime() ?? now) - now;
        if (!row.fixSnapshotId || !row.fixFiles || left <= 0) {
          await this.incidents.update(row.id, { state: "fixed", watchUntil: null, note: "Fixed by Kojy — the fix held." }, "The fix held");
          continue;
        }
        this.startWatch(uuid, project, { signature: fix.signature, tail: fix.tail, snapshotId: row.fixSnapshotId, incidentId: row.id, survived: fix.survived }, row.fixFiles, left);
        continue;
      }
      const holdText = `Kojy is fixing a crash (${row.summary}) — the bot starts again with the fix`;
      if (this.restartsCantHelp(context, fix.streak)) this.supervisorHold(uuid, holdText);
      if (row.state === "fixing" || row.state === "waiting_for_ai") {
        if (!fix.requestId || (row.state === "fixing" && fix.resumed)) { await lost(); await this.supervisorRelease(uuid); continue; }
        const crashFix: CrashFix = { signature: fix.signature, tail: fix.tail, snapshotId: fix.snapshotId ?? null, requestId: fix.requestId, what: fix.survived ? "an error" : "a crash",
          incidentId: row.id, survived: fix.survived, event: fix.event, phase: row.phase };
        const running = row.state === "fixing";
        const at = running ? now + RESUME_DELAY_MS : Math.max(row.retryAt?.getTime() ?? now, now + RESUME_DELAY_MS);
        this.fixing.set(uuid, fix.signature); // a crash of it meanwhile isn't fixed twice
        if (running) {
          resumed.add(uuid);
          await this.incidents.update(row.id, { fix: { ...fix, resumed: true } }, "KojyAI restarted — picking the fix up again");
          await this.add({ thread: `project:${project.id}`, projectId: project.id, key: uuid, orgId: project.orgId }, "assistant", "KojyAI restarted while I was fixing this — picking up where I left off.", "event");
        }
        const timer = setTimeout(() => {
          this.retryTimers.delete(uuid);
          this.fixing.delete(uuid);
          void (running ? this.runCrashFix(uuid, project, crashFix) : this.retryCrashFix(uuid, crashFix)).catch((err) => log.warn({ err, uuid }, "Resumed automatic fix failed"));
        }, at - now);
        timer.unref();
        this.retryTimers.set(uuid, timer);
        continue;
      }
      // queued: its turn (or a spaced retry) comes after the restart.
      this.deferCrash(uuid, fix.streak, fix.tail, context, Math.max(row.retryAt?.getTime() ?? now, now + RESUME_DELAY_MS));
    }
    if (rows.length) log.info({ count: rows.length }, "Picked up automatic fixes after the restart");
    return resumed;
  }

  /** Starts on the next crash that came in while Kojy was busy with this bot. */
  private drainCrashQueue(uuid: string): void {
    if (this.active.has(uuid)) return;
    const queue = this.queuedCrash.get(uuid);
    const next = queue?.entries().next().value;
    if (!queue || !next) return;
    const [signature, crash] = next;
    queue.delete(signature);
    if (!queue.size) this.queuedCrash.delete(uuid);
    void this.onCrash(uuid, crash.streak, crash.tail, crash.context)
      .catch((err) => log.warn({ err, uuid }, "Queued crash failed"))
      .finally(() => this.drainCrashQueue(uuid));
  }

  /**
   * After an automatic fix that changed code: watch the bot for FIX_WATCH_MS.
   * No crash in that time → say the fix held. A crash → fixDidNotHold.
   */
  private watchFix(uuid: string, project: ProjectRow, fix: CrashFix): void {
    if (!fix.snapshotId) return;
    this.startWatch(uuid, project, { ...fix, snapshotId: fix.snapshotId }, codeFingerprint(uuid), FIX_WATCH_MS);
  }

  /** Watches a fix for `ms` more: `files` is the code right after it (a rollback never overwrites later changes). */
  private startWatch(uuid: string, project: ProjectRow, fix: Pick<CrashFix, "signature" | "tail" | "incidentId" | "survived"> & { snapshotId: string }, files: Record<string, string>, ms: number): void {
    this.clearWatch(uuid);
    const timer = setTimeout(() => {
      this.watching.delete(uuid);
      if (!this.supervisor.isRunning(uuid)) { // stopped meanwhile: nothing was proven
        void this.incidents.update(fix.incidentId, { state: "open", watchUntil: null, note: "The bot was stopped before the fix could be confirmed." });
        return;
      }
      void this.add({ thread: `project:${project.id}`, projectId: project.id, key: uuid, orgId: project.orgId }, "assistant",
        `✓ The automatic fix held: no crash in the ${Math.round(FIX_WATCH_MS / 60_000)} minutes after it.`, "event").catch(() => undefined);
      void this.incidents.update(fix.incidentId, { state: "fixed", watchUntil: null, fix: null, note: "Fixed by Kojy — the fix held." }, "The fix held");
    }, ms);
    timer.unref();
    this.watching.set(uuid, { snapshotId: fix.snapshotId, signature: fix.signature, tail: fix.tail, files, incidentId: fix.incidentId, survived: fix.survived, timer });
  }

  private clearWatch(uuid: string): void {
    const w = this.watching.get(uuid);
    if (w) { clearTimeout(w.timer); this.watching.delete(uuid); }
  }

  /**
   * The bot crashed while an automatic fix was being watched. The fix didn't
   * stop the crash (same error) or brought a new one: put the code back as it
   * was before the fix (the current code is kept as an undo point too), tell
   * the owner, and start a new fix of the original crash that knows why the
   * last one was undone. If the code was changed after the fix (the owner, an
   * upload), nothing is put back: the crash goes the normal way. True when it
   * handled the crash.
   */
  private async fixDidNotHold(uuid: string, project: ProjectRow, streak: number, tail: string[], incidentId: number | null): Promise<boolean> {
    const w = this.watching.get(uuid);
    if (!w) return false;
    this.clearWatch(uuid);
    const same = crashSignature(tail) === w.signature;
    const thread = `project:${project.id}`;
    const scope = { thread, projectId: project.id, key: uuid, orgId: project.orgId };
    const why = same ? "the same error came back" : "the bot crashed with a different error right after it";
    const changed = fingerprintChanges(w.files, codeFingerprint(uuid));
    if (changed.length) {
      await this.incidents.update(w.incidentId, { state: "open", watchUntil: null, note: "It crashed again after Kojy's fix, but the code had been changed since, so the fix wasn't undone." },
        `Crashed again after the fix (${why}); code changed since — not undone`);
      await this.add(scope, "assistant",
        `The bot crashed again after the automatic fix (${why}), but its code was changed since (${changed.slice(0, 3).join(", ")}${changed.length > 3 ? ", …" : ""}), ` +
        "so I'm not undoing anything — I'm looking at this crash as it is now.", "event");
      return false;
    }
    try {
      snapshotProject(uuid, "Before undoing an automatic fix that didn't hold");
      restoreSnapshot(uuid, w.snapshotId);
    } catch (err) {
      log.warn({ err, uuid }, "Could not undo the automatic fix");
      return false;
    }
    // A bot that's still running (it survived the error) keeps the undone code in memory until it restarts.
    if (this.supervisor.isRunning(uuid) && typeof this.supervisor.handle === "function") {
      await this.supervisor.handle(uuid, "restart").catch((err: unknown) => log.warn({ err, uuid }, "Could not restart the bot after undoing a fix"));
    }
    await this.add(scope, "assistant",
      `↶ The automatic fix didn't hold (${why}), so I put the code back as it was before it, and I'm starting a new fix that takes this into account. ` +
      "The code with the earlier fix is saved in Undo.", "event");
    await recordWork(this.db, thread, project.id, "error").catch(() => undefined);
    await this.learn(project, `An automatic fix for "${w.signature.slice(0, 140)}" didn't hold (${why}) and was undone — look for the real cause instead of repeating it.`);
    const title = `Kojy undid its fix for ${project.name}`;
    await notifyUser(this.db, project.ownerId, "bot_error", title, `The automatic fix didn't hold (${why}). The code is back to how it was before it, and Kojy is working on a new fix.`, `/studio/p/${uuid}`);
    void sendAlert(`↶ ${title}: ${why}.`);
    log.info({ uuid, same }, "Automatic fix didn't hold — code restored, starting over");
    await this.incidents.update(w.incidentId, { watchUntil: null }, `The fix didn't hold (${why}) — undone`);
    if (incidentId && incidentId !== w.incidentId) {
      await this.incidents.update(incidentId, { state: "ignored", note: "Came from an automatic fix that was undone right away." }, "Caused by a fix that was undone");
    }
    // Start over on the crash the fix was for, saying what went wrong. A
    // different error is described with names and numbers taken out (V-03).
    const location = crashLocation(tail);
    const earlier = same ? "the same error came back after it"
      : `right after it the bot crashed with a different error (${normalizeError(lastException(tail))}${location ? ` at ${location}` : ""})`;
    void this.onCrash(uuid, streak, w.tail, { incident: w.incidentId ? { id: w.incidentId, category: "code" } : null, earlier, ...(w.survived ? { survived: w.survived } : {}) })
      .catch((err) => log.warn({ err, uuid }, "New automatic fix failed"));
    return true;
  }
}

/** The undo label of an automatic crash fix ("Before Kojy: automatic crash fix"). */
export const AUTO_FIX_LABEL = "automatic crash fix";
/** How long after an automatic fix a crash counts as "the fix didn't hold". */
export const FIX_WATCH_MS = Number(process.env.AGENT_FIX_WATCH_MS ?? 15 * 60_000);
/** How long the bot has, with the fix, to get back into its room. */
const LIVE_CHECK_MS = Number(process.env.AGENT_LIVE_CHECK_MS ?? 90_000);
const LIVE_CHECK_POLL_MS = 2000;
/** Attempts on the same bug are spaced out only while the last one was this recent. */
const RETRY_SPACING_WINDOW_MS = 2 * 3600_000;

/**
 * How long the next automatic fix of the same bug waits after `attempts`
 * that didn't fix it: 2, 5, 15, 30 minutes, then hourly. It never stops trying.
 */
export function retrySpacingMs(attempts: number): number {
  return ([2, 5, 15, 30][attempts - 1] ?? 60) * 60_000;
}

/**
 * The chat rows sent as history: the newest 80 — or, for an automatic fix,
 * only its own request and steps (earlier work is in the work log and the
 * task notes): a crash fix needs the crash, not the owner's last chat, and a
 * small request fits every AI, the free ones too. `requestAt` = the index of
 * the current request in `stored` (oldest first).
 */
export function historyRows<T extends { kind: string }>(stored: T[], requestAt: number): T[] {
  const request = stored[requestAt];
  if (request && AUTOMATED_KINDS.has(request.kind)) return stored.slice(requestAt).slice(-80);
  return stored.slice(-80);
}

/**
 * Turn order every AI accepts. The history starts with a user turn: Gemini
 * refuses a chat that opens with a tool call ("function call turn comes
 * immediately after a user turn or after a function response turn"), which
 * the history window can start on. Two assistant turns in a row (an app note,
 * then a step) become one.
 */
export function normalizeTurns(msgs: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of msgs) {
    if (!out.length && m.role !== "user") {
      if (m.role === "tool") continue; // a result whose call is out of view
      out.push({ role: "user", content: "[app] (Earlier messages of this chat are left out here; the notes above say what was asked and done.)" });
    }
    const last = out[out.length - 1];
    if (last && last.role === "assistant" && !last.tool_calls?.length && m.role === "assistant") {
      out[out.length - 1] = { ...m, content: [last.content, m.content].filter((c) => c?.trim()).join("\n\n") || null };
      continue;
    }
    out.push(m);
  }
  return out;
}

/**
 * Every tool call must be answered right after it, so: results move up next
 * to their call, a message the owner sent mid-step moves after the results,
 * and a call left unanswered (runner restarted mid-step) is dropped.
 */
export function pairToolCalls(msgs: ChatMessage[]): ChatMessage[] {
  const results = new Map<string, ChatMessage>();
  for (const m of msgs) if (m.role === "tool" && m.tool_call_id) results.set(m.tool_call_id, m);
  const out: ChatMessage[] = [];
  for (const m of msgs) {
    if (m.role === "tool") continue;
    if (m.role === "assistant" && m.tool_calls?.length) {
      const answered = m.tool_calls.filter((c) => results.has(c.id));
      if (!answered.length) { if (m.content) out.push({ role: "assistant", content: m.content }); continue; }
      out.push({ ...m, tool_calls: answered });
      for (const c of answered) out.push(results.get(c.id)!);
      continue;
    }
    out.push(m);
  }
  return out;
}

function shrinkArgs(json: string): string {
  try {
    const args = JSON.parse(json) as Record<string, unknown>;
    for (const [k, v] of Object.entries(args)) if (typeof v === "string" && v.length > 200) args[k] = `${v.slice(0, 120)}… (${v.length} chars)`;
    return JSON.stringify(args);
  } catch { return "{}"; }
}

function describeCall(name: string, args: Record<string, unknown>): string {
  const p = typeof args.path === "string" ? ` ${args.path}` : "";
  switch (name) {
    case "read_file": return `Reading${p}…`;
    case "edit_file": case "write_file": case "multi_edit": case "append_file": return `Editing${p}…`;
    case "move_file": return "Moving a file…";
    case "undo_changes": return "Undoing my changes…";
    case "run_python": return "Running a Python script…";
    case "fetch_url": return `Reading ${typeof args.url === "string" ? args.url.replace(/^https?:\/\//, "").slice(0, 40) : "a web page"}…`;
    case "update_todo": return "Updating the checklist…";
    case "work_on_bot": return `Handing it to ${String(args.bot ?? "the bot")}'s chat…`;
    case "search_code": return "Searching the code…";
    case "run_command": return `Running ${typeof args.command === "string" ? `\`${args.command.slice(0, 50)}\`` : "a command"}…`;
    case "git": return typeof args.action === "string" && args.action.includes("push") ? "Pushing to GitHub…" : "Working with git…";
    case "check_code": return "Checking the code (may install packages)…";
    case "test_in_room": return "Testing in a fake room…";
    case "run_saved_tests": return "Running the saved tests…";
    case "save_test": return "Saving the test…";
    case "test_secrets": return "Testing secrets…";
    case "discord_check": return "Checking the bot with Discord…";
    case "bot_control": return `${String(args.action ?? "")} the bot…`;
    case "list_bots": return "Looking at your bots…";
    case "analytics": case "room_activity": return "Checking the numbers…";
    case "query_data": return "Looking at the bot's data…";
    case "server_status": return "Checking the server…";
    case "test_script": return "Testing the script…";
    case "write_script": return `Writing ${String(args.name ?? "a script")}…`;
    case "convert_to_python": return "Starting the Python version…";
    case "create_bot": return `Creating ${String(args.name ?? "a bot")}…`;
    case "propose_plan": return "Writing a plan…";
    case "control_bot": return `${String(args.action ?? "")} ${String(args.bot ?? "")}…`;
    default: return "Working…";
  }
}


/** The summary of a tool call an automatic fix refused. */
export const AUTOMATIC_REFUSAL_SUMMARY = "Not allowed in an automatic fix";
/** What such a refusal says in the history of a later owner request. */
const AUTOMATIC_LIMIT_NOTE = "(Refused by the limits of an automatic crash fix. Those limits don't apply now: the owner is asking, and every tool works.)";
/** Tools whose arguments carry file contents. */
const BIG_ARG_TOOLS = new Set(["write_file", "append_file", "edit_file", "multi_edit", "run_python", "run_command"]);
/** Tools that write files: a cut-off call to one is written in parts instead. */
const WRITE_TOOLS = new Set(["write_file", "append_file", "edit_file", "multi_edit"]);

/** A tool call's arguments as an object (a ```json fence around them is fine), or null when they aren't one. */
export function parseToolArguments(raw: string): Record<string, unknown> | null {
  const text = (raw || "").trim() || "{}";
  for (const candidate of [text, text.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1")]) {
    try {
      const v = JSON.parse(candidate) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* next */ }
  }
  return null;
}

/**
 * Why a call's arguments can't be used: cut off (the answer hit its output
 * limit) or not JSON. Nothing is run; the model is told how to do it instead.
 */
export function badArguments(name: string, raw: string, truncated: boolean, outputLimit: number): ToolResult {
  if (truncated) {
    const part = Math.max(2000, Math.floor(outputLimit * 2.5));
    return {
      ok: false,
      summary: `${name} was cut off (too long for one answer) — nothing was run`,
      output: `Your ${name} call was cut off after ${raw.length} characters: one answer can only be about ${outputLimit} tokens long, so its arguments never finished. Nothing was run and no file was changed.\n` +
        (WRITE_TOOLS.has(name)
          ? `Write it in parts instead: write_file with the first part (under ~${part} characters), then append_file with each next part (each under ~${part} characters). To change an existing file, edit only the lines that change (edit_file or multi_edit).`
          : "Split the work into several shorter calls."),
    };
  }
  return {
    ok: false,
    summary: `${name}: the arguments weren't valid JSON — nothing was run`,
    output: `The arguments of your ${name} call weren't a valid JSON object (${raw.length} characters${raw ? `, ending with ${JSON.stringify(raw.slice(-60))}` : ""}). Nothing was run. Call it again with valid JSON arguments.`,
  };
}

/** Text arguments that may be empty (an empty file, deleting text). */
const MAY_BE_EMPTY = new Set(["content", "new_text", "message", "query", "folder"]);

/** A call missing required arguments (it would only fail with a confusing error), or null when it has them all. */
export function missingArguments(spec: ToolSpec | undefined, args: Record<string, unknown>): ToolResult | null {
  if (!spec) return null;
  const params = spec.function.parameters as { required?: string[]; properties?: Record<string, { type?: string }> };
  const missing = (params.required ?? []).filter((k) => {
    const v = args[k];
    if (v === undefined || v === null) return true;
    return params.properties?.[k]?.type === "string" && (typeof v !== "string" || (!v.trim() && !MAY_BE_EMPTY.has(k)));
  });
  if (!missing.length) return null;
  const name = spec.function.name;
  return {
    ok: false,
    summary: `${name}: missing ${missing.join(", ")} — nothing was run`,
    output: `${name} needs ${(params.required ?? []).join(", ")}; this call had no usable ${missing.join(", ")}. Nothing was run. Call it again with every required argument.`,
  };
}

/** Said before the owner's request is called done (the changes follow). */
const REVIEW_NOTE = "[app] Before you finish, review what you changed in this request (below) like a careful reviewer: a bug, a case you missed (None, empty, a wrong type, a user who isn't there), something left half-done, a name that doesn't exist, a change you didn't test. " +
  "If you find a problem, fix it now with the tools and test again. If it's all good, reply with your final short summary for the owner — don't mention this review.\n";

/** What changed since the request's undo point, as diffs from then to now, for the review (null when nothing). */
export function reviewText(uuid: string, snapshotId: string): string | null {
  const tmp = mkdtempSync(path.join(tmpdir(), "kojy-review-"));
  try {
    const { files, more } = compareSnapshot(uuid, snapshotId, 15);
    if (!files.length) return null;
    extractSnapshot(uuid, snapshotId, tmp);
    const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
    const parts: string[] = [];
    for (const f of files) {
      const then = read(path.join(tmp, f.path));
      const now = read(path.join(projectDir(uuid), f.path));
      // compareSnapshot looks back from now: "added" there means Kojy deleted it, "removed" that Kojy created it.
      if (f.change === "added") { parts.push(`--- ${f.path} (deleted)`); continue; }
      if (f.change === "removed") { parts.push(`--- ${f.path} (new file)\n${now.split("\n").map((l, i) => `+${String(i + 1).padStart(4)} ${l}`).join("\n")}`); continue; }
      parts.push(`--- ${f.path} (changed)\n${lineDiff(then, now, 2, 4000)?.text ?? "(too big to show)"}`);
    }
    const body = parts.join("\n").slice(0, 8000);
    return `\`\`\`diff\n${body}${more ? `\n… and ${more} more files` : ""}\n\`\`\``;
  } catch {
    return null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
