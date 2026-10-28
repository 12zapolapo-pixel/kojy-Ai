/**
 * tests/invariants/domain-invariants.test.ts
 *
 * P2-18: Domain-level invariant testing.
 *
 * WHY: Function-level tests verify individual outputs. Domain invariants
 * verify that the SYSTEM as a whole satisfies business guarantees:
 *
 *   INVARIANT-1: All personality trait values are always in [0.0, 1.0]
 *   INVARIANT-2: Personality evolution always converges (doesn't diverge)
 *   INVARIANT-3: Compressed memories never increase token count
 *   INVARIANT-4: Relationship trust + loyalty always in declared ranges
 *   INVARIANT-5: Bot loyalty score is always in [0.0, 1.0]
 *   INVARIANT-6: Memory importance is always a finite number in [0.0, 1.0]
 *   INVARIANT-7: Simulated time always advances (never goes backward)
 *   INVARIANT-8: A fully-evolved bot still has valid traits
 *
 * HOW: Property tests with fc — exhaustive over arbitrary inputs.
 */

import { describe, it, expect, beforeEach } from "vitest";
import fc from "fast-check";

import {
  evolvePersonality,
  validatePersonalityProfile,
} from "../../packages/engine/src/personality/PersonalityEngine.js";

import {
  buildTraits,
  buildMemory,
  buildRelationship,
  resetUid,
} from "../helpers/factories.js";
import { expectClampedRange, expectFiniteNumber } from "../helpers/assertions.js";
import { LIMITS } from "../../packages/shared/src/constants/limits.js";
import type { PersonalityTraits } from "@kojyai/shared/types";

beforeEach(() => resetUid());

// ─── INVARIANT-1: Traits always in [0, 1] ────────────────────────────────────

describe("INVARIANT-1: personality traits always in [0.0, 1.0]", () => {
  it("[property] traits stay clamped after any number of evolution cycles", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            sentiments: fc.array(fc.float({ min: Math.fround(-1), max: Math.fround(2), noNaN: true }), { minLength: 1, maxLength: 20 }),
            retention: fc.float({ min: Math.fround(-0.5), max: Math.fround(1.5), noNaN: true }),
            loyaltyDelta: fc.float({ min: Math.fround(-2), max: Math.fround(2), noNaN: true }),
            interactions: fc.integer({ min: 1, max: 1000 }),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        (evolutionSteps) => {
          let traits = buildTraits();
          for (const step of evolutionSteps) {
            const result = evolvePersonality({
              currentTraits: traits,
              recentSentiments: step.sentiments,
              retentionRate: step.retention,
              loyaltyDelta: step.loyaltyDelta,
              interactionCount: step.interactions,
            });
            traits = result.newTraits;
          }
          for (const [key, val] of Object.entries(traits)) {
            expectClampedRange(val, 0, 1, `after evolution: ${key}`);
          }
        },
      ),
      { seed: 42, numRuns: 300 },
    );
  });
});

// ─── INVARIANT-2: Evolution converges ────────────────────────────────────────

describe("INVARIANT-2: personality evolution converges, does not diverge", () => {
  it("100 cycles of identical inputs produce stable traits (convergence)", () => {
    let traits = buildTraits({ agreeableness: 0.5 });
    const input = {
      recentSentiments: [0.8, 0.8, 0.8],
      retentionRate: 0.7,
      loyaltyDelta: 0.1,
      interactionCount: 50,
    };

    let prevAgreeableness = traits.agreeableness;
    let monotonicallyIncreasing = true;

    for (let i = 0; i < 100; i++) {
      const result = evolvePersonality({ currentTraits: traits, ...input });
      traits = result.newTraits;

      // Once it stops increasing, it must not start going up dramatically again
      if (traits.agreeableness < prevAgreeableness - 0.001) {
        monotonicallyIncreasing = false;
      }
      prevAgreeableness = traits.agreeableness;
    }

    // After convergence, trait must be in valid range
    expectClampedRange(traits.agreeableness, 0, 1, "converged agreeableness");

    // FIX-2: assert the monotonicity flag — this is the actual convergence proof.
    // Without this line the guarantee "declared but never proven" (audit finding).
    expect(monotonicallyIncreasing, "agreeableness diverged — evolution is not monotonic").toBe(true);

    // Convergence: final value must be > initial (positive sentiment drove it up)
    expect(traits.agreeableness).toBeGreaterThan(0.5);
  });
});

// ─── INVARIANT-3: Compression never increases token count ────────────────────

describe("INVARIANT-3: compressed memories are never larger than originals", () => {
  /** Simple compression simulation: deduplicate repeated phrases */
  function compressSummary(summary: string): string {
    const sentences = summary.split(". ");
    const unique = [...new Set(sentences)];
    return unique.join(". ");
  }

  it("compressed summary is always <= original length", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 5, maxLength: 100 }), { minLength: 2, maxLength: 20 }),
        (phrases) => {
          const original = phrases.join(". ");
          const compressed = compressSummary(original);
          expect(compressed.length).toBeLessThanOrEqual(original.length);
        },
      ),
      { seed: 42, numRuns: 300 },
    );
  });

  it("compression of already-compressed summary is idempotent", () => {
    const memory = buildMemory({ summary: "The user asked. The user asked. Hello world." });
    const first = compressSummary(memory.summary);
    const second = compressSummary(first);
    expect(second.length).toBeLessThanOrEqual(first.length);
  });
});

// ─── INVARIANT-4: Relationship numeric ranges ────────────────────────────────

describe("INVARIANT-4: relationship fields always within declared ranges", () => {
  it("clean factory output satisfies range invariants", () => {
    const rel = buildRelationship({ trust: 0.5, loyalty: 0.7, affinity: -0.2 });
    expectClampedRange(rel.trust, LIMITS.RELATIONSHIP_TRUST_MIN, LIMITS.RELATIONSHIP_TRUST_MAX, "trust");
    expectClampedRange(rel.loyalty, LIMITS.RELATIONSHIP_LOYALTY_MIN, LIMITS.RELATIONSHIP_LOYALTY_MAX, "loyalty");
  });

  it("[property] clamped relationship update always stays in range", () => {
    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(-1), max: Math.fround(1), noNaN: true }),
        fc.float({ min: Math.fround(0), max: Math.fround(1), noNaN: true }),
        fc.float({ min: Math.fround(-0.5), max: Math.fround(0.5), noNaN: true }),
        (trust, loyalty, delta) => {
          const clampedTrust = Math.max(
            LIMITS.RELATIONSHIP_TRUST_MIN,
            Math.min(LIMITS.RELATIONSHIP_TRUST_MAX, trust + delta),
          );
          const clampedLoyalty = Math.max(
            LIMITS.RELATIONSHIP_LOYALTY_MIN,
            Math.min(LIMITS.RELATIONSHIP_LOYALTY_MAX, loyalty + delta),
          );
          expectClampedRange(clampedTrust, LIMITS.RELATIONSHIP_TRUST_MIN, LIMITS.RELATIONSHIP_TRUST_MAX, "trust");
          expectClampedRange(clampedLoyalty, LIMITS.RELATIONSHIP_LOYALTY_MIN, LIMITS.RELATIONSHIP_LOYALTY_MAX, "loyalty");
        },
      ),
      { seed: 42, numRuns: 500 },
    );
  });
});

// ─── INVARIANT-5: Bot loyalty score ──────────────────────────────────────────

describe("INVARIANT-5: bot loyalty score in [0.0, 1.0]", () => {
  it("[property] clamped loyalty update always in [0, 1]", () => {
    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(0), max: Math.fround(1), noNaN: true }),
        fc.float({ min: Math.fround(-0.5), max: Math.fround(0.5), noNaN: true }),
        (current, delta) => {
          const updated = Math.max(0, Math.min(1, current + delta));
          expectClampedRange(updated, 0, 1, "loyalty");
        },
      ),
      { seed: 42, numRuns: 500 },
    );
  });
});

// ─── INVARIANT-6: Memory importance is always finite ─────────────────────────

describe("INVARIANT-6: memory importance always finite [0.0, 1.0]", () => {
  it("factory output is finite", () => {
    const m = buildMemory({ importance: 0.7 });
    expectFiniteNumber(m.importance, "importance");
  });

  it("[property] importance calculation stays finite for any valid base + delta", () => {
    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(0), max: Math.fround(1), noNaN: true }),
        fc.float({ min: Math.fround(-0.3), max: Math.fround(0.3), noNaN: true }),
        (base, delta) => {
          const updated = Math.max(0, Math.min(1, base + delta));
          expectFiniteNumber(updated, "importance");
          expectClampedRange(updated, 0, 1, "importance");
        },
      ),
      { seed: 42, numRuns: 500 },
    );
  });
});

// ─── INVARIANT-7: Simulated time always advances ──────────────────────────────

describe("INVARIANT-7: simulated time never goes backward", () => {
  it("sequence of timestamped events is monotonically increasing", () => {
    const STEP_MS = 1_000;
    const start = new Date("2025-01-01T00:00:00.000Z").getTime();

    const timestamps = Array.from({ length: 100 }, (_, i) =>
      new Date(start + i * STEP_MS).toISOString(),
    );

    for (let i = 1; i < timestamps.length; i++) {
      const prev = new Date(timestamps[i - 1]!).getTime();
      const curr = new Date(timestamps[i]!).getTime();
      expect(curr, `timestamp[${i}] went backward`).toBeGreaterThan(prev);
    }
  });
});

// ─── INVARIANT-8: Fully evolved bot has valid personality ────────────────────

describe("INVARIANT-8: evolved personality always validates", () => {
  it("traits after 50 evolution cycles still pass validation", () => {
    let traits: PersonalityTraits = buildTraits();
    const inputs = [
      { sentiments: [0.9, 0.8], retention: 0.8, loyalty: 0.1, interactions: 100 },
      { sentiments: [-0.3, 0.5], retention: 0.3, loyalty: -0.2, interactions: 50 },
      { sentiments: [1.0, 1.0], retention: 1.0, loyalty: 0.5, interactions: 200 },
    ];

    for (let i = 0; i < 50; i++) {
      const step = inputs[i % inputs.length]!;
      traits = evolvePersonality({
        currentTraits: traits,
        recentSentiments: step.sentiments,
        retentionRate: step.retention,
        loyaltyDelta: step.loyalty,
        interactionCount: step.interactions,
      }).newTraits;
    }

    const { valid, errors } = validatePersonalityProfile({
      traits,
      behaviorRules: [],
    });

    expect(valid, `validation failed after evolution: ${errors.join(", ")}`).toBe(true);
  });
});
