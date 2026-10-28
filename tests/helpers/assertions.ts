/**
 * tests/helpers/assertions.ts
 * Custom assertion helpers used across all 8 uploaded test files.
 */

import { expect } from "vitest";
import type { LogEntry } from "../../packages/shared/src/observability/Logger.js";

// ─── Log assertions ───────────────────────────────────────────────────────────

/**
 * Asserts at least one log entry matches the criteria (level and/or message substring).
 * Takes the entries array (`sink.entries`) — that is how every caller uses it; this
 * helper previously expected the whole sink plus positional args and threw
 * "sink.entries.find is not a function" for all of them.
 */
export function expectLogEmitted(
  entries:  readonly LogEntry[],
  criteria: { level?: string; messageContains?: string },
  label = "log entry",
): void {
  const match = entries.find(
    (e) =>
      (criteria.level === undefined || e.level === criteria.level) &&
      (criteria.messageContains === undefined || String(e.message).includes(criteria.messageContains)),
  );
  expect(
    match,
    `Expected ${label}: ${JSON.stringify(criteria)}.\nActual entries:\n${JSON.stringify(entries, null, 2)}`,
  ).toBeDefined();
}

/**
 * Asserts a metric with this name was emitted (metrics are log entries carrying a
 * `metric` payload). Optionally checks the value.
 */
export function expectMetricEmitted(
  entries:    readonly LogEntry[],
  metricName: string,
  label = `metric "${metricName}"`,
  value?:     number,
): void {
  const match = entries.find((e) => (e as any).metric?.name === metricName);
  expect(
    match,
    `Expected ${label} to be emitted.\nActual entries:\n${JSON.stringify(entries, null, 2)}`,
  ).toBeDefined();
  if (value !== undefined) expect((match as any).metric.value, `Expected ${label} to have value ${value}`).toBe(value);
}

/**
 * Asserts none of the forbidden strings appear anywhere in the serialized log
 * entries. With no list given, falls back to generic sensitive-data patterns.
 */
export function expectNoSensitiveDataInLogs(
  entries:    readonly LogEntry[],
  forbidden?: readonly string[],
  label = "log output",
): void {
  const GENERIC = [
    /password/i, /passwordHash/i, /apiKey/i, /highriseApiKey/i, /secret/i, /token(?!ize)/i,
    /credit.?card/i, /ssn/i, /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,
  ];
  for (const entry of entries) {
    const serialized = JSON.stringify(entry);
    for (const f of forbidden ?? []) {
      expect(serialized.includes(f), `${label}: forbidden string "${f}" found in log entry: ${serialized}`).toBe(false);
    }
    if (!forbidden) for (const pattern of GENERIC) {
      expect(pattern.test(serialized), `${label}: sensitive data matching ${pattern} found: ${serialized}`).toBe(false);
    }
  }
}

// ─── Value assertions ─────────────────────────────────────────────────────────

/**
 * Asserts a number is within [min, max] inclusive.
 */
export function expectClampedRange(
  value: number,
  min:   number,
  max:   number,
  label = "value",
): void {
  expect(value, `${label} ${value} must be ≥ ${min}`).toBeGreaterThanOrEqual(min);
  expect(value, `${label} ${value} must be ≤ ${max}`).toBeLessThanOrEqual(max);
}

/**
 * Asserts a number is finite and not NaN.
 */
export function expectFiniteNumber(value: number, label = "value"): void {
  expect(Number.isFinite(value), `${label} must be finite, got ${value}`).toBe(true);
  expect(Number.isNaN(value),    `${label} must not be NaN`).toBe(false);
}
