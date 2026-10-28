/**
 * Groq chat client for the coder AI — OpenAI-compatible, with tool calls.
 * OWNERSHIP: apps/runner/src/agent
 *
 * Built for Groq's free plan (per model: ~8K tokens/minute, ~200K/day):
 *   - paces itself: waits before a request that would go over the minute budget
 *   - on 429 it waits for `retry-after` and tries again
 *   - when the main model's daily budget is used up it moves to the fast model
 * GROQ_BASE_URL can point at any OpenAI-compatible server (used by tests).
 */

import { createLogger } from "../logger.js";

const log = createLogger("agent-groq");

export interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
export interface ToolSpec { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }

export class AiUnavailableError extends Error {}
/** The request is over the plan's per-request size; retry with less history. */
export class RequestTooLargeError extends AiUnavailableError {}

const BASE_URL = (process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1").replace(/\/$/, "");
const SMART = process.env.AGENT_MODEL ?? process.env.GROQ_MODEL_SMART ?? "openai/gpt-oss-120b";
const FAST = process.env.AGENT_FALLBACK_MODEL ?? process.env.GROQ_MODEL_FAST ?? "openai/gpt-oss-20b";
const TOKENS_PER_MINUTE = Number(process.env.AGENT_TOKENS_PER_MINUTE ?? 7500);

/** Rough size of a request: ~4 characters per token. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

// Tokens sent in the last minute, per model — shared by every project.
const recent = new Map<string, { at: number; tokens: number }[]>();
const exhaustedUntil = new Map<string, number>();

function usedLastMinute(model: string): number {
  const now = Date.now();
  const list = (recent.get(model) ?? []).filter((r) => now - r.at < 60_000);
  recent.set(model, list);
  return list.reduce((n, r) => n + r.tokens, 0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ChatOptions {
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxTokens?: number;
  /** Called while waiting on rate limits, so the chat can say so. */
  onWait?: (seconds: number, why: string) => void;
  signal?: AbortSignal;
}

export async function chat(opts: ChatOptions): Promise<{ message: ChatMessage; model: string }> {
  const key = process.env.GROQ_API_KEY;
  if (!key || key.includes("placeholder")) {
    throw new AiUnavailableError("The coder AI needs a Groq key: set GROQ_API_KEY in the server's .env (free at console.groq.com/keys).");
  }
  const maxTokens = opts.maxTokens ?? Number(process.env.AGENT_MAX_OUTPUT_TOKENS ?? 1200);
  const size = estimateTokens(JSON.stringify(opts.messages)) + estimateTokens(JSON.stringify(opts.tools)) + maxTokens;

  for (let attempt = 0; attempt < 6; attempt++) {
    if (opts.signal?.aborted) throw new AiUnavailableError("Stopped.");
    const model = (exhaustedUntil.get(SMART) ?? 0) > Date.now() ? FAST : SMART;

    const used = usedLastMinute(model);
    if (used > 0 && used + size > TOKENS_PER_MINUTE) {
      const oldest = recent.get(model)![0]!;
      const wait = Math.max(1, Math.ceil((60_000 - (Date.now() - oldest.at)) / 1000));
      opts.onWait?.(wait, "pacing for the free AI plan");
      await sleep(wait * 1000);
      continue;
    }

    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      signal: opts.signal ?? AbortSignal.timeout(120_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: opts.messages,
        tools: opts.tools,
        tool_choice: "auto",
        temperature: 0.2,
        max_tokens: maxTokens + 800, // headroom for gpt-oss reasoning tokens
        reasoning_effort: "medium",
      }),
    }).catch((err: Error) => {
      if (opts.signal?.aborted) throw new AiUnavailableError("Stopped.");
      throw new AiUnavailableError(`Couldn't reach the AI: ${err.message}`);
    });
    recent.get(model)!.push({ at: Date.now(), tokens: size });

    if (res.ok) {
      const body = await res.json() as { choices?: { message: ChatMessage }[] };
      const message = body.choices?.[0]?.message;
      if (!message) throw new AiUnavailableError("The AI returned an empty answer.");
      return { message: { role: "assistant", content: message.content ?? null, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) }, model };
    }

    const text = await res.text().catch(() => "");
    if (res.status === 429) {
      if (/Request too large/i.test(text)) throw new RequestTooLargeError("The conversation got too big for the free AI plan.");
      if (/per day|TPD|RPD/i.test(text)) {
        if (model === SMART && FAST !== SMART) {
          exhaustedUntil.set(SMART, Date.now() + 60 * 60_000);
          log.warn("Daily AI budget used up on the main model — switching to the fast model for an hour");
          continue;
        }
        throw new AiUnavailableError("The free AI plan's daily limit is used up. It resets within 24 hours (or add a paid Groq key).");
      }
      const wait = Math.min(65, Number(res.headers.get("retry-after")) || 20);
      opts.onWait?.(wait, "AI rate limit");
      await sleep(wait * 1000);
      continue;
    }
    if (res.status === 400 && /tool_use_failed|failed_generation/i.test(text) && attempt < 2) {
      // The model wrote a malformed tool call; asking again usually works.
      log.warn("Malformed tool call from the model — retrying");
      continue;
    }
    if (res.status === 413 || (res.status === 400 && /too large|context_length|maximum context/i.test(text))) {
      throw new RequestTooLargeError("The conversation got too big for the free AI plan. Start a new chat or ask about one thing at a time.");
    }
    if (res.status >= 500) { await sleep(3000 * (attempt + 1)); continue; }
    throw new AiUnavailableError(`AI request failed (${res.status}): ${text.slice(0, 300)}`);
  }
  throw new AiUnavailableError("The AI is busy right now — try again in a minute.");
}
