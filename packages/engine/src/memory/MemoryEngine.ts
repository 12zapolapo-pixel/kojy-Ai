/**
 * Memory Compression Engine
 *
 * SKILL #18 — Bot Intelligence Layer
 * OWNERSHIP: packages/engine/src/memory
 *
 * WHAT IT DOES:
 * Raw bot memories accumulate rapidly (every interaction creates entries).
 * This engine compresses groups of related raw memories into dense semantic
 * summaries using Claude, preserving the most important context while
 * dramatically reducing storage and context window usage.
 *
 * ALGORITHM:
 * 1. Select raw memories older than 24h AND below importance threshold
 * 2. Group by time window (6-hour buckets)
 * 3. For each group: call Claude with memories → produce summary paragraph
 * 4. Store compressed summary with avgImportance of the group
 * 5. Mark originals as "compressed" (retained 30 days for audit)
 * 6. After 90 days: archive originals to cold storage (S3), delete from DB
 *
 * WORKER JOB:
 * - Queue: QUEUE_NAMES.MEMORY_COMPRESSION
 * - Schedule: every 6 hours per org
 * - Concurrency: 3 (limited by API rate limits)
 * - Retry: 2 attempts with 30min backoff
 *
 * COST MANAGEMENT:
 * - Uses the fast Groq model (openai/gpt-oss-20b) — sufficient for summarization
 * - Batches up to 20 memories per API call
 * - Skips compression if <5 raw memories exist (not worth the API cost)
 * - Free tier bots: compression disabled (memories capped at 100 entries)
 *
 * SECURITY:
 * - Memory content never leaves the user's org context
 * - API key used is the platform key, not user's BYOK key
 *
 * FAILURE:
 * - Claude API fails: job retries 2x, then marks job as "pending" for next run
 * - Partial compression: already-compressed summaries kept, raw batch retried
 * - Corrupt memory payload: skip that entry, log warning, continue
 */

import type { BotMemory, MemoryCompressionState } from "@kojyai/shared/types";
import { aiChat } from "@kojyai/shared/ai";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CompressionBatch {
  botId: string;
  orgId: string;
  memories: BotMemory[];
  windowStart: Date;
  windowEnd: Date;
}

export interface CompressionResult {
  success: boolean;
  summary: string;
  avgImportance: number;
  memoriesCompressed: number;
  tokensUsed: number;
  error?: string;
}

// ─── Core Compression ─────────────────────────────────────────────────────────

/**
 * Compress a batch of raw memories into a single semantic summary.
 * Called by the worker job — never called synchronously on request path.
 */
export async function compressBatch(batch: CompressionBatch): Promise<CompressionResult> {
  const { memories } = batch;

  if (memories.length < 3) {
    return {
      success: false,
      summary: "",
      avgImportance: 0,
      memoriesCompressed: 0,
      tokensUsed: 0,
      error: "Batch too small to compress",
    };
  }

  // Build the compression prompt
  const memoriesText = memories
    .map((m, i) => `Memory ${i + 1} [importance: ${m.importance.toFixed(2)}, type: ${m.type}]:\n${m.summary}`)
    .join("\n\n---\n\n");

  const prompt = buildCompressionPrompt(memoriesText, memories.length);

  try {
    const response = await aiChat(
      [{ role: "user", content: prompt }],
      { maxTokens: 500 },
    );

    const summaryText = response.text;

    const avgImportance =
      memories.reduce((sum, m) => sum + m.importance, 0) / memories.length;

    return {
      success: true,
      summary: summaryText.trim(),
      avgImportance,
      memoriesCompressed: memories.length,
      // FIX-AUDIT: AiResponse exposes flat inputTokens/outputTokens, not a
      // nested usage.{input_tokens,output_tokens} object (that's the raw
      // OpenAI/Anthropic wire format — this codebase normalizes it before
      // returning from generateChatReply). The old line read a property that
      // doesn't exist on AiResponse at all and would have thrown at runtime.
      tokensUsed: response.inputTokens + response.outputTokens,
    };
  } catch (err) {
    return {
      success: false,
      summary: "",
      avgImportance: 0,
      memoriesCompressed: 0,
      tokensUsed: 0,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

// ─── Prompt Builder ───────────────────────────────────────────────────────────

function buildCompressionPrompt(memoriesText: string, count: number): string {
  return `You are a memory compression system for an AI agent. 
Your task is to compress ${count} individual memory entries into a single coherent summary paragraph.

RULES:
- Preserve the most important facts, relationships, and emotional context
- Write in third person ("The bot experienced...", "The user mentioned...")
- Capture patterns, not just individual events
- Be specific about key names, places, or values mentioned
- Maximum 3 sentences
- Output ONLY the summary paragraph, nothing else

MEMORIES TO COMPRESS:
${memoriesText}

COMPRESSED SUMMARY:`;
}

// ─── Memory Grouping ──────────────────────────────────────────────────────────

/**
 * Groups raw memories by 6-hour time windows.
 * Returns batches ready for compression.
 */
export function groupMemoriesForCompression(
  memories: BotMemory[],
  botId: string,
  orgId: string,
): CompressionBatch[] {
  if (memories.length === 0) return [];

  const WINDOW_MS = 6 * 60 * 60 * 1_000; // 6 hours

  // Sort by timestamp ascending
  const sorted = [...memories].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const batches: CompressionBatch[] = [];
  let windowStart = new Date(sorted[0]!.timestamp);
  let currentBatch: BotMemory[] = [];

  for (const memory of sorted) {
    const memTime = new Date(memory.timestamp).getTime();
    const windowEnd = windowStart.getTime() + WINDOW_MS;

    if (memTime <= windowEnd) {
      currentBatch.push(memory);
    } else {
      // Flush current batch
      if (currentBatch.length >= 3) {
        batches.push({
          botId,
          orgId,
          memories: currentBatch,
          windowStart,
          windowEnd: new Date(windowEnd),
        });
      }
      // Start new window
      windowStart = new Date(memory.timestamp);
      currentBatch = [memory];
    }
  }

  // Flush final batch
  if (currentBatch.length >= 3) {
    batches.push({
      botId,
      orgId,
      memories: currentBatch,
      windowStart,
      windowEnd: new Date(windowStart.getTime() + WINDOW_MS),
    });
  }

  return batches;
}

// ─── Importance Scorer ────────────────────────────────────────────────────────

/**
 * Scores the importance of a new memory entry before storage.
 * Higher scores = retained longer, compressed last.
 *
 * Score factors:
 * - Memory type weight (emotional > episodic > semantic > procedural)
 * - Presence of named entities (names, amounts, places)
 * - Sentiment intensity (strongly positive or negative = important)
 * - Recency (not used here — importance is content-based, recency is a query concern)
 */
export function scoreMemoryImportance(input: {
  content: string;
  type: BotMemory["type"];
  sentiment?: number;
}): number {
  let score = 0.5; // Base score

  // Type weights
  const typeWeights: Record<BotMemory["type"], number> = {
    emotional:   0.2,
    episodic:    0.1,
    semantic:    0.05,
    procedural:  0,
  };
  score += typeWeights[input.type] ?? 0;

  // Named entity boost (simple heuristic — production would use NER)
  const namedEntityPattern = /\b[A-Z][a-z]+\b|\$[\d,]+|\d+ gold|\broom\s+\d+/g;
  const entityCount = (input.content.match(namedEntityPattern) ?? []).length;
  score += Math.min(entityCount * 0.05, 0.2);

  // Sentiment intensity boost
  if (input.sentiment !== undefined) {
    const intensity = Math.abs(input.sentiment);
    score += intensity * 0.15;
  }

  return Math.min(1, Math.max(0, score));
}

// ─── Memory Context Builder ───────────────────────────────────────────────────

/**
 * Builds the memory context injected into the bot's AI prompt.
 * Selects the most important/recent memories and formats them for injection.
 * Called on every message cycle — must be fast (no async).
 */
export function buildMemoryContext(memories: BotMemory[], maxTokens = 800): string {
  if (memories.length === 0) return "";

  // Sort: compressed summaries first (higher quality), then by importance desc
  const sorted = [...memories].sort((a, b) => {
    if (a.compressionState === "compressed" && b.compressionState !== "compressed") return -1;
    if (b.compressionState === "compressed" && a.compressionState !== "compressed") return 1;
    return b.importance - a.importance;
  });

  const lines: string[] = [];
  let estimatedTokens = 0;
  const TOKEN_ESTIMATE_PER_CHAR = 0.25;

  for (const memory of sorted) {
    const line = `[${memory.type}] ${memory.summary}`;
    const tokens = line.length * TOKEN_ESTIMATE_PER_CHAR;
    if (estimatedTokens + tokens > maxTokens) break;
    lines.push(line);
    estimatedTokens += tokens;
  }

  if (lines.length === 0) return "";

  return `Relevant memories:\n${lines.join("\n")}`;
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export interface MemoryStats {
  totalRaw: number;
  totalCompressed: number;
  totalArchived: number;
  estimatedTokens: number;
  compressionRatio: number;
}

export function calculateMemoryStats(memories: BotMemory[]): MemoryStats {
  const raw = memories.filter((m) => m.compressionState === "raw").length;
  const compressed = memories.filter((m) => m.compressionState === "compressed").length;
  const archived = memories.filter((m) => m.compressionState === "archived").length;

  // Rough token estimate: 50 tokens per raw memory, 200 tokens per compressed
  const estimatedTokens = raw * 50 + compressed * 200;

  const compressionRatio =
    raw + archived > 0 ? compressed / (raw + compressed + archived) : 0;

  return {
    totalRaw: raw,
    totalCompressed: compressed,
    totalArchived: archived,
    estimatedTokens,
    compressionRatio,
  };
}
