/**
 * Embedding Provider — for Delegation Agent Memory
 * OWNERSHIP: packages/engine/src/runtime
 *
 * Separate from AIProvider.ts (which handles chat replies) because
 * embeddings and chat completions are different API surfaces, sometimes
 * from different providers. Mirrors the same pluggable, graceful-degradation
 * pattern: if nothing is configured, embed() resolves to null and the
 * Delegation memory store simply skips writing/searching — nothing else in
 * the platform depends on this.
 *
 * Dimensions are fixed at 384 to match the `delegation_memories.embedding`
 * pgvector column (apps/api/src/db/pg/schema.ts). OpenAI's
 * text-embedding-3-small supports an explicit `dimensions` parameter for
 * exactly this kind of truncation; Ollama models are the caller's
 * responsibility to pick one whose native output is already 384-dim (or
 * close — most local embedding models default to 384 or 768).
 */

const EMBEDDING_DIMENSIONS = 384;

export interface EmbeddingProviderConfig {
  name: "openai" | "ollama";
  baseUrl: string;
  apiKey?: string;
  model: string;
}

export function resolveEmbeddingProvider(env: NodeJS.ProcessEnv = process.env): EmbeddingProviderConfig | null {
  if (env.OPENAI_API_KEY) {
    return {
      name: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
    };
  }
  if (env.OLLAMA_BASE_URL) {
    return {
      name: "ollama",
      baseUrl: env.OLLAMA_BASE_URL,
      model: env.OLLAMA_EMBEDDING_MODEL ?? "nomic-embed-text",
    };
  }
  return null;
}

/** L-37: default network timeout. Embedding models can be slow to warm up (Ollama loads the model on first call), hence more generous than chat's 10s. */
const DEFAULT_EMBEDDING_TIMEOUT_MS = 15_000;

export async function embed(
  config: EmbeddingProviderConfig,
  text: string,
  opts: { timeoutMs?: number } = {},
): Promise<number[] | null> {
  // L-37: these fetches had NO timeout, so a hung provider stalled the caller (the
  // Delegation memory write/search path) indefinitely — unlike the sibling chat
  // implementation in AIProvider.ts, which has always used an AbortController.
  // The timer stays armed until the body has been read: a server that sends headers
  // and then stalls the body would otherwise hang res.json().
  const timeoutMs = opts.timeoutMs ?? (Number(process.env.EMBEDDING_TIMEOUT_MS) || DEFAULT_EMBEDDING_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (config.name === "openai") {
      const res = await fetch(`${config.baseUrl}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, input: text, dimensions: EMBEDDING_DIMENSIONS }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
      const vec = data.data?.[0]?.embedding;
      return vec && vec.length === EMBEDDING_DIMENSIONS ? vec : null;
    }

    if (config.name === "ollama") {
      const res = await fetch(`${config.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: config.model, prompt: text }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { embedding?: number[] };
      return data.embedding && data.embedding.length === EMBEDDING_DIMENSIONS ? data.embedding : null;
    }

    return null;
  } catch {
    // Network error, timeout/abort, provider down, dimension mismatch — degrade
    // gracefully, same philosophy as AIProvider.generateChatReply.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
