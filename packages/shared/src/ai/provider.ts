/**
 * Unified AI Provider
 * OWNERSHIP: packages/shared/src/ai
 *
 * Supports: OpenAI · Groq · Mistral · Replicate · Serper (web search)
 *
 * All AI calls go through `aiChat()` — one function, any provider.
 * Provider is selected by AI_PROVIDER env var or per-call override.
 *
 * Model routing by tier:
 *   free/starter → groq   (fastest, cheapest)
 *   pro          → mistral (balanced)
 *   elite/enterprise → openai gpt-4o (most capable)
 */

export type AiProvider = "openai" | "groq" | "mistral";

export interface AiMessage {
  role:    "system" | "user" | "assistant";
  content: string;
}

export interface AiResponse {
  text:       string;
  provider:   AiProvider;
  model:      string;
  inputTokens:  number;
  outputTokens: number;
}

// ─── Model map per provider ───────────────────────────────────────────────────
const MODELS: Record<AiProvider, { fast: string; smart: string }> = {
  openai:  { fast: "gpt-4o-mini",           smart: "gpt-4o"                  },
  // Groq shut Llama 3.x off for free/developer keys on 2026-08-16; these are
  // its recommended replacements (console.groq.com/docs/deprecations).
  groq:    { fast: "openai/gpt-oss-20b",     smart: "openai/gpt-oss-120b"     },
  mistral: { fast: "mistral-small-latest",   smart: "mistral-large-latest"    },
};

// ─── Tier → provider routing ──────────────────────────────────────────────────
export function providerForTier(tier: string): AiProvider {
  if (tier === "elite" || tier === "enterprise" || tier === "dev") return "openai";
  if (tier === "pro") return "mistral";
  return "groq"; // free + starter
}

export function modelForTier(tier: string, quality: "fast" | "smart" = "fast"): string {
  const provider = providerForTier(tier);
  return MODELS[provider][quality];
}

// ─── Core chat function ───────────────────────────────────────────────────────

export async function aiChat(
  messages:   AiMessage[],
  options: {
    provider?:   AiProvider;
    model?:      string;
    maxTokens?:  number;
    tier?:       string;
    quality?:    "fast" | "smart";
  } = {},
): Promise<AiResponse> {
  const provider = options.provider
    ?? (options.tier ? providerForTier(options.tier) : getDefaultProvider());

  const quality = options.quality ?? "fast";
  const model   = options.model ?? MODELS[provider][quality];

  switch (provider) {
    case "groq":    return callGroq(messages, model, options.maxTokens ?? 1000);
    case "mistral": return callMistral(messages, model, options.maxTokens ?? 1000);
    case "openai":  return callOpenAI(messages, model, options.maxTokens ?? 1000);
    default:        return callGroq(messages, MODELS.groq.fast, options.maxTokens ?? 1000);
  }
}

function getDefaultProvider(): AiProvider {
  const env = process.env.AI_PROVIDER as AiProvider | undefined;
  if (env && MODELS[env]) return env;
  // Auto-select based on available keys
  if (process.env.GROQ_API_KEY)    return "groq";
  if (process.env.MISTRAL_API_KEY) return "mistral";
  if (process.env.OPENAI_API_KEY)  return "openai";
  throw new Error("No AI provider configured. Set GROQ_API_KEY, MISTRAL_API_KEY, or OPENAI_API_KEY in .env");
}

// ─── Timeout (M-22) ───────────────────────────────────────────────────────────
//
// SECURITY/RELIABILITY FIX (M-22): callGroq / callMistral / callOpenAI had no
// timeout at all, unlike the sibling packages/engine/src/runtime/AIProvider.ts.
// A provider that accepts the connection and then stalls would hold the
// caller (a request handler or worker job) open indefinitely — a cheap way to
// exhaust concurrency. One shared helper now bounds all three.
//
// AbortSignal.timeout() is used (not setTimeout+clear) so the limit also
// covers reading the response BODY, not just waiting for headers.
const AI_REQUEST_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(
  url:       string,
  init:      RequestInit,
  timeoutMs: number = AI_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if ((err as { name?: string })?.name === "TimeoutError" || (err as { name?: string })?.name === "AbortError") {
      throw new Error(`AI provider request timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

// ─── Groq ─────────────────────────────────────────────────────────────────────

/**
 * gpt-oss models think before answering and those reasoning tokens count
 * against max_tokens — a small budget can be used up before any visible
 * reply. Keep reasoning short and leave room for it.
 */
export function groqTokenParams(model: string, maxTokens: number): Record<string, unknown> {
  if (!model.startsWith("openai/gpt-oss")) return { max_tokens: maxTokens };
  return { max_tokens: maxTokens + 1024, reasoning_effort: "low" };
}

async function callGroq(
  messages:  AiMessage[],
  model:     string,
  maxTokens: number,
): Promise<AiResponse> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY not set");

  const res = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
    method:  "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body:    JSON.stringify({ model, messages, ...groqTokenParams(model, maxTokens) }),
  });

  if (!res.ok) throw new Error(`Groq error ${res.status}: ${await res.text()}`);
  const data = await res.json() as any;

  return {
    text:         data.choices[0].message.content ?? "",
    provider:     "groq",
    model,
    inputTokens:  data.usage?.prompt_tokens    ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };
}

// ─── Mistral ──────────────────────────────────────────────────────────────────

async function callMistral(
  messages:  AiMessage[],
  model:     string,
  maxTokens: number,
): Promise<AiResponse> {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) throw new Error("MISTRAL_API_KEY not set");

  const res = await fetchWithTimeout("https://api.mistral.ai/v1/chat/completions", {
    method:  "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body:    JSON.stringify({ model, messages, max_tokens: maxTokens }),
  });

  if (!res.ok) throw new Error(`Mistral error ${res.status}: ${await res.text()}`);
  const data = await res.json() as any;

  return {
    text:         data.choices[0].message.content ?? "",
    provider:     "mistral",
    model,
    inputTokens:  data.usage?.prompt_tokens    ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };
}

// ─── OpenAI ───────────────────────────────────────────────────────────────────

async function callOpenAI(
  messages:  AiMessage[],
  model:     string,
  maxTokens: number,
): Promise<AiResponse> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");

  const res = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
    method:  "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body:    JSON.stringify({ model, messages, max_tokens: maxTokens }),
  });

  if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
  const data = await res.json() as any;

  return {
    text:         data.choices[0].message.content ?? "",
    provider:     "openai",
    model,
    inputTokens:  data.usage?.prompt_tokens    ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };
}

// ─── Serper Web Search ────────────────────────────────────────────────────────

export interface SerperResult {
  title:   string;
  link:    string;
  snippet: string;
}

/**
 * Searches the web via Serper and returns top results.
 * Used for the bot's real-time knowledge retrieval (web search skill).
 */
export async function webSearch(
  query:    string,
  maxResults = 5,
): Promise<SerperResult[]> {
  const key = process.env.SERPER_API_KEY;
  if (!key) {
    console.warn("SERPER_API_KEY not set — web search disabled");
    return [];
  }

  // M-22 follow-up: bounded like the LLM calls. Web search is optional
  // enrichment and already degrades to [] on failure, so a timeout/network
  // error degrades the same way instead of newly throwing into callers.
  let data: any;
  try {
    const res = await fetchWithTimeout("https://google.serper.dev/search", {
      method:  "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": key },
      body:    JSON.stringify({ q: query, num: maxResults }),
    }, 10_000);

    if (!res.ok) return [];
    data = await res.json();
  } catch (err) {
    console.warn("Serper search failed or timed out — returning no results:", (err as Error).message);
    return [];
  }

  return (data.organic ?? []).slice(0, maxResults).map((r: any) => ({
    title:   r.title   ?? "",
    link:    r.link    ?? "",
    snippet: r.snippet ?? "",
  }));
}

// ─── Replicate Image Generation ───────────────────────────────────────────────

/**
 * Generates an image via Replicate (SDXL or Flux).
 * Used for bot avatar generation and room visual content.
 */
export async function generateImage(
  prompt:  string,
  model =  "black-forest-labs/flux-schnell",
): Promise<string | null> {
  const key = process.env.REPLICATE_API_KEY;
  if (!key) {
    console.warn("REPLICATE_API_KEY not set — image generation disabled");
    return null;
  }

  const res = await fetchWithTimeout(`https://api.replicate.com/v1/models/${model}/predictions`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body:    JSON.stringify({ input: { prompt, num_outputs: 1, output_format: "webp" } }),
  });

  if (!res.ok) return null;
  const prediction = await res.json() as any;

  // Poll for completion (Replicate is async)
  const pollUrl = prediction.urls?.get;
  if (!pollUrl) return null;

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    // One slow/failed poll must not abort the whole generation — each poll is
    // individually bounded, and the loop's own 20-iteration cap still applies.
    let result: any;
    try {
      const poll = await fetchWithTimeout(pollUrl, {
        headers: { "Authorization": `Bearer ${key}` },
      }, 10_000);
      result = await poll.json();
    } catch {
      continue;
    }
    if (result.status === "succeeded") return result.output?.[0] ?? null;
    if (result.status === "failed")    return null;
  }

  return null; // Timeout
}
