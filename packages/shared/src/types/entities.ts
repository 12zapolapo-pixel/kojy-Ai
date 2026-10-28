/**
 * @kojyai/shared — Core Platform Types
 *
 * OWNERSHIP: This file is the canonical type contract for the entire platform.
 * All apps and packages MUST import entity types from here.
 * No app may define its own duplicate of these types.
 *
 * CHANGE POLICY: Any breaking change here requires a coordinated update
 * across all consumers. Use deprecation markers before removing fields.
 */

// ─── Identity ─────────────────────────────────────────────────────────────────

/** All IDs are strings (UUID v4 or nanoid) — no integer IDs at the API boundary */
export type ID = string;
/**
 * A point in time as the API delivers it. The tRPC transformer (superjson)
 * turns server Dates into real Date objects, while some sources (WebSocket
 * events, JSON fixtures) still carry ISO strings — so accept both.
 */
export type Timestamp = Date | string;

// ─── User ─────────────────────────────────────────────────────────────────────

export type UserTier = "free" | "starter" | "pro" | "elite" | "enterprise" | "dev";
export type UserRole = "user" | "admin" | "superadmin";
export type UserStatus = "active" | "suspended" | "pending_verification" | "deleted";

export interface User {
  id: ID;
  email: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  tier: UserTier;
  role: UserRole;
  status: UserStatus;
  isDev: boolean;
  walletBalance: number;
  locale: string;
  timezone: string;
  /** White-label branding — only populated for enterprise tier */
  branding: UserBranding | null;
  createdAt: Timestamp; // ISO 8601
  updatedAt: Timestamp;
}

export interface UserBranding {
  name: string;
  logoUrl: string | null;
  primaryColor: string;
  accentColor: string;
}

// ─── Organization ─────────────────────────────────────────────────────────────

export type OrgPlan = UserTier;
export type OrgStatus = "active" | "suspended" | "trialing" | "past_due";

export interface Organization {
  id: ID;
  ownerId: ID;
  name: string;
  slug: string;
  plan: OrgPlan;
  status: OrgStatus;
  memberCount: number;
  botQuota: number;
  settings: OrgSettings;
  branding: UserBranding | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface OrgSettings {
  allowPublicBots: boolean;
  defaultLanguage: string;
  notificationsEnabled: boolean;
  simulationEnabled: boolean;
  analyticsRetentionDays: number;
}

// ─── Bot ──────────────────────────────────────────────────────────────────────

export type BotStatus = "offline" | "connecting" | "online" | "error" | "suspended";
export type BotRuntimeMode = "ai" | "scripted" | "hybrid";
export type BotHealthScore = 0 | 1 | 2 | 3 | 4 | 5; // 0=dead, 5=excellent

export interface Bot {
  id: ID;
  orgId: ID;
  ownerId: ID;
  name: string;
  avatarUrl: string | null;
  status: BotStatus;
  runtimeMode: BotRuntimeMode;
  healthScore: number; // 0–5, see BotHealthScore (stored as a smallint)
  activeRoomId: string | null;
  language: string;
  personalityProfileId: ID | null;
  isActive: boolean;
  version: number;
  tags: string[];
  stats?: BotStats;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  lastSeen: Timestamp | null;
}

export interface BotStats {
  totalMessages: number;
  totalGreetings: number;
  totalCommands: number;
  uptimeSeconds: number;
  uniqueUsers: number;
  returningUsers: number;
}

// ─── Personality DNA ─────────────────────────────────────────────────────────

export interface PersonalityDNA {
  id: ID;
  botId: ID;
  version: number;
  traits: PersonalityTraits;
  voice: VoiceProfile;
  behaviorRules: BehaviorRule[];
  evolvedState: Record<string, unknown>;
  createdAt: Timestamp;
}

export interface PersonalityTraits {
  /** 0–1 scale for each dimension */
  openness: number;
  conscientiousness: number;
  extraversion: number;
  agreeableness: number;
  neuroticism: number;
  humor: number;
  empathy: number;
  assertiveness: number;
  creativity: number;
}

export interface VoiceProfile {
  tone: "formal" | "casual" | "playful" | "mysterious" | "warm" | "sharp";
  pace: "slow" | "normal" | "fast";
  verbosity: "terse" | "normal" | "verbose";
  useEmoji: boolean;
  signaturePhrase: string | null;
}

export interface BehaviorRule {
  trigger: string;
  action: string;
  priority: number;
  isActive: boolean;
}

// ─── Memory ───────────────────────────────────────────────────────────────────

export type MemoryType = "episodic" | "semantic" | "procedural" | "emotional";
export type MemoryCompressionState = "raw" | "compressed" | "archived";

export interface BotMemory {
  id: ID;
  botId: ID;
  type: MemoryType;
  summary: string;
  importance: number; // 0–1
  compressionState: MemoryCompressionState;
  relatedEntities: string[];
  timestamp: string;
  expiresAt: Timestamp | null;
}

// ─── Relationships ────────────────────────────────────────────────────────────

export type RelationshipTarget = "user" | "bot";
export type RelationshipType =
  | "ally"
  | "rival"
  | "neutral"
  | "mentor"
  | "student"
  | "friend"
  | "enemy";

export interface BotRelationship {
  id: ID;
  botId: ID;
  targetType: RelationshipTarget;
  targetId: ID;
  type: RelationshipType;
  trust: number; // -1 to 1
  loyalty: number; // 0 to 1
  affinity: number; // -1 to 1
  interactionCount: number;
  lastUpdated: Timestamp;
}

// ─── Room ─────────────────────────────────────────────────────────────────────

export type RoomStatus = "active" | "inactive" | "archived";

export interface Room {
  id: ID;
  orgId: ID;
  name: string;
  highriseRoomId: string;
  status: RoomStatus;
  activeBotIds: ID[];
  settings: RoomSettings;
  analytics: RoomAnalyticsSummary;
  createdAt: Timestamp;
}

export interface RoomSettings {
  language: string;
  moderationEnabled: boolean;
  economyEnabled: boolean;
  maxBots: number;
}

export interface RoomAnalyticsSummary {
  totalVisitors: number;
  avgSessionMinutes: number;
  retentionRate: number;
  energyScore: number;
}

// ─── Simulation ───────────────────────────────────────────────────────────────

export type SimulationStatus = "draft" | "running" | "paused" | "completed" | "failed";
export type SimulationScenario =
  | "social"
  | "economy"
  | "moderation"
  | "churn"
  | "chaos"
  | "custom";

export interface Simulation {
  id: ID;
  orgId: ID;
  name: string;
  scenario: SimulationScenario;
  status: SimulationStatus;
  config: SimulationConfig;
  result: SimulationResult | null;
  createdAt: Timestamp;
  startedAt: Timestamp | null;
  completedAt: Timestamp | null;
}

export interface SimulationConfig {
  botIds: ID[];
  roomId: ID | null;
  speedMultiplier: number; // 1x, 2x, 5x, 10x
  durationSeconds: number;
  fakePlayers: number;
  injectedEvents: InjectedEvent[];
  chaosEnabled: boolean;
}

export interface InjectedEvent {
  atSecond: number;
  type: string;
  payload: Record<string, unknown>;
}

export interface SimulationResult {
  passed: boolean;
  metrics: Record<string, number>;
  timeline: SimulationTimelineEntry[];
  errors: string[];
}

export interface SimulationTimelineEntry {
  second: number;
  agentId: string;
  action: string;
  payload: Record<string, unknown>;
}

// ─── Subscription ─────────────────────────────────────────────────────────────

export type SubscriptionStatus = "active" | "trialing" | "past_due" | "canceled" | "paused";

export interface Subscription {
  id: ID;
  orgId: ID;
  plan: UserTier;
  status: SubscriptionStatus;
  stripeSubscriptionId: string | null;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  limits: PlanLimits;
}

export interface PlanLimits {
  maxBots: number;
  maxRooms: number;
  maxMessagesPerDay: number;
  maxSimulations: number;
  analyticsRetentionDays: number;
  aiModel: string;
  webSearchEnabled: boolean;
  simulationEnabled: boolean;
  whitelabelEnabled: boolean;
  marketplaceEnabled: boolean;
}

// ─── Analytics ────────────────────────────────────────────────────────────────

export type MetricPeriod = "hour" | "day" | "week" | "month";

export interface AnalyticsSnapshot {
  id: ID;
  orgId: ID;
  botId: ID | null;
  metricType: string;
  metricValue: number;
  dimensions: Record<string, string | number>;
  period: MetricPeriod;
  periodStart: string;
  createdAt: Timestamp;
}

// ─── Notifications ────────────────────────────────────────────────────────────

export type NotificationType =
  | "bot_offline"
  | "bot_error"
  | "billing_due"
  | "simulation_complete"
  | "new_member"
  | "security_alert"
  | "system";

export interface Notification {
  id: ID;
  userId: ID;
  type: NotificationType;
  title: string;
  body: string;
  actionUrl: string | null;
  readAt: Timestamp | null;
  createdAt: Timestamp;
}

// ─── Audit ────────────────────────────────────────────────────────────────────

export interface AuditLog {
  id: ID;
  actorId: ID;
  actorType: "user" | "bot" | "system";
  action: string;
  resourceType: string;
  resourceId: ID;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: Timestamp;
}

// ─── Security Events ─────────────────────────────────────────────────────────

export type SecuritySeverity = "low" | "medium" | "high" | "critical";
export type SecurityCategory =
  | "auth"
  | "rate_limit"
  | "toxicity"
  | "fraud"
  | "impersonation"
  | "account_takeover";

export interface SecurityEvent {
  // FIX-AUDIT: was `id: ID` (the string-UUID convention used by Bot/
  // Simulation/etc.) but security_events has no uuid column — verified
  // against apps/api/src/db/schemas/schema.ts, it's a raw autoincrement int,
  // and security.resolveEvent's real input schema is z.number(). This type
  // was simply wrong; it was masked because the one call site consuming it
  // was, until fixed, silently typed `unknown` (see SecurityPage.tsx).
  id: number;
  severity: SecuritySeverity;
  category: SecurityCategory;
  actorId: number | null;
  ip: string;
  payload: Record<string, unknown>;
  resolved: boolean;
  resolvedAt: Timestamp | null;
  createdAt: Timestamp;
}

// ─── Feature Flags ────────────────────────────────────────────────────────────

export interface FeatureFlag {
  id: ID;
  key: string;
  enabled: boolean;
  rolloutPercentage: number; // 0–100
  audience: FeatureFlagAudience;
  createdAt: Timestamp;
}

export interface FeatureFlagAudience {
  tiers?: UserTier[];
  userIds?: ID[];
  orgIds?: ID[];
  isDev?: boolean;
}

// ─── Marketplace ──────────────────────────────────────────────────────────────

export type MarketplaceItemType = "bot_config" | "personality" | "plugin" | "template" | "rental";
export type MarketplaceItemStatus = "draft" | "published" | "suspended";

export interface MarketplaceItem {
  id: ID;
  sellerId: ID;
  type: MarketplaceItemType;
  title: string;
  description: string;
  price: number; // in cents
  currency: string;
  metadata: Record<string, unknown>;
  status: MarketplaceItemStatus;
  purchaseCount: number;
  rating: number | null;
  createdAt: Timestamp;
}
