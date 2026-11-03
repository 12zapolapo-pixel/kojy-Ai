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
// Large 3 (mistral-large-2512) is refused on the free plan ("not available in your subscription tier").
const MISTRAL_MODELS = (process.env.MISTRAL_MODELS ?? "mistral-large-4,codestral-latest").split(",").map((s) => s.trim()).filter(Boolean);
const MISTRAL_KEY = usable(process.env.MISTRAL_API_KEY) ? process.env.MISTRAL_API_KEY.trim() : "";

/** Mistral's free plan: about one request per second… */
const MISTRAL_MIN_INTERVAL_MS = Number(process.env.MISTRAL_MIN_INTERVAL_MS ?? 1100);
/** …and 20,000 tokens a minute (its x-ratelimit-limit-tokens-minute header), so about one long Kojy step a minute. */
const MISTRAL_TOKENS_PER_MINUTE = Number(process.env.MISTRAL_TOKENS_PER_MINUTE ?? 20000);

const GROQ_BASE = (process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1").replace(/\/$/, "");
const GROQ_KEY = usable(process.env.GROQ_API_KEY) ? process.env.GROQ_API_KEY.trim() : "";
const GROQ_SMART = process.env.AGENT_MODEL ?? process.env.GROQ_MODEL_SMART ?? "openai/gpt-oss-120b";
const GROQ_FAST = process.env.AGENT_FALLBACK_MODEL ?? process.env.GROQ_MODEL_FAST ?? "openai/gpt-oss-20b";
const TOKENS_PER_MINUTE = Number(process.env.AGENT_TOKENS_PER_MINUTE ?? 7500);

/**
 * More models through OpenAI-compatible endpoints, each switched on by its
 * key in .env:
 *   <NAME>_API_KEY      the key (LiteLLM: a virtual key or its master key)
 *   <NAME>_MODELS       models to use, comma-separated, best first
 *   <NAME>_BASE_URL     the endpoint (required for LiteLLM; the others have a default)
 *   <NAME>_TOKENS_PER_MINUTE  the plan's per-minute token budget (optional)
 * LiteLLM is a self-hosted router to 100+ providers; the others are providers
 * with free plans. They're tried after Gemini and before Groq.
 */
export const GATEWAYS: { name: string; label: string; base?: string }[] = [
  { name: "LITELLM", label: "LiteLLM" },
  { name: "CEREBRAS", label: "Cerebras", base: "https://api.cerebras.ai/v1" },
  { name: "SAMBANOVA", label: "SambaNova", base: "https://api.sambanova.ai/v1" },
  { name: "GITHUB_MODELS", label: "GitHub Models", base: "https://models.github.ai/inference" },
  { name: "OPENROUTER", label: "OpenRouter", base: "https://openrouter.ai/api/v1" },
];

interface Lane {
  id: string;
  /** Position in the try-order (0 = tried first). */
  order: number;
  /** Largest request (estimated tokens) this lane can take at all. */
  maxRequestTokens: number;
  /** The plan's tokens-per-minute budget (Infinity: limited by cooldowns only). */
  tokensPerMinute: number;
  /** 1-based number of the key within its provider, for display only. */
  keyNo: number;
  /** "gemini", "mistral", "groq", or a gateway's name in lower case ("litellm", "cerebras"…). */
  provider: string;
  model: string;
  key: string;
  base: string;
  /** For logs only; never the key itself. */
  label: string;
}

function buildLanes(): Lane[] {
  // Gemini and Mistral take far longer chats than Kojy sends; Groq's free plan
  // can't take a request over its tokens-per-minute limit at all.
  const gemini = GEMINI_MODELS.flatMap((model) =>
    GEMINI_KEYS.map((key, i): Lane => ({
      id: `gemini:${model}:${i}`, order: 0, maxRequestTokens: Infinity, tokensPerMinute: Infinity, keyNo: i + 1, provider: "gemini", model, key, base: GEMINI_BASE, label: `Gemini ${model} (key ${i + 1})`,
    })),
  );
  const mistral = MISTRAL_KEY
    ? MISTRAL_MODELS.map((model): Lane => ({
        id: `mistral:${model}`, order: 0, maxRequestTokens: MISTRAL_TOKENS_PER_MINUTE, tokensPerMinute: MISTRAL_TOKENS_PER_MINUTE, keyNo: 1, provider: "mistral", model, key: MISTRAL_KEY, base: MISTRAL_BASE, label: `Mistral ${model}`,
      }))
    : [];
  const gateways = GATEWAYS.flatMap(({ name, label, base: defaultBase }): Lane[] => {
    const key = process.env[`${name}_API_KEY`];
    const base = (process.env[`${name}_BASE_URL`] || defaultBase || "").trim().replace(/\/$/, "");
    const models = (process.env[`${name}_MODELS`] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!usable(key) || !base || !models.length) return [];
    const perMinute = Number(process.env[`${name}_TOKENS_PER_MINUTE`]) || Infinity;
    return models.map((model): Lane => ({
      id: `${name.toLowerCase()}:${model}`, order: 0, maxRequestTokens: perMinute, tokensPerMinute: perMinute, keyNo: 1,
      provider: name.toLowerCase(), model, key: key.trim(), base, label: `${label} ${model}`,
    }));
  });
  if (!GROQ_KEY) return [...mistral, ...gemini, ...gateways];
  const groqModels = [...new Set([GROQ_SMART, GROQ_FAST])];
  const groq = groqModels.map((model): Lane => ({
    id: `groq:${model}`, order: 0, maxRequestTokens: TOKENS_PER_MINUTE, tokensPerMinute: TOKENS_PER_MINUTE, keyNo: 1, provider: "groq", model, key: GROQ_KEY, base: GROQ_BASE, label: `Groq ${model}`,
  }));
  return [...mistral, ...gemini, ...gateways, ...groq];
}

const LANES = buildLanes();
LANES.forEach((l, i) => { l.order = i; });

/** Rough size of a request: ~4 characters per token. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

// Groq's and Mistral's free plans limit tokens per minute; Gemini's limits are handled by cooldowns.
/** Requests sent in the last minute, per lane. */
const recent = new Map<string, { at: number; tokens: number }[]>();
const coolUntil = new Map<string, number>();

/** When the lane's per-minute budget can take `size` more tokens (0: now). */
function budgetFreeAt(lane: Lane, size: number): number {
  if (!Number.isFinite(lane.tokensPerMinute)) return 0;
  const now = Date.now();
  const list = (recent.get(lane.id) ?? []).filter((r) => now - r.at < 60_000);
  recent.set(lane.id, list);
  let used = list.reduce((n, r) => n + r.tokens, 0);
  if (used + size <= lane.tokensPerMinute) return 0;
  // Older requests leave the window one by one.
  for (const r of list) {
    used -= r.tokens;
    if (used + size <= lane.tokensPerMinute) return r.at + 60_000;
  }
  return now + 60_000;
}
/** When the lane can take a request of `size`: after its cooldown and once its minute budget allows. */
const readyAt = (lane: Lane, size: number) => Math.max(coolUntil.get(lane.id) ?? 0, budgetFreeAt(lane, size));

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
export function prepareMessages(provider: string, messages: ChatMessage[]): ChatMessage[] {
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

// ─── Usage for the chat's "AI models" circle ──────────────────────────────────
// Counts per model/key, per day, in Redis (shared with the API). Never holds a key.

/** The few Redis commands used; a real ioredis client satisfies this. */
export interface UsageSink {
  hincrby(key: string, field: string, by: number): Promise<unknown>;
  hset(key: string, field: string, value: string): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  /** With these two, models taken out of the configuration also leave the chat's list. */
  hkeys?(key: string): Promise<string[]>;
  hdel?(key: string, ...fields: string[]): Promise<unknown>;
}
export type CoolKind = "rate_limited" | "out_of_quota" | "refused" | "unavailable" | "error";
export interface LaneState {
  order: number; provider: string; model: string; keyNo: number; label: string;
  coolUntil: number; kind: CoolKind | null; reason: string;
}

let usageSink: UsageSink | null = null;
const usageKey = () => `ai_usage:${new Date().toISOString().slice(0, 10)}`;

function publishLane(lane: Lane, kind: CoolKind | null, reason: string): void {
  if (!usageSink) return;
  const state: LaneState = {
    order: lane.order, provider: lane.provider, model: lane.model, keyNo: lane.keyNo, label: lane.label,
    coolUntil: coolUntil.get(lane.id) ?? 0, kind, reason: reason.slice(0, 200),
  };
  void usageSink.hset("ai_lanes", lane.id, JSON.stringify(state)).catch(() => undefined);
}

/** Start recording usage into Redis, and publish every configured model. */
export function setUsageSink(sink: UsageSink | null): void {
  usageSink = sink;
  for (const lane of LANES) publishLane(lane, null, "");
  // A model removed from .env would otherwise stay in the AI models circle for good.
  if (!sink?.hkeys || !sink.hdel) return;
  const configured = new Set(LANES.map((l) => l.id));
  void sink.hkeys("ai_lanes")
    .then((ids) => {
      const gone = ids.filter((id) => !configured.has(id));
      return gone.length && sink.hdel ? sink.hdel("ai_lanes", ...gone) : undefined;
    })
    .catch(() => undefined);
}

function recordUsage(lane: Lane, d: { req?: number; tokensIn?: number; tokensOut?: number; fail?: number }): void {
  if (!usageSink) return;
  const key = usageKey();
  const sink = usageSink;
  const ops: Promise<unknown>[] = [];
  if (d.req) ops.push(sink.hincrby(key, `${lane.id}|req`, d.req));
  if (d.tokensIn) ops.push(sink.hincrby(key, `${lane.id}|in`, d.tokensIn));
  if (d.tokensOut) ops.push(sink.hincrby(key, `${lane.id}|out`, d.tokensOut));
  if (d.fail) ops.push(sink.hincrby(key, `${lane.id}|fail`, d.fail));
  ops.push(sink.hset(key, `${lane.id}|last`, String(Date.now())));
  ops.push(sink.expire(key, 8 * 24 * 3600));
  void Promise.all(ops).catch(() => undefined);
}

const cool = (lane: Lane, ms: number, why: string, kind: CoolKind = "error") => {
  coolUntil.set(lane.id, Date.now() + ms);
  log.warn({ lane: lane.label, minutes: Math.round(ms / 60_000) }, `${why} — trying the next AI`);
  recordUsage(lane, { fail: 1 });
  publishLane(lane, kind, why);
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

/**
 * Mistral's reasoning models answer with a list of chunks — their thinking,
 * then the reply. Only the reply's text is kept: the thinking isn't meant for
 * the owner, and stored as it came it showed up in the chat as raw JSON.
 */
export function contentText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const text = content.map((c) => {
    if (typeof c === "string") return c;
    if (c && typeof c === "object" && (c as { type?: unknown }).type === "text") return String((c as { text?: unknown }).text ?? "");
    return "";
  }).join("");
  return text || null;
}

const TOO_LARGE = /context_length|context length|maximum context|too large|too long|exceeds the maximum number of tokens/i;

export async function chat(opts: ChatOptions): Promise<{ message: ChatMessage; model: string }> {
  if (LANES.length === 0) {
    throw new AiUnavailableError("The coder AI needs an AI key: set AGENT_API_KEY or AGENT_API_KEYS (Gemini keys from aistudio.google.com/apikey), MISTRAL_API_KEY, GROQ_API_KEY, or a LiteLLM/Cerebras/SambaNova/GitHub Models/OpenRouter key and model list in the server's .env.");
  }
  const maxTokens = opts.maxTokens ?? Number(process.env.AGENT_MAX_OUTPUT_TOKENS ?? 1200);
  const size = estimateTokens(JSON.stringify(opts.messages)) + estimateTokens(JSON.stringify(opts.tools)) + maxTokens;
  let badRequests = 0;
  /** Lanes that rejected this particular request (a content problem, not the lane's fault). */
  const skip = new Set<string>();
  /** Lanes this request turned out to be too large for. */
  const tooBig = new Set<string>();
  const fits = (l: Lane) => size <= l.maxRequestTokens && !tooBig.has(l.id);
  let firstRejection = "";

  /** Each lane gets a couple of tries per request; waiting for one doesn't use them up. */
  const maxAttempts = LANES.length * 2 + 4;
  /** Waiting on rate limits stops here; then a shorter request (Groq) or an error. */
  const deadline = Date.now() + 150_000;
  let waits = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (opts.signal?.aborted) throw new AiUnavailableError("Stopped.");

    const now = Date.now();
    const lane = LANES.find((l) => !skip.has(l.id) && fits(l) && readyAt(l, size) <= now);
    if (!lane) {
      // Lanes that could take this request once their cooldown or minute budget allows.
      const later = LANES.filter((l) => !skip.has(l.id) && fits(l));
      const soonest = later.length ? Math.min(...later.map((l) => readyAt(l, size))) - now : Infinity;
      // A lane free right now that's only too small for it (Groq): a shorter history goes at once.
      const smallerNow = LANES.some((l) => !skip.has(l.id) && !fits(l) && !isCooling(l));
      // Waiting for a lane that takes the whole chat beats cutting it — but only
      // once when a shorter request could go right away.
      if (soonest <= 65_000 && now + soonest <= deadline && (!smallerNow || waits === 0)) {
        waits++;
        attempt--; // a wait isn't a try
        const wait = Math.max(1, Math.ceil(soonest / 1000));
        opts.onWait?.(wait, "AI rate limit");
        await sleep(wait * 1000);
        continue;
      }
      if (smallerNow) {
        throw new RequestTooLargeError(later.length
          ? `The AIs that can take a chat this long are busy for about ${Math.max(1, Math.ceil(soonest / 60_000))} min, and the free Groq AI is too small for it. Try again then, or start a new chat.`
          : "The conversation got too big for the AI. Start a new chat or ask about one thing at a time.");
      }
      // Every ready lane rejected this request itself: say why, don't call it "busy".
      if (LANES.some((l) => !isCooling(l))) {
        throw new AiUnavailableError(`The AI rejected this request: ${firstRejection.slice(0, 300) || "unknown reason"}`);
      }
      throw new AiUnavailableError("The AI keys are all at their limit right now. They reset within a few hours, or add another key.");
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
      cool(lane, 30_000, `${lane.label} couldn't be reached (${err.message})`, "unavailable");
      return null;
    });
    if (!res) continue;
    if (Number.isFinite(lane.tokensPerMinute)) {
      const list = recent.get(lane.id) ?? [];
      list.push({ at: Date.now(), tokens: size });
      recent.set(lane.id, list);
    }

    if (res.ok) {
      const data = await res.json() as { choices?: { message: { content?: unknown; tool_calls?: ToolCall[] } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const message = data.choices?.[0]?.message;
      if (!message) { cool(lane, 30_000, `${lane.label} returned an empty answer`); continue; }
      recordUsage(lane, { req: 1, tokensIn: data.usage?.prompt_tokens ?? 0, tokensOut: data.usage?.completion_tokens ?? 0 });
      const content = contentText(message.content);
      const toolCalls = message.tool_calls?.length ? message.tool_calls : undefined;
      if (!content?.trim() && !toolCalls) {
        // Nothing to say or do (e.g. it only "thought"): another model may do better.
        skip.add(lane.id);
        firstRejection ||= `${lane.label} answered with nothing`;
        log.warn({ lane: lane.label }, `${lane.label} answered with nothing — trying the next AI`);
        continue;
      }
      return { message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, model: lane.model };
    }

    const text = await res.text().catch(() => "");
    if (res.status === 413 || ((res.status === 400 || res.status === 422) && TOO_LARGE.test(text))) {
      // Too big for this lane (Groq's per-minute size, a context window); a bigger one may take it.
      tooBig.add(lane.id);
      log.warn({ lane: lane.label }, `${lane.label}: request too large — trying the next AI`);
      continue;
    }
    if (res.status === 429) {
      if (DAILY.test(text)) cool(lane, 60 * 60_000, `${lane.label} is out of quota`, "out_of_quota");
      // Mistral's limits are per minute: a 429 means its minute is used up.
      else cool(lane, Math.min(65, Number(res.headers.get("retry-after")) || (lane.provider === "mistral" ? 60 : 30)) * 1000, `${lane.label} is rate limited`, "rate_limited");
      continue;
    }
    if (res.status === 400 && /tool_use_failed|failed_generation/i.test(text) && badRequests++ < 2) {
      // The model wrote a malformed tool call; asking again usually works.
      log.warn("Malformed tool call from the model — retrying");
      continue;
    }
    if (res.status === 401 || res.status === 403) { cool(lane, 60 * 60_000, `${lane.label} was refused (check the key or plan)`, "refused"); continue; }
    if (res.status === 404) { cool(lane, 24 * 60 * 60_000, `${lane.label} isn't available`, "unavailable"); continue; }
    if (res.status >= 500) { cool(lane, 30_000, `${lane.label} had a server error (${res.status})`, "unavailable"); continue; }
    if (res.status === 400 || res.status === 422) {
      // The request itself was refused. Don't take the lane out for everyone;
      // just try the next lane for this request.
      skip.add(lane.id);
      recordUsage(lane, { fail: 1 });
      firstRejection ||= `${lane.label}: ${text.replace(/\s+/g, " ")}`;
      log.warn({ lane: lane.label, status: res.status, detail: text.replace(/\s+/g, " ").slice(0, 300) }, `${lane.label} rejected this request — trying the next AI`);
      continue;
    }
    cool(lane, 2 * 60_000, `${lane.label} failed (${res.status}): ${text.slice(0, 160)}`);
  }
  // Out of tries: a shorter request may still fit the AI that's free (Groq).
  if (LANES.some((l) => !skip.has(l.id) && !fits(l) && !isCooling(l))) {
    throw new RequestTooLargeError("The AIs that can take a chat this long are busy right now. Try again in a minute, or start a new chat.");
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
