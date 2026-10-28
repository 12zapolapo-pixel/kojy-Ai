/**
 * @kojyai/shared — Platform Constants
 *
 * OWNERSHIP: Imported by api, worker, and web.
 * These are compile-time constants — not runtime config.
 * Runtime config lives in .env and is accessed via packages/shared/validators.
 */

import type { UserTier, PlanLimits } from "../types/entities.js";

// ─── Plan Limits ──────────────────────────────────────────────────────────────

export const PLAN_LIMITS: Record<UserTier, PlanLimits> = {
  free: {
    maxBots: 1,
    maxRooms: 1,
    maxMessagesPerDay: 100,
    maxSimulations: 0,
    analyticsRetentionDays: 7,
    aiModel: "groq/openai/gpt-oss-20b",
    webSearchEnabled: false,
    simulationEnabled: false,
    whitelabelEnabled: false,
    marketplaceEnabled: false,
  },
  starter: {
    maxBots: 3,
    maxRooms: 3,
    maxMessagesPerDay: 1_000,
    maxSimulations: 5,
    analyticsRetentionDays: 30,
    aiModel: "groq/openai/gpt-oss-20b",
    webSearchEnabled: false,
    simulationEnabled: true,
    whitelabelEnabled: false,
    marketplaceEnabled: true,
  },
  pro: {
    maxBots: 10,
    maxRooms: 10,
    maxMessagesPerDay: 10_000,
    maxSimulations: 50,
    analyticsRetentionDays: 90,
    aiModel: "mistral/mistral-large-latest",
    webSearchEnabled: true,
    simulationEnabled: true,
    whitelabelEnabled: false,
    marketplaceEnabled: true,
  },
  elite: {
    maxBots: 50,
    maxRooms: 50,
    maxMessagesPerDay: 100_000,
    maxSimulations: 500,
    analyticsRetentionDays: 365,
    aiModel: "openai/gpt-4o",
    webSearchEnabled: true,
    simulationEnabled: true,
    whitelabelEnabled: true,
    marketplaceEnabled: true,
  },
  enterprise: {
    maxBots: 999,
    maxRooms: 999,
    maxMessagesPerDay: 1_000_000,
    maxSimulations: 9999,
    analyticsRetentionDays: 730,
    aiModel: "openai/gpt-4o",
    webSearchEnabled: true,
    simulationEnabled: true,
    whitelabelEnabled: true,
    marketplaceEnabled: true,
  },
  dev: {
    maxBots: 999,
    maxRooms: 999,
    maxMessagesPerDay: 999_999,
    maxSimulations: 9999,
    analyticsRetentionDays: 365,
    aiModel: "openai/gpt-4o",
    webSearchEnabled: true,
    simulationEnabled: true,
    whitelabelEnabled: true,
    marketplaceEnabled: true,
  },
};

// ─── Queue Names ──────────────────────────────────────────────────────────────

export const QUEUE_NAMES = {
  BOT_LIFECYCLE: "bot_lifecycle",
  MEMORY_COMPRESSION: "intelligence_memory_compression",
  ANALYTICS_AGGREGATION: "analytics_aggregation",
  NOTIFICATION_DELIVERY: "notifications_delivery",
  CHURN_PREDICTION: "intelligence_churn_prediction",
  MODERATION_SCAN: "security_moderation_scan",
  SIMULATION_RUN: "simulation_run",
  BACKUP_AUTOMATION: "infra_backup",
  EMAIL_SEND: "notifications_email",
  RELATIONSHIP_UPDATE: "intelligence_relationship_update",
  AUDIT_FLUSH:          "audit_flush",
  STRIPE_WEBHOOK:       "billing_stripe_webhook",
  // Emote catalog: refreshed daily from webapi.highrise.game → SQLite cache.
  // Separate queue so a slow API response doesn't starve other jobs.
  EMOTE_CATALOG_REFRESH: "emote_catalog_refresh",
  // Delegation agent pipeline: planning → coding → testing → deploying.
  // Separate queue with low concurrency (1) — agent runs are sequential per
  // user so they can't collide on the same delegation_session row.
  DELEGATION_RUN: "delegation_run",
  // Highrise Bot Composer — runs the full orchestrator pipeline per prompt.
  // Each job = one user→AI interaction producing spec + code + tests + deploy.
  COMPOSER_RUN: "composer_run",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// ─── Redis Key Prefixes ───────────────────────────────────────────────────────

export const REDIS_KEYS = {
  SESSION: (sessionId: string) => `session:${sessionId}`,
  RATE_LIMIT: (key: string) => `rl:${key}`,
  BOT_PRESENCE: (botId: string) => `bot:presence:${botId}`,
  WS_CHANNEL: (channel: string) => `ws:${channel}`,
  FEATURE_FLAG: (key: string) => `ff:${key}`,
  AI_CACHE: (hash: string) => `ai:cache:${hash}`,
  SIM_STATE: (simId: string) => `sim:state:${simId}`,
  // List of pending chaos/inject events for a running simulation, pushed by
  // the API (simulations.injectEvent) and drained each tick by the worker's
  // SimulationRunner.
  SIM_INJECT_QUEUE: (simId: string) => `sim:${simId}:inject_queue`,
} as const;

// ─── Feature Flag Keys ────────────────────────────────────────────────────────

export const FEATURE_FLAGS = {
  SIMULATION_ENABLED: "simulation_enabled",
  MARKETPLACE_ENABLED: "marketplace_enabled",
  WHITE_LABEL_ENABLED: "white_label_enabled",
  HIVE_MIND_ENABLED: "hive_mind_enabled",
  DREAM_ENGINE_ENABLED: "dream_engine_enabled",
  ECONOMY_ENGINE_ENABLED: "economy_engine_enabled",
  COACHING_MODE_ENABLED: "coaching_mode_enabled",
  MULTILINGUAL_UI: "multilingual_ui",
  CHAOS_TESTING: "chaos_testing",
} as const;

// ─── Websocket Channels ───────────────────────────────────────────────────────

export const WS_CHANNELS = {
  BOT: (botId: string) => `bot:${botId}`,
  ORG: (orgId: string) => `org:${orgId}`,
  SIMULATION: (simId: string) => `sim:${simId}`,
  SYSTEM: "system",
  // Delegation agent status updates: emitted during agent planning/coding/etc.
  // Subscribed to by the frontend's DelegationStudio to drive the 3D scene
  // and chat status indicators in real time.
  DELEGATION: (userId: string) => `delegation:${userId}`,
} as const;

// Internal control channel: worker -> API runtime manager. NOT forwarded to
// WS clients (deliberately namespaced outside "bot:*" so it never collides
// with the WS gateway's fan-out pattern subscription).
export const BOT_CONTROL_CHANNEL = (botId: string) => `bot_control:${botId}`;

// ─── Validation ───────────────────────────────────────────────────────────────

export const LIMITS = {
  BOT_NAME_MAX: 150,
  ORG_NAME_MAX: 100,
  PERSONALITY_RULE_MAX: 50,
  MEMORY_SUMMARY_MAX: 2000,
  MESSAGE_MAX_BYTES: 8192,
  WS_MAX_CLIENTS_TOTAL: 500,
  WS_MAX_PER_USER: 5,
  WS_MAX_MESSAGE_BYTES: 65536,  // 64 KiB per WS frame
  AUTH_TIMEOUT_MS: 5_000,
  REAUTH_INTERVAL_MS: 5 * 60 * 1_000,
  PING_INTERVAL_MS: 30_000,
  LOG_BUFFER_SIZE: 500,
  SIMULATION_MAX_DURATION_SECONDS: 3600,
  SIMULATION_MAX_SPEED: 10,
} as const;

// ─── HTTP Status Codes (semantic aliases) ─────────────────────────────────────

export const HTTP = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;
