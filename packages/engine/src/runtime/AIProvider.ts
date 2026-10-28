/**
 * AI Provider Abstraction
 * OWNERSHIP: packages/engine/src/runtime
 *
 * Bots use this for *conversational chat replies only*. Moderation and
 * reactivity (auto-react, mute/kick on rule violations) are handled by the
 * deterministic ReactiveEngine (./ReactiveEngine.ts) and do NOT depend on
 * any of these providers — they work with zero configuration.
 *
 * This layer is purely additive: when no provider is configured,
 * generateChatReply() resolves to `null` and callers fall back to
 * ReactiveEngine's templated responses.
 *
 * SUPPORTED PROVIDERS:
 *   - groq    — https://api.groq.com (OpenAI-compatible)        env: GROQ_API_KEY
 *   - openai  — https://api.openai.com (OpenAI-compatible)      env: OPENAI_API_KEY
 *   - mistral — https://api.mistral.ai (OpenAI-compatible)      env: MISTRAL_API_KEY
 *   - ollama  — http://localhost:11434 (local, OpenAI-compatible /v1) env: OLLAMA_BASE_URL, OLLAMA_MODEL
 *
 * SELECTION:
 *   AI_PROVIDER env var picks explicitly. If unset, auto-selects the first
 *   provider with a usable configuration in the order above (matches the
 *   "auto-selects based on which keys are present" behavior documented in
 *   .env.example).
 */

export type AIProviderName = "groq" | "openai" | "mistral" | "ollama";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AIProviderConfig {
  name: AIProviderName;
  baseUrl: string;
  apiKey?: string;
  model: string;
}

const DEFAULT_MODELS: Record<AIProviderName, string> = {
  // Llama 3.x was shut off for free Groq keys on 2026-08-16.
  groq:    "openai/gpt-oss-20b",
  openai:  "gpt-4o-mini",
  mistral: "mistral-small-latest",
  ollama:  "qwen2.5:3b",
};

const BASE_URLS: Record<AIProviderName, string> = {
  groq:    "https://api.groq.com/openai/v1",
  openai:  "https://api.openai.com/v1",
  mistral: "https://api.mistral.ai/v1",
  ollama:  "http://localhost:11434/v1",
};

/**
 * Resolves the active AI provider config from environment variables, or
 * `null` if none is configured. Ollama needs no API key — only its local
 * server needs to be reachable — so it's treated as "configured" whenever
 * explicitly selected or when OLLAMA_BASE_URL is set.
 */
export function resolveAIProvider(env: NodeJS.ProcessEnv = process.env): AIProviderConfig | null {
  const explicit = (env.AI_PROVIDER ?? "").toLowerCase() as AIProviderName | "";

  const candidates: AIProviderName[] = explicit
    ? [explicit as AIProviderName]
    : ["groq", "openai", "mistral", "ollama"];

  for (const name of candidates) {
    switch (name) {
      case "groq":
        if (env.GROQ_API_KEY) {
          return { name, baseUrl: BASE_URLS.groq, apiKey: env.GROQ_API_KEY, model: env.GROQ_MODEL ?? DEFAULT_MODELS.groq };
        }
        break;
      case "openai":
        if (env.OPENAI_API_KEY) {
          return { name, baseUrl: BASE_URLS.openai, apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL ?? DEFAULT_MODELS.openai };
        }
        break;
      case "mistral":
        if (env.MISTRAL_API_KEY) {
          return { name, baseUrl: BASE_URLS.mistral, apiKey: env.MISTRAL_API_KEY, model: env.MISTRAL_MODEL ?? DEFAULT_MODELS.mistral };
        }
        break;
      case "ollama":
        // No key needed — only treat as "configured" if explicitly chosen
        // or a base URL was provided, so we don't silently probe
        // localhost:11434 on every message when nothing is set up.
        if (explicit === "ollama" || env.OLLAMA_BASE_URL) {
          return {
            name,
            baseUrl: env.OLLAMA_BASE_URL ?? BASE_URLS.ollama,
            model:   env.OLLAMA_MODEL ?? DEFAULT_MODELS.ollama,
          };
        }
        break;
    }
  }

  return null;
}

/**
 * Generates a chat reply via the configured provider's OpenAI-compatible
 * `/chat/completions` endpoint. Returns `null` on any failure (network,
 * auth, provider down) so the caller can fall back to ReactiveEngine —
 * a flaky AI provider should never take a bot offline.
 */
export async function generateChatReply(
  config: AIProviderConfig,
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number; timeoutMs?: number } = {},
): Promise<string | null> {
  const { maxTokens = 200, temperature = 0.8, timeoutMs = 10_000 } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;

    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method:  "POST",
      headers,
      signal:  controller.signal,
      body: JSON.stringify({
        model:       config.model,
        messages,
        temperature,
        // gpt-oss reasoning tokens count against max_tokens; keep reasoning
        // short and leave room for it so a reply is still produced.
        ...(config.model.startsWith("openai/gpt-oss")
          ? { max_tokens: maxTokens + 1024, reasoning_effort: "low" }
          : { max_tokens: maxTokens }),
      }),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content?.trim();
    return content && content.length > 0 ? content : null;
  } catch {
    // Network error, timeout, provider unreachable (e.g. Ollama not
    // running) — degrade gracefully rather than throwing.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
