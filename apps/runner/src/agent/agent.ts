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
 * results → model … until it replies without tools or asks for secrets (only
 * a runaway job hits the step/time cap). Every step is written to project_messages, which is both
 * the chat the page shows and the model's history.
 *
 * Stabilizer: when a bot crashes repeatedly with a Python traceback, the
 * supervisor calls onCrash and (if the project allows auto-fix) the AI is
 * started on the crash by itself — at most 3 times a day per project.
 */

import { and, desc, eq, gt } from "drizzle-orm";
import type { Redis } from "ioredis";
import { notifyUser, sendAlert, type Database } from "@kojyai/db";
import { botProjects, bots, projectMessages, projectSecrets } from "@kojyai/db/schema";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { listFiles, projectDir, readLogs, restoreSnapshot } from "@kojyai/shared/projects";
import type { Supervisor } from "../supervisor.js";
import { createLogger } from "../logger.js";
import { chat, estimateTokens, aiConfigured, currentEndpoint, AiUnavailableError, RequestTooLargeError, ResizeError, type Endpoint, type ChatMessage, type ToolCall, type ToolSpec } from "./groq.js";
import { TOOL_SPECS, runTool, loadMemories, type Project, type ToolContext, type ToolResult } from "./tools.js";
import { systemPrompt, studioPrompt, jsBotPrompt } from "./prompt.js";
import { STUDIO_TOOL_SPECS, runStudioTool, studioSnapshot, type StudioContext } from "./studioTools.js";
import { JS_TOOL_SPECS, runJsTool, type JsContext } from "./jsTools.js";
import { runCheckups } from "./checkup.js";
import { projectMap, readSpec, KOJY_DIR } from "./codeQuality.js";
import { changesSince } from "./review.js";

const log = createLogger("agent");

// Kojy keeps going until the task is done; these only stop a job that has lost its way.
const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS ?? 200);
const MAX_JOB_MS = Number(process.env.AGENT_MAX_MINUTES ?? 45) * 60_000;
/** Kojy jobs at once (each runs Python tests and calls the AI; the server and the free AI plans are small). */
const MAX_JOBS = Math.max(1, Number(process.env.AGENT_MAX_JOBS ?? 2));
const WATCH_MS = Number(process.env.AGENT_WATCH_SECONDS ?? 120) * 1000;
const WATCH_TICK_MS = Math.min(10_000, WATCH_MS / 4);
const AUTOFIX_PER_DAY = 3;

type Row = typeof projectMessages.$inferSelect;

/** One conversation: where its messages live, its tools and its instructions. */
interface Scope {
  key: string;
  thread: string;
  projectId: number;
  tools: ToolSpec[];
  runTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** compact: for a small plan (Groq), a shorter prompt. */
  system(compact?: boolean): Promise<string>;
  setState(state: "idle" | "working" | "waiting"): Promise<void>;
  /** A Python bot's tool context (its checks, edits and snapshot), for the report and the watch. */
  ctx?: ToolContext;
}

export const STUDIO_PREFIX = "studio-";
/** Key for a JS bot's chat: "jsbot-<bots.uuid>". */
export const JSBOT_PREFIX = "jsbot-";

export class Agent {
  private active = new Map<string, AbortController>();
  private again = new Set<string>();
  private autofixLog = new Map<string, number[]>();

  constructor(private db: Database, private supervisor: Supervisor, private redis: Redis | null) {
    supervisor.onCrash = (uuid, streak, tail, how) => void this.onCrash(uuid, streak, tail, how);
    // Daily check-ups: look every hour for bots that are due.
    const tick = () => void runCheckups(this.db, (uuid) => void this.run(uuid)).catch((err) => log.warn({ err }, "Check-ups failed"));
    setTimeout(tick, 60_000).unref();
    setInterval(tick, 3600_000).unref();
  }

  /** Control messages from the API: "agent" (new message) and "agent_stop". */
  async handle(key: string, action: string): Promise<void> {
    if (action === "agent_stop") { this.active.get(key)?.abort(); return; }
    if (action === "agent") return this.run(key);
  }

  /** After a runner restart nobody is working any more. */
  async resetStates(): Promise<void> {
    await this.db.update(botProjects).set({ agentState: "idle" }).where(eq(botProjects.agentState, "working"));
  }

  private async progress(uuid: string, text: string | null): Promise<void> {
    if (!this.redis) return;
    try {
      if (text) await this.redis.set(`agent_progress:${uuid}`, text, "EX", 180);
      else await this.redis.del(`agent_progress:${uuid}`);
    } catch { /* progress is cosmetic */ }
  }

  private async add(scope: Pick<Scope, "thread" | "projectId">, role: string, content: string, kind = "text", data?: Record<string, unknown>): Promise<Row> {
    const [row] = await this.db.insert(projectMessages).values({ thread: scope.thread, projectId: scope.projectId, role, kind, content, data: data ?? null }).returning();
    return row!;
  }

  /** The conversation behind a control-message key, or null if it's gone. */
  private async scopeFor(key: string): Promise<Scope | null> {
    if (key.startsWith(STUDIO_PREFIX)) {
      const orgId = Number(key.slice(STUDIO_PREFIX.length));
      if (!Number.isInteger(orgId) || orgId <= 0) return null;
      const ctx: StudioContext = { db: this.db, supervisor: this.supervisor, redis: this.redis, orgId, startBotChat: (uuid) => void this.run(uuid) };
      return {
        key, thread: `studio:${orgId}`, projectId: 0, tools: STUDIO_TOOL_SPECS,
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
        key, thread: `bot:${bot.id}`, projectId: 0, tools: JS_TOOL_SPECS,
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
    const ctx: ToolContext = { db: this.db, supervisor: this.supervisor, project, snapshotted: false, changedFiles: new Set(), checks: [], edits: 0 };
    return {
      key, thread: `project:${project.id}`, projectId: project.id, tools: TOOL_SPECS,
      runTool: (name, args) => runTool(name, args, ctx),
      system: async (compact = false) => {
        const [secrets, memories] = await Promise.all([
          this.db.select({ key: projectSecrets.key }).from(projectSecrets).where(eq(projectSecrets.projectId, project.id)),
          loadMemories(this.db, project),
        ]);
        return systemPrompt({
          projectName: project.name, entrypoint: ctx.project.entrypoint, status: project.status,
          secrets: secrets.map((x) => x.key), memories: compact ? memories.slice(-3) : memories, fileCount: listFiles(project.uuid).filter((f) => !f.isDir).length,
          map: projectMap(project.uuid, compact ? 700 : 2500), spec: readSpec(project.uuid).slice(0, compact ? 500 : 2500),
        });
      },
      setState: async (state) => { await this.db.update(botProjects).set({ agentState: state }).where(eq(botProjects.id, project.id)); },
      ctx,
    };
  }

  async run(uuid: string): Promise<void> {
    if (this.active.has(uuid)) { this.again.add(uuid); return; }
    const abort = new AbortController();
    this.active.set(uuid, abort);
    try {
      await this.takeSlot(uuid, abort.signal);
      if (abort.signal.aborted) return;
      do {
        this.again.delete(uuid);
        await this.runOnce(uuid, abort.signal);
      } while (this.again.has(uuid) && !abort.signal.aborted);
    } finally {
      this.giveSlot(uuid);
      this.active.delete(uuid);
      await this.progress(uuid, null);
    }
  }

  // ── job queue: a few Kojy jobs at once, the rest wait their turn ──
  private running = new Set<string>();
  private waiting: { uuid: string; go: () => void }[] = [];

  private async takeSlot(uuid: string, signal: AbortSignal): Promise<void> {
    if (this.running.size < MAX_JOBS) { this.running.add(uuid); return; }
    // Shown as busy in the Studio while it waits (Python bots; other chats have no row).
    await this.db.update(botProjects).set({ agentState: "working" }).where(eq(botProjects.uuid, uuid));
    await this.progress(uuid, `Queued: waiting for ${this.running.size === 1 ? "another job" : `${this.running.size} other jobs`} to finish…`);
    await new Promise<void>((resolve) => {
      const entry = { uuid, go: resolve };
      this.waiting.push(entry);
      signal.addEventListener("abort", () => { this.waiting = this.waiting.filter((w) => w !== entry); resolve(); }, { once: true });
    });
    if (signal.aborted) await this.db.update(botProjects).set({ agentState: "idle" }).where(eq(botProjects.uuid, uuid));
  }

  private giveSlot(uuid: string): void {
    if (!this.running.delete(uuid)) return;
    const next = this.waiting.shift();
    if (next) { this.running.add(next.uuid); next.go(); }
  }

  /** Jobs running and waiting, for the Studio's job list. */
  jobs(): { running: string[]; queued: string[] } {
    return { running: [...this.running], queued: this.waiting.map((w) => w.uuid) };
  }

  private async runOnce(uuid: string, signal: AbortSignal): Promise<void> {
    const scope = await this.scopeFor(uuid);
    if (!scope) return;
    await scope.setState("working");
    let finalState: "idle" | "waiting" = "idle";
    const ctx = scope.ctx;
    if (ctx) {
      const [ask] = await this.db.select({ content: projectMessages.content }).from(projectMessages)
        .where(and(eq(projectMessages.thread, scope.thread), eq(projectMessages.role, "user"))).orderBy(desc(projectMessages.id)).limit(1);
      ctx.goal = ask?.content ?? "";
      ctx.signal = signal;
      ctx.onRestarted = () => this.watchAfterRestart(uuid, ctx);
    }

    try {
      const began = Date.now();
      for (let step = 0; step < MAX_STEPS; step++) {
        if (signal.aborted) { await this.add(scope, "assistant", "Stopped.", "event"); break; }
        await this.progress(uuid, step === 0 ? "Thinking…" : "Working…");

        let message: ChatMessage | undefined;
        // History sized for the AI that takes the request (Gemini's plan fits far more
        // than Groq's). When Gemini rests and Groq takes over, the request is built again
        // in Groq's size; still too big for the plan → try again with less (3 times).
        let target: Endpoint | undefined;
        for (let shrink = 1; !message;) {
          const ep = target ?? currentEndpoint();
          const budget = Math.floor((ep?.historyTokens ?? 3000) / shrink);
          try {
            let model: string;
            ({ message, model } = await chat({
              messages: await this.buildMessages(scope, budget, !!ep?.compact), tools: scope.tools, signal,
              onWait: (sec, why) => void this.progress(uuid, `Waiting ${sec}s (${why})…`),
            }));
            if (ctx) ctx.mainModel = model;
          } catch (err) {
            if (err instanceof ResizeError && target?.id !== err.ep.id) { target = err.ep; continue; }
            if (!(err instanceof RequestTooLargeError) || shrink >= 8) throw err;
            shrink *= 2;
          }
        }
        const calls = message.tool_calls ?? [];
        await this.add(scope, "assistant", message.content ?? "", "text", calls.length ? { toolCalls: calls } : undefined);
        if (!calls.length) break;

        let pause = false;
        for (const call of calls) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* reported below */ }
          await this.progress(uuid, describeCall(call.function.name, args));
          const result = await scope.runTool(call.function.name, args);
          await this.add(scope, "tool", result.output, result.cardKind ?? (result.card ? "secret_request" : "tool"), {
            toolCallId: call.id, name: call.function.name, summary: result.summary, ok: result.ok, ...(result.card ? { card: result.card } : {}),
          });
          if (result.pause) pause = true;
        }
        if (pause) { finalState = "waiting"; break; }
        if (step === MAX_STEPS - 1 || Date.now() - began > MAX_JOB_MS) {
          await this.add(scope, "assistant", `I've been working on this for ${step + 1} steps (${Math.round((Date.now() - began) / 60_000)} min) without finishing, so I stopped to keep from going in circles. Send “continue” to let me carry on, or tell me what to focus on.`, "event");
          break;
        }
      }
    } catch (err) {
      const text = err instanceof AiUnavailableError ? err.message : `Something went wrong: ${(err as Error).message}`;
      if (!(err instanceof AiUnavailableError)) log.error({ err, uuid }, "Agent run failed");
      await this.add(scope, "assistant", text, "error");
    } finally {
      if (ctx && (ctx.edits > 0 || ctx.checks.length)) await this.report(scope, ctx).catch((err) => log.warn({ err, uuid }, "Couldn't write the work report"));
      await scope.setState(finalState);
    }
  }

  /** The task's work report: files changed (with diffs), what was checked and tested, and what wasn't. */
  private async report(scope: Scope, ctx: ToolContext): Promise<void> {
    const files = ctx.snapshotId ? changesSince(ctx.project.uuid, ctx.snapshotId, ctx.changedFiles) : [];
    const last = (name: RegExp) => [...ctx.checks].reverse().find((c) => name.test(c.name));
    const notTested: string[] = [];
    if (files.length) {
      if (!last(/^Code check/)?.ok) notTested.push("The code check didn't pass after the last change.");
      if (!last(/^(Test room|Saved tests)/)?.ok) notTested.push("No passing test in the test room after the change.");
      if (!ctx.restarted) notTested.push("The real bot wasn't restarted, so the change isn't live yet.");
    }
    const card = {
      snapshotId: ctx.snapshotId, files, checks: ctx.checks, notTested, live: !!ctx.restarted,
      ...(ctx.reviewNotes ? { reviewNotes: ctx.reviewNotes } : {}),
    };
    const lines = [
      files.length ? `Changed: ${files.map((f) => `${f.path} (+${f.added} -${f.removed})`).join(", ")}` : "No code changes.",
      ...ctx.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`),
      ...notTested.map((n) => `Not done: ${n}`),
    ];
    await this.add(scope, "assistant", lines.join("\n"), "report", { card });
  }

  /**
   * System prompt + as much recent history as fits the budget. Older tool
   * results are shrunk to their one-line summary; the history always starts at
   * a user message so tool calls and their results stay paired.
   */
  private async buildMessages(scope: Scope, historyTokens: number, compact = false): Promise<ChatMessage[]> {
    const [rowsDesc, system] = await Promise.all([
      this.db.select().from(projectMessages).where(eq(projectMessages.thread, scope.thread)).orderBy(desc(projectMessages.id)).limit(80),
      scope.system(compact),
    ]);
    // Errors and work reports are for the owner; the model has the steps themselves.
    const rows = rowsDesc.reverse().filter((r) => r.kind !== "error" && r.kind !== "report");
    // A long task can push the owner's request out of the 80-row window: keep it first,
    // so the model still knows the task (and the history starts at a user message).
    if (!rows.some((r) => r.role === "user")) {
      const [ask] = await this.db.select().from(projectMessages)
        .where(and(eq(projectMessages.thread, scope.thread), eq(projectMessages.role, "user"))).orderBy(desc(projectMessages.id)).limit(1);
      if (ask) rows.unshift(ask);
    }
    const lastUser = rows.map((r) => r.role).lastIndexOf("user");

    const toMsg = (r: Row, full: boolean): ChatMessage => {
      if (r.role === "tool") {
        const d = (r.data ?? {}) as { toolCallId?: string; summary?: string };
        return { role: "tool", tool_call_id: d.toolCallId ?? "", content: full ? r.content : `(earlier result) ${d.summary ?? ""}` };
      }
      if (r.role === "assistant") {
        let calls = (r.data as { toolCalls?: ToolCall[] } | null)?.toolCalls;
        // Old write_file/edit_file calls carry whole file contents; keep just their shape.
        if (calls && !full) calls = calls.map((c) => ({ ...c, function: { ...c.function, arguments: shrinkArgs(c.function.arguments) } }));
        return { role: "assistant", content: r.content || null, ...(calls?.length ? { tool_calls: calls } : {}) };
      }
      return { role: "user", content: r.kind === "event" ? `[app] ${r.content}` : r.content };
    };

    // Newest first, until the budget runs out; results after the last user message stay full.
    const picked: ChatMessage[] = [];
    let budget = historyTokens;
    for (let i = rows.length - 1; i >= 0; i--) {
      const full = i >= lastUser || rows[i]!.role === "user";
      let m = toMsg(rows[i]!, full);
      let cost = estimateTokens(JSON.stringify(m));
      if (cost > budget && rows[i]!.role === "tool" && i >= lastUser) {
        // Even the current task's results are too big: keep their summary.
        m = toMsg(rows[i]!, false);
        cost = estimateTokens(JSON.stringify(m));
      }
      // Over the budget: stop here, even inside the current task (a long task on
      // Groq's small plan keeps its newest steps; the request goes back on top below).
      if (cost > budget) break;
      budget -= cost;
      picked.unshift(m);
    }
    if (!picked.some((m) => m.role === "user") && lastUser >= 0) picked.unshift(toMsg(rows[lastUser]!, true));
    // Start at a user message, whether the budget or the 80-row window did the
    // cutting: a history that begins mid-task leaves a tool result without its
    // call, and Gemini refuses a tool call that doesn't follow a user turn (400).
    let start = 0;
    while (start < picked.length && picked[start]!.role !== "user") start++;
    if (start === picked.length) start = 0; // no user message at all: keep what there is
    const history = pairToolCalls(picked.slice(start));

    return [{ role: "system", content: system }, ...history];
  }

  // ── watch after a restart ──────────────────────────────────────────────────

  private watches = new Map<string, NodeJS.Timeout>();
  private rollbacks = new Map<string, number[]>();

  /**
   * For 2 minutes after a run restarts the real bot with new code: a crash, a
   * stuck connection, or an error from a file the run changed puts the previous
   * version back, and Kojy is told what happened so it can fix it properly.
   */
  private watchAfterRestart(uuid: string, ctx: ToolContext): void {
    const snapshotId = ctx.snapshotId;
    if (!snapshotId) return;
    clearTimeout(this.watches.get(uuid));
    const since = Date.now();
    const changed = [...ctx.changedFiles];
    const tick = async () => {
      try {
        const problem = await findProblem(this.db, uuid, since, changed);
        if (problem) { this.watches.delete(uuid); return await this.rollback(uuid, ctx.project, snapshotId, problem); }
        if (Date.now() - since >= WATCH_MS) { this.watches.delete(uuid); return; }
      } catch (err) { log.warn({ err, uuid }, "Watch after restart failed"); }
      this.watches.set(uuid, setTimeout(() => void tick(), WATCH_TICK_MS));
    };
    this.watches.set(uuid, setTimeout(() => void tick(), WATCH_TICK_MS));
  }

  private async rollback(uuid: string, project: Project, snapshotId: string, problem: string): Promise<void> {
    const now = Date.now();
    const recent = (this.rollbacks.get(uuid) ?? []).filter((t) => now - t < 3600_000);
    this.rollbacks.set(uuid, [...recent, now]);
    // Kojy's own notes (tests, spec, insights) stay as they are now.
    const keep = readKojyFiles(uuid);
    restoreSnapshot(uuid, snapshotId);
    writeKojyFiles(uuid, keep);
    await this.supervisor.handle(uuid, "restart");
    log.warn({ uuid, snapshotId }, "Rolled back a change that broke the bot");
    await this.add({ thread: `project:${project.id}`, projectId: project.id }, "user",
      `The change you just made broke the bot after the restart, so the platform put the previous version back and restarted it (the bot is running the old code now; your edits are undone). What happened:\n${problem}\n\nFind the cause, then redo the change correctly: check_code, a test that reproduces this problem (save_test), run_tests, and restart again.`,
      "rollback");
    await notifyUser(this.db, project.ownerId, "bot_error", `${project.name}: a change was undone`, `The new version broke the bot, so the previous one is back. Kojy is fixing it.`, `/studio/p/${uuid}`);
    // At most twice an hour, so a change that keeps breaking doesn't loop.
    if (recent.length < 2) void this.run(uuid);
  }

  // ── stabilizer ─────────────────────────────────────────────────────────────

  /** A bot crashed twice in a row, or (how: "error") its code failed twice while it stayed in the room. */
  private async onCrash(uuid: string, streak: number, tail: string[], how: "crash" | "error" = "crash"): Promise<void> {
    if (streak < 2 || this.active.has(uuid)) return;
    // Only code errors: a network blip or Highrise outage isn't something to "fix".
    const traceback = tail.findIndex((l) => l.includes("Traceback (most recent call last)"));
    if (traceback < 0) return;
    const [project] = await this.db.select().from(botProjects).where(eq(botProjects.uuid, uuid)).limit(1);
    if (!project?.autoFix || project.desiredState !== "running") return;
    if (!aiConfigured()) return;

    const now = Date.now();
    const recent = (this.autofixLog.get(uuid) ?? []).filter((t) => now - t < 24 * 3600_000);
    if (recent.length >= AUTOFIX_PER_DAY) return;
    // Don't start a second fix for the same crash while the last one is fresh.
    const [last] = await this.db.select({ id: projectMessages.id }).from(projectMessages)
      .where(and(eq(projectMessages.thread, `project:${project.id}`), eq(projectMessages.kind, "crash"), gt(projectMessages.createdAt, new Date(now - 20 * 60_000)))).limit(1);
    if (last) return;
    recent.push(now);
    this.autofixLog.set(uuid, recent);

    const trace = tail.slice(Math.max(0, traceback - 2)).slice(-40).join("\n");
    const what = how === "error"
      ? `The bot's code failed ${streak} times recently (the bot stayed in the room and skipped what failed)`
      : `The bot crashed ${streak} times in a row`;
    await this.add({ thread: `project:${project.id}`, projectId: project.id }, "user",
      `${what}. Its last output:\n${trace}\n\nFind the cause in the code, fix it, check it in the test room, then restart the bot and confirm in the logs that ${how === "error" ? "the error is gone" : "it stays up"}. Remember the lesson.`,
      "crash");
    log.info({ uuid, streak, how }, "Auto-fix started for a failing bot");
    const problem = how === "error" ? "an error" : "a crash";
    void this.run(uuid).then(async () => {
      const [last] = await this.db.select({ content: projectMessages.content }).from(projectMessages)
        .where(and(eq(projectMessages.thread, `project:${project.id}`), eq(projectMessages.role, "assistant"))).orderBy(desc(projectMessages.id)).limit(1);
      const summary = last?.content.trim().slice(0, 400) || `Kojy looked into ${problem} — see the chat.`;
      await notifyUser(this.db, project.ownerId, "bot_error", `Kojy worked on ${problem} in ${project.name}`, summary, `/studio/p/${uuid}`);
      void sendAlert(`🛠️ ${project.name} ${how === "error" ? "kept hitting an error" : "kept crashing"} — Kojy: ${summary}`);
    }).catch((err) => log.warn({ err, uuid }, "Auto-fix follow-up failed"));
  }
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
    case "edit_file": case "write_file": return `Editing${p}…`;
    case "search_code": return "Searching the code…";
    case "explore": return "A helper is reading the code…";
    case "web_search": return "Searching the web…";
    case "fetch_url": return "Reading a web page…";
    case "check_code": return "Checking the code (may install packages)…";
    case "test_in_room": return "Testing in a fake room…";
    case "test_secrets": return "Testing secrets…";
    case "bot_control": return `${String(args.action ?? "")} the bot…`;
    case "list_bots": return "Looking at your bots…";
    case "analytics": return "Checking the numbers…";
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


/** Kojy's own files (.kojy/), so a rollback of the code doesn't undo them. */
function readKojyFiles(uuid: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const root = projectDir(uuid);
  for (const f of listFiles(uuid)) if (!f.isDir && f.path.startsWith(`${KOJY_DIR}/`)) out.set(f.path, readFileSync(path.join(root, f.path)));
  return out;
}

function writeKojyFiles(uuid: string, files: Map<string, Buffer>): void {
  const root = projectDir(uuid);
  for (const [rel, data] of files) { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), data); }
}

/**
 * What went wrong since the restart, or null: the bot crashed or got stuck, or
 * a traceback points into a file the run changed (errors elsewhere may be old).
 */
export async function findProblem(db: Database, uuid: string, since: number, changed: string[]): Promise<string | null> {
  const lines = readLogs(uuid, undefined, 96 * 1024).lines.filter((l) => l.ts >= since);
  const text = (from: number) => lines.slice(Math.max(0, from - 1), from + 30).map((l) => l.line).join("\n").slice(0, 3000);
  const exited = lines.findIndex((l) => l.stream === "system" && /Bot exited/.test(l.line));
  if (exited >= 0) {
    const tb = lines.findIndex((l) => /Traceback \(most recent call last\)/.test(l.line));
    return `The bot crashed:\n${text(tb >= 0 ? tb : Math.max(0, exited - 15))}`;
  }
  const stuck = lines.findIndex((l) => /\[kojy\] Nothing from Highrise/.test(l.line));
  if (stuck >= 0) return `The bot got stuck and stopped talking to Highrise:\n${text(stuck)}`;
  for (let i = 0; i < lines.length; i++) {
    if (!/\[kojy\] Error in /.test(lines[i]!.line)) continue;
    const trace = lines.slice(i, i + 40).map((l) => l.line);
    const end = trace.findIndex((l, j) => j > 1 && !/^\s/.test(l) && !/^Traceback/.test(l));
    const body = trace.slice(0, end > 0 ? end + 1 : 30);
    if (changed.some((f) => body.some((l) => l.includes(`/${f}"`) || l.includes(`"${f}"`)))) return `A command failed in code this change touched:\n${body.join("\n")}`;
  }
  const [p] = await db.select({ status: botProjects.status, statusMessage: botProjects.statusMessage }).from(botProjects).where(eq(botProjects.uuid, uuid)).limit(1);
  if (p?.status === "error" && !/^Kicked out/.test(p.statusMessage ?? "")) return `The bot stopped with an error: ${p.statusMessage ?? ""}`;
  return null;
}
