/**
 * @kojyai/shared/policy/PolicyEngine
 *
 * P0-6:  Replaces scattered validation with a single security policy gate.
 * P2-17: Centralized, versioned, auditable rules — all security/AI/RBAC
 *         limits flow through here.
 *
 * WHY THIS EXISTS:
 *   Scattered validation means rules drift, get duplicated, or get skipped.
 *   A policy engine makes every rule:
 *     - visible in one place
 *     - versioned (breaking changes are explicit)
 *     - auditable (every rejection is a structured PolicyViolation)
 *     - testable in isolation
 *
 * RULES FOR ADDING POLICIES:
 *   1. Add the rule constant to POLICY_VERSION or a new version block.
 *   2. Implement the check function — PURE, no I/O.
 *   3. Add a test in tests/security/policy-engine.test.ts.
 *   4. Bump POLICY_VERSION.
 *
 * CHANGING A RULE:
 *   Requires PR review from Security lead + Platform Core lead.
 */

import { LIMITS } from "../constants/limits.js";

// ─── Versioning ───────────────────────────────────────────────────────────────

export const POLICY_VERSION = "1.0.0";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PolicyViolation {
  readonly rule: string;
  readonly message: string;
  readonly severity: "error" | "warning";
  readonly field?: string;
  readonly value?: unknown;
}

export interface PolicyResult {
  readonly allowed: boolean;
  readonly violations: readonly PolicyViolation[];
  readonly policyVersion: string;
}

// ─── Injection pattern registry ───────────────────────────────────────────────
// Every pattern here is a documented attack vector with a reference.

const INJECTION_PATTERNS: ReadonlyArray<{ pattern: RegExp; name: string }> = [
  // Standard ASCII injection
  { pattern: /ignore\s+previous/i,        name: "IGNORE_PREVIOUS" },
  { pattern: /you\s+are\s+now/i,          name: "YOU_ARE_NOW" },
  { pattern: /system\s*:/i,               name: "SYSTEM_COLON" },
  { pattern: /\bdan\b/i,                  name: "DAN_MODE" },
  { pattern: /disregard\s+(all|any)/i,    name: "DISREGARD_ALL" },
  { pattern: /act\s+as\b/i,              name: "ACT_AS" },
  { pattern: /roleplay\s+as/i,           name: "ROLEPLAY_AS" },
  { pattern: /jailbreak/i,               name: "JAILBREAK" },
  { pattern: /bypass\s+(safety|filter)/i, name: "BYPASS_SAFETY" },

  // Unicode homoglyph attacks (Cyrillic/Greek lookalikes)
  // і = U+0456 (Cyrillic і), о = U+043E, е = U+0435 etc.
  { pattern: /[\u0456\u04CF\u0131]\s*g\s*n\s*o\s*r\s*e/i, name: "HOMOGLYPH_IGNORE" },

  // Invisible / directional control characters
  // RTL Override U+202E, LTR Override U+202D, zero-width U+200B/C/D, BOM U+FEFF
  { pattern: /[\u202E\u202D\u200B\u200C\u200D\uFEFF]/, name: "INVISIBLE_CHARS" },

  // Null bytes
  { pattern: /\x00/, name: "NULL_BYTE" },

  // JSON escape poisoning — \\u0000 in a string is an encoded null byte
  { pattern: /\\u0000/, name: "JSON_NULL_ESCAPE" },

  // REMOVED: /\}\s*,\s*"role"\s*:\s*"system"/ — regex bypassed by whitespace,
  // encoding, or key ordering variants. Replaced by structuralJsonRoleCheck()
  // below, which parses the string as JSON and walks the tree.

  // Markdown exploitation
  { pattern: /```\s*(system|prompt|instruction)/i, name: "MARKDOWN_BLOCK_EXPLOIT" },

  // Token flooding — 500+ repeated chars is always an attack
  { pattern: /.{501}/, name: "TOKEN_FLOOD" },
] as const;

// ─── Structural JSON role check (FIX-5) ──────────────────────────────────────
//
// WHY: The old regex  /\}\s*,\s*"role"\s*:\s*"system"/  was bypassed by:
//   - Extra whitespace:  {"role" :  "system"}
//   - Unicode escapes:   {"role": "\u0073ystem"}
//   - Key reordering:    {"content": "x", "role": "system"}
//   - Encoded braces:    [{"role":"system"}]
//
// The structural check attempts JSON.parse() on the entire input. If it
// succeeds and the result contains ANY object with a "role" key whose value
// is a dangerous string ("system", "admin", "assistant"), it's rejected.
// If parse fails (not valid JSON), the input is left to regex checks above.

const DANGEROUS_ROLES: ReadonlySet<string> = new Set([
  "system", "admin", "assistant", "tool",
]);

/**
 * Recursively walks a parsed JSON value and returns true if any object
 * node has a "role" key with a value in DANGEROUS_ROLES.
 */
function containsDangerousRole(node: unknown, depth = 0): boolean {
  // Cap recursion depth to prevent stack overflow on adversarial input
  if (depth > 10) return false;
  if (node === null || typeof node !== "object") return false;
  if (Array.isArray(node)) {
    return node.some((item) => containsDangerousRole(item, depth + 1));
  }
  const record = node as Record<string, unknown>;
  if (
    "role" in record &&
    typeof record["role"] === "string" &&
    DANGEROUS_ROLES.has(record["role"].toLowerCase())
  ) {
    return true;
  }
  return Object.values(record).some((v) => containsDangerousRole(v, depth + 1));
}

/**
 * Returns a PolicyViolation if the string parses as JSON containing a
 * dangerous "role" field — structural detection that regex cannot provide.
 */
function checkStructuralJsonRole(value: string, field: string): PolicyViolation | null {
  // Only attempt parse if the string looks JSON-like (starts with { or [)
  const trimmed = value.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null; // Not valid JSON — regex patterns handle it
  }

  if (containsDangerousRole(parsed)) {
    return {
      rule: "JSON_ROLE_POISON",
      message: `Field '${field}' contains JSON with a dangerous 'role' key`,
      severity: "error",
      field,
      value: value.slice(0, 100),
    };
  }
  return null;
}

// ─── Policy checks (pure functions) ──────────────────────────────────────────

/**
 * Checks a string for injection attack patterns.
 * Returns all matching violations — does NOT short-circuit.
 *
 * Runs both:
 *   1. Regex pattern registry (fast, catches most vectors)
 *   2. Structural JSON role check (FIX-5 — catches what regex misses)
 */
export function checkInjection(
  value: string,
  field: string,
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];

  for (const { pattern, name } of INJECTION_PATTERNS) {
    if (pattern.test(value)) {
      violations.push({
        rule: `INJECTION_${name}`,
        message: `Field '${field}' matches injection pattern '${name}'`,
        severity: "error",
        field,
        value: value.slice(0, 100), // never log full payload
      });
    }
  }

  // FIX-5: structural JSON role detection — catches bypass variants
  const jsonViolation = checkStructuralJsonRole(value, field);
  if (jsonViolation !== null) violations.push(jsonViolation);

  return violations;
}

/**
 * Checks a numeric trait value is finite and in [0, 1].
 */
export function checkTraitValue(
  value: unknown,
  field: string,
): PolicyViolation[] {
  if (typeof value !== "number") {
    return [{
      rule: "TRAIT_NOT_NUMBER",
      message: `Trait '${field}' must be a number, got ${typeof value}`,
      severity: "error",
      field,
      value,
    }];
  }
  if (!Number.isFinite(value)) {
    return [{
      rule: "TRAIT_NOT_FINITE",
      message: `Trait '${field}' must be finite, got ${String(value)}`,
      severity: "error",
      field,
      value,
    }];
  }
  if (value < 0 || value > 1) {
    return [{
      rule: "TRAIT_OUT_OF_RANGE",
      message: `Trait '${field}' must be in [0, 1], got ${value}`,
      severity: "error",
      field,
      value,
    }];
  }
  return [];
}

/**
 * Checks a relationship numeric value against its allowed range.
 */
export function checkRelationshipValue(
  value: unknown,
  field: string,
  min: number,
  max: number,
): PolicyViolation[] {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return [{
      rule: "RELATIONSHIP_NON_FINITE",
      message: `Relationship field '${field}' must be finite, got ${String(value)}`,
      severity: "error",
      field,
      value,
    }];
  }
  if (value < min || value > max) {
    return [{
      rule: "RELATIONSHIP_OUT_OF_RANGE",
      message: `Relationship '${field}' must be in [${min}, ${max}], got ${value}`,
      severity: "error",
      field,
      value,
    }];
  }
  return [];
}

/**
 * Checks a string field for byte budget compliance.
 */
export function checkStringBudget(
  value: unknown,
  field: string,
  maxChars: number,
): PolicyViolation[] {
  if (typeof value !== "string") {
    return [{
      rule: "NOT_STRING",
      message: `Field '${field}' must be a string`,
      severity: "error",
      field,
    }];
  }
  if (value.length === 0) {
    return [{
      rule: "EMPTY_STRING",
      message: `Field '${field}' must not be empty`,
      severity: "error",
      field,
    }];
  }
  if (value.length > maxChars) {
    return [{
      rule: "STRING_TOO_LONG",
      message: `Field '${field}' exceeds ${maxChars} chars (got ${value.length})`,
      severity: "error",
      field,
      value: value.length,
    }];
  }
  return [];
}

/**
 * Checks array count against a hard limit.
 */
export function checkArrayLimit(
  arr: unknown[],
  field: string,
  max: number,
): PolicyViolation[] {
  if (arr.length > max) {
    return [{
      rule: "ARRAY_LIMIT_EXCEEDED",
      message: `Field '${field}' exceeds max count ${max} (got ${arr.length})`,
      severity: "error",
      field,
      value: arr.length,
    }];
  }
  return [];
}

/**
 * Checks a financial value: must be finite and non-negative.
 */
export function checkFinancialValue(
  value: unknown,
  field: string,
): PolicyViolation[] {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return [{
      rule: "FINANCIAL_NON_FINITE",
      message: `Financial field '${field}' must be finite, got ${String(value)}`,
      severity: "error",
      field,
      value,
    }];
  }
  if (value < 0) {
    return [{
      rule: "FINANCIAL_NEGATIVE",
      message: `Financial field '${field}' must be >= 0, got ${value}`,
      severity: "error",
      field,
      value,
    }];
  }
  return [];
}

// ─── Composite policy runners ─────────────────────────────────────────────────

export interface BehaviorRuleInput {
  trigger: string;
  action: string;
  priority: number;
  isActive: boolean;
}

/**
 * Full policy check for a behavior rule.
 * Validates ALL rules regardless of isActive — dormant injection prevention.
 */
export function evaluateRulePolicy(
  rule: BehaviorRuleInput,
  index: number,
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const prefix = `behaviorRules[${index}]`;

  violations.push(
    ...checkStringBudget(rule.trigger, `${prefix}.trigger`, LIMITS.MAX_RULE_TRIGGER_CHARS),
    ...checkStringBudget(rule.action, `${prefix}.action`, LIMITS.MAX_RULE_ACTION_CHARS),
    ...checkInjection(rule.trigger, `${prefix}.trigger`),
    ...checkInjection(rule.action, `${prefix}.action`),
  );

  if (!Number.isFinite(rule.priority) || rule.priority < 1 || rule.priority > 10) {
    violations.push({
      rule: "INVALID_PRIORITY",
      message: `${prefix}.priority must be 1–10`,
      severity: "error",
      field: `${prefix}.priority`,
      value: rule.priority,
    });
  }

  return violations;
}

/**
 * Full policy evaluation for a personality profile.
 * Returns a PolicyResult with policyVersion for auditability.
 */
export function evaluatePersonalityPolicy(input: {
  traits: Record<string, unknown>;
  behaviorRules: BehaviorRuleInput[];
}): PolicyResult {
  const violations: PolicyViolation[] = [];

  // Trait checks
  const traitKeys = [
    "openness", "conscientiousness", "extraversion", "agreeableness",
    "neuroticism", "humor", "empathy", "assertiveness", "creativity",
  ];
  for (const key of traitKeys) {
    violations.push(...checkTraitValue(input.traits[key], `traits.${key}`));
  }

  // Rule count check
  violations.push(
    ...checkArrayLimit(input.behaviorRules, "behaviorRules", LIMITS.MAX_BEHAVIOR_RULES_PER_BOT),
  );

  // Individual rule checks — ALL rules, active or not
  for (let i = 0; i < input.behaviorRules.length; i++) {
    const rule = input.behaviorRules[i];
    if (rule) violations.push(...evaluateRulePolicy(rule, i));
  }

  return {
    allowed: violations.length === 0,
    violations,
    policyVersion: POLICY_VERSION,
  };
}

/**
 * Evaluates memory write policy: size, injection, field sanity.
 */
export function evaluateMemoryWritePolicy(input: {
  summary: string;
  importance: unknown;
  relatedEntities: unknown[];
}): PolicyResult {
  const violations: PolicyViolation[] = [];

  violations.push(
    ...checkStringBudget(input.summary, "summary", LIMITS.MAX_MEMORY_SUMMARY_CHARS),
    ...checkInjection(input.summary, "summary"),
    ...checkTraitValue(input.importance, "importance"),  // [0,1]
    ...checkArrayLimit(input.relatedEntities, "relatedEntities", LIMITS.MAX_MEMORY_RELATED_ENTITIES),
  );

  return { allowed: violations.length === 0, violations, policyVersion: POLICY_VERSION };
}
