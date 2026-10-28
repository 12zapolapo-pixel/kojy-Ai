/**
 * tests/helpers/factories.ts
 * Typed factory helpers required by all 8 uploaded test files.
 * Zero `as any`. Every object satisfies its declared interface.
 */

import type {
  BotMemory,
  BotRelationship,
  PersonalityTraits,
  MemoryCompressionState,
  MemoryType,
  RelationshipType,
  // FIX-16: BehaviorRule added — tests/security/policy-engine.test.ts imports
  // buildBehaviorRule which was missing from this file, causing a runtime import error.
  BehaviorRule,
} from "@kojyai/shared/types";
import type { ClockFn } from "../../packages/shared/src/observability/Clock.js";

// ─── Deterministic UID ───────────────────────────────────────────────────────

let _counter = 0;
export function resetUid(): void { _counter = 0; }
export function uid(prefix = ""): string {
  return `${prefix}${String(++_counter).padStart(6, "0")}`;
}

// ─── Frozen clock ─────────────────────────────────────────────────────────────

export const FROZEN_ISO  = "2025-06-16T14:00:00.000Z";
export const FROZEN_NOW  = new Date(FROZEN_ISO);
export const frozenClock: ClockFn = () => FROZEN_NOW;

// ─── PersonalityTraits factory ────────────────────────────────────────────────

export function buildTraits(overrides: Partial<PersonalityTraits> = {}): PersonalityTraits {
  return {
    openness:          0.5,
    conscientiousness: 0.5,
    extraversion:      0.5,
    agreeableness:     0.5,
    neuroticism:       0.5,
    humor:             0.5,
    empathy:           0.5,
    assertiveness:     0.5,
    creativity:        0.5,
    ...overrides,
  } satisfies PersonalityTraits;
}

// ─── BotMemory factory ────────────────────────────────────────────────────────

export function buildMemory(overrides: Partial<BotMemory> = {}): BotMemory {
  return {
    id:               uid("mem-"),
    botId:            uid("bot-"),
    type:             "episodic"  satisfies MemoryType,
    summary:          "A test memory event occurred in the room",
    importance:       0.5,
    compressionState: "raw"       satisfies MemoryCompressionState,
    relatedEntities:  [],
    timestamp:        FROZEN_ISO,
    expiresAt:        null,
    ...overrides,
  } satisfies BotMemory;
}

/** V1 memory — no compressionState field (simulates legacy DB row) */
export function buildLegacyMemoryV1(overrides: Partial<Omit<BotMemory, "compressionState">> = {}): Omit<BotMemory, "compressionState"> & { version?: number } {
  return {
    id:       uid("mem-v1-"),
    botId:    uid("bot-"),
    type:     "episodic" satisfies MemoryType,
    summary:  "Legacy V1 memory — no compressionState",
    importance: 0.5,
    relatedEntities: [],
    timestamp: FROZEN_ISO,
    expiresAt: null,
    version:   1,
    ...overrides,
  };
}

/** Mixed-version memory array — some V1, some V2 */
export function buildMixedVersionMemory(): Array<BotMemory | ReturnType<typeof buildLegacyMemoryV1>> {
  return [
    buildMemory({ id: uid("mem-v2-"), compressionState: "raw" }),
    buildLegacyMemoryV1(),
    buildMemory({ id: uid("mem-v2-"), compressionState: "compressed" }),
    buildLegacyMemoryV1(),
  ];
}

// ─── BotRelationship factory ──────────────────────────────────────────────────

export function buildRelationship(overrides: Partial<BotRelationship> = {}): BotRelationship {
  return {
    id:               uid("rel-"),
    botId:            uid("bot-"),
    targetType:       "user",
    targetId:         uid("usr-"),
    type:             "neutral" satisfies RelationshipType,
    trust:            0,
    loyalty:          0.5,
    affinity:         0,
    interactionCount: 0,
    lastUpdated:      FROZEN_ISO,
    ...overrides,
  } satisfies BotRelationship;
}

/** V1 relationship — no affinity field (simulates legacy DB row) */
export function buildLegacyRelationshipV1(
  overrides: Partial<Omit<BotRelationship, "affinity">> = {},
): Omit<BotRelationship, "affinity"> & { version?: number } {
  return {
    id:               uid("rel-v1-"),
    botId:            uid("bot-"),
    targetType:       "user",
    targetId:         uid("usr-"),
    type:             "neutral" satisfies RelationshipType,
    trust:            0,
    loyalty:          0.5,
    interactionCount: 0,
    lastUpdated:      FROZEN_ISO,
    version:          1,
    ...overrides,
  };
}

// ─── BehaviorRule Factory (FIX-16) ───────────────────────────────────────────
// tests/security/policy-engine.test.ts imports this. It was never exported here,
// causing a build-time import error that silently skipped the entire test file.

export function buildBehaviorRule(
  overrides: Partial<BehaviorRule> = {},
): BehaviorRule {
  return {
    trigger:  "when user says hello",
    action:   "reply with a greeting",
    priority: 5,
    isActive: true,
    ...overrides,
  } satisfies BehaviorRule;
}
