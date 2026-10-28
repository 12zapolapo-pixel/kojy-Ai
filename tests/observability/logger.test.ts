/**
 * tests/observability/logger.test.ts
 *
 * P0-10: Validates the structured logging / observability system.
 *
 * WHAT WE ASSERT:
 *   ✓ Logs are emitted as structured JSON entries
 *   ✓ requestId propagates through all log entries
 *   ✓ Metrics are emitted with correct name/value/unit
 *   ✓ Error classification captures name + message + stack
 *   ✓ Sensitive data is NEVER logged (PII guard)
 *   ✓ Log levels are respected (debug suppressed at info+)
 *   ✓ TestSink captures correctly for test assertions
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  Logger,
  TestSink,
  type LogLevel,
} from "../../packages/shared/src/observability/Logger.js";
import { frozenClock, FROZEN_ISO } from "../helpers/factories.js";
import { expectLogEmitted, expectMetricEmitted, expectNoSensitiveDataInLogs } from "../helpers/assertions.js";

let sink: TestSink;
let logger: Logger;

beforeEach(() => {
  sink = new TestSink();
  // FIX-3: inject frozenClock so all timestamps in this test suite are deterministic
  logger = new Logger("test-service", sink, "debug", frozenClock);
});

// ─── FIX-3: Clock injection ───────────────────────────────────────────────────

describe("clock injection (FIX-3)", () => {
  it("timestamp equals frozenClock output — not wall clock", () => {
    logger.info("clock test", "req-clock-1");
    expect(sink.entries[0]?.timestamp).toBe(FROZEN_ISO);
  });

  it("two log calls with same frozenClock produce identical timestamps", () => {
    logger.info("first", "req-clock-2");
    logger.info("second", "req-clock-3");
    expect(sink.entries[0]?.timestamp).toBe(sink.entries[1]?.timestamp);
  });

  it("child logger inherits injected clock", () => {
    const child = logger.child("sub-service");
    child.info("from child", "req-clock-4");
    expect(sink.entries[0]?.timestamp).toBe(FROZEN_ISO);
  });
});

// ─── FIX-1: PII redaction — raw sensitive data IN, "[REDACTED]" OUT ──────────

describe("PII redaction (FIX-1)", () => {
  // These tests pass raw sensitive values directly to the logger.
  // The logger — NOT the caller — must scrub them before they reach the sink.

  it("password is redacted when passed raw in data payload", () => {
    logger.info("user login", "req-pii-1", {
      userId: "user-001",
      password: "super_secret_password_123",   // raw — caller does NOT pre-scrub
    });
    const entry = sink.entries[0];
    expect(entry?.data?.["password"]).toBe("[REDACTED]");
    expect(entry?.data?.["userId"]).toBe("user-001");  // non-sensitive preserved
  });

  it("token is redacted", () => {
    logger.info("api call", "req-pii-2", {
      token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abc",
    });
    expect(sink.entries[0]?.data?.["token"]).toBe("[REDACTED]");
  });

  it("secret is redacted", () => {
    logger.warn("config loaded", "req-pii-3", { secret: "sk_live_abc123" });
    expect(sink.entries[0]?.data?.["secret"]).toBe("[REDACTED]");
  });

  it("apiKey is redacted (camelCase)", () => {
    logger.info("request", "req-pii-4", { apiKey: "abc-def-ghi" });
    expect(sink.entries[0]?.data?.["apiKey"]).toBe("[REDACTED]");
  });

  it("authorization is redacted (HTTP header key)", () => {
    logger.info("incoming request", "req-pii-5", {
      authorization: "Bearer eyJhbGciOiJIUzI1NiJ9",
    });
    expect(sink.entries[0]?.data?.["authorization"]).toBe("[REDACTED]");
  });

  it("stripeKey is redacted", () => {
    logger.info("billing", "req-pii-6", { stripeKey: "sk_test_abcdef" });
    expect(sink.entries[0]?.data?.["stripeKey"]).toBe("[REDACTED]");
  });

  it("clientSecret is redacted", () => {
    logger.info("oauth", "req-pii-7", { clientSecret: "oauth_client_secret_xyz" });
    expect(sink.entries[0]?.data?.["clientSecret"]).toBe("[REDACTED]");
  });

  it("nested sensitive key inside data object is redacted", () => {
    logger.info("nested", "req-pii-8", {
      user: { id: "u1", password: "nested_secret" },
    });
    const nested = sink.entries[0]?.data?.["user"] as Record<string, unknown> | undefined;
    expect(nested?.["password"]).toBe("[REDACTED]");
    expect(nested?.["id"]).toBe("u1");  // non-sensitive nested field preserved
  });

  it("multiple sensitive keys in one payload are all redacted", () => {
    logger.error("auth failure", "req-pii-9", new Error("invalid"), {
      password: "pass123",
      token: "tok_abc",
      userId: "user-999",
    });
    const data = sink.entries[0]?.data;
    expect(data?.["password"]).toBe("[REDACTED]");
    expect(data?.["token"]).toBe("[REDACTED]");
    expect(data?.["userId"]).toBe("user-999");  // preserved
  });

  it("non-sensitive fields are preserved unchanged", () => {
    logger.info("bot event", "req-pii-10", {
      botId: "bot-001",
      orgId: "org-001",
      eventType: "interaction",
      count: 42,
    });
    const data = sink.entries[0]?.data;
    expect(data?.["botId"]).toBe("bot-001");
    expect(data?.["orgId"]).toBe("org-001");
    expect(data?.["count"]).toBe(42);
  });

  it("raw sensitive data never appears as a string anywhere in the serialised entry", () => {
    const rawPassword = "ultra_secret_password_DO_NOT_LOG";
    logger.info("test", "req-pii-11", { password: rawPassword });
    const serialized = JSON.stringify(sink.entries[0]);
    expect(serialized).not.toContain(rawPassword);
    expect(serialized).toContain("[REDACTED]");
  });

  it("entry with no data payload is unchanged (no false errors)", () => {
    logger.info("no data", "req-pii-12");
    expect(sink.entries[0]?.data).toBeUndefined();
  });
});

// ─── Basic emission ───────────────────────────────────────────────────────────

describe("log emission", () => {
  it("emits an entry for every log call", () => {
    logger.info("hello", "req-001");
    expect(sink.entries).toHaveLength(1);
  });

  it("entry has correct shape: level, service, message, requestId, timestamp", () => {
    logger.warn("something degraded", "req-002", { count: 3 });
    const entry = sink.entries[0];
    expect(entry?.level).toBe("warn");
    expect(entry?.service).toBe("test-service");
    expect(entry?.message).toBe("something degraded");
    expect(entry?.requestId).toBe("req-002");
    expect(entry?.timestamp).toBe(FROZEN_ISO);
  });

  it("data payload is attached (non-sensitive fields)", () => {
    logger.info("test", "req-003", { botId: "bot-001", count: 5 });
    expect(sink.entries[0]?.data).toEqual({ botId: "bot-001", count: 5 });
  });
});

// ─── Error logging ────────────────────────────────────────────────────────────

describe("error classification", () => {
  it("captures error name, message, and stack", () => {
    const err = new Error("db connection failed");
    logger.error("DB error", "req-004", err);
    const entry = sink.entries[0];
    expect(entry?.error?.name).toBe("Error");
    expect(entry?.error?.message).toBe("db connection failed");
    expect(typeof entry?.error?.stack).toBe("string");
  });

  it("fatal level is captured correctly", () => {
    logger.fatal("out of memory", "req-005", new Error("OOM"));
    expect(sink.entries[0]?.level).toBe("fatal");
  });
});

// ─── Metrics ─────────────────────────────────────────────────────────────────

describe("metric emission", () => {
  it("emits metric with name, value, unit", () => {
    logger.metric("prompt_build_ms", 12.5, "ms", "req-006");
    expectMetricEmitted(sink.entries, "prompt_build_ms", "prompt_build_ms metric");
    expect(sink.entries[0]?.metric?.value).toBe(12.5);
    expect(sink.entries[0]?.metric?.unit).toBe("ms");
  });

  it("metric message starts with 'metric:'", () => {
    logger.metric("validation_ms", 3.2, "ms", "req-007");
    expect(sink.entries[0]?.message).toBe("metric:validation_ms");
  });
});

// ─── Level filtering ──────────────────────────────────────────────────────────

describe("level filtering", () => {
  it("debug is suppressed at info level", () => {
    const infoLogger = new Logger("test", sink, "info", frozenClock);
    infoLogger.debug("debug message", "req-008");
    expect(sink.entries).toHaveLength(0);
  });

  it("info passes at info level", () => {
    const infoLogger = new Logger("test", sink, "info", frozenClock);
    infoLogger.info("info message", "req-009");
    expect(sink.entries).toHaveLength(1);
  });

  it("warn and error pass at info level", () => {
    const infoLogger = new Logger("test", sink, "info", frozenClock);
    infoLogger.warn("warn", "req-010");
    infoLogger.error("error", "req-011");
    expect(sink.entries).toHaveLength(2);
  });
});

// ─── TestSink helpers ─────────────────────────────────────────────────────────

describe("TestSink utility methods", () => {
  beforeEach(() => {
    sink.reset();
    logger.debug("d", "r1");
    logger.info("i", "r2");
    logger.warn("w", "r3");
    logger.error("e", "r4", new Error("test"));
    logger.metric("m", 1, "count", "r5");
  });

  it("findByLevel returns correct entries", () => {
    expect(sink.findByLevel("warn")).toHaveLength(1);
    expect(sink.findByLevel("error")).toHaveLength(1);
  });

  it("findByMessage matches substring", () => {
    expect(sink.findByMessage("metric:m")).toHaveLength(1);
  });

  it("hasMetric returns true when metric was emitted", () => {
    expect(sink.hasMetric("m")).toBe(true);
    expect(sink.hasMetric("nonexistent")).toBe(false);
  });

  it("reset() clears all entries", () => {
    sink.reset();
    expect(sink.entries).toHaveLength(0);
  });
});

// ─── expectLogEmitted / expectNoSensitiveDataInLogs helpers ──────────────────

describe("assertion helpers", () => {
  it("expectLogEmitted passes when matching entry exists", () => {
    logger.info("bot evolved", "req-015");
    expect(() =>
      expectLogEmitted(sink.entries, { level: "info", messageContains: "bot evolved" }),
    ).not.toThrow();
  });

  it("expectLogEmitted fails when no matching entry exists", () => {
    expect(() =>
      expectLogEmitted(sink.entries, { level: "fatal", messageContains: "never happened" }),
    ).toThrow();
  });

  it("expectNoSensitiveDataInLogs passes when data is clean", () => {
    logger.info("clean", "req-016", { botId: "bot-001" });
    expect(() =>
      expectNoSensitiveDataInLogs(sink.entries, ["super_secret"], "clean entry"),
    ).not.toThrow();
  });
});

// ─── Basic emission ───────────────────────────────────────────────────────────

describe("log emission", () => {
  it("emits an entry for every log call", () => {
    logger.info("hello", "req-001");
    expect(sink.entries).toHaveLength(1);
  });

  it("entry has correct shape: level, service, message, requestId, timestamp", () => {
    logger.warn("something degraded", "req-002", { count: 3 });
    const entry = sink.entries[0];
    expect(entry?.level).toBe("warn");
    expect(entry?.service).toBe("test-service");
    expect(entry?.message).toBe("something degraded");
    expect(entry?.requestId).toBe("req-002");
    expect(entry?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("data payload is attached to entry", () => {
    logger.info("test", "req-003", { botId: "bot-001", count: 5 });
    expect(sink.entries[0]?.data).toEqual({ botId: "bot-001", count: 5 });
  });
});

// ─── Error logging ────────────────────────────────────────────────────────────

describe("error classification", () => {
  it("captures error name, message, and stack", () => {
    const err = new Error("db connection failed");
    logger.error("DB error", "req-004", err);
    const entry = sink.entries[0];
    expect(entry?.error?.name).toBe("Error");
    expect(entry?.error?.message).toBe("db connection failed");
    expect(typeof entry?.error?.stack).toBe("string");
  });

  it("fatal level is captured correctly", () => {
    logger.fatal("out of memory", "req-005", new Error("OOM"));
    expect(sink.entries[0]?.level).toBe("fatal");
  });
});

// ─── Metrics ─────────────────────────────────────────────────────────────────

describe("metric emission", () => {
  it("emits metric with name, value, unit", () => {
    logger.metric("prompt_build_ms", 12.5, "ms", "req-006");
    expectMetricEmitted(sink.entries, "prompt_build_ms", "prompt_build_ms metric");
    expect(sink.entries[0]?.metric?.value).toBe(12.5);
    expect(sink.entries[0]?.metric?.unit).toBe("ms");
  });

  it("metric message starts with 'metric:'", () => {
    logger.metric("validation_ms", 3.2, "ms", "req-007");
    expect(sink.entries[0]?.message).toBe("metric:validation_ms");
  });
});

// ─── Level filtering ──────────────────────────────────────────────────────────

describe("level filtering", () => {
  it("debug is suppressed at info level", () => {
    const infoLogger = new Logger("test", sink, "info");
    infoLogger.debug("debug message", "req-008");
    expect(sink.entries).toHaveLength(0);
  });

  it("info passes at info level", () => {
    const infoLogger = new Logger("test", sink, "info");
    infoLogger.info("info message", "req-009");
    expect(sink.entries).toHaveLength(1);
  });

  it("warn and error pass at info level", () => {
    const infoLogger = new Logger("test", sink, "info");
    infoLogger.warn("warn", "req-010");
    infoLogger.error("error", "req-011");
    expect(sink.entries).toHaveLength(2);
  });
});

// ─── PII / sensitive data guard (P0-6) ────────────────────────────────────────

describe("PII guard — no sensitive data in logs", () => {
  it("does not log raw injection payload beyond 100 chars", () => {
    const sensitivePayload = "sk_live_" + "x".repeat(200);
    logger.info("request received", "req-012", {
      // In real code: never log raw user content
      // This test verifies our test pattern works
      truncated: sensitivePayload.slice(0, 20),
    });
    expectNoSensitiveDataInLogs(
      sink.entries,
      ["sk_live_" + "x".repeat(50)], // the full key was never logged
      "API key must not appear in full",
    );
  });

  it("does not log passwords or tokens in error data", () => {
    logger.error("auth failed", "req-013", new Error("invalid token"), {
      // Simulates accidentally passing sanitized data
      userId: "user-001",
    });
    // password and raw token must never be in logs
    expectNoSensitiveDataInLogs(sink.entries, ["password", "sk_live"], "sensitive fields");
  });
});

// ─── TestSink helpers ─────────────────────────────────────────────────────────

describe("TestSink utility methods", () => {
  beforeEach(() => {
    logger.debug("d", "r1");
    logger.info("i", "r2");
    logger.warn("w", "r3");
    logger.error("e", "r4", new Error("test"));
    logger.metric("m", 1, "count", "r5");
  });

  it("findByLevel returns correct entries", () => {
    expect(sink.findByLevel("warn")).toHaveLength(1);
    expect(sink.findByLevel("error")).toHaveLength(1);
  });

  it("findByMessage matches substring", () => {
    expect(sink.findByMessage("metric:m")).toHaveLength(1);
  });

  it("hasMetric returns true when metric was emitted", () => {
    expect(sink.hasMetric("m")).toBe(true);
    expect(sink.hasMetric("nonexistent")).toBe(false);
  });

  it("reset() clears all entries", () => {
    sink.reset();
    expect(sink.entries).toHaveLength(0);
  });
});

// ─── Assertion helpers work correctly ─────────────────────────────────────────

describe("expectLogEmitted helper", () => {
  it("passes when matching entry exists", () => {
    logger.info("bot evolved", "req-015");
    expect(() =>
      expectLogEmitted(sink.entries, { level: "info", messageContains: "bot evolved" }),
    ).not.toThrow();
  });

  it("fails when no matching entry exists", () => {
    expect(() =>
      expectLogEmitted(sink.entries, { level: "fatal", messageContains: "never happened" }),
    ).toThrow();
  });
});
