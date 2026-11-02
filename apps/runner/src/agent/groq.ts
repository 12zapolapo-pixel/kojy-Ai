/**
 * AI client for the coder AI: OpenAI-compatible chat with tool calls.
 * OWNERSHIP: apps/runner/src/agent
 *
 * Providers, in the order they are tried:
 *   1. Mistral (MISTRAL_API_KEY; models from MISTRAL_MODELS, default
 *      mistral-large-4 then mistral-large-2512 = Mistral Large 3).
 *   2. Gemini (Google AI Studio, OpenAI-compatible endpoint). Every key is
 *      tried with every model: keys come from AGENT_API_KEY and
 *      AGENT_API_KEYS (comma-separated), models from GEMINI_MODELS.
 *   3. Groq (optional, GROQ_API_KEY): the main and fast models, paced to the
 *      free plan's per-minute token budget.
 *
 * Each (key, model) pair is a "lane". A lane that hits its limit (429), fails
 * its key (401/403) or doesn't exist (404) is put on cooldown and the next
 * lane is tried straight away, so one exhausted key never stops the work.
 * Keys are never logged.
 *
 * GEMINI_BASE_URL / GROQ_BASE_URL can point at any OpenAI-compatible server
 * (used by tests).
 */

import { createLogger } from "../logger.js";

const log = createLogger("agent-ai");

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /** Gemini 3 puts its thought signature here (extra_content.google.thought_signature). */
  extra_content?: { google?: { thought_signature?: string } } & Record<string, unknown>;
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

// ─── Configuration ────────────────────────────────────────────────────────────

const usable = (k: string | undefined): k is string => !!k && k.trim() !== "" && !k.includes("placeholder");

const GEMINI_BASE = (process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/$/, "");
const GEMINI_MODELS = (process.env.GEMINI_MODELS ?? "gemini-3.6-flash,gemini-3.5-flash,gemini-3-flash-preview,gemini-3.5-flash-lite,gemini-3.1-flash-lite")
  .split(",").map((s) => s.trim()).filter(Boolean);
const GEMINI_KEYS = [...new Set([process.env.AGENT_API_KEY, ...(process.env.AGENT_API_KEYS ?? "").split(",")]
  .map((k) => k?.trim()).filter(usable))];

const MISTRAL_BASE = (process.env.MISTRAL_BASE_URL ?? "https://api.mistral.ai/v1").replace(/\/$/, "");
const MISTRAL_MODELS = (process.env.MISTRAL_MODELS ?? "mistral-large-4,mistral-large-2512").split(",").map((s) => s.trim()).filter(Boolean);
const MISTRAL_KEY = usable(process.env.MISTRAL_API_KEY) ? process.env.MISTRAL_API_KEY!.trim() : "";

/** Mistral's free plan allows about one request per second. */
const MISTRAL_MIN_INTERVAL_MS = Number(process.env.MISTRAL_MIN_INTERVAL_MS ?? 1100);

const GROQ_BASE = (process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1").replace(/\/$/, "");
const GROQ_KEY = usable(process.env.GROQ_API_KEY) ? process.env.GROQ_API_KEY!.trim() : "";
const GROQ_SMART = process.env.AGENT_MODEL ?? process.env.GROQ_MODEL_SMART ?? "openai/gpt-oss-120b";
const GROQ_FAST = process.env.AGENT_FALLBACK_MODEL ?? process.env.GROQ_MODEL_FAST ?? "openai/gpt-oss-20b";
const TOKENS_PER_MINUTE = Number(process.env.AGENT_TOKENS_PER_MINUTE ?? 7500);

interface Lane {
  id: string;
  provider: "gemini" | "mistral" | "groq";
  model: string;
  key: string;
  base: string;
  /** For logs only; never the key itself. */
  label: string;
}

function buildLanes(): Lane[] {
  const gemini = GEMINI_MODELS.flatMap((model) =>
    GEMINI_KEYS.map((key, i): Lane => ({
      id: `gemini:${model}:${i}`, provider: "gemini", model, key, base: GEMINI_BASE, label: `Gemini ${model} (key ${i + 1})`,
    })),
  );
  const mistral = MISTRAL_KEY
    ? MISTRAL_MODELS.map((model): Lane => ({
        id: `mistral:${model}`, provider: "mistral", model, key: MISTRAL_KEY, base: MISTRAL_BASE, label: `Mistral ${model}`,
      }))
    : [];
  if (!GROQ_KEY) return [...mistral, ...gemini];
  const groqModels = [...new Set([GROQ_SMART, GROQ_FAST])];
  const groq = groqModels.map((model): Lane => ({
    id: `groq:${model}`, provider: "groq", model, key: GROQ_KEY, base: GROQ_BASE, label: `Groq ${model}`,
  }));
  return [...mistral, ...gemini, ...groq];
}

const LANES = buildLanes();

/** Rough size of a request: ~4 characters per token. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

// Groq's free plan limits tokens per minute per model; Gemini's are per request, handled by cooldowns.
const recent = new Map<string, { at: number; tokens: number }[]>();
const coolUntil = new Map<string, number>();

function usedLastMinute(model: string): number {
  const now = Date.now();
  const list = (recent.get(model) ?? []).filter((r) => now - r.at < 60_000);
  recent.set(model, list);
  return list.reduce((n, r) => n + r.tokens, 0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastMistralAt = 0;

/**
 * Gemini 3 refuses a conversation whose tool calls carry no thought
 * signature (400 "Function call is missing a thought_signature") — which is
 * every tool call another model made earlier in the same chat. Google's
 * documented placeholder lets it accept them; real signatures from Gemini
 * itself are kept. Other providers don't know the field, so it's removed.
 */
const DUMMY_SIGNATURE = "skip_thought_signature_validator";
export function prepareMessages(provider: Lane["provider"], messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.role !== "assistant" || !m.tool_calls?.length) return m;
    const tool_calls = m.tool_calls.map((c): ToolCall => {
      if (provider === "gemini") {
        if (c.extra_content?.google?.thought_signature) return c;
        return { ...c, extra_content: { ...c.extra_content, google: { ...c.extra_content?.google, thought_signature: DUMMY_SIGNATURE } } };
      }
      if (!("extra_content" in c)) return c;
      const { extra_content: _drop, ...rest } = c;
      return rest;
    });
    return { ...m, tool_calls };
  });
}

const cool = (lane: Lane, ms: number, why: string) => {
  coolUntil.set(lane.id, Date.now() + ms);
  log.warn({ lane: lane.label, minutes: Math.round(ms / 60_000) }, `${why} — trying the next AI`);
};
const isCooling = (lane: Lane) => (coolUntil.get(lane.id) ?? 0) > Date.now();
const DAILY = /per day|TPD|RPD|quota|RESOURCE_EXHAUSTED|daily/i;

export interface ChatOptions {
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxTokens?: number;
  /** Called while waiting on rate limits, so the chat can say so. */
  onWait?: (seconds: number, why: string) => void;
  signal?: AbortSignal;
}

export async function chat(opts: ChatOptions): Promise<{ message: ChatMessage; model: string }> {
  if (LANES.length === 0) {
    throw new AiUnavailableError("The coder AI needs an AI key: set AGENT_API_KEY or AGENT_API_KEYS (Gemini keys from aistudio.google.com/apikey) or GROQ_API_KEY in the server's .env.");
  }
  const maxTokens = opts.maxTokens ?? Number(process.env.AGENT_MAX_OUTPUT_TOKENS ?? 1200);
  const size = estimateTokens(JSON.stringify(opts.messages)) + estimateTokens(JSON.stringify(opts.tools)) + maxTokens;
  let badRequests = 0;
  /** Lanes that rejected this particular request (a content problem, not the lane's fault). */
  const skip = new Set<string>();
  let firstRejection = "";

  for (let attempt = 0; attempt < 12; attempt++) {
    if (opts.signal?.aborted) throw new AiUnavailableError("Stopped.");

    const lane = LANES.find((l) => !isCooling(l) && !skip.has(l.id));
    if (!lane && LANES.some((l) => !isCooling(l)) ) {
      // Every healthy lane rejected this request itself: say why, don't call it "busy".
      throw new AiUnavailableError(`The AI rejected this request: ${firstRejection.slice(0, 300) || "unknown reason"}`);
    }
    if (!lane) {
      // Every lane is cooling down: wait for the soonest one, if it's short.
      const soonest = Math.min(...LANES.map((l) => coolUntil.get(l.id) ?? 0)) - Date.now();
      if (soonest > 65_000) throw new AiUnavailableError("The AI keys are all at their limit right now. They reset within a few hours, or add another key.");
      const wait = Math.max(1, Math.ceil(soonest / 1000));
      opts.onWait?.(wait, "AI rate limit");
      await sleep(wait * 1000);
      continue;
    }

    if (lane.provider === "groq") {
      const used = usedLastMinute(lane.model);
      if (used > 0 && used + size > TOKENS_PER_MINUTE) {
        const oldest = recent.get(lane.model)![0]!;
        const wait = Math.max(1, Math.ceil((60_000 - (Date.now() - oldest.at)) / 1000));
        opts.onWait?.(wait, "pacing for the free AI plan");
        await sleep(wait * 1000);
        continue;
      }
    }

    if (lane.provider === "mistral") {
      const wait = lastMistralAt + MISTRAL_MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastMistralAt = Date.now();
    }

    const body: Record<string, unknown> = {
      model: lane.model,
      messages: prepareMessages(lane.provider, opts.messages),
      tools: opts.tools,
      tool_choice: "auto",
      temperature: 0.2,
      max_tokens: maxTokens + 800, // headroom for reasoning tokens
    };
    if (lane.provider === "groq") body.reasoning_effort = "medium";

    const res = await fetch(`${lane.base}/chat/completions`, {
      method: "POST",
      signal: opts.signal ?? AbortSignal.timeout(120_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${lane.key}` },
      body: JSON.stringify(body),
    }).catch((err: Error) => {
      if (opts.signal?.aborted) throw new AiUnavailableError("Stopped.");
      cool(lane, 30_000, `${lane.label} couldn't be reached (${err.message})`);
      return null;
    });
    if (!res) continue;
    if (lane.provider === "groq") {
      const list = recent.get(lane.model) ?? [];
      list.push({ at: Date.now(), tokens: size });
      recent.set(lane.model, list);
    }

    if (res.ok) {
      const data = await res.json() as { choices?: { message: ChatMessage }[] };
      const message = data.choices?.[0]?.message;
      if (!message) { cool(lane, 30_000, `${lane.label} returned an empty answer`); continue; }
      return { message: { role: "assistant", content: message.content ?? null, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) }, model: lane.model };
    }

    const text = await res.text().catch(() => "");
    if (res.status === 413 || /Request too large|context_length|maximum context|too large/i.test(text)) {
      throw new RequestTooLargeError("The conversation got too big for the AI. Start a new chat or ask about one thing at a time.");
    }
    if (res.status === 429) {
      if (DAILY.test(text)) cool(lane, 60 * 60_000, `${lane.label} is out of quota`);
      else cool(lane, Math.min(65, Number(res.headers.get("retry-after")) || (lane.provider === "mistral" ? 8 : 30)) * 1000, `${lane.label} is rate limited`);
      continue;
    }
    if (res.status === 400 && /tool_use_failed|failed_generation/i.test(text) && badRequests++ < 2) {
      // The model wrote a malformed tool call; asking again usually works.
      log.warn("Malformed tool call from the model — retrying");
      continue;
    }
    if (res.status === 401 || res.status === 403) { cool(lane, 60 * 60_000, `${lane.label} was refused (check the key)`); continue; }
    if (res.status === 404) { cool(lane, 24 * 60 * 60_000, `${lane.label} isn't available`); continue; }
    if (res.status >= 500) { cool(lane, 30_000, `${lane.label} had a server error (${res.status})`); continue; }
    if (res.status === 400 || res.status === 422) {
      // The request itself was refused. Don't take the lane out for everyone;
      // just try the next lane for this request.
      skip.add(lane.id);
      firstRejection ||= `${lane.label}: ${text.replace(/\s+/g, " ")}`;
      log.warn({ lane: lane.label, status: res.status }, `${lane.label} rejected this request — trying the next AI`);
      continue;
    }
    cool(lane, 2 * 60_000, `${lane.label} failed (${res.status}): ${text.slice(0, 160)}`);
  }
  throw new AiUnavailableError("The AI is busy right now — try again in a minute.");
}

/** For tests: forget cooldowns and pacing. */
export function _resetAiStateForTests(): void {
  coolUntil.clear();
  recent.clear();
}

/** Which lanes are configured (for the health check and tests). */
export function configuredLanes(): string[] {
  return LANES.map((l) => l.label);
}
