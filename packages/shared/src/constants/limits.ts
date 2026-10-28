/**
 * Engine-specific runtime limits
 * Separate from the platform LIMITS in constants/index.ts to avoid name collision.
 * Referenced by packages/engine and tests/chaos.
 */
export const ENGINE_LIMITS = {
  MAX_ASYNC_RETRY_ATTEMPTS:      3,
  MAX_BEHAVIOR_RULES_PER_BOT:    50,
  MAX_RULE_TRIGGER_CHARS:        200,
  MAX_RULE_ACTION_CHARS:         500,
  MAX_MEMORY_SUMMARY_CHARS:      2000,
  MAX_MEMORY_RELATED_ENTITIES:   20,
  RELATIONSHIP_TRUST_MIN:        -1,
  RELATIONSHIP_TRUST_MAX:        1,
  RELATIONSHIP_LOYALTY_MIN:      0,
  RELATIONSHIP_LOYALTY_MAX:      1,
  RELATIONSHIP_AFFINITY_MIN:     -1,
  RELATIONSHIP_AFFINITY_MAX:     1,
  MAX_TRAIT_VALUE:               1,
  MIN_TRAIT_VALUE:               0,
  MAX_LRU_CACHE_SIZE:            1000,
  /** Max tokens fed to the AI during a single dream session */
  DREAM_SESSION_MAX_TOKENS:      600,
  /** Max insights extracted per dream session */
  DREAM_SESSION_MAX_INSIGHTS:    4,
  /** Max personality delta per trait per dream cycle */
  DREAM_SESSION_MAX_DELTA:       0.02,
  /** Max bot scripts per bot (ReactiveEngine) */
  MAX_BOT_SCRIPTS_PER_BOT:       20,
  /** Max VM execution time (ms) for a single ReactiveEngine script tick */
  VM_TICK_TIMEOUT_MS:            50,
} as const;

// Legacy alias — some engine files import LIMITS from here
export { ENGINE_LIMITS as LIMITS };
