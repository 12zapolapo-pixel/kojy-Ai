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
 * Stabilizer: when a bot crashes repeatedly with a Python traceback, the
 * supervisor calls onCrash and (if the project allows auto-fix) the AI is
 * started on the crash by itself — at most 3 times a day per project.
 */

import { and, desc, eq, gt } from "drizzle-orm";
import type { Redis } from "ioredis";
import { notifyUser, sendAlert, type Database } from "@kojyai/db";
import { botProjects, bots, projectMessages, projectSecrets } from "@kojyai/db/schema";
import { listFiles } from "@kojyai/shared/projects";
import type { Supervisor } from "../supervisor.js";
import { createLogger } from "../logger.js";
import { chat, estimateTokens, aiConfigured, currentEndpoint, AiUnavailableError, RequestTooLargeError, type ChatMessage, type ToolCall, type ToolSpec } from "./groq.js";
import { TOOL_SPECS, runTool, loadMemories, type ToolContext, type ToolResult } from "./tools.js";
import { systemPrompt, studioPrompt, jsBotPrompt } from "./prompt.js";
import { STUDIO_TOOL_SPECS, runStudioTool, studioSnapshot, type StudioContext } from "./studioTools.js";
import { JS_TOOL_SPECS, runJsTool, type JsContext } from "./jsTools.js";
import { runCheckups } from "./checkup.js";

const log = createLogger("agent");

const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS ?? 24);
const AUTOFIX_PER_DAY = 3;

type Row = typeof projectMessages.$inferSelect;

/** One conversation: where its messages live, its tools and its instructions. */
interface Scope {
  key: string;
  thread: string;
  projectId: number;
  tools: ToolSpec[];
  runTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  system(): Promise<string>;
  setState(state: "idle" | "working" | "waiting"): Promise<void>;
}

export const STUDIO_PREFIX = "studio-";
/** Key for a JS bot's chat: "jsbot-<bots.uuid>". */
export const JSBOT_PREFIX = "jsbot-";

export class Agent {
  private active = new Map<string, AbortController>();
  private again = new Set<string>();
  private autofixLog = new Map<string, number[]>();

  constructor(private db: Database, private supervisor: Supervisor, private redis: Redis | null) {
    supervisor.onCrash = (uuid, streak, tail) => void this.onCrash(uuid, streak, tail);
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
    const ctx: ToolContext = { db: this.db, supervisor: this.supervisor, project, snapshotted: false, changedFiles: new Set() };
    return {
      key, thread: `project:${project.id}`, projectId: project.id, tools: TOOL_SPECS,
      runTool: (name, args) => runTool(name, args, ctx),
      system: async () => {
        const [secrets, memories] = await Promise.all([
          this.db.select({ key: projectSecrets.key }).from(projectSecrets).where(eq(projectSecrets.projectId, project.id)),
          loadMemories(this.db, project),
        ]);
        return systemPrompt({
          projectName: project.name, entrypoint: ctx.project.entrypoint, status: project.status,
          secrets: secrets.map((x) => x.key), memories, fileCount: listFiles(project.uuid).filter((f) => !f.isDir).length,
        });
      },
      setState: async (state) => { await this.db.update(botProjects).set({ agentState: state }).where(eq(botProjects.id, project.id)); },
    };
  }

  async run(uuid: string): Promise<void> {
    if (this.active.has(uuid)) { this.again.add(uuid); return; }
    const abort = new AbortController();
    this.active.set(uuid, abort);
    try {
      do {
        this.again.delete(uuid);
        await this.runOnce(uuid, abort.signal);
      } while (this.again.has(uuid) && !abort.signal.aborted);
    } finally {
      this.active.delete(uuid);
      await this.progress(uuid, null);
    }
  }

  private async runOnce(uuid: string, signal: AbortSignal): Promise<void> {
    const scope = await this.scopeFor(uuid);
    if (!scope) return;
    await scope.setState("working");
    let finalState: "idle" | "waiting" = "idle";

    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        if (signal.aborted) { await this.add(scope, "assistant", "Stopped.", "event"); break; }
        await this.progress(uuid, step === 0 ? "Thinking…" : "Working…");

        let message: ChatMessage | undefined;
        // History sized for the AI that takes the request (Gemini's plan fits far
        // more than Groq's). Too big for the plan → try again with less (3 times).
        for (let shrink = 1; !message; shrink *= 2) {
          const budget = Math.floor((currentEndpoint()?.historyTokens ?? 3000) / shrink);
          try {
            ({ message } = await chat({
              messages: await this.buildMessages(scope, budget), tools: scope.tools, signal,
              onWait: (sec, why) => void this.progress(uuid, `Waiting ${sec}s (${why})…`),
            }));
          } catch (err) {
            if (!(err instanceof RequestTooLargeError) || shrink >= 8) throw err;
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
        if (step === MAX_STEPS - 1) {
          await this.add(scope, "assistant", "I've used my step limit for this task. Send “continue” and I'll pick up where I left off.", "event");
        }
      }
    } catch (err) {
      const text = err instanceof AiUnavailableError ? err.message : `Something went wrong: ${(err as Error).message}`;
      if (!(err instanceof AiUnavailableError)) log.error({ err, uuid }, "Agent run failed");
      await this.add(scope, "assistant", text, "error");
    } finally {
      await scope.setState(finalState);
    }
  }

  /**
   * System prompt + as much recent history as fits the budget. Older tool
   * results are shrunk to their one-line summary; the history always starts at
   * a user message so tool calls and their results stay paired.
   */
  private async buildMessages(scope: Scope, historyTokens: number): Promise<ChatMessage[]> {
    const [rowsDesc, system] = await Promise.all([
      this.db.select().from(projectMessages).where(eq(projectMessages.thread, scope.thread)).orderBy(desc(projectMessages.id)).limit(80),
      scope.system(),
    ]);
    const rows = rowsDesc.reverse().filter((r) => r.kind !== "error");
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
      if (cost > budget && i < lastUser) break;
      budget -= cost;
      picked.unshift(m);
    }
    // Start at a user message, whether the budget or the 80-row window did the
    // cutting: a history that begins mid-task leaves a tool result without its
    // call, and Gemini refuses a tool call that doesn't follow a user turn (400).
    let start = 0;
    while (start < picked.length && picked[start]!.role !== "user") start++;
    if (start === picked.length) start = 0; // no user message at all: keep what there is
    const history = pairToolCalls(picked.slice(start));

    return [{ role: "system", content: system }, ...history];
  }

  // ── stabilizer ─────────────────────────────────────────────────────────────

  private async onCrash(uuid: string, streak: number, tail: string[]): Promise<void> {
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
    await this.add({ thread: `project:${project.id}`, projectId: project.id }, "user",
      `The bot crashed ${streak} times in a row. Its last output:\n${trace}\n\nFind the cause in the code, fix it, check it in the test room, then restart the bot and confirm in the logs that it stays up. Remember the lesson.`,
      "crash");
    log.info({ uuid, streak }, "Auto-fix started for a crashing bot");
    void this.run(uuid).then(async () => {
      const [last] = await this.db.select({ content: projectMessages.content }).from(projectMessages)
        .where(and(eq(projectMessages.thread, `project:${project.id}`), eq(projectMessages.role, "assistant"))).orderBy(desc(projectMessages.id)).limit(1);
      const summary = last?.content.trim().slice(0, 400) || "Kojy looked into the crash — see the chat.";
      await notifyUser(this.db, project.ownerId, "bot_error", `Kojy worked on a crash in ${project.name}`, summary, `/studio/p/${uuid}`);
      void sendAlert(`🛠️ ${project.name} kept crashing — Kojy: ${summary}`);
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

