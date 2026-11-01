/**
 * Chat client for the coder AI — any OpenAI-compatible server, with tool calls.
 * OWNERSHIP: apps/runner/src/agent
 *
 * Kojy uses these AIs, best first (see endpoints()):
 *   1. AGENT_API_KEY — a bigger free plan: several Google Gemini models by
 *      default, taking turns (AGENT_BASE_URL / AGENT_MODEL pick others)
 *   2. GROQ_API_KEY — Groq's free plan: gpt-oss-120b, gpt-oss-20b, qwen3.8-27b
 * Each has its own budgets: Groq's free plan (per model: ~8K tokens/minute,
 * ~200K/day) only fits a short history and answer; Gemini's fits whole files.
 *   - paces itself: waits before a request that would go over the minute budget
 *   - on 429 it waits for the retry time and tries again — or, for Gemini,
 *     hands the request to the next model of the same AI at once (each has its own limits)
 *   - when an AI's daily budget is used up, its key is refused, it doesn't
 *     answer in time or keeps failing, it moves to the next AI for a while
 *   - a request one AI refuses (a 400) goes to the next AI
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
/** The request was sized for a bigger plan than the AI that's free now (Gemini resting → Groq): build it again for `ep`. */
export class ResizeError extends RequestTooLargeError {
  constructor(readonly ep: Endpoint) { super(`The request is too big for ${ep.id}; rebuilding it smaller.`); }
}

/** One AI Kojy can use, with the budgets its plan allows. */
export interface Endpoint {
  /** Small plan (Groq): send short tool descriptions and a shorter prompt so a request fits its per-minute budget. */
  compact?: boolean;
  /** For logs, and the key for pacing and skipping. */
  id: string;
  /** Models of one service; on a per-minute limit the next one in the group answers at once. */
  group: string;
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
  /** Longest wait for one answer; after that the next AI gets the request. */
  timeoutMs: number;
}

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const GROQ_URL = "https://api.groq.com/openai/v1";
// Gemini's free plan allows each model only 20 requests a day (and a few a
// minute), counted per model, so Kojy takes turns with several. All of these
// answered a real Kojy tool call in 1-2s (Oct 2026); gemini-3.8-flash took
// minutes, so it's left out.
// Checked with real tool-call requests (Oct 31): these answer in 1-6s. Not here:
// 3.7/3.8 Flash (60-90s+, overloaded), 3.1 Pro (no free allowance), 2.5 (retired).
const GEMINI_MODELS = "gemini-3.6-flash,gemini-3.5-flash,gemini-3-flash-preview,gemini-3.5-flash-lite,gemini-3.1-flash-lite";
// Groq's free plan (each: 1000 requests/day, 8K tokens/minute). It has no 70B model any more.
const GROQ_MODELS = "openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b"; // qwen last: weakest at finding bugs in a check

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
    // AGENT_MODEL: one model, or several separated by commas, best first.
    const models = (env.AGENT_MODEL ?? (gemini ? GEMINI_MODELS : "")).split(",").map((m) => m.trim()).filter(Boolean);
    for (const model of models) {
      list.push({
        id: `agent:${model}`, group: "agent", baseUrl, key: agentKey, model, kind: gemini ? "gemini" : "openai",
        tokensPerMinute: setting(env.AGENT_TOKENS_PER_MINUTE, 200_000),
        historyTokens: setting(env.AGENT_HISTORY_TOKENS, 30_000),
        maxOutputTokens: setting(env.AGENT_MAX_OUTPUT_TOKENS, 8000),
        reasoningTokens: 8000,
        ...(effort && effort !== "none" ? { reasoningEffort: effort } : {}),
        timeoutMs: setting(env.AGENT_TIMEOUT_SECONDS, 90) * 1000,
      });
    }
  }
  const groqKey = env.GROQ_API_KEY;
  if (groqKey && !groqKey.includes("placeholder")) {
    // Without AGENT_API_KEY the AGENT_* settings keep their old meaning: Kojy's Groq settings.
    const own: NodeJS.ProcessEnv = agentKey ? {} : env;
    // GROQ_MODELS: several, best first. The older single settings still win when set.
    const single = [own.AGENT_MODEL ?? env.GROQ_MODEL_SMART, env.AGENT_FALLBACK_MODEL ?? env.GROQ_MODEL_FAST].filter(Boolean) as string[];
    const groqModels = single.length ? single : (env.GROQ_MODELS ?? GROQ_MODELS).split(",").map((m) => m.trim()).filter(Boolean);
    const groq = (model: string): Endpoint => ({
      id: `groq:${model}`, group: "groq", baseUrl: trimSlash(env.GROQ_BASE_URL ?? GROQ_URL), key: groqKey, model, kind: "openai",
      tokensPerMinute: setting(own.AGENT_TOKENS_PER_MINUTE, 7500),
      historyTokens: setting(own.AGENT_HISTORY_TOKENS, 1000),
      compact: true,
      // gpt-oss reasons first (headroom for those tokens). Qwen may write only ~1000
      // tokens a minute on the free plan, and asking it to reason goes over that.
      ...(model.startsWith("qwen/")
        ? { maxOutputTokens: Math.min(setting(own.AGENT_MAX_OUTPUT_TOKENS, 900), 900), reasoningTokens: 0 }
        : { maxOutputTokens: setting(own.AGENT_MAX_OUTPUT_TOKENS, 1200), reasoningTokens: 800, reasoningEffort: "medium" }),
      timeoutMs: 120_000,
    });
    for (const model of [...new Set(groqModels)]) list.push(groq(model));
  }
  // More free plans, between Gemini and Groq: each switches on with its key plus
  // <ID>_MODELS (models are checked by hand first, so there's no default list).
  const extra: Endpoint[] = [];
  for (const p of EXTRA_PROVIDERS) {
    const key = env[p.keyEnv];
    const models = (env[`${p.id.toUpperCase()}_MODELS`] ?? "").split(",").map((m) => m.trim()).filter(Boolean);
    if (!key || !models.length) continue;
    const up = p.id.toUpperCase();
    const historyTokens = setting(env[`${up}_HISTORY_TOKENS`], p.historyTokens);
    for (const model of [...new Set(models)]) {
      extra.push({
        id: `${p.id}:${model}`, group: p.id, baseUrl: trimSlash(env[`${up}_BASE_URL`] ?? p.baseUrl), key, model, kind: "openai",
        tokensPerMinute: setting(env[`${up}_TOKENS_PER_MINUTE`], p.tokensPerMinute), historyTokens,
        maxOutputTokens: setting(env[`${up}_MAX_OUTPUT_TOKENS`], 3000), reasoningTokens: 1000,
        ...(historyTokens < 4000 ? { compact: true } : {}), timeoutMs: 90_000,
      });
    }
  }
  const firstGroq = list.findIndex((e) => e.group === "groq");
  list.splice(firstGroq < 0 ? list.length : firstGroq, 0, ...extra);
  return list;
}

/** Other free OpenAI-compatible plans Kojy can use (keys in the server's .env). */
export const EXTRA_PROVIDERS = [
  { id: "cerebras", keyEnv: "CEREBRAS_API_KEY", baseUrl: "https://api.cerebras.ai/v1", tokensPerMinute: 60_000, historyTokens: 8000 },
  { id: "openrouter", keyEnv: "OPENROUTER_API_KEY", baseUrl: "https://openrouter.ai/api/v1", tokensPerMinute: 100_000, historyTokens: 8000 },
  { id: "mistral", keyEnv: "MISTRAL_API_KEY", baseUrl: "https://api.mistral.ai/v1", tokensPerMinute: 100_000, historyTokens: 8000 },
  { id: "github", keyEnv: "GITHUB_MODELS_TOKEN", baseUrl: "https://models.github.ai/inference", tokensPerMinute: 20_000, historyTokens: 3000 },
] as const;

// ── usage, for the AI usage page ─────────────────────────────────────────────

interface Usage { day: string; requests: number; tokensIn: number; tokensOut: number; limited: number; failed: number; lastUsed: number }
const usage = new Map<string, Usage>();
const today = () => new Date().toISOString().slice(0, 10);

function count(id: string, change: Partial<Omit<Usage, "day" | "lastUsed">>): void {
  let u = usage.get(id);
  if (!u || u.day !== today()) { u = { day: today(), requests: 0, tokensIn: 0, tokensOut: 0, limited: 0, failed: 0, lastUsed: 0 }; usage.set(id, u); }
  const counters = u as unknown as Record<string, number>;
  for (const [k, v] of Object.entries(change)) counters[k] = (counters[k] ?? 0) + (v ?? 0);
  u.lastUsed = Date.now();
}

/** Every AI with today's numbers (UTC day, since the runner started) and whether it's resting now. */
export function aiUsage(): { id: string; group: string; model: string; available: boolean; restingUntil: number | null; why: string | null; usage: Usage | null }[] {
  return endpoints().map((e) => {
    const s = skipped.get(e.id);
    const resting = s !== undefined && s.until > Date.now();
    const u = usage.get(e.id);
    return { id: e.id, group: e.group, model: e.model, available: !resting, restingUntil: resting ? s!.until : null, why: resting ? s!.why : null, usage: u && u.day === today() ? u : null };
  });
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

/** Seconds to wait from a 429: the retry-after header, or Gemini's "retry in 20.5s" / "retry in 5h38m24s" / retryDelay. */
export function retrySeconds(headers: Headers, text: string): number | null {
  const header = Number(headers.get("retry-after"));
  if (header > 0) return Math.ceil(header);
  const m = /retry in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i.exec(text);
  if (m && (m[1] || m[2] || m[3])) return Math.ceil(Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0));
  const delay = /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(text);
  return delay ? Math.ceil(Number(delay[1])) : null;
}

const shortArgs = (args: string) => (args.length > 200 ? `${args.slice(0, 200)}…` : args);

/**
 * Gemini 3 refuses a tool call without its thought signature, and the steps
 * Groq made (every chat from before Gemini, too) have none. Gemini gets those
 * steps as app notes instead: "[app] Earlier step by the backup AI:
 * list_files({})" and the result (Gemini refuses a request that ends on its own turn). A
 * step is Gemini's own when any call is signed (parallel calls carry the
 * signature on the first one only); those go as they are.
 */
export function unsignedStepsAsText(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const names = new Map<string, string>(); // call id → tool name, for steps turned into text
  // Text joins a text message of the same role right before it, so turns keep alternating.
  const add = (role: "user" | "assistant", text: string) => {
    const last = out[out.length - 1];
    if (last?.role === role && !last.tool_calls?.length) out[out.length - 1] = { ...last, content: [last.content, text].filter(Boolean).join("\n") };
    else out.push({ role, content: text });
  };
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls?.length && !m.tool_calls.some((c) => c.extra_content)) {
      // As an app note, not as the model's own words: a model shown "I ran x()." as
      // its earlier reply tends to answer with that text instead of calling tools.
      if (m.content) add("assistant", m.content);
      add("user", m.tool_calls.map((c) => `[app] Earlier step by the backup AI: ${c.function.name}(${shortArgs(c.function.arguments)})`).join("\n"));
      for (const c of m.tool_calls) names.set(c.id, c.function.name);
    } else if (m.role === "tool" && m.tool_call_id && names.has(m.tool_call_id)) {
      add("user", `[app] Result of ${names.get(m.tool_call_id)}: ${m.content ?? ""}`);
    } else if ((m.role === "assistant" || m.role === "user") && !m.tool_calls?.length) {
      add(m.role, m.content ?? "");
    } else {
      out.push(m);
    }
  }
  return out;
}

/**
 * The request body for one AI. Gemini 3 gets its thought signatures back,
 * other AIs' steps as text, and its default temperature (lower values can
 * make it loop); other AIs get standard tool calls only, since extra fields
 * can be refused.
 */
/** Tools with one-sentence descriptions and no parameter descriptions (for small plans). */
export function compactTools(tools: ToolSpec[]): ToolSpec[] {
  const short = (d: unknown) => typeof d === "string" ? (d.split(/(?<=\.)\s/)[0] ?? d).slice(0, 70) : d;
  return tools.map((t) => {
    const params = t.function.parameters as { properties?: Record<string, Record<string, unknown>> } | undefined;
    const properties = params?.properties ? Object.fromEntries(Object.entries(params.properties).map(([k, v]) => {
      const { description: _d, ...rest } = v;
      if (rest.items && typeof rest.items === "object") { const { description: _i, ...items } = rest.items as Record<string, unknown>; rest.items = items; }
      return [k, rest];
    })) : undefined;
    return { ...t, function: { ...t.function, description: short(t.function.description) as string, ...(params ? { parameters: { ...params, ...(properties ? { properties } : {}) } } : {}) } };
  });
}

export function requestBody(ep: Endpoint, messages: ChatMessage[], tools: ToolSpec[], maxTokens: number): Record<string, unknown> {
  if (ep.compact && tools) tools = compactTools(tools);
  const msgs = ep.kind === "gemini" ? unsignedStepsAsText(messages) : messages.map((m) => (m.tool_calls?.length
    ? { ...m, tool_calls: m.tool_calls.map(({ id, type, function: f }) => ({ id, type, function: f })) }
    : m));
  // Gemini gets tools without settings with no "parameters" at all, the plainest valid form.
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
    // No tools (the reviewer): leave them out; an empty list is refused.
    ...(specs?.length ? { tools: specs, tool_choice: "auto" } : {}),
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
  /** Try other models first, e.g. for a second opinion on the main model's work (it's still used if nothing else answers). */
  avoidModel?: string;
  /** Only this AI's models (e.g. "groq" for the code scout, so Gemini's daily requests are kept for the real work). */
  group?: Endpoint["group"];
}

export async function chat(opts: ChatOptions): Promise<{ message: ChatMessage; model: string }> {
  const listed = endpoints().filter((e) => !opts.group || e.group === opts.group);
  const all = opts.avoidModel ? [...listed.filter((e) => e.model !== opts.avoidModel), ...listed.filter((e) => e.model === opts.avoidModel)] : listed;
  if (!all.length) {
    throw new AiUnavailableError("The coder AI needs an AI key: set AGENT_API_KEY (a free Gemini key from aistudio.google.com/apikey) or GROQ_API_KEY (free at console.groq.com/keys) in the server's .env.");
  }
  const skip = (ep: Endpoint, ms: number, why: string) => skipped.set(ep.id, { until: Date.now() + ms, why });
  // AIs that refused this particular request; the next one gets it instead.
  const refused = new Map<string, string>();
  const usable = (e: Endpoint) => available(e) && !refused.has(e.id);
  let serverErrors = 0;

  for (let attempt = 0; attempt < 8 + 2 * all.length; attempt++) {
    if (opts.signal?.aborted) throw new AiUnavailableError("Stopped.");
    const ep = all.find(usable);
    // Only when nothing else can take the step: wait for a model resting a moment (a per-minute limit).
    const resting = ep ? [] : all.filter((e) => !refused.has(e.id) && !available(e) && skipped.get(e.id)!.until - Date.now() <= 70_000);
    if (resting.length) {
      const ms = Math.max(0, Math.min(...resting.map((e) => skipped.get(e.id)!.until)) - Date.now());
      opts.onWait?.(Math.max(1, Math.ceil(ms / 1000)), "AI rate limit");
      await sleep(ms);
      continue;
    }
    if (!ep) {
      const why = [...refused.values(), ...all.map((e) => skipped.get(e.id)?.why)].filter(Boolean).pop();
      throw new AiUnavailableError(why ?? "The AI is busy right now — try again in a minute.");
    }
    const hasNext = all.some((e) => e !== ep && usable(e));
    // Another Gemini model takes the request instead of waiting out a per-minute limit
    // (each model has its own) — for Groq too, whose 8K tokens a minute fit only ~2 steps.
    const sibling = all.some((e) => e !== ep && e.group === ep.group && usable(e));
    const maxTokens = opts.maxTokens ?? ep.maxOutputTokens;
    const body = requestBody(ep, opts.messages, opts.tools, maxTokens);
    const size = estimateTokens(JSON.stringify(body.messages)) + estimateTokens(JSON.stringify(body.tools ?? [])) + maxTokens;

    // Sized for a bigger plan (Gemini's) than this AI's: the caller builds it again smaller.
    if (size > ep.tokensPerMinute) throw new ResizeError(ep);

    const used = usedLastMinute(ep.id);
    if (used > 0 && used + size > ep.tokensPerMinute) {
      const oldest = recent.get(ep.id)![0]!;
      const wait = Math.max(1, Math.ceil((60_000 - (Date.now() - oldest.at)) / 1000));
      // Another model (the same AI's, or Groq) takes the step instead of waiting.
      if (sibling || hasNext) { skip(ep, wait * 1000, "The AI's per-minute budget is used up."); continue; }
      opts.onWait?.(wait, "pacing for the free AI plan");
      await sleep(wait * 1000);
      continue;
    }

    // The owner's Stop, or this AI's time limit (an overloaded AI can take minutes).
    const timeout = AbortSignal.timeout(ep.timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${ep.baseUrl}/chat/completions`, {
        method: "POST",
        signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
        headers: { "content-type": "application/json", authorization: `Bearer ${ep.key}` },
        body: JSON.stringify(body),
      });
      text = await res.text();
    } catch (err) {
      if (opts.signal?.aborted) throw new AiUnavailableError("Stopped.");
      const why = timeout.aborted ? `The AI took longer than ${Math.round(ep.timeoutMs / 1000)}s to answer.` : `Couldn't reach the AI: ${(err as Error).message}`;
      if (!hasNext) throw new AiUnavailableError(why);
      log.warn({ ai: ep.id, why }, "AI didn't answer — using the next one for 5 minutes");
      skip(ep, 5 * 60_000, why);
      continue;
    }
    recent.get(ep.id)!.push({ at: Date.now(), tokens: size });

    if (res.ok) {
      let data: { choices?: { message: ChatMessage }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } } = {};
      try { data = JSON.parse(text) as typeof data; } catch { /* reported as empty below */ }
      count(ep.id, { requests: 1, tokensIn: data.usage?.prompt_tokens ?? size, tokensOut: data.usage?.completion_tokens ?? 0 });
      const message = data.choices?.[0]?.message;
      if (!message) throw new AiUnavailableError("The AI returned an empty answer.");
      return { message: { role: "assistant", content: message.content ?? null, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) }, model: ep.model };
    }

    if (res.status === 429) count(ep.id, { limited: 1 });
    else count(ep.id, { failed: 1 });
    if (res.status === 429) {
      if (/Request too large/i.test(text)) throw new RequestTooLargeError("The conversation got too big for the free AI plan.");
      // Groq says "tokens per day (TPD)"; Gemini "requests per day", with "retry in 5h38m24s".
      if (/per ?day|TPD|RPD/i.test(text)) {
        const seconds = Math.min(24 * 3600, retrySeconds(res.headers, text) ?? 3600);
        log.warn({ ai: ep.id, hours: Math.round(seconds / 360) / 10 }, "Daily AI budget used up — using the next AI until it resets");
        skip(ep, seconds * 1000, "The free AI plans' daily limits are used up. They reset within 24 hours (or add a paid key).");
        continue;
      }
      const wait = Math.min(65, retrySeconds(res.headers, text) ?? 20);
      if (sibling) { skip(ep, wait * 1000, "The AI's per-minute limit was reached."); continue; }
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
    const why = `AI request failed (${res.status}): ${text.slice(0, 300)}`;
    if (!hasNext) throw new AiUnavailableError(why);
    // Refused by this AI (a 400 for something only it checks): the next one may take it.
    log.warn({ ai: ep.id, status: res.status, error: text.slice(0, 300) }, "AI refused the request — trying the next one");
    refused.set(ep.id, why);
  }
  throw new AiUnavailableError("The AI is busy right now — try again in a minute.");
}
