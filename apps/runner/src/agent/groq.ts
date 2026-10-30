/**
 * Chat client for the coder AI — any OpenAI-compatible server, with tool calls.
 * OWNERSHIP: apps/runner/src/agent
 *
 * Kojy uses these AIs, best first (see endpoints()):
 *   1. AGENT_API_KEY — a bigger free plan: Google Gemini by default
 *      (AGENT_BASE_URL / AGENT_MODEL pick another OpenAI-compatible one)
 *   2. GROQ_API_KEY — Groq's free plan: gpt-oss-120b, then gpt-oss-20b
 * Each has its own budgets: Groq's free plan (per model: ~8K tokens/minute,
 * ~200K/day) only fits a short history and answer; Gemini's fits whole files.
 *   - paces itself: waits before a request that would go over the minute budget
 *   - on 429 it waits for the retry time and tries again
 *   - when an AI's daily budget is used up, its key is refused or it keeps
 *     failing, it moves to the next AI for a while
 * GROQ_BASE_URL can point at any OpenAI-compatible server (used by tests).
 */

import { createLogger } from "../logger.js";

const log = createLogger("agent-groq");

export interface ToolCall {
  id: string; type: "function"; function: { name: string; arguments: string };
  /** Gemini 3 puts its thought signature here; it must be sent back unchanged. */
  extra_content?: Record<string, unknown>;
}
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

/** One AI Kojy can use, with the budgets its plan allows. */
export interface Endpoint {
  /** For logs, and the key for pacing and skipping. */
  id: string;
  baseUrl: string;
  key: string;
  model: string;
  /** "gemini": keeps Gemini 3's thought signatures and its default temperature. */
  kind: "gemini" | "openai";
  tokensPerMinute: number;
  /** Earlier conversation sent with each request (the current task always goes in full). */
  historyTokens: number;
  maxOutputTokens: number;
  /** Room on top of the answer for the model's reasoning tokens. */
  reasoningTokens: number;
  reasoningEffort?: string;
}

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const GROQ_URL = "https://api.groq.com/openai/v1";

/** A positive number setting, or the default. */
const setting = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const trimSlash = (url: string) => url.replace(/\/+$/, "");

/** The AIs Kojy can use, best first. Read on every call, so a changed setting applies at once. */
export function endpoints(env: NodeJS.ProcessEnv = process.env): Endpoint[] {
  const list: Endpoint[] = [];
  const agentKey = env.AGENT_API_KEY;
  if (agentKey) {
    const baseUrl = trimSlash(env.AGENT_BASE_URL ?? GEMINI_URL);
    const gemini = baseUrl.includes("generativelanguage.googleapis.com");
    const effort = env.AGENT_REASONING_EFFORT ?? (gemini ? "medium" : undefined);
    list.push({
      id: "agent", baseUrl, key: agentKey, model: env.AGENT_MODEL ?? "gemini-3.8-flash", kind: gemini ? "gemini" : "openai",
      tokensPerMinute: setting(env.AGENT_TOKENS_PER_MINUTE, 200_000),
      historyTokens: setting(env.AGENT_HISTORY_TOKENS, 30_000),
      maxOutputTokens: setting(env.AGENT_MAX_OUTPUT_TOKENS, 8000),
      reasoningTokens: 8000,
      ...(effort && effort !== "none" ? { reasoningEffort: effort } : {}),
    });
  }
  const groqKey = env.GROQ_API_KEY;
  if (groqKey && !groqKey.includes("placeholder")) {
    // Without AGENT_API_KEY the AGENT_* settings keep their old meaning: Kojy's Groq settings.
    const own: NodeJS.ProcessEnv = agentKey ? {} : env;
    const smart = own.AGENT_MODEL ?? env.GROQ_MODEL_SMART ?? "openai/gpt-oss-120b";
    const fast = env.AGENT_FALLBACK_MODEL ?? env.GROQ_MODEL_FAST ?? "openai/gpt-oss-20b";
    const groq = (model: string): Endpoint => ({
      id: `groq:${model}`, baseUrl: trimSlash(env.GROQ_BASE_URL ?? GROQ_URL), key: groqKey, model, kind: "openai",
      tokensPerMinute: setting(own.AGENT_TOKENS_PER_MINUTE, 7500),
      historyTokens: setting(own.AGENT_HISTORY_TOKENS, 3000),
      maxOutputTokens: setting(own.AGENT_MAX_OUTPUT_TOKENS, 1200),
      reasoningTokens: 800, // headroom for gpt-oss reasoning tokens
      reasoningEffort: "medium",
    });
    list.push(groq(smart));
    if (fast !== smart) list.push(groq(fast));
  }
  return list;
}

export const aiConfigured = () => endpoints().length > 0;

/** Rough size of a request: ~4 characters per token. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

// Tokens sent in the last minute, per AI — shared by every project.
const recent = new Map<string, { at: number; tokens: number }[]>();
// AIs left out until a time (daily budget used up, key refused, outage), and why.
const skipped = new Map<string, { until: number; why: string }>();

const available = (e: Endpoint) => (skipped.get(e.id)?.until ?? 0) <= Date.now();

/** The AI the next request goes to, or undefined when none is set up or all are skipped. */
export function currentEndpoint(): Endpoint | undefined {
  return endpoints().find(available);
}

/** For tests: forget pacing and skipped AIs. */
export function resetAiState(): void {
  recent.clear();
  skipped.clear();
}

function usedLastMinute(id: string): number {
  const now = Date.now();
  const list = (recent.get(id) ?? []).filter((r) => now - r.at < 60_000);
  recent.set(id, list);
  return list.reduce((n, r) => n + r.tokens, 0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Seconds to wait from a 429: the retry-after header, or Gemini's "retry in 33.6s" / retryDelay. */
function retrySeconds(res: Response, text: string): number | null {
  const header = Number(res.headers.get("retry-after"));
  if (header > 0) return Math.ceil(header);
  const m = /retry in ([\d.]+)\s*s/i.exec(text) ?? /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(text);
  return m ? Math.ceil(Number(m[1])) : null;
}

/**
 * The request body for one AI. Gemini 3 gets its thought signatures back and
 * keeps its default temperature (lower values can make it loop); other AIs
 * get standard tool calls only, since extra fields can be refused.
 */
export function requestBody(ep: Endpoint, messages: ChatMessage[], tools: ToolSpec[], maxTokens: number): Record<string, unknown> {
  const msgs = ep.kind === "gemini" ? messages : messages.map((m) => (m.tool_calls?.length
    ? { ...m, tool_calls: m.tool_calls.map(({ id, type, function: f }) => ({ id, type, function: f })) }
    : m));
  // A tool without settings goes without "parameters"; Gemini refuses an empty object schema.
  const specs = ep.kind !== "gemini" ? tools : tools.map((t) => {
    const params: Record<string, unknown> = { ...t.function.parameters };
    const fn: Record<string, unknown> = { ...t.function, parameters: params };
    if (Array.isArray(params.required) && !params.required.length) delete params.required;
    const props = params.properties as Record<string, unknown> | undefined;
    if (!props || !Object.keys(props).length) delete fn.parameters;
    return { ...t, function: fn };
  });
  return {
    model: ep.model,
    messages: msgs,
    tools: specs,
    tool_choice: "auto",
    max_tokens: maxTokens + ep.reasoningTokens,
    ...(ep.kind === "gemini" ? {} : { temperature: 0.2 }),
    ...(ep.reasoningEffort ? { reasoning_effort: ep.reasoningEffort } : {}),
  };
}

export interface ChatOptions {
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxTokens?: number;
  /** Called while waiting on rate limits, so the chat can say so. */
  onWait?: (seconds: number, why: string) => void;
  signal?: AbortSignal;
}

export async function chat(opts: ChatOptions): Promise<{ message: ChatMessage; model: string }> {
  const all = endpoints();
  if (!all.length) {
    throw new AiUnavailableError("The coder AI needs an AI key: set AGENT_API_KEY (a free Gemini key from aistudio.google.com/apikey) or GROQ_API_KEY (free at console.groq.com/keys) in the server's .env.");
  }
  const skip = (ep: Endpoint, ms: number, why: string) => skipped.set(ep.id, { until: Date.now() + ms, why });
  let serverErrors = 0;

  for (let attempt = 0; attempt < 8; attempt++) {
    if (opts.signal?.aborted) throw new AiUnavailableError("Stopped.");
    const ep = all.find(available);
    if (!ep) {
      const why = all.map((e) => skipped.get(e.id)?.why).filter(Boolean).pop();
      throw new AiUnavailableError(why ?? "The AI is busy right now — try again in a minute.");
    }
    const hasNext = all.some((e) => e !== ep && available(e));
    const maxTokens = opts.maxTokens ?? ep.maxOutputTokens;
    const body = requestBody(ep, opts.messages, opts.tools, maxTokens);
    const size = estimateTokens(JSON.stringify(body.messages)) + estimateTokens(JSON.stringify(body.tools)) + maxTokens;

    const used = usedLastMinute(ep.id);
    if (used > 0 && used + size > ep.tokensPerMinute) {
      const oldest = recent.get(ep.id)![0]!;
      const wait = Math.max(1, Math.ceil((60_000 - (Date.now() - oldest.at)) / 1000));
      opts.onWait?.(wait, "pacing for the free AI plan");
      await sleep(wait * 1000);
      continue;
    }

    let res: Response;
    try {
      res = await fetch(`${ep.baseUrl}/chat/completions`, {
        method: "POST",
        signal: opts.signal ?? AbortSignal.timeout(120_000),
        headers: { "content-type": "application/json", authorization: `Bearer ${ep.key}` },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (opts.signal?.aborted) throw new AiUnavailableError("Stopped.");
      if (!hasNext) throw new AiUnavailableError(`Couldn't reach the AI: ${(err as Error).message}`);
      log.warn({ ai: ep.id, err: (err as Error).message }, "Couldn't reach the AI — using the next one for 5 minutes");
      skip(ep, 5 * 60_000, `Couldn't reach the AI: ${(err as Error).message}`);
      continue;
    }
    recent.get(ep.id)!.push({ at: Date.now(), tokens: size });

    if (res.ok) {
      const data = await res.json() as { choices?: { message: ChatMessage }[] };
      const message = data.choices?.[0]?.message;
      if (!message) throw new AiUnavailableError("The AI returned an empty answer.");
      return { message: { role: "assistant", content: message.content ?? null, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) }, model: ep.model };
    }

    const text = await res.text().catch(() => "");
    if (res.status === 429) {
      if (/Request too large/i.test(text)) throw new RequestTooLargeError("The conversation got too big for the free AI plan.");
      // Groq says "tokens per day (TPD)"; Gemini "GenerateRequestsPerDayPerProjectPerModel".
      if (/per ?day|TPD|RPD/i.test(text)) {
        log.warn({ ai: ep.id }, "Daily AI budget used up — using the next AI for an hour");
        skip(ep, 60 * 60_000, "The free AI plans' daily limits are used up. They reset within 24 hours (or add a paid key).");
        continue;
      }
      const wait = Math.min(65, retrySeconds(res, text) ?? 20);
      opts.onWait?.(wait, "AI rate limit");
      await sleep(wait * 1000);
      continue;
    }
    if (res.status === 400 && /tool_use_failed|failed_generation/i.test(text) && attempt < 2) {
      // The model wrote a malformed tool call; asking again usually works.
      log.warn("Malformed tool call from the model — retrying");
      continue;
    }
    if (res.status === 413 || (res.status === 400 && /too large|context_length|maximum context|exceeds the maximum/i.test(text))) {
      throw new RequestTooLargeError("The conversation got too big for the free AI plan. Start a new chat or ask about one thing at a time.");
    }
    if (res.status === 401 || res.status === 403) {
      // A wrong or revoked key: say so in the chat, but keep Kojy working on the next AI.
      log.warn({ ai: ep.id, status: res.status }, "The AI refused the key — using the next AI for an hour");
      skip(ep, 60 * 60_000, `The AI refused its key (${res.status}): ${text.slice(0, 300)}`);
      continue;
    }
    if (res.status >= 500) {
      if (++serverErrors >= 2 && hasNext) {
        log.warn({ ai: ep.id, status: res.status }, "The AI keeps failing — using the next AI for 5 minutes");
        skip(ep, 5 * 60_000, `The AI service is having problems (${res.status}).`);
        serverErrors = 0;
        continue;
      }
      await sleep(3000 * (attempt + 1));
      continue;
    }
    throw new AiUnavailableError(`AI request failed (${res.status}): ${text.slice(0, 300)}`);
  }
  throw new AiUnavailableError("The AI is busy right now — try again in a minute.");
}
