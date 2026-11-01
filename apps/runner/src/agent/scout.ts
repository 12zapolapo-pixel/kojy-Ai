/**
 * Code scout: Groq reads the project so Gemini doesn't have to.
 * OWNERSHIP: apps/runner/src/agent
 *
 * Gemini's free plan counts requests (about 20 a day per model), and most of
 * a task's steps are reading: list, search, read, read again. The main AI asks
 * explore() one question; a Groq model runs those reading steps with read-only
 * tools and answers with its findings and the exact code lines, so the main AI
 * spends one step instead of many. To fit Groq's small per-request budget,
 * only the newest readings stay in full; older ones shrink to their summary.
 */

import { chat, AiUnavailableError, RequestTooLargeError, type ChatMessage, type ToolSpec } from "./groq.js";
import type { ToolContext, ToolResult } from "./tools.js";

/** What the scout may use: reading only, nothing that changes the bot or costs the owner anything. */
export const SCOUT_TOOLS = new Set(["list_files", "read_file", "search_code", "sdk_lookup", "get_logs", "room_insights", "find_env_vars", "find_emotes"]);
const MAX_STEPS = 10;

const SCOUT_PROMPT = `You are the code scout for Kojy, a senior coder AI working on a Highrise bot (Python, highrise-bot-sdk). Kojy asked you a question about the project. Find the answer by reading the code with your tools: search first, then read only the line ranges you need.
Answer for Kojy, not for the owner, in this shape:
Findings: the answer in a few sentences, with file:line for every claim.
Code: the exact lines that matter, copied verbatim with their line numbers (at most ~60 lines in all).
Not checked: anything you couldn't find or didn't look at.
Never guess: if the code doesn't show it, say so. Don't suggest big rewrites.`;

export interface ScoutAnswer { answer: string; model: string; reads: string[] }

/**
 * Old results shrink to their one-line summary so a long search still fits
 * Groq's plan; the newest `keep` stay whole.
 */
export function shrinkOld(messages: ChatMessage[], summaries: Map<string, string>, keep: number): ChatMessage[] {
  const toolIdx = messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
  const old = new Set(toolIdx.slice(0, Math.max(0, toolIdx.length - keep)));
  return messages.map((m, i) => (old.has(i) && m.role === "tool" ? { ...m, content: `(read earlier) ${summaries.get(m.tool_call_id ?? "") ?? ""}` } : m));
}

export async function explore(
  question: string, tools: ToolSpec[], run: (name: string, args: Record<string, unknown>) => Promise<ToolResult>, signal?: AbortSignal,
): Promise<ScoutAnswer> {
  const specs = tools.filter((t) => SCOUT_TOOLS.has(t.function.name));
  const messages: ChatMessage[] = [{ role: "system", content: SCOUT_PROMPT }, { role: "user", content: question.slice(0, 2000) }];
  const summaries = new Map<string, string>();
  const reads: string[] = [];
  let model = "";
  for (let step = 0; step < MAX_STEPS; step++) {
    const last = step === MAX_STEPS - 1;
    let reply: ChatMessage | undefined;
    for (let keep = 3; !reply; keep--) {
      try {
        const r = await chat({
          messages: last ? [...shrinkOld(messages, summaries, keep), { role: "user", content: "That's enough reading: answer now in the shape asked." }] : shrinkOld(messages, summaries, keep),
          tools: last ? [] : specs, group: "groq", ...(signal ? { signal } : {}),
        });
        reply = r.message; model = r.model;
      } catch (err) {
        if (!(err instanceof RequestTooLargeError) || keep <= 0) throw err;
      }
    }
    const calls = (reply.tool_calls ?? []).filter((c) => SCOUT_TOOLS.has(c.function.name)).slice(0, 4);
    if (!calls.length) return { answer: (reply.content ?? "").trim() || "(the scout found nothing to report)", model, reads };
    messages.push({ role: "assistant", content: reply.content ?? null, tool_calls: calls });
    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* the tool says what's missing */ }
      const result = await run(call.function.name, args);
      summaries.set(call.id, result.summary);
      reads.push(result.summary);
      // A read can be long; Groq's plan can't hold several whole files.
      messages.push({ role: "tool", tool_call_id: call.id, content: result.output.length > 5000 ? `${result.output.slice(0, 5000)}\n… (cut; read a narrower range)` : result.output });
    }
  }
  throw new AiUnavailableError("The scout ran out of steps.");
}

/** The explore tool for the main AI. Falls back to "read it yourself" when Groq isn't set up or is busy. */
export async function exploreTool(question: string, ctx: Pick<ToolContext, "signal">, tools: ToolSpec[], run: (name: string, args: Record<string, unknown>) => Promise<ToolResult>): Promise<ToolResult> {
  if (!question.trim()) return { ok: false, output: "Ask a question, e.g. 'Where is !request handled and what does it save?'", summary: "Empty question" };
  try {
    const r = await explore(question, tools, run, ctx.signal);
    return {
      ok: true,
      output: `Scout (${r.model}) read: ${r.reads.join("; ") || "nothing"}\n\n${r.answer}\n\n(Check the lines you'll change with read_file before editing.)`,
      summary: `Explored: ${question.slice(0, 60)} (${r.reads.length} reads by ${r.model.split("/").pop()})`,
    };
  } catch (err) {
    const why = err instanceof AiUnavailableError ? err.message : (err as Error).message;
    return { ok: false, output: `The scout couldn't help (${why.slice(0, 200)}). Read the files yourself with search_code and read_file.`, summary: "Scout unavailable, reading directly" };
  }
}
