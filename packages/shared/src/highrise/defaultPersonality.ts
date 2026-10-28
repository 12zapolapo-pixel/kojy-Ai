/**
 * Default Personality Profile
 * OWNERSHIP: packages/shared/src/highrise
 *
 * Moved from packages/engine/src/personality/PersonalityEngine.ts — this
 * function only ever depended on @kojyai/shared/types (PersonalityDNA), not
 * on anything else in the engine package, so it was always more correctly a
 * shared data-shape utility than an AI-engine capability. Moving it here
 * lets createBot.ts (in this same directory) build a real bot record —
 * including its default personality profile — without packages/shared ever
 * needing to depend on packages/engine, which would create a circular
 * dependency (packages/engine already depends on packages/shared).
 *
 * packages/engine/src/personality/PersonalityEngine.ts re-exports this for
 * backward compatibility — existing `import { createDefaultPersonalityProfile }
 * from "@kojyai/engine/personality"` call sites are unchanged.
 */

import type { PersonalityDNA } from "../types/entities.js";

export function createDefaultPersonalityProfile(botId: string): Omit<PersonalityDNA, "id" | "createdAt"> {
  return {
    botId,
    version: 1,
    traits: {
      openness: 0.6,
      conscientiousness: 0.7,
      extraversion: 0.65,
      agreeableness: 0.75,
      neuroticism: 0.3,
      humor: 0.5,
      empathy: 0.7,
      assertiveness: 0.5,
      creativity: 0.55,
    },
    voice: {
      tone: "casual",
      pace: "normal",
      verbosity: "normal",
      useEmoji: true,
      signaturePhrase: null,
    },
    behaviorRules: [],
    evolvedState: {},
  };
}
