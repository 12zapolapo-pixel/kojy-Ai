/**
 * Relationship Graph Engine
 *
 * SKILL #4 — Bot Intelligence Layer
 * OWNERSHIP: packages/engine/src/relationships
 *
 * WHAT IT DOES:
 * Maintains a weighted, directed social graph between bots and users/bots.
 * Relationships evolve based on interaction sentiment, frequency, and outcomes.
 * This graph powers the NeuralMapCanvas visualization and influences bot
 * response behavior toward specific users (more empathetic to loyal users,
 * more assertive with rivals, etc.).
 *
 * GRAPH STRUCTURE:
 * - Nodes: bots and users
 * - Edges: relationships with three dimensions:
 *   trust [-1, 1]   — how much the bot trusts this entity
 *   loyalty [0, 1]  — how consistent/committed the relationship is
 *   affinity [-1, 1] — emotional warmth vs coldness
 *
 * UPDATE TRIGGERS:
 * - Every message: small delta based on sentiment
 * - User returns after absence: loyalty boost
 * - User ignores bot repeatedly: trust reduction
 * - Positive gift/trade: affinity boost
 * - Toxic message detected: trust + affinity sharp drop
 *
 * WORKER JOB:
 * - Queue: QUEUE_NAMES.RELATIONSHIP_UPDATE
 * - Trigger: buffered, fires after every 10 interactions (not per-message)
 * - Reason: relationship updates are noisy; batching smooths the graph
 *
 * SCALING:
 * - Relationship reads: hot-cached in Redis (bot:rel:{botId}:{targetId})
 * - Graph queries (find all relationships for a bot): paginated
 * - Neural map: only fetches relationships with |affinity| > 0.1 (prunes noise)
 *
 * SECURITY:
 * - Relationship data scoped by orgId — cross-org reads blocked at API layer
 * - Users can request deletion of their relationship data (GDPR)
 */

import type { BotRelationship, RelationshipType } from "@kojyai/shared/types";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RelationshipDelta {
  trustDelta: number;
  loyaltyDelta: number;
  affinityDelta: number;
  reason: string;
}

export interface InteractionContext {
  sentiment: number;        // -1 to 1
  messageType: "chat" | "command" | "gift" | "ignore" | "toxic" | "return";
  daysAbsent?: number;      // For return events
  giftValue?: number;       // For gift events
}

// ─── Delta Calculator ─────────────────────────────────────────────────────────

/**
 * Computes the relationship delta from a single interaction.
 * Deltas are small — relationships change gradually over many interactions.
 * Maximum change per interaction: ±0.05 on any dimension.
 */
export function calculateInteractionDelta(
  current: BotRelationship,
  ctx: InteractionContext,
): RelationshipDelta {
  const MAX = 0.05;

  switch (ctx.messageType) {
    case "chat": {
      // Sentiment-driven changes — both trust and affinity move with sentiment
      const sentimentImpact = ctx.sentiment * 0.03;
      return {
        trustDelta:   clamp(sentimentImpact, -MAX, MAX),
        loyaltyDelta: clamp(0.005, 0, MAX), // Loyalty always increases slightly with engagement
        affinityDelta: clamp(sentimentImpact * 1.5, -MAX, MAX),
        reason: `Chat interaction (sentiment: ${ctx.sentiment.toFixed(2)})`,
      };
    }

    case "return": {
      // User returning after absence — loyalty and trust boost
      const absenceBoost = Math.min((ctx.daysAbsent ?? 0) * 0.005, 0.03);
      return {
        trustDelta:   absenceBoost,
        loyaltyDelta: 0.02 + absenceBoost,
        affinityDelta: 0.015,
        reason: `User returned after ${ctx.daysAbsent ?? "?"}d absence`,
      };
    }

    case "gift": {
      const giftValue = ctx.giftValue ?? 0;
      const giftImpact = Math.min(giftValue / 10_000, 0.04); // Capped regardless of gift size
      return {
        trustDelta:   0.02 + giftImpact,
        loyaltyDelta: 0.03,
        affinityDelta: 0.04 + giftImpact,
        reason: `Gift received (value: ${giftValue})`,
      };
    }

    case "ignore": {
      // User ignored bot's message — mild negative signal
      return {
        trustDelta:   -0.01,
        loyaltyDelta: -0.005,
        affinityDelta: -0.01,
        reason: "Bot message ignored",
      };
    }

    case "toxic": {
      // Toxic message — sharp trust drop
      return {
        trustDelta:   -0.08,  // Exceeds MAX — toxic events are significant
        loyaltyDelta: -0.04,
        affinityDelta: -0.1,
        reason: "Toxic interaction detected",
      };
    }

    case "command": {
      return {
        trustDelta:   0.01,
        loyaltyDelta: 0.01,
        affinityDelta: 0.005,
        reason: "Command interaction (active engagement)",
      };
    }

    default:
      return { trustDelta: 0, loyaltyDelta: 0, affinityDelta: 0, reason: "Unknown" };
  }
}

// ─── Apply Delta ──────────────────────────────────────────────────────────────

export function applyRelationshipDelta(
  relationship: BotRelationship,
  delta: RelationshipDelta,
): BotRelationship {
  return {
    ...relationship,
    trust:            clamp(relationship.trust + delta.trustDelta, -1, 1),
    loyalty:          clamp(relationship.loyalty + delta.loyaltyDelta, 0, 1),
    affinity:         clamp(relationship.affinity + delta.affinityDelta, -1, 1),
    interactionCount: relationship.interactionCount + 1,
    lastUpdated:      new Date().toISOString(),
  };
}

// ─── Relationship Type Classifier ─────────────────────────────────────────────

/**
 * Determines the named relationship type from current scores.
 * Used for display and for influencing AI behavior context.
 */
export function classifyRelationshipType(rel: BotRelationship): RelationshipType {
  const { trust, loyalty, affinity } = rel;

  if (trust > 0.6 && affinity > 0.6 && loyalty > 0.5) return "ally";
  if (trust > 0.4 && affinity > 0.4 && loyalty > 0.7) return "friend";
  if (trust < -0.4 && affinity < -0.4) return "enemy";
  if (trust < -0.2 && affinity < 0) return "rival";
  if (trust > 0.5 && loyalty > 0.6 && rel.interactionCount > 100) {
    return affinity > 0 ? "mentor" : "student";
  }
  return "neutral";
}

// ─── Relationship Context Builder ─────────────────────────────────────────────

/**
 * Builds relationship context injected into bot's AI prompt.
 * Influences how the bot speaks to this specific user.
 * Called on every message — must be synchronous and fast.
 */
export function buildRelationshipContext(
  relationship: BotRelationship | null,
  targetName: string,
): string {
  if (!relationship || Math.abs(relationship.affinity) < 0.1 && Math.abs(relationship.trust) < 0.1) {
    return ""; // No meaningful relationship yet — don't inject context
  }

  const relType = classifyRelationshipType(relationship);

  const contextMap: Record<RelationshipType, string> = {
    ally:    `${targetName} is a trusted ally. Be warm, collaborative, and openly helpful.`,
    friend:  `${targetName} is a friend. Be warm and personable with them.`,
    mentor:  `${targetName} looks up to you. Be encouraging and guide them gently.`,
    student: `You look up to ${targetName}. Show some respect and attentiveness.`,
    neutral: `You have a casual relationship with ${targetName}.`,
    rival:   `You have a competitive dynamic with ${targetName}. Be respectful but assertive.`,
    enemy:   `You are wary of ${targetName}. Be guarded and careful.`,
  };

  const loyaltyNote =
    relationship.loyalty > 0.7
      ? ` They have been consistently loyal — acknowledge it subtly.`
      : "";

  return contextMap[relType] + loyaltyNote;
}

// ─── Graph Query Helpers ──────────────────────────────────────────────────────

/** Returns relationships worth visualizing (significant signal) */
export function filterVisualizableRelationships(
  relationships: BotRelationship[],
): BotRelationship[] {
  return relationships.filter(
    (r) => Math.abs(r.affinity) > 0.1 || Math.abs(r.trust) > 0.1 || r.interactionCount > 5,
  );
}

/** Computes the edge weight for the neural map visualization */
export function getEdgeWeight(rel: BotRelationship): number {
  // Combines trust, affinity magnitude, and interaction count into 0–1 range
  const score = (Math.abs(rel.trust) + Math.abs(rel.affinity)) / 2;
  const activityBoost = Math.min(rel.interactionCount / 200, 0.2);
  return Math.min(1, score + activityBoost);
}

/** Returns color for neural map edge — blue = positive, red = negative */
export function getEdgeColor(rel: BotRelationship): string {
  const t = (rel.affinity + 1) / 2; // normalize to 0–1
  // Lerp red→gray→cyan
  if (t < 0.5) {
    const f = t * 2;
    const r = Math.round(239 + (100 - 239) * f);
    const g = Math.round(68 + (100 - 68) * f);
    const b = Math.round(68 + (100 - 68) * f);
    return `rgb(${r},${g},${b})`;
  } else {
    const f = (t - 0.5) * 2;
    const r = Math.round(100 + (0 - 100) * f);
    const g = Math.round(100 + (184 - 100) * f);
    const b = Math.round(100 + (245 - 100) * f);
    return `rgb(${r},${g},${b})`;
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

export function formatRelationshipLabel(rel: BotRelationship): string {
  const type = classifyRelationshipType(rel);
  const strength = rel.loyalty > 0.7 ? "Strong " : rel.loyalty > 0.4 ? "" : "Weak ";
  return `${strength}${type.charAt(0).toUpperCase() + type.slice(1)}`;
}
