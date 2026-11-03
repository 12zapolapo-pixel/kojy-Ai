/**
 * What the coder AI used today: one row per model (and key), in the order the
 * runner tries them. The runner writes the counts and each model's state to
 * Redis (apps/runner/src/agent/groq.ts); this only reads and shapes them for
 * the chat's "AI models" circle. No API keys are stored or returned.
 * OWNERSHIP: apps/api/src/modules/projects
 */

export type AiModelState = "ready" | "rate_limited" | "out_of_quota" | "refused" | "unavailable" | "error";

export interface AiModelUsage {
  id: string;
  order: number;
  provider: string;
  model: string;
  /** Which key of that provider (1, 2, 3…); for display only. */
  keyNo: number;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  failures: number;
  lastUsedAt: number | null;
  state: AiModelState;
  /** When not ready: seconds until it is tried again. */
  restSeconds: number;
  reason: string;
}

export interface AiUsageResult {
  /** UTC day the counts are for; they start again at 00:00 UTC. */
  date: string;
  models: AiModelUsage[];
}

/** The one Redis command this needs. */
export interface HashReader { hgetall(key: string): Promise<Record<string, string>> }

const KINDS = new Set(["rate_limited", "out_of_quota", "refused", "unavailable", "error"]);
const num = (v: string | undefined) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

export async function readAiUsage(redis: HashReader | null, now = Date.now()): Promise<AiUsageResult> {
  const date = new Date(now).toISOString().slice(0, 10);
  if (!redis) return { date, models: [] };
  const [lanes, day] = await Promise.all([redis.hgetall("ai_lanes"), redis.hgetall(`ai_usage:${date}`)]);

  const models: AiModelUsage[] = [];
  for (const [id, raw] of Object.entries(lanes)) {
    let s: { order?: number; provider?: string; model?: string; keyNo?: number; coolUntil?: number; kind?: string | null; reason?: string };
    try { s = JSON.parse(raw); } catch { continue; }
    const resting = (s.coolUntil ?? 0) > now && !!s.kind && KINDS.has(s.kind);
    models.push({
      id,
      order: s.order ?? 0,
      provider: s.provider ?? id.split(":")[0] ?? "",
      model: s.model ?? "",
      keyNo: s.keyNo ?? 1,
      requests: num(day[`${id}|req`]),
      tokensIn: num(day[`${id}|in`]),
      tokensOut: num(day[`${id}|out`]),
      failures: num(day[`${id}|fail`]),
      lastUsedAt: day[`${id}|last`] ? num(day[`${id}|last`]) : null,
      state: resting ? (s.kind as AiModelState) : "ready",
      restSeconds: resting ? Math.ceil(((s.coolUntil ?? 0) - now) / 1000) : 0,
      reason: resting ? (s.reason ?? "") : "",
    });
  }
  models.sort((a, b) => a.order - b.order);
  return { date, models };
}
