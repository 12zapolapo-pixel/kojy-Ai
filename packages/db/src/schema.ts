/**
 * KOJYAI Platform — Drizzle ORM PostgreSQL Schema
 *
 * OWNERSHIP: packages/db — the single source of truth for every table. The
 *            API and the worker both import this file (they used to keep two
 *            drifting MySQL copies), and migrations are generated from it.
 *
 * DESIGN PRINCIPLES:
 * - UUIDs at the API layer, serial ints as DB primary keys
 * - All timestamps are timestamptz (stored UTC)
 * - jsonb only where flexibility is REQUIRED (personalities, settings)
 * - Soft-delete pattern: isActive / deletedAt instead of hard DELETE
 * - Every FK-join column has a covering index
 * - Org-level isolation on every multi-tenant table (orgId column + index)
 *
 * Postgres has no `ON UPDATE CURRENT_TIMESTAMP`, so every updatedAt column
 * uses Drizzle's $onUpdate hook instead — it fires on every ORM update().
 */

import {
  pgTable, pgEnum, varchar, integer, serial, bigserial, bigint, boolean,
  timestamp, text, doublePrecision, smallint, jsonb, index, uniqueIndex, unique, vector,
} from "drizzle-orm/pg-core";

// ─── Column helpers ───────────────────────────────────────────────────────────

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").defaultNow().notNull();
const updatedAt = () => ts("updated_at").defaultNow().$onUpdate(() => new Date()).notNull();

// ─── Enums ────────────────────────────────────────────────────────────────────

export const tierEnum = pgEnum("tier", [
  "free", "starter", "pro", "elite", "enterprise", "dev",
]);
export const userRoleEnum = pgEnum("user_role", ["user", "admin", "superadmin"]);
export const userStatusEnum = pgEnum("user_status", [
  "active", "suspended", "pending_verification", "deleted",
]);
export const botStatusEnum = pgEnum("bot_status", [
  "offline", "connecting", "online", "error", "suspended",
]);
export const botRuntimeModeEnum = pgEnum("bot_runtime_mode", [
  "ai", "scripted", "hybrid",
]);
export const memoryTypeEnum = pgEnum("memory_type", [
  "episodic", "semantic", "procedural", "emotional",
]);
export const compressionStateEnum = pgEnum("compression_state", [
  "raw", "compressed", "archived",
]);
export const simStatusEnum = pgEnum("sim_status", [
  "draft", "running", "paused", "completed", "failed",
]);
export const simScenarioEnum = pgEnum("sim_scenario", [
  "social", "economy", "moderation", "churn", "chaos", "custom",
]);
export const subStatusEnum = pgEnum("sub_status", [
  "active", "trialing", "past_due", "canceled", "paused",
]);
export const mktItemTypeEnum = pgEnum("mkt_item_type", [
  "bot_config", "personality", "plugin", "template", "rental",
]);
export const mktItemStatusEnum = pgEnum("mkt_item_status", [
  "draft", "published", "suspended",
]);
export const secSeverityEnum = pgEnum("sec_severity", [
  "low", "medium", "high", "critical",
]);
export const secCategoryEnum = pgEnum("sec_category", [
  "auth", "rate_limit", "toxicity", "fraud", "impersonation", "account_takeover",
]);
export const metricPeriodEnum = pgEnum("metric_period", [
  "hour", "day", "week", "month",
]);
export const notifTypeEnum = pgEnum("notif_type", [
  "bot_offline", "bot_error", "billing_due", "simulation_complete",
  "new_member", "security_alert", "system",
]);
export const relTypeEnum = pgEnum("rel_type", [
  "ally", "rival", "neutral", "mentor", "student", "friend", "enemy",
]);
export const roomStatusEnum = pgEnum("room_status", [
  "active", "inactive", "archived",
]);
export const orgStatusEnum = pgEnum("org_status", [
  "active", "suspended", "trialing", "past_due",
]);
export const taskStatusEnum = pgEnum("task_status", [
  "idle", "planning", "coding", "testing", "deploying", "done", "failed",
]);
export const scriptTestStatusEnum = pgEnum("script_test_status", [
  "pending", "passed", "failed", "timeout",
]);
export const composerLanguageEnum = pgEnum("composer_language", ["python", "javascript"]);
export const composerStageEnum = pgEnum("composer_stage", [
  "idle", "spec", "codegen", "sandbox", "testing",
  "fixing", "deploying", "monitoring", "done", "failed",
]);
export const marketplacePurchaseStatusEnum = pgEnum("mkt_purchase_status", [
  "pending", "completed", "refunded", "failed",
]);

// ─── Users ────────────────────────────────────────────────────────────────────
// Purpose: Auth principal + tier/billing anchor
// Ownership: modules/auth, modules/billing
// Scaling: low-write, high-read — cache user by session

export const users = pgTable("users", {
  id:               serial("id").primaryKey(),
  uuid:             varchar("uuid", { length: 36 }).notNull(),
  email:            varchar("email", { length: 255 }).notNull(),
  username:         varchar("username", { length: 100 }).notNull(),
  displayName:      varchar("display_name", { length: 150 }),
  passwordHash:     varchar("password_hash", { length: 255 }).notNull(),
  role:             userRoleEnum("role").default("user").notNull(),
  status:           userStatusEnum("status").default("pending_verification").notNull(),
  tier:             tierEnum("tier").default("free").notNull(),
  isDev:            boolean("is_dev").default(false).notNull(),
  walletBalance:    doublePrecision("wallet_balance").default(0).notNull(),
  stripeCustomerId: varchar("stripe_customer_id", { length: 200 }),
  avatarUrl:        varchar("avatar_url", { length: 500 }),
  locale:           varchar("locale", { length: 10 }).default("en").notNull(),
  timezone:         varchar("timezone", { length: 50 }).default("UTC").notNull(),
  // White-label branding (enterprise only)
  brandName:        varchar("brand_name", { length: 100 }),
  brandColor:       varchar("brand_color", { length: 20 }),
  brandLogoUrl:     varchar("brand_logo_url", { length: 500 }),
  // Security
  failedLoginCount: smallint("failed_login_count").default(0).notNull(),
  lockedUntil:      ts("locked_until"),
  lastLoginAt:      ts("last_login_at"),
  lastLoginIp:      varchar("last_login_ip", { length: 45 }),
  deletedAt:        ts("deleted_at"),
  createdAt:        createdAt(),
  updatedAt:        updatedAt(),
}, (t) => ({
  emailIdx:    uniqueIndex("users_email_idx").on(t.email),
  usernameIdx: uniqueIndex("users_username_idx").on(t.username),
  uuidIdx:     uniqueIndex("users_uuid_idx").on(t.uuid),
  tierIdx:     index("users_tier_idx").on(t.tier),
  statusIdx:   index("users_status_idx").on(t.status),
}));

// ─── OTP Codes ────────────────────────────────────────────────────────────────

export const otpCodes = pgTable("otp_codes", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").notNull(),
  code:      varchar("code", { length: 6 }).notNull(),
  purpose:   varchar("purpose", { length: 50 }).notNull(),
  expiresAt: ts("expires_at").notNull(),
  used:      boolean("used").default(false).notNull(),
  createdAt: createdAt(),
}, (t) => ({
  userIdx: index("otp_user_idx").on(t.userId),
}));

// ─── Sessions ─────────────────────────────────────────────────────────────────

export const sessions = pgTable("sessions", {
  id:          varchar("id", { length: 128 }).primaryKey(),
  userId:      integer("user_id").notNull(),
  expiresAt:   ts("expires_at").notNull(),
  ip:          varchar("ip", { length: 45 }),
  userAgent:   varchar("user_agent", { length: 512 }),
  // activeOrgId tracks which org is active for multi-org users.
  // auth.switchOrg writes this; bots router resolveOrgId() reads it.
  // Nullable — null means "use the user's primary/first org".
  activeOrgId: integer("active_org_id"),
  createdAt:   createdAt(),
}, (t) => ({
  userIdx:      index("session_user_idx").on(t.userId),
  expiryIdx:    index("session_expiry_idx").on(t.expiresAt),
  activeOrgIdx: index("session_active_org_idx").on(t.activeOrgId),
}));

// ─── Organizations ────────────────────────────────────────────────────────────
// Purpose: Multi-tenant isolation boundary. All bots, rooms, and data belong to an org.
// Ownership: modules/auth (creation), modules/billing (plan)

export const organizations = pgTable("organizations", {
  id:           serial("id").primaryKey(),
  uuid:         varchar("uuid", { length: 36 }).notNull(),
  ownerId:      integer("owner_id").notNull(),
  name:         varchar("name", { length: 100 }).notNull(),
  slug:         varchar("slug", { length: 100 }).notNull(),
  plan:         tierEnum("plan").default("free").notNull(),
  status:       orgStatusEnum("status").default("active").notNull(),
  botQuota:     integer("bot_quota").default(1).notNull(),
  settings:     jsonb("settings").$type<Record<string, unknown>>().default({}).notNull(),
  brandName:    varchar("brand_name", { length: 100 }),
  brandColor:   varchar("brand_color", { length: 20 }),
  brandLogoUrl: varchar("brand_logo_url", { length: 500 }),
  deletedAt:    ts("deleted_at"),
  createdAt:    createdAt(),
  updatedAt:    updatedAt(),
}, (t) => ({
  uuidIdx:    uniqueIndex("org_uuid_idx").on(t.uuid),
  slugIdx:    uniqueIndex("org_slug_idx").on(t.slug),
  ownerIdx:   index("org_owner_idx").on(t.ownerId),
  planIdx:    index("org_plan_idx").on(t.plan),
}));

// ─── Org Members ─────────────────────────────────────────────────────────────

export const orgMembers = pgTable("org_members", {
  id:        serial("id").primaryKey(),
  orgId:     integer("org_id").notNull(),
  userId:    integer("user_id").notNull(),
  role:      userRoleEnum("role").default("user").notNull(),
  invitedBy: integer("invited_by"),
  joinedAt:  ts("joined_at").defaultNow().notNull(),
}, (t) => ({
  orgUserIdx: uniqueIndex("org_member_unique").on(t.orgId, t.userId),
  orgIdx:     index("org_member_org_idx").on(t.orgId),
  userIdx:    index("org_member_user_idx").on(t.userId),
}));

// ─── Bots ─────────────────────────────────────────────────────────────────────
// Purpose: Core deployable agent entity. Each bot has its own runtime process.
// Ownership: modules/bots (CRUD), bot-runtime (lifecycle)

export const bots = pgTable("bots", {
  id:                    serial("id").primaryKey(),
  uuid:                  varchar("uuid", { length: 36 }).notNull(),
  orgId:                 integer("org_id").notNull(),
  ownerId:               integer("owner_id").notNull(),
  name:                  varchar("name", { length: 150 }).notNull(),
  avatarUrl:             varchar("avatar_url", { length: 500 }),
  highriseApiKey:        varchar("highrise_api_key", { length: 600 }).notNull(),
  activeRoomId:          varchar("active_room_id", { length: 200 }),
  status:                botStatusEnum("status").default("offline").notNull(),
  runtimeMode:           botRuntimeModeEnum("runtime_mode").default("ai").notNull(),
  healthScore:           smallint("health_score").default(0).notNull(),
  greetMessage:          text("greet_message").default("Welcome! 👋"),
  personality:           text("personality").default(""),
  personalityProfileId:  integer("personality_profile_id"),
  connectionError:       text("connection_error"),
  language:              varchar("language", { length: 10 }).default("en").notNull(),
  isActive:              boolean("is_active").default(true).notNull(),
  version:               integer("version").default(1).notNull(),
  tags:                  jsonb("tags").$type<string[]>().default([]).notNull(),
  extraRooms:            jsonb("extra_rooms").$type<string[]>().default([]).notNull(),
  lastSeen:              ts("last_seen"),
  lastHeartbeat:         ts("last_heartbeat"),
  ownerHighriseUsername: varchar("owner_highrise_username", { length: 128 }).default(""),
  deletedAt:             ts("deleted_at"),
  createdAt:             createdAt(),
  updatedAt:             updatedAt(),
}, (t) => ({
  uuidIdx:      uniqueIndex("bot_uuid_idx").on(t.uuid),
  orgIdx:       index("bot_org_idx").on(t.orgId),
  ownerIdx:     index("bot_owner_idx").on(t.ownerId),
  statusIdx:    index("bot_status_idx").on(t.status),
  heartbeatIdx: index("bot_heartbeat_idx").on(t.lastHeartbeat),
  activeIdx:    index("bot_active_idx").on(t.isActive, t.status),
}));

// ─── Bot Stats ────────────────────────────────────────────────────────────────

export const botStats = pgTable("bot_stats", {
  id:             serial("id").primaryKey(),
  botId:          integer("bot_id").notNull(),
  totalMessages:  bigint("total_messages", { mode: "number" }).default(0).notNull(),
  totalGreetings: bigint("total_greetings", { mode: "number" }).default(0).notNull(),
  totalCommands:  bigint("total_commands", { mode: "number" }).default(0).notNull(),
  uptimeSeconds:  bigint("uptime_seconds", { mode: "number" }).default(0).notNull(),
  uniqueUsers:    integer("unique_users").default(0).notNull(),
  returningUsers: integer("returning_users").default(0).notNull(),
  updatedAt:      updatedAt(),
}, (t) => ({
  botIdx: uniqueIndex("bot_stats_bot_idx").on(t.botId),
}));

// ─── Personality Profiles ─────────────────────────────────────────────────────
// Purpose: Versioned personality DNA for each bot. Version column supports rollback.

export const botPersonalityProfiles = pgTable("bot_personality_profiles", {
  id:           serial("id").primaryKey(),
  botId:        integer("bot_id").notNull(),
  version:      integer("version").default(1).notNull(),
  isActive:     boolean("is_active").default(true).notNull(),
  // OCEAN trait scores 0.0–1.0
  openness:          doublePrecision("openness").default(0.5).notNull(),
  conscientiousness: doublePrecision("conscientiousness").default(0.5).notNull(),
  extraversion:      doublePrecision("extraversion").default(0.5).notNull(),
  agreeableness:     doublePrecision("agreeableness").default(0.5).notNull(),
  neuroticism:       doublePrecision("neuroticism").default(0.5).notNull(),
  // Additional dimensions
  humor:             doublePrecision("humor").default(0.5).notNull(),
  empathy:           doublePrecision("empathy").default(0.5).notNull(),
  assertiveness:     doublePrecision("assertiveness").default(0.5).notNull(),
  creativity:        doublePrecision("creativity").default(0.5).notNull(),
  // Voice
  tone:            varchar("tone", { length: 20 }).default("casual").notNull(),
  verbosity:       varchar("verbosity", { length: 20 }).default("normal").notNull(),
  useEmoji:        boolean("use_emoji").default(true).notNull(),
  signaturePhrase: varchar("signature_phrase", { length: 200 }),
  // Rules and evolved state
  behaviorRules: jsonb("behavior_rules").default([]),
  evolvedState:  jsonb("evolved_state").default({}),
  createdAt:     createdAt(),
}, (t) => ({
  botVersionIdx: uniqueIndex("personality_bot_version_idx").on(t.botId, t.version),
  botActiveIdx:  index("personality_bot_active_idx").on(t.botId, t.isActive),
}));

// ─── Bot Memories ─────────────────────────────────────────────────────────────
// Purpose: Episodic/semantic memory storage. Compressed over time by worker job.

export const botMemories = pgTable("bot_memories", {
  id:               serial("id").primaryKey(),
  uuid:             varchar("uuid", { length: 36 }).notNull(),
  botId:            integer("bot_id").notNull(),
  orgId:            integer("org_id").notNull(),
  type:             memoryTypeEnum("type").default("episodic").notNull(),
  summary:          text("summary").notNull(),
  rawPayload:       jsonb("raw_payload"),
  importance:       doublePrecision("importance").default(0.5).notNull(),
  compressionState: compressionStateEnum("compression_state").default("raw").notNull(),
  relatedEntities:  jsonb("related_entities").default([]),
  expiresAt:        ts("expires_at"),
  createdAt:        createdAt(),
}, (t) => ({
  uuidIdx:       uniqueIndex("memory_uuid_idx").on(t.uuid),
  botIdx:        index("memory_bot_idx").on(t.botId),
  orgIdx:        index("memory_org_idx").on(t.orgId),
  typeIdx:       index("memory_type_idx").on(t.type),
  importanceIdx: index("memory_importance_idx").on(t.importance),
  compressIdx:   index("memory_compress_idx").on(t.compressionState, t.createdAt),
}));

// ─── Bot Relationships ────────────────────────────────────────────────────────
// Purpose: Social graph between bots and between bots and users.

export const botRelationships = pgTable("bot_relationships", {
  id:               serial("id").primaryKey(),
  botId:            integer("bot_id").notNull(),
  targetType:       varchar("target_type", { length: 10 }).notNull(), // "user" | "bot"
  targetId:         integer("target_id").notNull(),
  type:             relTypeEnum("type").default("neutral").notNull(),
  trust:            doublePrecision("trust").default(0).notNull(),    // -1 to 1
  loyalty:          doublePrecision("loyalty").default(0).notNull(),  // 0 to 1
  affinity:         doublePrecision("affinity").default(0).notNull(), // -1 to 1
  interactionCount: integer("interaction_count").default(0).notNull(),
  lastUpdated:      ts("last_updated").defaultNow().$onUpdate(() => new Date()).notNull(),
}, (t) => ({
  botTargetIdx: uniqueIndex("rel_bot_target_idx").on(t.botId, t.targetType, t.targetId),
  botIdx:       index("rel_bot_idx").on(t.botId),
  targetIdx:    index("rel_target_idx").on(t.targetType, t.targetId),
  typeIdx:      index("rel_type_idx").on(t.type),
}));

// ─── Rooms ────────────────────────────────────────────────────────────────────

export const rooms = pgTable("rooms", {
  id:               serial("id").primaryKey(),
  uuid:             varchar("uuid", { length: 36 }).notNull(),
  orgId:            integer("org_id").notNull(),
  name:             varchar("name", { length: 200 }).notNull(),
  highriseRoomId:   varchar("highrise_room_id", { length: 200 }).notNull(),
  status:           roomStatusEnum("status").default("active").notNull(),
  activeBotIds:     jsonb("active_bot_ids").default([]),
  settings:         jsonb("settings").default({}),
  analyticsSummary: jsonb("analytics_summary").default({}),
  deletedAt:        ts("deleted_at"),
  createdAt:        createdAt(),
  updatedAt:        updatedAt(),
}, (t) => ({
  uuidIdx:   uniqueIndex("room_uuid_idx").on(t.uuid),
  orgIdx:    index("room_org_idx").on(t.orgId),
  statusIdx: index("room_status_idx").on(t.status),
}));

// ─── Interactions ─────────────────────────────────────────────────────────────
// Purpose: Every message/event in a room session. High-volume append-only log.

export const interactions = pgTable("interactions", {
  id:        bigserial("id", { mode: "number" }).primaryKey(),
  orgId:     integer("org_id").notNull(),
  roomId:    integer("room_id").notNull(),
  botId:     integer("bot_id"),
  userId:    integer("user_id"),
  role:      varchar("role", { length: 20 }).notNull(), // "bot" | "user" | "system"
  content:   text("content").notNull(),
  sentiment: doublePrecision("sentiment"), // -1 to 1
  language:  varchar("language", { length: 10 }).default("en"),
  metadata:  jsonb("metadata").default({}),
  createdAt: createdAt(),
}, (t) => ({
  orgIdx:     index("interaction_org_idx").on(t.orgId),
  roomIdx:    index("interaction_room_idx").on(t.roomId),
  botIdx:     index("interaction_bot_idx").on(t.botId),
  timeIdx:    index("interaction_time_idx").on(t.createdAt),
  orgTimeIdx: index("interaction_org_time_idx").on(t.orgId, t.createdAt),
}));

// ─── Simulations ─────────────────────────────────────────────────────────────

export const simulations = pgTable("simulations", {
  id:          serial("id").primaryKey(),
  uuid:        varchar("uuid", { length: 36 }).notNull(),
  orgId:       integer("org_id").notNull(),
  name:        varchar("name", { length: 200 }).notNull(),
  scenario:    simScenarioEnum("scenario").default("social").notNull(),
  status:      simStatusEnum("status").default("draft").notNull(),
  config:      jsonb("config").default({}),
  result:      jsonb("result"),
  createdBy:   integer("created_by").notNull(),
  startedAt:   ts("started_at"),
  completedAt: ts("completed_at"),
  createdAt:   createdAt(),
}, (t) => ({
  uuidIdx:      uniqueIndex("sim_uuid_idx").on(t.uuid),
  orgIdx:       index("sim_org_idx").on(t.orgId),
  statusIdx:    index("sim_status_idx").on(t.status),
  orgStatusIdx: index("sim_org_status_idx").on(t.orgId, t.status),
}));

// ─── Subscriptions ────────────────────────────────────────────────────────────

export const subscriptions = pgTable("subscriptions", {
  id:                   serial("id").primaryKey(),
  uuid:                 varchar("uuid", { length: 36 }).notNull(),
  orgId:                integer("org_id").notNull(),
  plan:                 tierEnum("plan").default("free").notNull(),
  status:               subStatusEnum("status").default("active").notNull(),
  stripeSubscriptionId: varchar("stripe_subscription_id", { length: 200 }),
  stripeCustomerId:     varchar("stripe_customer_id", { length: 200 }),
  stripePriceId:        varchar("stripe_price_id", { length: 200 }),
  currentPeriodStart:   ts("current_period_start").notNull(),
  currentPeriodEnd:     ts("current_period_end").notNull(),
  cancelAtPeriodEnd:    boolean("cancel_at_period_end").default(false).notNull(),
  limits:               jsonb("limits").notNull(),
  trialEndsAt:          ts("trial_ends_at"),
  createdAt:            createdAt(),
  updatedAt:            updatedAt(),
}, (t) => ({
  uuidIdx:   uniqueIndex("sub_uuid_idx").on(t.uuid),
  orgIdx:    uniqueIndex("sub_org_idx").on(t.orgId),
  statusIdx: index("sub_status_idx").on(t.status),
  stripeIdx: index("sub_stripe_idx").on(t.stripeSubscriptionId),
}));

// ─── Usage Records ────────────────────────────────────────────────────────────

export const usageRecords = pgTable("usage_records", {
  id:           bigserial("id", { mode: "number" }).primaryKey(),
  orgId:        integer("org_id").notNull(),
  botId:        integer("bot_id"),
  resourceType: varchar("resource_type", { length: 50 }).notNull(),
  quantity:     integer("quantity").default(0).notNull(),
  cost:         doublePrecision("cost").default(0).notNull(),
  period:       varchar("period", { length: 20 }).notNull(), // "2025-01"
  createdAt:    createdAt(),
}, (t) => ({
  orgPeriodIdx: index("usage_org_period_idx").on(t.orgId, t.period),
  typeIdx:      index("usage_type_idx").on(t.resourceType),
}));

// ─── Analytics Snapshots ──────────────────────────────────────────────────────
// Purpose: Pre-aggregated metrics — saves re-querying interactions at render time.

export const analyticsSnapshots = pgTable("analytics_snapshots", {
  id:          bigserial("id", { mode: "number" }).primaryKey(),
  orgId:       integer("org_id").notNull(),
  botId:       integer("bot_id"),
  metricType:  varchar("metric_type", { length: 100 }).notNull(),
  metricValue: doublePrecision("metric_value").notNull(),
  dimensions:  jsonb("dimensions").default({}),
  period:      metricPeriodEnum("period").notNull(),
  periodStart: ts("period_start").notNull(),
  createdAt:   createdAt(),
}, (t) => ({
  orgPeriodIdx: index("snap_org_period_idx").on(t.orgId, t.period, t.periodStart),
  metricIdx:    index("snap_metric_idx").on(t.metricType),
  botPeriodIdx: index("snap_bot_period_idx").on(t.botId, t.period),
  // Target of the worker's per-period upserts: one row per org/bot/metric/period.
  // NULLS NOT DISTINCT so org-level rows (botId NULL) still collide.
  uniqueSnap: unique("snap_unique").on(t.orgId, t.botId, t.metricType, t.period, t.periodStart).nullsNotDistinct(),
}));

// ─── Marketplace Items ────────────────────────────────────────────────────────

export const marketplaceItems = pgTable("marketplace_items", {
  id:            serial("id").primaryKey(),
  uuid:          varchar("uuid", { length: 36 }).notNull(),
  sellerId:      integer("seller_id").notNull(),
  type:          mktItemTypeEnum("type").notNull(),
  title:         varchar("title", { length: 200 }).notNull(),
  description:   text("description"),
  price:         integer("price").default(0).notNull(), // cents
  currency:      varchar("currency", { length: 3 }).default("USD").notNull(),
  metadata:      jsonb("metadata").default({}),
  status:        mktItemStatusEnum("status").default("draft").notNull(),
  purchaseCount: integer("purchase_count").default(0).notNull(),
  rating:        doublePrecision("rating"),
  deletedAt:     ts("deleted_at"),
  createdAt:     createdAt(),
  updatedAt:     updatedAt(),
}, (t) => ({
  uuidIdx:   uniqueIndex("mkt_uuid_idx").on(t.uuid),
  sellerIdx: index("mkt_seller_idx").on(t.sellerId),
  typeIdx:   index("mkt_type_idx").on(t.type),
  statusIdx: index("mkt_status_idx").on(t.status),
}));

// ─── Notifications ────────────────────────────────────────────────────────────

export const notifications = pgTable("notifications", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").notNull(),
  type:      notifTypeEnum("type").notNull(),
  title:     varchar("title", { length: 200 }).notNull(),
  body:      text("body").notNull(),
  actionUrl: varchar("action_url", { length: 500 }),
  readAt:    ts("read_at"),
  createdAt: createdAt(),
}, (t) => ({
  userIdx:   index("notif_user_idx").on(t.userId),
  unreadIdx: index("notif_unread_idx").on(t.userId, t.readAt),
}));

// ─── Audit Logs ───────────────────────────────────────────────────────────────
// Retention: 2 years per GDPR. Purge job runs monthly.

export const auditLogs = pgTable("audit_logs", {
  id:           bigserial("id", { mode: "number" }).primaryKey(),
  // Scopes audit.list to the caller's org. Nullable because a handful of
  // write sites (see events/audit.ts) can't always attribute a row to one org.
  orgId:        integer("org_id"),
  actorId:      integer("actor_id").notNull(),
  actorType:    varchar("actor_type", { length: 10 }).notNull(), // "user" | "bot" | "system"
  action:       varchar("action", { length: 100 }).notNull(),
  resourceType: varchar("resource_type", { length: 50 }).notNull(),
  resourceId:   varchar("resource_id", { length: 36 }).notNull(),
  beforeState:  jsonb("before_state"),
  afterState:   jsonb("after_state"),
  ip:           varchar("ip", { length: 45 }),
  userAgent:    varchar("user_agent", { length: 512 }),
  createdAt:    createdAt(),
}, (t) => ({
  actorIdx:    index("audit_actor_idx").on(t.actorId),
  resourceIdx: index("audit_resource_idx").on(t.resourceType, t.resourceId),
  timeIdx:     index("audit_time_idx").on(t.createdAt),
  actionIdx:   index("audit_action_idx").on(t.action),
  orgIdx:      index("audit_org_idx").on(t.orgId, t.createdAt),
}));

// ─── Security Events ─────────────────────────────────────────────────────────

export const securityEvents = pgTable("security_events", {
  id:         serial("id").primaryKey(),
  // Scopes security.getEvents to the caller's org. Nullable: some events
  // (e.g. a login attempt for an unknown email) have no org context.
  orgId:      integer("org_id"),
  severity:   secSeverityEnum("severity").notNull(),
  category:   secCategoryEnum("category").notNull(),
  actorId:    integer("actor_id"),
  ip:         varchar("ip", { length: 45 }).notNull(),
  payload:    jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
  resolved:   boolean("resolved").default(false).notNull(),
  resolvedAt: ts("resolved_at"),
  createdAt:  createdAt(),
}, (t) => ({
  severityIdx: index("sec_severity_idx").on(t.severity),
  categoryIdx: index("sec_category_idx").on(t.category),
  ipIdx:       index("sec_ip_idx").on(t.ip),
  resolvedIdx: index("sec_resolved_idx").on(t.resolved, t.createdAt),
  orgIdx:      index("sec_org_idx").on(t.orgId, t.createdAt),
}));

// ─── Bot Logs ─────────────────────────────────────────────────────────────────
// Purpose: Persistent log entries from bot runtime (errors, events, AI decisions).
// Live logs are streamed via WebSocket (bot_log events); this table stores the
// historical record for paginated retrieval. Retention: 30 days.

export const botLogs = pgTable("bot_logs", {
  id:        bigserial("id", { mode: "number" }).primaryKey(),
  botId:     integer("bot_id").notNull(),
  orgId:     integer("org_id").notNull(),
  level:     varchar("level", { length: 10 }).notNull(),   // "info" | "warn" | "error" | "debug"
  source:    varchar("source", { length: 50 }).notNull(),  // "runtime" | "ai" | "manager" | "skill"
  message:   text("message").notNull(),
  metadata:  jsonb("metadata").default({}),
  createdAt: createdAt(),
}, (t) => ({
  botIdx:     index("bot_log_bot_idx").on(t.botId),
  orgIdx:     index("bot_log_org_idx").on(t.orgId),
  levelIdx:   index("bot_log_level_idx").on(t.level),
  timeIdx:    index("bot_log_time_idx").on(t.createdAt),
  botTimeIdx: index("bot_log_bot_time_idx").on(t.botId, t.createdAt),
}));

// ─── Stripe Webhook Events ────────────────────────────────────────────────────
// Durable record of every Stripe event received (replay + audit trail).

export const stripeWebhookEvents = pgTable("stripe_webhook_events", {
  id:            serial("id").primaryKey(),
  stripeEventId: varchar("stripe_event_id", { length: 200 }).notNull(),
  type:          varchar("type", { length: 100 }).notNull(),
  payload:       jsonb("payload").notNull(),
  processed:     boolean("processed").default(false).notNull(),
  processedAt:   ts("processed_at"),
  error:         text("error"),
  createdAt:     createdAt(),
}, (t) => ({
  stripeEventIdx: uniqueIndex("stripe_webhook_event_id_idx").on(t.stripeEventId),
  typeIdx:        index("stripe_webhook_type_idx").on(t.type),
  processedIdx:   index("stripe_webhook_processed_idx").on(t.processed, t.createdAt),
}));

// ─── Feature Flags ────────────────────────────────────────────────────────────

export const featureFlags = pgTable("feature_flags", {
  id:                serial("id").primaryKey(),
  key:               varchar("key", { length: 100 }).notNull(),
  enabled:           boolean("enabled").default(false).notNull(),
  rolloutPercentage: smallint("rollout_percentage").default(0).notNull(),
  audience:          jsonb("audience").default({}),
  description:       varchar("description", { length: 500 }),
  createdAt:         createdAt(),
  updatedAt:         updatedAt(),
}, (t) => ({
  keyIdx: uniqueIndex("ff_key_idx").on(t.key),
}));

// ─── The Delegation ───────────────────────────────────────────────────────────
//
// Each user has one Delegation — their personal AI agent: the user describes a
// bot feature, the agent writes the code, tests it in a sandbox and deploys it.
//
// delegation_sessions:  conversation history + agent memory per user
// bot_scripts:          scripts per bot, versioned (latest isActive=true)
// delegation_memories:  pgvector embeddings for semantic recall (below)

export const delegationSessions = pgTable("delegation_sessions", {
  id:         serial("id").primaryKey(),
  uuid:       varchar("uuid", { length: 128 }).notNull(),
  userId:     integer("user_id").notNull(),
  orgId:      integer("org_id").notNull(),
  // Full conversation history as JSON array of {role, content} messages
  messages:   jsonb("messages").default([]).notNull(),
  // Agent long-term memory — facts extracted from past sessions
  memory:     jsonb("memory").default({}).notNull(),
  // Current agent task (null = idle)
  activeTask: varchar("active_task", { length: 1000 }),
  taskStatus: taskStatusEnum("task_status").default("idle").notNull(),
  createdAt:  createdAt(),
  updatedAt:  updatedAt(),
}, (t) => ({
  uuidIdx: uniqueIndex("delegation_uuid_idx").on(t.uuid),
  userIdx: uniqueIndex("delegation_user_idx").on(t.userId),
  orgIdx:  index("delegation_org_idx").on(t.orgId),
}));

export const botScripts = pgTable("bot_scripts", {
  id:          serial("id").primaryKey(),
  uuid:        varchar("uuid", { length: 128 }).notNull(),
  botId:       integer("bot_id").notNull(),
  orgId:       integer("org_id").notNull(),
  // Human-readable name for this script (e.g. "Emote command system")
  name:        varchar("name", { length: 300 }).notNull(),
  code:        text("code").notNull(),
  description: text("description"),
  // Version counter — incremented on each deploy by the agent
  version:     integer("version").default(1).notNull(),
  // Only the latest version of each named script is active
  isActive:    boolean("is_active").default(true).notNull(),
  // Test results from the last sandbox run
  lastTestOutput: text("last_test_output"),
  lastTestStatus: scriptTestStatusEnum("last_test_status").default("pending").notNull(),
  lastTestedAt:   ts("last_tested_at"),
  // The agent session that created/last modified this script
  delegationSessionId: integer("delegation_session_id"),
  createdAt:   createdAt(),
  updatedAt:   updatedAt(),
}, (t) => ({
  uuidIdx: uniqueIndex("bot_scripts_uuid_idx").on(t.uuid),
  botIdx:  index("bot_scripts_bot_idx").on(t.botId, t.isActive),
  orgIdx:  index("bot_scripts_org_idx").on(t.orgId),
}));

// 384 dimensions matches common small open embedding models (e.g.
// all-MiniLM-L6-v2) and OpenAI text-embedding-3-small with dimensions=384.
export const EMBEDDING_DIMENSIONS = 384;

export const delegationMemories = pgTable("delegation_memories", {
  id:                  serial("id").primaryKey(),
  uuid:                varchar("uuid", { length: 64 }).notNull(),
  userId:              integer("user_id").notNull(),
  orgId:               integer("org_id").notNull(),
  delegationSessionId: integer("delegation_session_id"),
  botScriptId:         integer("bot_script_id"),
  // "feature_request" | "script_outcome" | "user_preference" | "fact"
  kind:      varchar("kind", { length: 40 }).notNull(),
  summary:   text("summary").notNull(),
  embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
  // Free-form structured detail (e.g. the script diff, test results), JSON-encoded
  metadata:  text("metadata"),
  createdAt: createdAt(),
}, (t) => ({
  embeddingIdx: index("delegation_memories_embedding_idx")
    .using("hnsw", t.embedding.op("vector_cosine_ops")),
  userIdx: index("delegation_memories_user_idx").on(t.userId),
  orgIdx:  index("delegation_memories_org_idx").on(t.orgId),
}));

export type DelegationMemory = typeof delegationMemories.$inferSelect;
export type NewDelegationMemory = typeof delegationMemories.$inferInsert;

// highriseEmotes intentionally lives in SQLite instead — see
// apps/worker/src/sqlite/emoteCache.ts. It's global reference data with no
// multi-tenant dimension, a better fit for a small local file.

// ─── Composer Projects ───────────────────────────────────────────────────────
// One row per Highrise bot project created in the Bot Composer workbench:
// prompt history, generated spec, files, test results and deployment status.

export const composerProjects = pgTable("composer_projects", {
  id:         serial("id").primaryKey(),
  uuid:       varchar("uuid", { length: 36 }).notNull(),
  userId:     integer("user_id").notNull(),
  orgId:      integer("org_id").notNull(),
  // Link to the real bots table. Null until the project's first successful
  // deploy, then never changed — a composer-built bot and a dashboard bot are
  // the same row, not two parallel registries.
  botId:      integer("bot_id"),
  botName:    varchar("bot_name", { length: 200 }).notNull(),
  language:   composerLanguageEnum("language").default("python").notNull(),
  sdkVersion: varchar("sdk_version", { length: 20 }).default("25.1.0"),
  roomId:     varchar("room_id", { length: 200 }).default(""),
  // Encrypted bot API token — decrypted server-side only, never sent to frontend
  tokenVault: text("token_vault"),
  stage:      composerStageEnum("stage").default("idle").notNull(),
  activeTask: text("active_task"),
  // Generated artifacts
  spec:        jsonb("spec"),          // HighriseBotSpec
  files:       jsonb("files"),         // ProjectFile[]
  testResults: jsonb("test_results"),  // TestResult[]
  history:     jsonb("history"),       // ConversationMessage[]
  logs:        jsonb("logs"),          // string[]
  botPid:      integer("bot_pid"),
  lastError:   text("last_error"),
  isArchived:  boolean("is_archived").default(false).notNull(),
  createdAt:   createdAt(),
  updatedAt:   updatedAt(),
}, (t) => ({
  uuidIdx:  uniqueIndex("composer_projects_uuid_idx").on(t.uuid),
  userIdx:  index("composer_projects_user_idx").on(t.userId, t.isArchived),
  orgIdx:   index("composer_projects_org_idx").on(t.orgId),
  stageIdx: index("composer_projects_stage_idx").on(t.stage),
  // A bot can only have been created by one composer project. Postgres
  // unique indexes don't count NULLs against each other, so many
  // never-deployed projects (botId NULL) are fine.
  botIdx:   uniqueIndex("composer_projects_bot_idx").on(t.botId),
}));

// ─── Marketplace Purchases ────────────────────────────────────────────────────
// Every completed or pending purchase. Used for idempotency and delivery tracking.

export const marketplacePurchases = pgTable("marketplace_purchases", {
  id:                    serial("id").primaryKey(),
  uuid:                  varchar("uuid", { length: 36 }).notNull(),
  itemId:                integer("item_id").notNull(),   // FK → marketplace_items.id
  buyerId:               integer("buyer_id").notNull(),  // FK → users.id
  sellerId:              integer("seller_id"),           // denormalized for analytics
  price:                 integer("price").notNull().default(0), // cents
  status:                marketplacePurchaseStatusEnum("status").notNull().default("pending"),
  stripePaymentIntentId: varchar("stripe_payment_intent_id", { length: 255 }),
  deliveredAt:           ts("delivered_at"),
  createdAt:             createdAt(),
  updatedAt:             updatedAt(),
}, (t) => ({
  uuidIdx:        uniqueIndex("mkt_purchases_uuid_idx").on(t.uuid),
  buyerIdx:       index("mkt_purchases_buyer_idx").on(t.buyerId, t.status),
  itemIdx:        index("mkt_purchases_item_idx").on(t.itemId),
  uniquePurchase: uniqueIndex("mkt_purchases_buyer_item_idx").on(t.buyerId, t.itemId),
}));

// ─── Org Library Items ────────────────────────────────────────────────────────
// Delivered marketplace items (bot_config, personality, template) stored per org.

export const orgLibraryItems = pgTable("org_library_items", {
  id:        serial("id").primaryKey(),
  orgId:     integer("org_id").notNull(),
  itemId:    integer("item_id").notNull(),
  itemType:  varchar("item_type", { length: 50 }).notNull(),
  config:    jsonb("config"),
  createdAt: createdAt(),
}, (t) => ({
  orgItemIdx: uniqueIndex("org_library_org_item_idx").on(t.orgId, t.itemId),
  orgIdx:     index("org_library_org_idx").on(t.orgId),
}));

// ─── Org Plugins ──────────────────────────────────────────────────────────────

export const orgPlugins = pgTable("org_plugins", {
  id:        serial("id").primaryKey(),
  orgId:     integer("org_id").notNull(),
  pluginId:  integer("plugin_id").notNull(),
  enabled:   boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
}, (t) => ({
  orgPluginIdx: uniqueIndex("org_plugins_org_plugin_idx").on(t.orgId, t.pluginId),
  orgIdx:       index("org_plugins_org_idx").on(t.orgId),
}));

// ─── Org Rentals ─────────────────────────────────────────────────────────────

export const orgRentals = pgTable("org_rentals", {
  id:        serial("id").primaryKey(),
  orgId:     integer("org_id").notNull(),
  itemId:    integer("item_id").notNull(),
  expiresAt: ts("expires_at").notNull(),
  createdAt: createdAt(),
}, (t) => ({
  orgRentalIdx: uniqueIndex("org_rentals_org_item_idx").on(t.orgId, t.itemId),
  orgIdx:       index("org_rentals_org_idx").on(t.orgId),
  expiryIdx:    index("org_rentals_expiry_idx").on(t.expiresAt),
}));

// ─── Bot Projects (Python bot hosting) ───────────────────────────────────────
// A project is a folder of bot code (e.g. an uploaded Replit bot) that the
// runner service executes as its own Python process with the official
// Highrise SDK. Files live on disk (PROJECTS_DIR/<uuid>/), not in the DB.

export const projectStateEnum = pgEnum("project_state", ["running", "stopped"]);
export const projectStatusEnum = pgEnum("project_status", [
  "stopped", "installing", "starting", "running", "crashed", "error",
]);

export const agentStateEnum = pgEnum("agent_state", ["idle", "working", "waiting"]);

export const botProjects = pgTable("bot_projects", {
  id:            serial("id").primaryKey(),
  uuid:          varchar("uuid", { length: 36 }).notNull(),
  orgId:         integer("org_id").notNull(),
  ownerId:       integer("owner_id").notNull(),
  name:          varchar("name", { length: 150 }).notNull(),
  // "package.module:BotClass"; detected from the code on upload, editable.
  entrypoint:    varchar("entrypoint", { length: 300 }).default("").notNull(),
  // What the owner asked for; the runner keeps the process matching it.
  desiredState:  projectStateEnum("desired_state").default("stopped").notNull(),
  // What the runner last reported.
  status:        projectStatusEnum("status").default("stopped").notNull(),
  statusMessage: text("status_message"),
  lastExitCode:  integer("last_exit_code"),
  restartCount:  integer("restart_count").default(0).notNull(),
  lastStartedAt: ts("last_started_at"),
  // The coder AI: what it's doing now, and whether it may fix crashes on its own.
  agentState:    agentStateEnum("agent_state").default("idle").notNull(),
  autoFix:       boolean("auto_fix").default(true).notNull(),
  // Once a day Kojy reads the bot's errors and reports (AI only if there are any).
  dailyCheckup:  boolean("daily_checkup").default(false).notNull(),
  lastCheckupAt: ts("last_checkup_at"),
  createdAt:     createdAt(),
  updatedAt:     updatedAt(),
}, (t) => ({
  uuidIdx: uniqueIndex("bot_projects_uuid_idx").on(t.uuid),
  orgIdx:  index("bot_projects_org_idx").on(t.orgId),
}));

// Environment variables handed to a project's process (HIGHRISE_ROOM_ID,
// HIGHRISE_BOT_TOKEN, GROQ_API_KEY, ...). Values are encrypted with the
// platform ENCRYPTION_KEY and never sent back to the browser.
export const projectSecrets = pgTable("project_secrets", {
  id:         serial("id").primaryKey(),
  projectId:  integer("project_id").notNull(),
  key:        varchar("key", { length: 100 }).notNull(),
  valueVault: text("value_vault").notNull(),
  createdAt:  createdAt(),
  updatedAt:  updatedAt(),
}, (t) => ({
  projectKeyIdx: uniqueIndex("project_secrets_project_key_idx").on(t.projectId, t.key),
}));

// The project's chat with the coder AI. Rows are both what the page shows and
// the AI's conversation history:
//   role user       — the owner's messages (kind "text"), or app events such
//                     as "secrets saved" / "code uploaded" (kind "event")
//   role assistant  — the AI's replies; data.toolCalls holds its tool calls
//   role tool       — a tool's result (content, trimmed); data.summary is the
//                     one-line version shown in the chat; kind "secret_request"
//                     renders the "add these secrets" card
// Secret values never appear here.
export const projectMessages = pgTable("project_messages", {
  id:        serial("id").primaryKey(),
  // Which conversation: "project:<bot_projects.id>" (a Python bot's chat),
  // "bot:<bots.id>" (a JS bot's chat) or "studio:<org id>" (the Studio chat,
  // about all bots). projectId is 0 for the last two.
  thread:    varchar("thread", { length: 64 }).default("").notNull(),
  projectId: integer("project_id").notNull(),
  role:      varchar("role", { length: 16 }).notNull(),
  kind:      varchar("kind", { length: 32 }).default("text").notNull(),
  content:   text("content").default("").notNull(),
  data:      jsonb("data").$type<Record<string, unknown>>(),
  createdAt: createdAt(),
}, (t) => ({
  projectIdx: index("project_messages_project_idx").on(t.projectId, t.id),
  threadIdx:  index("project_messages_thread_idx").on(t.thread, t.id),
}));

// What the coder AI learned (fixes that worked, how a bot is built). Notes
// with a projectId are about that bot; notes without one apply to all of the
// org's bots.
export const agentMemories = pgTable("agent_memories", {
  id:        serial("id").primaryKey(),
  orgId:     integer("org_id").notNull(),
  projectId: integer("project_id"),
  content:   text("content").notNull(),
  createdAt: createdAt(),
}, (t) => ({
  orgIdx: index("agent_memories_org_idx").on(t.orgId, t.projectId),
}));

// What bots did, for analytics — written by both runtimes:
//   source "bot"     → JS bots (sourceId = bots.id), from the API's runtime
//   source "project" → Python bots (sourceId = bot_projects.id), from the
//                      runner (the launcher reports the SDK events it sees)
// kind: chat, whisper, reply, join, leave, tip, emote, start, stop, crash.
// actorId/actorName are the Highrise user (not a KojyAI account).
export const botActivity = pgTable("bot_activity", {
  id:        bigserial("id", { mode: "number" }).primaryKey(),
  orgId:     integer("org_id").notNull(),
  source:    varchar("source", { length: 10 }).notNull(),
  sourceId:  integer("source_id").notNull(),
  kind:      varchar("kind", { length: 20 }).notNull(),
  actorId:   varchar("actor_id", { length: 64 }),
  actorName: varchar("actor_name", { length: 100 }),
  createdAt: createdAt(),
}, (t) => ({
  orgTimeIdx:    index("bot_activity_org_time_idx").on(t.orgId, t.createdAt),
  sourceTimeIdx: index("bot_activity_source_time_idx").on(t.source, t.sourceId, t.createdAt),
}));
