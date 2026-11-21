/**
 * AI client for the coder AI: OpenAI-compatible chat with tool calls.
 * OWNERSHIP: apps/runner/src/agent
 *
 * Providers, in the order they are tried (AGENT_LANE_ORDER changes it, e.g.
 * "gemini,mistral,groq"). Every one has a free plan: Kojy never needs a paid key.
 *   1. Mistral (MISTRAL_API_KEY; models from MISTRAL_MODELS).
 *   2. Gemini (Google AI Studio, OpenAI-compatible endpoint). Every key is
 *      tried with every model: keys come from AGENT_API_KEY and
 *      AGENT_API_KEYS (comma-separated), models from GEMINI_MODELS.
 *   3. Gateways (LiteLLM and providers with free plans), each switched
 *      on by its key and model list — see GATEWAYS.
 *   4. Groq (optional, GROQ_API_KEY): the main and fast models, paced to the
 *      free plan's per-minute token budget.
 *
 * Each (key, model) pair is a "lane". A lane that hits its limit (429), fails
 * its key (401/403) or doesn't exist (404) is put on cooldown and the next
 * lane is tried straight away, so one exhausted key never stops the work.
 * Keys are never logged.
 *
 * Output room: every step asks each AI for as much output as its plan
 * allows, up to AGENT_MAX_OUTPUT_TOKENS (8192 by default: a whole file in one
 * tool call). The old fixed ~2,000 tokens cut every bigger write_file off in
 * the middle of its arguments; the agent then ran it with none and Kojy ended
 * up telling the owner it "didn't have the tools". An answer cut off at its
 * limit (finish_reason "length") is asked again with more room where the
 * plan allows; otherwise it comes back marked `truncated`, so a cut-off call
 * is never run and the model is told to write in parts.
 *
 * GEMINI_BASE_URL / GROQ_BASE_URL can point at any OpenAI-compatible server
 * (used by tests).
 */

import { createHash, randomBytes } from "node:crypto";
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
// Mistral Large (3, 4, "latest") is refused on the free plan ("not available in your
// subscription tier"); Medium is the strongest model it includes.
const MISTRAL_MODELS = (process.env.MISTRAL_MODELS ?? "mistral-medium-latest,codestral-latest").split(",").map((s) => s.trim()).filter(Boolean);
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
/** One AI call (headers and body) gives up after this; the next AI is tried. */
const REQUEST_TIMEOUT_MS = Number(process.env.AGENT_REQUEST_TIMEOUT_MS ?? 180_000);

/** The most output one step asks for: room for a whole file in one tool call. */
const MAX_OUTPUT_TOKENS = Math.max(256, Number(process.env.AGENT_MAX_OUTPUT_TOKENS) || 8192);
/** An AI that can't give a request at least this much output isn't used for it: its answer would be cut off. */
const MIN_OUTPUT_TOKENS = Math.max(64, Number(process.env.AGENT_MIN_OUTPUT_TOKENS) || 1024);
/** Gemini counts its thinking as output: this much extra room on top (its plan isn't paced by tokens). */
const THINKING_TOKENS = Math.max(0, Number(process.env.AGENT_THINKING_TOKENS ?? 4096));
/** The most output an answer that was cut off is asked again with. */
const RETRY_OUTPUT_TOKENS = Math.max(MAX_OUTPUT_TOKENS, Number(process.env.AGENT_RETRY_OUTPUT_TOKENS) || 32_768);
/** What a gateway's models may be asked for unless <NAME>_MAX_OUTPUT_TOKENS says otherwise (many cap output at 8K). */
const GATEWAY_OUTPUT_TOKENS = 8192;

/** Provider names (lower case) in the order to try them; unlisted ones follow in the usual order. */
const LANE_ORDER = (process.env.AGENT_LANE_ORDER ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

/**
 * More models through OpenAI-compatible endpoints, each switched on by its
 * key in .env:
 *   <NAME>_API_KEY      the key (LiteLLM: a virtual key or its master key)
 *   <NAME>_MODELS       models to use, comma-separated, best first
 *   <NAME>_BASE_URL     the endpoint (required for LiteLLM; the others have a default)
 *   <NAME>_TOKENS_PER_MINUTE  the plan's per-minute token budget (optional)
 *   <NAME>_MAX_OUTPUT_TOKENS  the most output its models give per answer (optional)
 * LiteLLM is a self-hosted router to 100+ providers; the others are providers
 * with free plans. They're tried after Gemini and before Groq unless
 * AGENT_LANE_ORDER says otherwise.
 */
export const GATEWAYS: { name: string; label: string; base?: string; maxOutput?: number }[] = [
  { name: "LITELLM", label: "LiteLLM" },
  { name: "CEREBRAS", label: "Cerebras", base: "https://api.cerebras.ai/v1" },
  { name: "SAMBANOVA", label: "SambaNova", base: "https://api.sambanova.ai/v1" },
  { name: "GITHUB_MODELS", label: "GitHub Models", base: "https://models.github.ai/inference" },
  { name: "OPENROUTER", label: "OpenRouter", base: "https://openrouter.ai/api/v1" },
  { name: "GONKAROUTER", label: "GonkaRouter", base: "https://api.gonkarouter.io/v1" },
];

interface Lane {
  id: string;
  /** Position in the try-order (0 = tried first). */
  order: number;
  /** Largest request (estimated tokens) this lane can take at all. */
  maxRequestTokens: number;
  /** The plan's tokens-per-minute budget (Infinity: limited by cooldowns only). */
  tokensPerMinute: number;
  /** The most output tokens this lane's model may be asked for in one answer. */
  maxOutput: number;
  /** The model's thinking counts as output (Gemini): it gets THINKING_TOKENS more room. */
  thinks: boolean;
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
      id: `gemini:${model}:${i}`, order: 0, maxRequestTokens: Infinity, tokensPerMinute: Infinity, maxOutput: RETRY_OUTPUT_TOKENS, thinks: true,
      keyNo: i + 1, provider: "gemini", model, key, base: GEMINI_BASE, label: `Gemini ${model} (key ${i + 1})`,
    })),
  );
  const mistral = MISTRAL_KEY
    ? MISTRAL_MODELS.map((model): Lane => ({
        id: `mistral:${model}`, order: 0, maxRequestTokens: MISTRAL_TOKENS_PER_MINUTE, tokensPerMinute: MISTRAL_TOKENS_PER_MINUTE, maxOutput: RETRY_OUTPUT_TOKENS, thinks: false,
        keyNo: 1, provider: "mistral", model, key: MISTRAL_KEY, base: MISTRAL_BASE, label: `Mistral ${model}`,
      }))
    : [];
  const gateways = GATEWAYS.flatMap(({ name, label, base: defaultBase, maxOutput }): Lane[] => {
    const key = process.env[`${name}_API_KEY`];
    const base = (process.env[`${name}_BASE_URL`] || defaultBase || "").trim().replace(/\/$/, "");
    const models = (process.env[`${name}_MODELS`] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!usable(key) || !base || !models.length) return [];
    const perMinute = Number(process.env[`${name}_TOKENS_PER_MINUTE`]) || Infinity;
    const output = Number(process.env[`${name}_MAX_OUTPUT_TOKENS`]) || maxOutput || GATEWAY_OUTPUT_TOKENS;
    return models.map((model): Lane => ({
      id: `${name.toLowerCase()}:${model}`, order: 0, maxRequestTokens: perMinute, tokensPerMinute: perMinute, maxOutput: output, thinks: false, keyNo: 1,
      provider: name.toLowerCase(), model, key: key.trim(), base, label: `${label} ${model}`,
    }));
  });
  const groqModels = GROQ_KEY ? [...new Set([GROQ_SMART, GROQ_FAST])] : [];
  const groq = groqModels.map((model): Lane => ({
    id: `groq:${model}`, order: 0, maxRequestTokens: TOKENS_PER_MINUTE, tokensPerMinute: TOKENS_PER_MINUTE, maxOutput: RETRY_OUTPUT_TOKENS, thinks: false,
    keyNo: 1, provider: "groq", model, key: GROQ_KEY, base: GROQ_BASE, label: `Groq ${model}`,
  }));
  return orderLanes([...mistral, ...gemini, ...gateways, ...groq], LANE_ORDER);
}

/** Lanes of the providers named in `order` first, in that order; the rest keep their usual order after them. */
export function orderLanes<T extends { provider: string }>(lanes: T[], order: string[]): T[] {
  if (!order.length) return lanes;
  const rank = (l: T) => { const i = order.indexOf(l.provider); return i < 0 ? order.length : i; };
  return lanes.map((l, i) => ({ l, i })).sort((a, b) => rank(a.l) - rank(b.l) || a.i - b.i).map((x) => x.l);
}

const LANES = buildLanes();
LANES.forEach((l, i) => { l.order = i; });

/** Output limits learned from a model's own error ("max_tokens must be ≤ 8192"), per lane. */
const learnedCap = new Map<string, number>();

/**
 * How many output tokens to ask `lane` for, for a request of `input` tokens
 * that wants `want` (more after a cut-off answer: `boost`). As much as the
 * plan's per-minute budget leaves, never more than the model's own limit. 0:
 * the lane can't give this request enough room (it isn't used for it).
 */
export function outputFor(lane: Pick<Lane, "maxRequestTokens" | "maxOutput" | "thinks"> & { id?: string }, input: number, want: number, boost = 0): number {
  const room = lane.maxRequestTokens - input; // Infinity for lanes paced by cooldowns only
  const cap = Math.min(lane.maxOutput, (lane.id ? learnedCap.get(lane.id) : undefined) ?? Infinity);
  const out = Math.floor(Math.min(Math.max(want, boost) + (lane.thinks ? THINKING_TOKENS : 0), cap, room));
  return out >= Math.min(MIN_OUTPUT_TOKENS, want) ? out : 0;
}

/**
 * The output limit an error says a model has ("max_tokens must be less than
 * or equal to 8192", "supports at most 4096 completion tokens"): the largest
 * number in it below what was asked for. null when it names none.
 */
export function maxTokensFromError(text: string, asked: number): number | null {
  const nums = (text.match(/\d{3,7}/g) ?? []).map(Number).filter((n) => n >= 256 && n < asked);
  return nums.length ? Math.max(...nums) : null;
}

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
  const out = messages.map((m) => {
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
  return provider === "mistral" ? forMistral(out) : out;
}

const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** Mistral only takes tool-call ids of exactly 9 letters and digits; other models' ids are mapped (the same id always maps the same way). */
export function mistralToolId(id: string): string {
  if (/^[A-Za-z0-9]{9}$/.test(id)) return id;
  const h = createHash("sha256").update(id).digest();
  let s = "";
  for (let i = 0; i < 9; i++) s += BASE62[h[i]! % 62];
  return s;
}

/**
 * Mistral refuses a history with another model's tool-call ids ("must be
 * a-z, A-Z, 0-9, with a length of 9") and a user turn straight after a tool
 * result (after a pause for the owner's secrets or plan approval). Both are
 * fixed in the copy sent to it; the saved chat isn't changed.
 */
function forMistral(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "user" && out[out.length - 1]?.role === "tool") out.push({ role: "assistant", content: "OK." });
    if (m.role === "assistant" && m.tool_calls?.length) out.push({ ...m, tool_calls: m.tool_calls.map((c) => ({ ...c, id: mistralToolId(c.id) })) });
    else if (m.role === "tool" && m.tool_call_id) out.push({ ...m, tool_call_id: mistralToolId(m.tool_call_id) });
    else out.push(m);
  }
  return out;
}

const newCallId = () => `call_${randomBytes(9).toString("base64url").replace(/[-_]/g, "x")}`;

/**
 * Tool calls as every provider's answer may carry them, made uniform: a name
 * is required, arguments are a JSON string (some send an object), and every
 * call has its own id (some send none, or the same one twice).
 */
export function normalizeToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolCall[] = [];
  const ids = new Set<string>();
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const call = c as Partial<ToolCall> & { function?: { name?: unknown; arguments?: unknown } };
    const name = typeof call.function?.name === "string" ? call.function.name.trim() : "";
    if (!name) continue;
    const args = call.function?.arguments;
    let id = typeof call.id === "string" && call.id.trim() ? call.id : newCallId();
    if (ids.has(id)) id = newCallId();
    ids.add(id);
    out.push({ ...(call as ToolCall), id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) } });
  }
  return out;
}

const tryJson = (s: string): unknown => { try { return JSON.parse(s.trim()); } catch { return undefined; } };

/**
 * Tool calls a model wrote into its text instead of the tool_calls field —
 * what some self-hosted and gateway models do when their server isn't set up
 * to parse them (`<tool_call>{…}</tool_call>`, `<function=name>{…}</function>`,
 * `[TOOL_CALLS][…]`, DeepSeek's markers, or an answer that is only
 * `{"name": …, "arguments": …}`). Only names of tools this request offered
 * count. Returns them with the text that's left (null when nothing is).
 */
export function textToolCalls(text: string, names: Set<string>): { calls: ToolCall[]; text: string | null } {
  const calls: ToolCall[] = [];
  const take = (name: unknown, args: unknown): boolean => {
    if (typeof name !== "string" || !names.has(name.trim())) return false;
    const a = typeof args === "string" ? args : JSON.stringify(args ?? {});
    calls.push({ id: newCallId(), type: "function", function: { name: name.trim(), arguments: a } });
    return true;
  };
  const fromObject = (v: unknown): boolean => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return false;
    const o = v as Record<string, unknown>;
    const fnObj = o.function && typeof o.function === "object" ? o.function as Record<string, unknown> : null;
    return take(o.name ?? o.tool ?? fnObj?.name, o.arguments ?? o.parameters ?? o.args ?? o.input ?? fnObj?.arguments ?? {});
  };
  let rest = text
    .replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (m, body: string) => (fromObject(tryJson(body)) ? "" : m))
    .replace(/<function=([\w.-]+)>\s*(\{[\s\S]*?\})\s*(?:<\/function>|$)/g, (m, name: string, body: string) => {
      const args = tryJson(body);
      return args !== undefined && take(name, args) ? "" : m;
    })
    .replace(/\[TOOL_CALLS\]\s*(\[[\s\S]*\])/g, (m, body: string) => {
      const list = tryJson(body);
      return Array.isArray(list) && list.map(fromObject).some(Boolean) ? "" : m;
    })
    .replace(/<｜tool▁call▁begin｜>[\s\S]*?<｜tool▁sep｜>\s*([\w.-]+)\s*```(?:json)?\s*([\s\S]*?)```\s*<｜tool▁call▁end｜>/g, (m, name: string, body: string) => {
      const args = tryJson(body);
      return args !== undefined && take(name, args) ? "" : m;
    })
    .replace(/<｜tool▁calls?▁(?:begin|end)｜>/g, "");
  if (!calls.length) {
    // The whole answer is one call written as JSON (perhaps fenced).
    const whole = /^\s*(?:```(?:json)?\s*)?(\{[\s\S]*\})\s*(?:```)?\s*$/.exec(text);
    if (whole && fromObject(tryJson(whole[1]!))) rest = "";
  }
  if (!calls.length) return { calls, text };
  rest = rest.trim();
  return { calls, text: rest || null };
}

/** Whether a tool call's arguments are a complete JSON object (a cut-off answer leaves them unfinished). */
export function argumentsParse(args: string): boolean {
  const v = tryJson(args || "{}");
  return !!v && typeof v === "object" && !Array.isArray(v);
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
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * What a Gemini 429 really says. Google's message always mentions "quota" and
 * RESOURCE_EXHAUSTED — for the per-minute limit too — so the words alone made
 * a short burst look like a used-up day and benched the key for an hour. The
 * details say which limit it was (quotaId …PerMinute… or …PerDay…), how big
 * it is (quotaValue; "0" = no free use of this model at all) and when it
 * resets (RetryInfo.retryDelay, e.g. "11051s"). null: no such details.
 */
export function googleQuota(text: string): { daily: boolean; noFreeTier: boolean; retrySeconds: number | null } | null {
  let body: unknown;
  try { body = JSON.parse(text); } catch { return null; }
  const err = ((Array.isArray(body) ? body[0] : body) as { error?: { message?: unknown; details?: unknown } } | undefined)?.error;
  const details = Array.isArray(err?.details) ? (err.details as Record<string, unknown>[]) : [];
  const violations = details.flatMap((d) => (Array.isArray(d.violations) ? (d.violations as Record<string, unknown>[]) : []));
  const delay = details.map((d) => d.retryDelay).find((v): v is string => typeof v === "string");
  const inMessage = typeof err?.message === "string" ? /retry in ([\d.]+)\s*s/i.exec(err.message) : null;
  const seconds = delay ? parseFloat(delay) : inMessage ? parseFloat(inMessage[1]!) : NaN;
  if (!violations.length && Number.isNaN(seconds)) return null;
  return {
    daily: violations.some((v) => /PerDay/i.test(String(v.quotaId ?? ""))),
    noFreeTier: violations.some((v) => String(v.quotaValue ?? "") === "0"),
    retrySeconds: Number.isNaN(seconds) ? null : Math.ceil(seconds),
  };
}

export interface ChatOptions {
  messages: ChatMessage[];
  tools: ToolSpec[];
  /** The most output this step needs (default AGENT_MAX_OUTPUT_TOKENS); each AI gets up to what its plan allows. */
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
  let text: string;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content.map((c) => {
      if (typeof c === "string") return c;
      if (c && typeof c === "object" && (c as { type?: unknown }).type === "text") return String((c as { text?: unknown }).text ?? "");
      return "";
    }).join("");
  } else return null;
  // Some models (MiniMax, GLM) put their thinking in the answer as <think>…</think>: the owner sees only the answer.
  text = text.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
  return text || null;
}

const TOO_LARGE = /context_length|context length|maximum context|too large|too long|exceeds the maximum number of tokens/i;
/** An error about the output limit itself (not the request's size). */
const OUTPUT_LIMIT = /max_(?:completion_)?tokens|max_output_tokens|maxOutputTokens/i;
const CUT_OFF = /^(?:length|max_tokens|max_output_tokens)$/i;

export interface ChatResult {
  message: ChatMessage;
  model: string;
  /**
   * The answer stopped at its output limit (finish_reason "length"): a tool
   * call in it may be cut off — its arguments then don't parse (argumentsParse).
   */
  truncated: boolean;
  /** The output limit (tokens) the answering AI had for this step. */
  outputLimit: number;
}

export async function chat(opts: ChatOptions): Promise<ChatResult> {
  if (LANES.length === 0) {
    throw new AiUnavailableError("The coder AI needs an AI key: set AGENT_API_KEY or AGENT_API_KEYS (Gemini keys from aistudio.google.com/apikey), MISTRAL_API_KEY, GROQ_API_KEY, or a LiteLLM/Cerebras/SambaNova/GitHub Models/OpenRouter/GonkaRouter key and model list in the server's .env.");
  }
  const want = Math.max(1, opts.maxTokens ?? MAX_OUTPUT_TOKENS);
  const input = estimateTokens(JSON.stringify(opts.messages)) + estimateTokens(JSON.stringify(opts.tools));
  const toolNames = new Set(opts.tools.map((t) => t.function.name));
  let badRequests = 0;
  /** Lanes that rejected this particular request (a content problem, not the lane's fault). */
  const skip = new Set<string>();
  /** Lanes this request turned out to be too large for. */
  const tooBig = new Set<string>();
  /** Lanes asked again with more output room after a cut-off answer (once each): the room asked for. */
  const boosted = new Map<string, number>();
  /** Lanes whose output limit was corrected from their own error during this request (once each). */
  const capFixed = new Set<string>();
  const outOf = (l: Lane) => outputFor(l, input, want, boosted.get(l.id) ?? 0);
  /** What the request counts against a lane's per-minute budget: what's sent plus the output asked for. */
  const sizeOf = (l: Lane) => input + outOf(l);
  const fits = (l: Lane) => outOf(l) > 0 && !tooBig.has(l.id);
  let firstRejection = "";

  /** Each lane gets a couple of tries per request; waiting for one doesn't use them up. */
  const maxAttempts = LANES.length * 2 + 4;
  /** Waiting on rate limits stops here; then a shorter request (Groq) or an error. */
  const deadline = Date.now() + 150_000;
  let waits = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (opts.signal?.aborted) throw new AiUnavailableError("Stopped.");

    const now = Date.now();
    const lane = LANES.find((l) => !skip.has(l.id) && fits(l) && readyAt(l, sizeOf(l)) <= now);
    if (!lane) {
      // Lanes that could take this request once their cooldown or minute budget allows.
      const later = LANES.filter((l) => !skip.has(l.id) && fits(l));
      const soonest = later.length ? Math.min(...later.map((l) => readyAt(l, sizeOf(l)))) - now : Infinity;
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

    const out = outOf(lane);
    const body: Record<string, unknown> = {
      model: lane.model,
      messages: prepareMessages(lane.provider, opts.messages),
      ...(opts.tools.length ? { tools: opts.tools, tool_choice: "auto" } : {}),
      temperature: 0.2,
      max_tokens: out,
    };
    if (lane.provider === "groq") body.reasoning_effort = "medium";

    // The owner's Stop AND a timeout: a provider that hangs must not hold the
    // request until someone presses Stop (the agent always passes a signal).
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const res = await fetch(`${lane.base}/chat/completions`, {
      method: "POST",
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
      headers: { "content-type": "application/json", authorization: `Bearer ${lane.key}` },
      body: JSON.stringify(body),
    }).catch((err: Error) => {
      if (opts.signal?.aborted) throw new AiUnavailableError("Stopped.");
      const why = timeout.aborted ? `didn't answer within ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s` : `couldn't be reached (${err.message})`;
      cool(lane, timeout.aborted ? 60_000 : 30_000, `${lane.label} ${why}`, "unavailable");
      return null;
    });
    if (!res) continue;
    if (Number.isFinite(lane.tokensPerMinute)) {
      const list = recent.get(lane.id) ?? [];
      list.push({ at: Date.now(), tokens: sizeOf(lane) });
      recent.set(lane.id, list);
    }

    if (res.ok) {
      type Completion = { choices?: { message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      // The body can time out or be cut off too.
      const data = await (res.json() as Promise<Completion>).catch((): null => {
        if (opts.signal?.aborted) throw new AiUnavailableError("Stopped.");
        return null;
      });
      if (!data) { cool(lane, 60_000, `${lane.label} sent an incomplete answer`, "unavailable"); continue; }
      const choice = data.choices?.[0];
      const raw = choice?.message;
      if (!raw) { cool(lane, 30_000, `${lane.label} returned an empty answer`); continue; }
      recordUsage(lane, { req: 1, tokensIn: data.usage?.prompt_tokens ?? 0, tokensOut: data.usage?.completion_tokens ?? 0 });
      let content = contentText(raw.content);
      let toolCalls = normalizeToolCalls(raw.tool_calls);
      if (!toolCalls.length && content && toolNames.size) {
        // A model whose server doesn't parse tool calls writes them as text: they're still calls.
        const found = textToolCalls(content, toolNames);
        if (found.calls.length) {
          log.info({ lane: lane.label, calls: found.calls.length }, "Tool calls written as text — taken as calls");
          toolCalls = found.calls;
          content = found.text;
        }
      }
      const cutOff = CUT_OFF.test(String(choice?.finish_reason ?? ""));
      const broken = toolCalls.some((c) => !argumentsParse(c.function.arguments));
      if (cutOff && (broken || (!content?.trim() && !toolCalls.length)) && !boosted.has(lane.id)) {
        // Cut off at its output limit (a long file, or thinking that used it all up): the same AI again, with more room.
        boosted.set(lane.id, out * 2);
        if (outOf(lane) >= out * 1.25) {
          log.info({ lane: lane.label, from: out, to: outOf(lane) }, "Answer was cut off at its output limit — asking again with more room");
          attempt--;
          continue;
        }
      }
      if (!content?.trim() && !toolCalls.length) {
        // Nothing to say or do (e.g. it only "thought"): another model may do better.
        skip.add(lane.id);
        firstRejection ||= `${lane.label} answered with nothing`;
        log.warn({ lane: lane.label }, `${lane.label} answered with nothing — trying the next AI`);
        continue;
      }
      if (cutOff) log.warn({ lane: lane.label, outputLimit: out, brokenCalls: broken }, "Answer was cut off at its output limit");
      return {
        message: { role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
        model: lane.model, truncated: cutOff, outputLimit: out,
      };
    }

    const text = await res.text().catch(() => "");
    if ((res.status === 400 || res.status === 422) && OUTPUT_LIMIT.test(text) && !capFixed.has(lane.id)) {
      // The model's own limit on output is lower than asked ("max_tokens must be ≤ 8192"): kept for next time, and asked again now.
      const cap = maxTokensFromError(text, out);
      if (cap) {
        capFixed.add(lane.id);
        learnedCap.set(lane.id, cap);
        log.warn({ lane: lane.label, cap }, `${lane.label} takes at most ${cap} output tokens — asking again with that`);
        if (outOf(lane) > 0) { attempt--; continue; }
      }
    }
    if (res.status === 413 || ((res.status === 400 || res.status === 422) && TOO_LARGE.test(text))) {
      // Too big for this lane (Groq's per-minute size, a context window); a bigger one may take it.
      tooBig.add(lane.id);
      log.warn({ lane: lane.label }, `${lane.label}: request too large — trying the next AI`);
      continue;
    }
    if (res.status === 429) {
      const google = lane.provider === "gemini" ? googleQuota(text) : null;
      if (google?.noFreeTier) cool(lane, DAY, `${lane.label} has no free use on this plan`, "unavailable");
      // Rest until the day's quota comes back (Google says when), not an hour at a time.
      else if (google?.daily) cool(lane, clamp((google.retrySeconds ?? 3600) * 1000, 5 * MINUTE, DAY), `${lane.label} used its free requests for today`, "out_of_quota");
      else if (google) cool(lane, clamp((google.retrySeconds ?? 30) * 1000, 5_000, 2 * MINUTE), `${lane.label} is rate limited`, "rate_limited");
      else if (DAILY.test(text)) cool(lane, 60 * 60_000, `${lane.label} is out of quota`, "out_of_quota");
      // Mistral's limits are per minute: a 429 means its minute is used up.
      else cool(lane, Math.min(65, Number(res.headers.get("retry-after")) || (lane.provider === "mistral" ? 60 : 30)) * 1000, `${lane.label} is rate limited`, "rate_limited");
      continue;
    }
    if (res.status === 400 && /tool_use_failed|failed_generation/i.test(text) && badRequests++ < 2) {
      // The model wrote a malformed tool call; asking again usually works.
      log.warn("Malformed tool call from the model — retrying");
      continue;
    }
    // A model the plan doesn't include won't start working in an hour: rest it for a day.
    if (res.status === 403 && /tier_not_allowed|not available in your subscription tier/i.test(text)) { cool(lane, DAY, `${lane.label} isn't included in this plan`, "refused"); continue; }
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
  learnedCap.clear();
}

/**
 * When some AI could take a request of about `size` tokens (ms timestamp; a
 * time in the past means now), from the lanes' cooldowns and minute budgets.
 * null when no AI is configured. Used to retry automatic fixes when every key
 * was at its limit.
 */
export function aiReadyAt(size = 6000): number | null {
  if (!LANES.length) return null;
  const fit = LANES.filter((l) => size <= l.maxRequestTokens);
  return Math.min(...(fit.length ? fit : LANES).map((l) => readyAt(l, size)));
}

/**
 * How much history to send: `large` when the AI that would answer first now
 * has no per-minute token limit (Gemini, most gateways — they take far
 * longer chats), else `small` (Mistral's and Groq's free plans). A request
 * that turns out too big is cut down by the agent as before.
 */
export function historyBudget(small: number, large: number): number {
  const now = Date.now();
  const first = LANES.find((l) => readyAt(l, small) <= now);
  return first && !Number.isFinite(first.maxRequestTokens) ? Math.max(small, large) : small;
}

/** Which lanes are configured (for the health check and tests). */
export function configuredLanes(): string[] {
  return LANES.map((l) => l.label);
}
