/**
 * Kojy's work log: what each owner request asked for, how it ended, which
 * files changed and which steps ran. One row per request (agent_work_log),
 * updated after every part of the request. It is read back into the prompt
 * (recent entries) and through the work_log / search_chat tools, so Kojy
 * keeps track of past work even after the chat is cleared or cut to fit.
 * OWNERSHIP: apps/runner/src/agent
 */

import { and, desc, eq, ilike, inArray, or } from "drizzle-orm";
import type { Database } from "@kojyai/db";
import { agentWorkLog, projectMessages } from "@kojyai/db/schema";
import type { ToolSpec } from "./groq.js";
import { requestIndex } from "./taskMemory.js";

export type WorkStatus = "done" | "waiting_for_owner" | "in_progress" | "paused" | "stopped" | "error";

export interface WorkRow {
  id: number;
  role: string;
  kind: string;
  content: string;
  data: Record<string, unknown> | null;
  createdAt: Date;
}

export interface FileChange { path: string; change: "wrote" | "edited" | "deleted" }

export interface WorkSummary {
  requestMessageId: number;
  request: string;
  summary: string;
  files: FileChange[];
  actions: string[];
  failed: string[];
  startedAt: Date;
}

const FILE_TOOLS: Record<string, FileChange["change"]> = { write_file: "wrote", edit_file: "edited", delete_file: "deleted" };
export const REQUEST_MAX = 2000;
export const SUMMARY_MAX = 1500;
const ACTIONS_MAX = 40;
const FAILED_MAX = 20;

/** Builds the log entry for the current request from the stored chat (oldest first). */
export function summarizeWork(rows: WorkRow[]): WorkSummary | null {
  const start = requestIndex(rows);
  if (start < 0) return null;
  const req = rows[start]!;

  // tool call id -> the file it targets, from the assistant's calls.
  const callFile = new Map<string, FileChange>();
  for (const r of rows.slice(start + 1)) {
    if (r.role !== "assistant") continue;
    const calls = (r.data as { toolCalls?: { id: string; function: { name: string; arguments: string } }[] } | null)?.toolCalls ?? [];
    for (const c of calls) {
      const change = FILE_TOOLS[c.function.name];
      if (!change) continue;
      let path = "";
      try { path = String((JSON.parse(c.function.arguments || "{}") as { path?: unknown }).path ?? ""); } catch { /* malformed call */ }
      if (path) callFile.set(c.id, { path, change });
    }
  }

  const files: FileChange[] = [];
  const actions: string[] = [];
  const failed: string[] = [];
  let summary = "";
  for (const r of rows.slice(start + 1)) {
    if (r.role === "tool") {
      const d = (r.data ?? {}) as { toolCallId?: string; summary?: string; ok?: boolean };
      const line = (d.summary ?? "").replace(/\s+/g, " ").slice(0, 160);
      if (d.ok === false) { if (line) failed.push(line); continue; }
      if (line) actions.push(line);
      const f = d.toolCallId ? callFile.get(d.toolCallId) : undefined;
      if (f) {
        const prev = files.findIndex((x) => x.path === f.path);
        if (prev >= 0) files.splice(prev, 1);
        files.push(f);
      }
    } else if (r.role === "assistant" && r.kind === "text" && r.content.trim()) {
      summary = r.content.trim(); // the latest thing Kojy told the owner
    }
  }
  return {
    requestMessageId: req.id,
    request: req.content.slice(0, REQUEST_MAX),
    summary: summary.slice(0, SUMMARY_MAX),
    files,
    actions: actions.slice(-ACTIONS_MAX),
    failed: failed.slice(-FAILED_MAX),
    startedAt: req.createdAt,
  };
}

/** Writes (or updates) the log entry for the thread's current request. Never throws. */
export async function recordWork(db: Database, thread: string, projectId: number, status: WorkStatus): Promise<void> {
  try {
    const rowsDesc = await db.select({
      id: projectMessages.id, role: projectMessages.role, kind: projectMessages.kind,
      content: projectMessages.content, data: projectMessages.data, createdAt: projectMessages.createdAt,
    }).from(projectMessages).where(eq(projectMessages.thread, thread)).orderBy(desc(projectMessages.id)).limit(400);
    const work = summarizeWork(rowsDesc.reverse().filter((r) => r.kind !== "error"));
    if (!work) return;
    const values = {
      thread, projectId, requestMessageId: work.requestMessageId, request: work.request, status,
      summary: work.summary, files: work.files, actions: work.actions, failed: work.failed, startedAt: work.startedAt,
    };
    await db.insert(agentWorkLog).values(values).onConflictDoUpdate({
      target: [agentWorkLog.thread, agentWorkLog.requestMessageId],
      set: { status, summary: work.summary, files: work.files, actions: work.actions, failed: work.failed, updatedAt: new Date() },
    });
  } catch {
    // The log is a help, never a reason for a request to fail.
  }
}

type LogEntry = typeof agentWorkLog.$inferSelect;

const day = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function formatEntry(e: Pick<LogEntry, "status" | "request" | "summary" | "files" | "updatedAt">, short = true): string {
  const files = e.files.slice(0, short ? 5 : 30).map((f) => `${f.change} ${f.path}`).join(", ");
  const more = e.files.length > (short ? 5 : 30) ? ` (+${e.files.length - (short ? 5 : 30)} more)` : "";
  const parts = [`${day(e.updatedAt)} UTC · ${e.status} · "${clip(e.request.replace(/\s+/g, " "), short ? 100 : 400)}"`];
  if (files) parts.push(`files: ${files}${more}`);
  if (e.summary) parts.push(`result: ${clip(e.summary.replace(/\s+/g, " "), short ? 160 : 600)}`);
  return parts.join(" → ");
}

/** The "recent work" block for the system prompt (oldest first), skipping the current request. */
export function recentWorkPrompt(entries: LogEntry[], currentRequest: string | null): string {
  const shown = entries
    .filter((e) => !(currentRequest && e.request.slice(0, 1200) === currentRequest.slice(0, 1200)))
    .slice(0, 6)
    .reverse();
  if (!shown.length) return "";
  return ["", "## Work log of this chat (earlier requests, newest last — use work_log for more, search_chat for what was said)",
    ...shown.map((e) => `- ${formatEntry(e)}`)].join("\n");
}

export async function recentWork(db: Database, thread: string, limit = 8): Promise<LogEntry[]> {
  return db.select().from(agentWorkLog).where(eq(agentWorkLog.thread, thread)).orderBy(desc(agentWorkLog.updatedAt)).limit(limit);
}

// ── tools ─────────────────────────────────────────────────────────────────────

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolSpec => ({
  type: "function", function: { name, description, parameters: { type: "object", properties, required } },
});

export const MEMORY_TOOL_SPECS: ToolSpec[] = [
  fn("work_log", "Look up earlier requests in this chat and what was done for each (status, files changed, result). Search by a word, or leave empty for the latest.",
    { query: { type: "string", description: "word to search for in requests, results and file names (optional)" }, limit: { type: "integer", description: "how many (max 15)" } }),
  fn("search_chat", "Search everything the owner and you said earlier in this chat, including messages too old to be in view. Use it instead of asking the owner to repeat themselves.",
    { query: { type: "string", description: "word or short phrase to find" } }, ["query"]),
];
export const MEMORY_TOOL_NAMES = new Set(MEMORY_TOOL_SPECS.map((t) => t.function.name));

/** Escapes LIKE wildcards so the owner's words are matched literally. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function runMemoryTool(name: string, args: Record<string, unknown>, ctx: { db: Database; thread: string }):
  Promise<{ ok: boolean; output: string; summary: string }> {
  const query = typeof args.query === "string" ? args.query.trim().slice(0, 100) : "";
  if (name === "work_log") {
    const limit = Math.min(15, Math.max(1, Number(args.limit) || 8));
    const where = query
      ? and(eq(agentWorkLog.thread, ctx.thread), or(
          ilike(agentWorkLog.request, likePattern(query)),
          ilike(agentWorkLog.summary, likePattern(query)),
        ))
      : eq(agentWorkLog.thread, ctx.thread);
    let rows = await ctx.db.select().from(agentWorkLog).where(where).orderBy(desc(agentWorkLog.updatedAt)).limit(limit);
    if (query && rows.length < limit) {
      // File names live in JSON; check them in code to keep the query simple.
      const extra = (await recentWork(ctx.db, ctx.thread, 100))
        .filter((e) => !rows.some((r) => r.id === e.id) && e.files.some((f) => f.path.toLowerCase().includes(query.toLowerCase())));
      rows = [...rows, ...extra].slice(0, limit);
    }
    if (!rows.length) return { ok: true, output: query ? `No earlier requests mention “${query}”.` : "No earlier requests in this chat yet.", summary: "Checked the work log" };
    return {
      ok: true,
      output: rows.map((e) => `- ${formatEntry(e, false)}${e.failed.length ? ` → failed steps: ${e.failed.slice(-5).join("; ")}` : ""}`).join("\n"),
      summary: `Checked the work log (${rows.length} ${rows.length === 1 ? "entry" : "entries"})`,
    };
  }
  if (name === "search_chat") {
    if (query.length < 2) return { ok: false, output: "Give a word or phrase to search for.", summary: "Chat search needs a word" };
    const rows = await ctx.db.select({ role: projectMessages.role, content: projectMessages.content, createdAt: projectMessages.createdAt })
      .from(projectMessages)
      .where(and(eq(projectMessages.thread, ctx.thread), inArray(projectMessages.role, ["user", "assistant"]), ilike(projectMessages.content, likePattern(query))))
      .orderBy(desc(projectMessages.id)).limit(15);
    if (!rows.length) return { ok: true, output: `Nothing in this chat mentions “${query}”.`, summary: `Searched the chat for “${clip(query, 30)}”` };
    const out = rows.reverse().map((r) => {
      const text = r.content.replace(/\s+/g, " ");
      const at = text.toLowerCase().indexOf(query.toLowerCase());
      const from = Math.max(0, at - 80);
      return `- ${day(r.createdAt)} UTC · ${r.role === "user" ? "owner" : "Kojy"}: ${from > 0 ? "…" : ""}${text.slice(from, from + 240)}${from + 240 < text.length ? "…" : ""}`;
    });
    return { ok: true, output: out.join("\n"), summary: `Searched the chat for “${clip(query, 30)}” (${rows.length} found)` };
  }
  return { ok: false, output: `Unknown memory tool ${name}`, summary: "Unknown tool" };
}
