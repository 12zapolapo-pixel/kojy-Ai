/**
 * @kojyai/shared/observability/Logger
 *
 * P0-10: Structured logging with tracing IDs, metrics hooks, error
 *         classification. Fully injectable for test environments.
 *
 * WHY:
 *   console.log in production is unstructured, unsearchable, and un-alertable.
 *   Every log entry here is a JSON object with:
 *     - requestId (trace correlation)
 *     - service name
 *     - severity
 *     - structured payload
 *   This makes production debugging tractable.
 *
 * TESTING:
 *   Tests inject a LogSink (array collector) instead of writing to stdout.
 *   Tests inject a frozenClock so timestamps are deterministic.
 *   assertLogEmitted() in test helpers verifies specific log entries.
 *
 * NEVER:
 *   - log raw user content (PII)
 *   - log full payloads that contain injection attempts (only first 100 chars)
 *   - log sensitive fields: passwords, tokens, API keys
 *
 * FIX-1:  SENSITIVE_KEYS blocklist — any data key matching this set gets its
 *          value replaced with "[REDACTED]" inside Logger.write() before the
 *          entry ever reaches a sink. Callers do NOT pre-scrub; the logger owns
 *          this guarantee unconditionally.
 * FIX-3:  ClockFn injection — timestamp is produced by an injected clock, not
 *          new Date() directly. Production uses systemClock(); tests inject
 *          frozenClock() for deterministic, replay-safe timestamps.
 */

import type { ClockFn } from "./Clock.js";
import { systemClock } from "./Clock.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface LogEntry {
  readonly level: LogLevel;
  readonly service: string;
  readonly message: string;
  readonly requestId: string;
  readonly timestamp: string;       // ISO 8601
  readonly traceId?: string;
  readonly spanId?: string;
  readonly data?: Record<string, unknown>;
  readonly error?: {
    readonly name: string;
    readonly message: string;
    readonly stack?: string;
    readonly code?: string;
  };
  readonly metric?: {
    readonly name: string;
    readonly value: number;
    readonly unit: "ms" | "count" | "bytes" | "ratio";
  };
}

/** Sink interface — stdout in prod, array in tests */
export interface LogSink {
  write(entry: LogEntry): void;
}

// ─── PII / secrets blocklist (FIX-1) ─────────────────────────────────────────
//
// Any data key whose lowercased name matches an entry here has its value
// replaced with "[REDACTED]" before the entry reaches any sink.
// Logger.write() enforces this unconditionally — callers must NOT pre-scrub.
//
// HOW TO EXTEND: add the canonical lowercase key name. Case is normalised
// inside redactData(), so "Authorization", "AUTHORIZATION", and "authorization"
// all match "authorization".
//
// RULE: Never shrink this list without Security lead sign-off.

const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "api_key",
  "authorization",
  "x-api-key",
  "cookie",
  "sessionid",
  "session_id",
  "privatekey",
  "private_key",
  "stripekey",
  "stripe_key",
  "jwtkey",
  "jwt_key",
  "clientsecret",
  "client_secret",
]);

/**
 * Recursively walks a plain-object data payload and replaces any value
 * whose key matches SENSITIVE_KEYS with the literal string "[REDACTED]".
 *
 * Rules:
 *   - Works on nested objects (walks one level of nesting)
 *   - Never throws — returns the original payload on any unexpected input
 *   - Only processes plain Record<string, unknown>; arrays are left as-is
 */
function redactData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase().replace(/[-_]/g, ""))) {
      result[key] = "[REDACTED]";
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result[key] = redactData(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ─── Default sinks ────────────────────────────────────────────────────────────

export class StdoutSink implements LogSink {
  write(entry: LogEntry): void {
    process.stdout.write(JSON.stringify(entry) + "\n");
  }
}

/** Captures log entries into an in-memory array for test assertions. */
export class TestSink implements LogSink {
  readonly entries: LogEntry[] = [];

  write(entry: LogEntry): void {
    this.entries.push(entry);
  }

  reset(): void {
    this.entries.length = 0;
  }

  findByLevel(level: LogLevel): LogEntry[] {
    return this.entries.filter((e) => e.level === level);
  }

  findByMessage(substring: string): LogEntry[] {
    return this.entries.filter((e) => e.message.includes(substring));
  }

  findByMetricName(name: string): LogEntry[] {
    return this.entries.filter((e) => e.metric?.name === name);
  }

  hasMetric(name: string): boolean {
    return this.findByMetricName(name).length > 0;
  }
}

// ─── Logger ───────────────────────────────────────────────────────────────────

export class Logger {
  // FIX-8: clock must be the function itself (ClockFn = () => Date).
  // systemClock().iso does not exist — systemClock() returns a Date object, not
  // a {iso} helper. Pass systemClock directly; call .toISOString() at write time.
  constructor(
    private readonly service: string,
    private readonly sink: LogSink,
    private readonly minLevel: LogLevel = "info",
    private readonly clock: ClockFn = systemClock,
  ) {}

  private shouldLog(level: LogLevel): boolean {
    const order: LogLevel[] = ["debug", "info", "warn", "error", "fatal"];
    return order.indexOf(level) >= order.indexOf(this.minLevel);
  }

  private write(
    level: LogLevel,
    message: string,
    requestId: string,
    data?: Record<string, unknown>,
    error?: Error,
    metric?: LogEntry["metric"],
  ): void {
    if (!this.shouldLog(level)) return;

    // FIX-1: redactData() strips sensitive keys unconditionally before sink.
    // Callers do NOT pre-scrub — this is the single enforcement point.
    const safeData = data ? redactData(data) : undefined;

    const entry: LogEntry = {
      level,
      service: this.service,
      message,
      requestId,
      timestamp: this.clock().toISOString(), // FIX-8: Date → ISO string
      ...(safeData ? { data: safeData } : {}),
      ...(error
        ? {
            error: {
              name:    error.name,
              message: error.message,
              // exactOptionalPropertyTypes: stack/code are `string | undefined`
              // — must not assign undefined to an optional-but-not-undefined field.
              // Use conditional spread to omit the key when the value is absent.
              ...(error.stack !== undefined ? { stack: error.stack } : {}),
              // FIX-AUDIT: the original re-cast `(error as NodeJS.ErrnoException).code`
              // inside both the condition and the branch — TS doesn't reliably narrow
              // across two separate re-casts of the same expression, only a stable
              // variable reference, so this still failed exactOptionalPropertyTypes.
              // Casting once to a local const makes the narrowing unambiguous.
              ...((() => {
                const code = (error as NodeJS.ErrnoException).code;
                return code !== undefined ? { code } : {};
              })()),
            },
          }
        : {}),
      ...(metric ? { metric } : {}),
    };

    this.sink.write(entry);
  }

  debug(message: string, requestId: string, data?: Record<string, unknown>): void {
    this.write("debug", message, requestId, data);
  }

  info(message: string, requestId: string, data?: Record<string, unknown>): void {
    this.write("info", message, requestId, data);
  }

  warn(message: string, requestId: string, data?: Record<string, unknown>): void {
    this.write("warn", message, requestId, data);
  }

  error(message: string, requestId: string, err?: Error, data?: Record<string, unknown>): void {
    this.write("error", message, requestId, data, err);
  }

  fatal(message: string, requestId: string, err?: Error, data?: Record<string, unknown>): void {
    this.write("fatal", message, requestId, data, err);
  }

  metric(
    name: string,
    value: number,
    unit: NonNullable<LogEntry["metric"]>["unit"], // FIX-8: metric is optional, must unwrap
    requestId: string,
    data?: Record<string, unknown>,
  ): void {
    this.write("info", `metric:${name}`, requestId, data, undefined, { name, value, unit });
  }

  /** Creates a child logger that inherits sink, minLevel, and clock. */
  child(service: string): Logger {
    return new Logger(
      `${this.service}:${service}`,
      this.sink,
      this.minLevel,
      this.clock,          // FIX-3: clock propagates to children
    );
  }
}

// ─── Singleton for production ─────────────────────────────────────────────────

let _globalSink: LogSink = new StdoutSink();

export function setGlobalSink(sink: LogSink): void {
  _globalSink = sink;
}

export function createLogger(
  service: string,
  level: LogLevel = "info",
  clock: ClockFn = systemClock, // FIX-8: pass the function, not systemClock().iso
): Logger {
  return new Logger(service, _globalSink, level, clock);
}

// Re-export ClockFn so consumers can import it from one place
export type { ClockFn };
