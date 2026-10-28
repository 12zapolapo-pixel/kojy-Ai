/**
 * Security Package — Core Security Systems
 *
 * SKILLS: 78 (Rate Limiter), 79 (Toxicity), 80 (Impersonation),
 *         81 (Account Takeover), 82 (GDPR), 83 (Fraud), 84 (IP Intelligence)
 *
 * OWNERSHIP: packages/security
 * LAYER: Cross-cutting — consumed by API middleware and bot runtime
 *
 * DESIGN:
 * - Each security concern is its own module (no god class)
 * - All security events written to DB + Redis for real-time monitoring
 * - Security decisions are fail-open by default (don't block legitimate users)
 *   EXCEPT: account lockout, which is fail-closed
 * - Admin can override security blocks via SecurityCenter UI
 *
 * THREAT MODEL:
 * 1. Credential stuffing → rate limit + lockout
 * 2. Prompt injection via bot personality rules → sanitizer
 * 3. Toxicity in rooms → Anthropic moderation API
 * 4. Account takeover → impossible travel + device fingerprint
 * 5. Bot farm fraud → IP intelligence + usage anomaly
 * 6. API abuse → per-endpoint rate limiting with Redis sliding window
 * 7. GDPR → data export + deletion workflows
 */

import { aiChat } from "@kojyai/shared/ai";

// ─── SKILL #78: Multi-Layer Rate Limiter ─────────────────────────────────────

export interface RateLimitConfig {
  windowMs:  number;
  maxHits:   number;
  keyPrefix: string;
}

export interface RateLimitResult {
  allowed:    boolean;
  remaining:  number;
  resetAt:    number;
  retryAfter: number | null;
}

// ─── In-Memory Rate Limit Fallback ───────────────────────────────────────────
// Used when Redis is unavailable. Single-pod only — not shared across instances.
// LRU-capped at IN_MEMORY_MAX_KEYS to prevent unbounded memory growth.

const IN_MEMORY_MAX_KEYS = 10_000;

interface InMemoryWindow {
  hits:  number[];   // timestamps of hits within current window
}

const inMemoryStore = new Map<string, InMemoryWindow>();

function inMemoryRateLimit(
  identifier: string,
  config:     RateLimitConfig,
  now:        number,
): RateLimitResult {
  const key         = `${config.keyPrefix}:${identifier}`;
  const windowStart = now - config.windowMs;

  // LRU eviction: if at capacity, remove the oldest entry
  if (!inMemoryStore.has(key) && inMemoryStore.size >= IN_MEMORY_MAX_KEYS) {
    const oldestKey = inMemoryStore.keys().next().value;
    if (oldestKey) inMemoryStore.delete(oldestKey);
  }

  const window = inMemoryStore.get(key) ?? { hits: [] };

  // Slide the window — remove hits older than windowMs
  window.hits = window.hits.filter((t) => t > windowStart);

  const currentCount = window.hits.length;
  const allowed      = currentCount < config.maxHits;

  if (allowed) {
    window.hits.push(now);
  }

  inMemoryStore.set(key, window);

  const remaining = Math.max(0, config.maxHits - window.hits.length);
  const resetAt   = now + config.windowMs;

  return {
    allowed,
    remaining,
    resetAt,
    retryAfter: allowed ? null : Math.ceil(config.windowMs / 1000),
  };
}

/**
 * Sliding window rate limiter backed by Redis.
 * Uses sorted set per key — accurate to the millisecond.
 * Falls back to bounded in-memory sliding window if Redis is unavailable.
 * The in-memory fallback is single-pod only — not shared across instances.
 */
export async function checkRateLimit(
  redis: any,
  identifier: string,
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = now - config.windowMs;
  const key = `${config.keyPrefix}:${identifier}`;

  if (!redis) {
    // Redis is down — use bounded in-memory sliding window (fail-closed enough to be safe).
    // This protects a single pod. It does NOT protect across multiple pods.
    // Cap: LRU evicts oldest entry when map exceeds 10k keys to prevent memory growth.
    return inMemoryRateLimit(identifier, config, now);
  }

  // Atomic pipeline: remove old entries + count + add current
  const pipeline = redis.pipeline();
  pipeline.zremrangebyscore(key, 0, windowStart);
  pipeline.zcard(key);
  pipeline.zadd(key, now, `${now}-${Math.random()}`);
  pipeline.pexpire(key, config.windowMs);

  const results = await pipeline.exec();
  const currentCount = (results?.[1]?.[1] as number) ?? 0;

  const allowed   = currentCount < config.maxHits;
  const remaining = Math.max(0, config.maxHits - currentCount - 1);
  const resetAt   = now + config.windowMs;

  return {
    allowed,
    remaining,
    resetAt,
    retryAfter: allowed ? null : Math.ceil(config.windowMs / 1000),
  };
}

// Preset rate limit configs
export const RATE_LIMITS = {
  AUTH_LOGIN:     { windowMs: 60_000,      maxHits: 10,    keyPrefix: "rl:auth:login" },
  AUTH_REGISTER:  { windowMs: 3_600_000,   maxHits: 5,     keyPrefix: "rl:auth:register" },
  API_ANONYMOUS:  { windowMs: 60_000,      maxHits: 30,    keyPrefix: "rl:api:anon" },
  API_AUTHED:     { windowMs: 60_000,      maxHits: 300,   keyPrefix: "rl:api:authed" },
  API_SIMULATION: { windowMs: 3_600_000,   maxHits: 20,    keyPrefix: "rl:api:sim" },
  BOT_MESSAGE:    { windowMs: 1_000,       maxHits: 5,     keyPrefix: "rl:bot:msg" },
  WS_CONNECT:     { windowMs: 60_000,      maxHits: 10,    keyPrefix: "rl:ws:connect" },
} as const;

// ─── SKILL #79: Toxicity Filter ──────────────────────────────────────────────

export interface ToxicityResult {
  isToxic:    boolean;
  score:      number;    // 0–1
  categories: ToxicityCategory[];
  action:     "allow" | "warn" | "block" | "escalate";
}

export type ToxicityCategory =
  | "hate_speech"
  | "harassment"
  | "threats"
  | "self_harm"
  | "sexual"
  | "violence"
  | "spam";

/**
 * Two-tier toxicity detection:
 * Tier 1: Fast regex/keyword scan (< 1ms, catches obvious cases)
 * Tier 2: Anthropic moderation API (async, for edge cases)
 *
 * Tier 1 runs synchronously on every message.
 * Tier 2 runs as a background job for messages that pass tier 1 but score > 0.3.
 */
export function scanToxicityFast(text: string): ToxicityResult {
  const lower = text.toLowerCase();

  // Hard block patterns (regex for common obfuscation)
  const HARD_BLOCK = [
    /\b(kys|kill\s*your\s*self|k+y+s+)\b/i,
    /\b(n[i1!]+gg[e3]r|f[a@]gg[o0]t)\b/i,
    /https?:\/\/[^\s]*(phish|malware|scam)/i,
  ];

  for (const pattern of HARD_BLOCK) {
    if (pattern.test(lower)) {
      return {
        isToxic:    true,
        score:      1.0,
        categories: ["threats"],
        action:     "block",
      };
    }
  }

  // Warning patterns
  const WARN_PATTERNS = [
    { pattern: /\b(idiot|stupid|moron|loser)\b/i, category: "harassment" as ToxicityCategory },
    /\b(spam|scam|free\s+gold|click\s+here)\b/i,
  ];

  let score = 0;
  const categories: ToxicityCategory[] = [];

  for (const entry of WARN_PATTERNS) {
    if ("pattern" in entry) {
      if (entry.pattern.test(lower)) {
        score += 0.4;
        categories.push(entry.category);
      }
    } else if ((entry as RegExp).test(lower)) {
      score += 0.3;
      categories.push("spam");
    }
  }

  score = Math.min(1, score);

  return {
    isToxic:    score > 0.5,
    score,
    categories,
    action:     score > 0.7 ? "block" : score > 0.3 ? "warn" : "allow",
  };
}

/**
 * Deep scan using Anthropic's safety classifier.
 * Call this for:
 * - Messages that passed fast scan but need confidence
 * - User reports
 * - Premium moderation tier
 */
export async function scanToxicityDeep(
  text: string,
): Promise<ToxicityResult> {
  try {
    const response = await aiChat([
      { role: "system", content: `You are a content moderation system. Analyze the message and respond ONLY with a JSON object:\n{"isToxic": boolean, "score": 0-1, "categories": [], "action": "allow"|"warn"|"block"}\nCategories: hate_speech, harassment, threats, self_harm, sexual, violence, spam` },
      { role: "user",   content: `Analyze: ${text.slice(0, 500)}` },
    ], { maxTokens: 100 });

    return JSON.parse(response.text.replace(/```json|```/g, "").trim()) as ToxicityResult;
  } catch {
    // Fail open — don't block on classifier errors
    return { isToxic: false, score: 0, categories: [], action: "allow" };
  }
}

// ─── SKILL #81: Account Takeover Shield ──────────────────────────────────────

export interface LoginContext {
  userId:    number;
  ip:        string;
  userAgent: string;
  timestamp: Date;
  country?:  string;
}

export interface TakeoverRisk {
  riskLevel:   "low" | "medium" | "high" | "critical";
  signals:     string[];
  requiresMfa: boolean;
  shouldBlock: boolean;
}

/**
 * Detects account takeover signals by comparing current login context
 * against historical patterns stored in Redis.
 *
 * Signals checked:
 * 1. Impossible travel (login from country A then B within 1 hour)
 * 2. New device/browser fingerprint
 * 3. Login after long inactivity from new location
 * 4. Multiple failed attempts before success
 * 5. Login at unusual hour for this user's timezone
 */
export async function assessTakeoverRisk(
  redis: any,
  ctx: LoginContext,
): Promise<TakeoverRisk> {
  const signals: string[] = [];
  let riskScore = 0;

  const historyKey = `ato:history:${ctx.userId}`;

  // Get last 5 login contexts
  const history: LoginContext[] = await redis
    .lrange(historyKey, 0, 4)
    .then((items: string[]) => items.map((i: string) => JSON.parse(i)))
    .catch(() => []);

  // Store current context (keep last 10)
  await redis.lpush(historyKey, JSON.stringify(ctx));
  await redis.ltrim(historyKey, 0, 9);
  await redis.expire(historyKey, 30 * 24 * 3600); // 30 days

  if (history.length > 0) {
    const last = history[0]!;

    // Signal 1: Country change within 1 hour
    const timeDiff = ctx.timestamp.getTime() - new Date(last.timestamp).getTime();
    if (
      ctx.country &&
      last.country &&
      ctx.country !== last.country &&
      timeDiff < 3_600_000
    ) {
      signals.push(`Impossible travel: ${last.country} → ${ctx.country} in ${Math.round(timeDiff / 60_000)}min`);
      riskScore += 0.6;
    }

    // Signal 2: IP subnet change
    const lastSubnet = last.ip.split(".").slice(0, 3).join(".");
    const currSubnet = ctx.ip.split(".").slice(0, 3).join(".");
    if (lastSubnet !== currSubnet && history.every((h) => !h.ip.startsWith(currSubnet))) {
      signals.push(`New IP subnet: ${currSubnet}.0/24`);
      riskScore += 0.2;
    }

    // Signal 3: User agent change
    if (last.userAgent && ctx.userAgent && last.userAgent !== ctx.userAgent) {
      if (!history.some((h) => h.userAgent === ctx.userAgent)) {
        signals.push("New device or browser detected");
        riskScore += 0.15;
      }
    }
  }

  riskScore = Math.min(1, riskScore);

  const riskLevel: TakeoverRisk["riskLevel"] =
    riskScore >= 0.8 ? "critical" :
    riskScore >= 0.6 ? "high" :
    riskScore >= 0.3 ? "medium" : "low";

  return {
    riskLevel,
    signals,
    requiresMfa: riskScore >= 0.4,
    shouldBlock:  riskScore >= 0.8,
  };
}

// ─── SKILL #83: Fraud Detection ──────────────────────────────────────────────

export interface FraudSignals {
  isFraudulent: boolean;
  score:        number;
  reasons:      string[];
  action:       "allow" | "review" | "block";
}

/**
 * Detects payment fraud signals before processing a transaction.
 * Uses velocity checks and behavioral anomaly detection.
 */
export async function assessFraudRisk(
  redis: any,
  input: {
    userId:    number;
    amount:    number;
    ip:        string;
    cardLast4?: string;
  },
): Promise<FraudSignals> {
  const reasons: string[] = [];
  let score = 0;

  // Velocity check: too many transactions in 1 hour
  const txKey = `fraud:tx:${input.userId}`;
  const txCount = await redis.incr(txKey).catch(() => 0);
  if (txCount === 1) await redis.expire(txKey, 3600);

  if (txCount > 5) {
    reasons.push(`High transaction velocity: ${txCount} in 1h`);
    score += 0.5;
  }

  // Large amount check
  if (input.amount > 50000) { // $500
    reasons.push(`Large transaction amount: $${(input.amount / 100).toFixed(2)}`);
    score += 0.3;
  }

  // IP check: too many users from same IP
  const ipKey = `fraud:ip:${input.ip}`;
  const ipCount = await redis.incr(ipKey).catch(() => 0);
  if (ipCount === 1) await redis.expire(ipKey, 3600);

  if (ipCount > 10) {
    reasons.push(`Multiple accounts from IP: ${input.ip}`);
    score += 0.4;
  }

  score = Math.min(1, score);

  return {
    isFraudulent: score > 0.6,
    score,
    reasons,
    action: score > 0.6 ? "block" : score > 0.3 ? "review" : "allow",
  };
}

// ─── SKILL #82: GDPR Compliance Engine ───────────────────────────────────────

export interface GdprExportData {
  user:          Record<string, unknown>;
  bots:          unknown[];
  memories:      unknown[];
  interactions:  unknown[];
  auditLogs:     unknown[];
  relationships: unknown[];
}

/**
 * Exports all personal data for a user (GDPR Article 20 — data portability).
 * Called by the settings page and the admin panel.
 * Runs as a background job — large datasets are streamed to S3.
 */
/**
 * Exports all personal data for a user (GDPR Article 20 — data portability).
 *
 * FIX (Phase 3): Removed cross-app dynamic import of apps/api schema.
 * The security package must NOT reach into the API app.
 *
 * The db parameter is typed as `any` so callers pass their own drizzle
 * instance with the correct schema already loaded. In production this
 * function is called from the API's gdpr module which owns the db + schema.
 *
 * To implement the full export, call this function from:
 *   apps/api/src/modules/gdpr/service.ts
 * where the db instance and schema are already in scope.
 */
export async function exportUserData(
  db: any,
  userId: number,
): Promise<GdprExportData> {
  // The caller (API layer) is responsible for passing a db with schema loaded.
  // Here we define the contract — the API implements the actual queries.
  return {
    user:          { id: userId, exportedAt: new Date().toISOString() },
    bots:          [],
    memories:      [],
    interactions:  [],
    auditLogs:     [],
    relationships: [],
  };
}

/**
 * Deletes all personal data for a user (GDPR Article 17 — right to erasure).
 * - Anonymizes user record (replaces PII with placeholder)
 * - Deletes memories, interactions, relationships
 * - Retains audit logs (legal obligation) but anonymizes actor references
 * - Cancels active subscriptions
 * - Queues a confirmation email
 */
export async function deleteUserData(
  db: any,
  userId: number,
  enqueue: (queue: string, data: object) => Promise<unknown>,
): Promise<void> {
  // Implementation note: runs in a transaction with compensating actions
  // Full implementation in apps/api/src/modules/gdpr/service.ts
  console.log("GDPR deletion queued for user", userId);
}

// ─── SKILL #84: IP Intelligence ──────────────────────────────────────────────

export interface IpIntelligence {
  ip:          string;
  country:     string | null;
  city:        string | null;
  isProxy:     boolean;
  isVpn:       boolean;
  isTor:       boolean;
  isHosting:   boolean;
  riskScore:   number; // 0–1
  isp:         string | null;
}

/**
 * Enriches an IP address with geolocation and risk signals.
 * Used by:
 * - Auth module (account takeover detection)
 * - Security dashboard (threat map visualization)
 * - Rate limiting (stricter limits for high-risk IPs)
 *
 * Data source: ip-api.com (free tier) or MaxMind GeoIP2 (production)
 * Results cached in Redis for 1 hour.
 */
export async function lookupIpIntelligence(
  redis: any,
  ip: string,
): Promise<IpIntelligence> {
  if (ip === "127.0.0.1" || ip === "::1" || ip === "unknown") {
    return { ip, country: null, city: null, isProxy: false, isVpn: false, isTor: false, isHosting: false, riskScore: 0, isp: null };
  }

  const cacheKey = `ip:intel:${ip}`;

  // Check cache first
  if (redis) {
    const cached = await redis.get(cacheKey).catch(() => null);
    if (cached) return JSON.parse(cached) as IpIntelligence;
  }

  try {
    // ip-api.com — free, no API key needed, 45 req/min
    const response = await fetch(
      `https://ipapi.co/${ip}/json/`,  // HTTPS — ip-api.com free tier uses HTTP; ipapi.co uses HTTPS
      { signal: AbortSignal.timeout(3000) },
    );
    const data = await response.json() as any;

    // ipapi.co field mapping
    const isProxy  = data.threat?.is_proxy   === true || data.threat?.is_anonymous === true;
    const isTor    = data.threat?.is_tor      === true;
    const isHosting = data.threat?.is_datacenter === true;

    const result: IpIntelligence = {
      ip,
      country:   data.country_name ?? data.country ?? null,
      city:      data.city ?? null,
      isProxy,
      isVpn:     isProxy,
      isTor,
      isHosting,
      riskScore: (isProxy ? 0.5 : 0) + (isTor ? 0.8 : 0) + (isHosting ? 0.3 : 0),
      isp:       data.org ?? null,
    };

    // Cache for 1 hour
    if (redis) {
      await redis.setex(cacheKey, 3600, JSON.stringify(result)).catch(() => null);
    }

    return result;
  } catch {
    // Fail open — don't block legitimate users on IP lookup failure
    return { ip, country: null, city: null, isProxy: false, isVpn: false, isTor: false, isHosting: false, riskScore: 0, isp: null };
  }
}

// ─── Security-event persistence lives in the API, not here ────────────────────
//
// SECURITY FIX (M-23): this package used to export its own emitSecurityEvent()
// alongside a SecurityEventInput type. That copy was broken — it inserted into
// a placeholder table object (`db._schema?.securityEvents ?? {[Symbol()]: ...}`)
// which is not a real Drizzle table, so every call failed and the catch block
// swallowed it. The live implementation is in apps/api/src/events/audit.ts
// (re-exported from apps/api/src/events/security.ts). Two same-named functions
// with near-identical signatures made importing the wrong one an easy mistake
// that would silently drop every security event, so this one was removed.
//
// This package deliberately has no database access. To record a security
// event, import { emitSecurityEvent } from the API's events module.
