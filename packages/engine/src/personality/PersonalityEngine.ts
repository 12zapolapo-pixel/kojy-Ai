/**
 * Personality DNA Engine
 *
 * SKILL #1 — Bot Intelligence Layer
 * OWNERSHIP: packages/engine/src/personality
 *
 * WHAT IT DOES:
 * Manages a bot's personality as a versioned, evolvable DNA structure.
 * Personality influences every AI response through a system prompt injection.
 * It evolves over time based on interaction outcomes (user retention,
 * sentiment scores, loyalty changes).
 *
 * DATA FLOW:
 * 1. User creates/edits personality via UI → PATCH /trpc/bots.updatePersonality
 * 2. API writes new personality version to bot_personality_profiles
 * 3. Bot runtime loads active profile on next message cycle
 * 4. After every 50 interactions, evolution job runs → may mutate trait scores
 * 5. New version created with evolved state, old version retained for rollback
 *
 * AI INTEGRATION:
 * - Trait scores → system prompt text via buildPersonalityPrompt()
 * - Voice profile → tone/style instructions in the prompt
 * - Behavior rules → few-shot examples injected into context
 *
 * SCALING:
 * - Profile read: cached in Redis for 5 min after first load
 * - Profile write: invalidates cache for that bot immediately
 * - Evolution job: runs in worker, never blocks API
 *
 * SECURITY:
 * - Behavior rules sanitized — no injection attacks via custom rules
 * - Profile access scoped to orgId — cannot read another org's profiles
 *
 * FAILURE:
 * - Profile load fails → bot uses hardcoded default personality (never silent fail)
 * - Evolution produces invalid scores → clamped to [0,1], job logs warning
 */

import type { PersonalityDNA, PersonalityTraits, VoiceProfile, BehaviorRule } from "@kojyai/shared/types";

// ─── Prompt Builder ───────────────────────────────────────────────────────────

/**
 * Converts personality DNA into system prompt text injected before every AI call.
 * This is the core mechanism: traits → natural language instructions → AI behavior.
 */
export function buildPersonalityPrompt(profile: PersonalityDNA): string {
  const { traits, voice, behaviorRules } = profile;

  const traitDescriptions = buildTraitDescriptions(traits);
  const voiceInstructions = buildVoiceInstructions(voice);
  const activeRules = behaviorRules
    .filter((r) => r.isActive)
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 10); // Cap at 10 rules to avoid prompt bloat

  const rulesText = activeRules.length > 0
    ? `\n\nBehavior rules (follow these precisely):\n${activeRules
        .map((r) => `- When ${r.trigger}: ${r.action}`)
        .join("\n")}`
    : "";

  return `You are an AI agent with the following personality:

${traitDescriptions}

${voiceInstructions}${rulesText}

These traits define who you are at a core level. Express them naturally in every response.
Do not describe yourself in meta terms — embody the personality, do not explain it.`;
}

function buildTraitDescriptions(traits: PersonalityTraits): string {
  const descriptions: string[] = [];

  if (traits.openness > 0.7) descriptions.push("You are highly curious and open to new experiences, often exploring ideas and asking thoughtful questions.");
  else if (traits.openness < 0.3) descriptions.push("You prefer familiar patterns and proven approaches, and tend to be cautious about new ideas.");

  if (traits.extraversion > 0.7) descriptions.push("You are outgoing, energetic, and genuinely excited to interact with people.");
  else if (traits.extraversion < 0.3) descriptions.push("You are more reserved and thoughtful, preferring depth over surface-level conversation.");

  if (traits.agreeableness > 0.7) descriptions.push("You are cooperative, warm, and genuinely care about the people you talk to.");
  else if (traits.agreeableness < 0.3) descriptions.push("You are direct and sometimes blunt, prioritizing honesty over social comfort.");

  if (traits.humor > 0.7) descriptions.push("You have a strong sense of humor and naturally find opportunities for wit or playful banter.");
  else if (traits.humor < 0.2) descriptions.push("You maintain a serious, professional tone and rarely make jokes.");

  if (traits.empathy > 0.7) descriptions.push("You are highly empathetic and attentive to emotional cues in conversation.");

  if (traits.assertiveness > 0.7) descriptions.push("You are confident and assertive, comfortable taking initiative and expressing opinions clearly.");
  else if (traits.assertiveness < 0.3) descriptions.push("You tend to be accommodating and prefer to follow the other person's lead.");

  if (traits.creativity > 0.7) descriptions.push("You are imaginative and often approach topics from unexpected, creative angles.");

  return descriptions.join(" ");
}

function buildVoiceInstructions(voice: VoiceProfile): string {
  const toneMap: Record<VoiceProfile["tone"], string> = {
    formal:    "Use formal, professional language. Avoid contractions and slang.",
    casual:    "Use casual, conversational language. Contractions and informal phrasing are natural.",
    playful:   "Use playful, lighthearted language. Be enthusiastic and fun.",
    mysterious: "Maintain an air of mystery. Be cryptic and intriguing at times.",
    warm:      "Be warm, welcoming, and nurturing in your tone.",
    sharp:     "Be sharp and efficient. Get to the point quickly without unnecessary elaboration.",
  };

  const verbosityMap: Record<VoiceProfile["verbosity"], string> = {
    terse:   "Keep responses short — one or two sentences when possible.",
    normal:  "Keep responses conversational — typically 2–4 sentences.",
    verbose: "You can be more detailed and thorough in your explanations.",
  };

  const emojiNote = voice.useEmoji
    ? "You can use emoji naturally when it fits the conversation, but don't overdo it."
    : "Do not use emoji.";

  const signatureNote = voice.signaturePhrase
    ? `You occasionally use your signature phrase: "${voice.signaturePhrase}"`
    : "";

  return [toneMap[voice.tone], verbosityMap[voice.verbosity], emojiNote, signatureNote]
    .filter(Boolean)
    .join(" ");
}

// ─── Evolution Engine ─────────────────────────────────────────────────────────

export interface PersonalityEvolutionInput {
  currentTraits: PersonalityTraits;
  recentSentiments: number[];     // Array of -1 to 1 sentiment scores
  retentionRate: number;          // 0 to 1
  loyaltyDelta: number;           // Change in loyalty scores
  interactionCount: number;
}

export interface PersonalityEvolutionOutput {
  newTraits: PersonalityTraits;
  evolved: boolean;
  changes: Array<{ trait: keyof PersonalityTraits; delta: number; reason: string }>;
}

/**
 * Evolves personality traits based on interaction outcomes.
 * Uses a rule-based system (not AI) for predictability and auditability.
 * Changes are small (max ±0.02 per evolution cycle) to prevent instability.
 */
export function evolvePersonality(input: PersonalityEvolutionInput): PersonalityEvolutionOutput {
  const { currentTraits, recentSentiments, retentionRate, loyaltyDelta } = input;

  const MAX_DELTA = 0.02;
  const changes: PersonalityEvolutionOutput["changes"] = [];
  const newTraits = { ...currentTraits };

  const avgSentiment =
    recentSentiments.length > 0
      ? recentSentiments.reduce((a, b) => a + b, 0) / recentSentiments.length
      : 0;

  // Rule 1: High positive sentiment → increase agreeableness slightly
  if (avgSentiment > 0.5 && currentTraits.agreeableness < 0.9) {
    const delta = Math.min(MAX_DELTA, (avgSentiment - 0.5) * 0.04);
    newTraits.agreeableness = clamp(currentTraits.agreeableness + delta, 0, 1);
    changes.push({ trait: "agreeableness", delta, reason: "High positive sentiment in recent interactions" });
  }

  // Rule 2: High retention rate → increase extraversion (users want to engage more)
  if (retentionRate > 0.7 && currentTraits.extraversion < 0.85) {
    const delta = Math.min(MAX_DELTA, (retentionRate - 0.7) * 0.06);
    newTraits.extraversion = clamp(currentTraits.extraversion + delta, 0, 1);
    changes.push({ trait: "extraversion", delta, reason: "High user retention indicates engaging personality" });
  }

  // Rule 3: Low retention → experiment with more humor
  if (retentionRate < 0.3 && currentTraits.humor < 0.7) {
    const delta = Math.min(MAX_DELTA, 0.015);
    newTraits.humor = clamp(currentTraits.humor + delta, 0, 1);
    changes.push({ trait: "humor", delta, reason: "Low retention — experimenting with more humor" });
  }

  // Rule 4: Positive loyalty delta → reward with more warmth
  if (loyaltyDelta > 0 && currentTraits.empathy < 0.9) {
    const delta = Math.min(MAX_DELTA, loyaltyDelta * 0.05);
    newTraits.empathy = clamp(currentTraits.empathy + delta, 0, 1);
    changes.push({ trait: "empathy", delta, reason: "Increasing loyalty reflects good emotional connection" });
  }

  const evolved = changes.length > 0;

  return { newTraits, evolved, changes };
}

// ─── Profile Validator ────────────────────────────────────────────────────────

export function validatePersonalityProfile(
  profile: Partial<PersonalityDNA>,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const traitKeys: (keyof PersonalityTraits)[] = [
    "openness", "conscientiousness", "extraversion", "agreeableness",
    "neuroticism", "humor", "empathy", "assertiveness", "creativity",
  ];

  if (profile.traits) {
    for (const key of traitKeys) {
      const val = profile.traits[key];
      if (val === undefined || val === null) {
        errors.push(`Trait '${key}' is required`);
      } else if (val < 0 || val > 1) {
        errors.push(`Trait '${key}' must be between 0 and 1, got ${val}`);
      }
    }
  }

  if (profile.behaviorRules) {
    if (profile.behaviorRules.length > 50) {
      errors.push("Maximum 50 behavior rules allowed");
    }
    for (const [i, rule] of profile.behaviorRules.entries()) {
      if (!rule.trigger || rule.trigger.length > 200) {
        errors.push(`Rule #${i + 1}: trigger must be 1–200 characters`);
      }
      if (!rule.action || rule.action.length > 500) {
        errors.push(`Rule #${i + 1}: action must be 1–500 characters`);
      }
      // Prevent prompt injection in custom rules
      if (containsInjectionPattern(rule.trigger) || containsInjectionPattern(rule.action)) {
        errors.push(`Rule #${i + 1}: contains disallowed patterns`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// Simple injection detection — production would use a more comprehensive scanner
function containsInjectionPattern(text: string): boolean {
  const DISALLOWED = [
    "ignore previous",
    "ignore all",
    "disregard",
    "you are now",
    "system:",
    "assistant:",
    "<|im_start|>",
    "[[",
  ];
  const lower = text.toLowerCase();
  return DISALLOWED.some((p) => lower.includes(p));
}

// ─── Default Profile ──────────────────────────────────────────────────────────

// Import the module itself, not the "@kojyai/shared/highrise" index: that index
// also exports createBot (node crypto), and this file is used by the browser.
export { createDefaultPersonalityProfile } from "@kojyai/shared/highrise/defaultPersonality";

// ─── Utilities ────────────────────────────────────────────────────────────────

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

export function traitToLabel(value: number): string {
  if (value >= 0.8) return "Very High";
  if (value >= 0.6) return "High";
  if (value >= 0.4) return "Moderate";
  if (value >= 0.2) return "Low";
  return "Very Low";
}
