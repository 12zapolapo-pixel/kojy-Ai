/**
 * Log redaction policy — the ONE place that decides what must never be logged.
 * OWNERSHIP: packages/shared/src/logging
 *
 * SECURITY FIX (L-27 / L-28): both services carried their own copy of a pino
 * `redact` path list. Pino paths are (a) case-sensitive, so an `Authorization`
 * header or `API_KEY` field slipped through, and (b) depth-limited — `*.password`
 * matches one level, so `{ body: { user: { password } } }` was logged in clear.
 * And the two copies could (and did) drift.
 *
 * This module is dependency-free and is bound to pino by each service's own
 * logger.ts via `formatters.log`:
 *   - redactSensitive()  recursive, case/format-insensitive key matching
 *                        (password, PASSWORD, api_key, apiKey, x-api-key, newPassword, botToken ...)
 *   - LOG_REDACT_PATHS   the pino fast-path list, kept as a second layer
 */

export const REDACTED = "[REDACTED]";
const MAX_DEPTH = 10;

/** Canonical names. Matching ignores case and every non-alphanumeric character. */
export const SENSITIVE_KEY_NAMES = [
  "password", "passwordHash", "passwd",
  "secret", "clientSecret", "client_secret",
  "token", "accessToken", "access_token", "refreshToken", "refresh_token",
  "apiKey", "api_key", "highriseApiKey", "x-api-key",
  "privateKey", "private_key",
  "stripeKey", "stripe_key", "jwtKey", "jwt_key",
  "authorization", "cookie", "set-cookie",
  "sessionId", "session_id", "sessionid",
] as const;

const normalize = (k: string): string => k.toLowerCase().replace(/[^a-z0-9]/g, "");

const EXACT = new Set(SENSITIVE_KEY_NAMES.map(normalize));
// Suffix rule catches compound names the exact list can't enumerate:
// newPassword, currentPassword, webhookSecret, botToken, stripeApiKey, csrfToken ...
const SUFFIXES = ["password", "passwd", "secret", "token", "apikey", "privatekey", "sessionid", "authorization", "cookie"];

export function isSensitiveKey(key: string): boolean {
  const n = normalize(key);
  return n.length > 0 && (EXACT.has(n) || SUFFIXES.some((s) => n.endsWith(s)));
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Returns `value` with every sensitive-keyed field replaced by "[REDACTED]", at any
 * depth up to MAX_DEPTH. Copy-on-write: untouched subtrees are returned by
 * reference (no allocation on the common path). Only plain objects and arrays are
 * traversed — Errors, Dates, Buffers, Maps and class instances pass through as-is.
 * Deeper than MAX_DEPTH or circular -> a marker string, never the raw value.
 */
export function redactSensitive<T>(value: T): T {
  return walk(value, 0, new WeakSet<object>()) as T;
}

function walk(value: unknown, depth: number, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return "[Truncated]";
    if (ancestors.has(value)) return "[Circular]";
    ancestors.add(value);
    let out: unknown[] | null = null;
    for (let i = 0; i < value.length; i++) {
      const child = walk(value[i], depth + 1, ancestors);
      if (child !== value[i]) { out ??= value.slice(); out[i] = child; }
    }
    ancestors.delete(value);
    return out ?? value;
  }
  if (!isPlainObject(value)) return value;
  if (depth >= MAX_DEPTH) return "[Truncated]";
  if (ancestors.has(value)) return "[Circular]";

  ancestors.add(value);
  let out: Record<string, unknown> | null = null;
  for (const key of Object.keys(value)) {
    const original = (value as Record<string, unknown>)[key];
    let next: unknown;
    if (isSensitiveKey(key) && original !== undefined && original !== null) next = REDACTED;
    else next = walk(original, depth + 1, ancestors);
    if (next !== original) { out ??= { ...(value as Record<string, unknown>) }; out[key] = next; }
  }
  ancestors.delete(value);
  return out ?? value;
}

/** Pino `redact` paths — fast first layer; redactSensitive() is the complete one. */
export const LOG_REDACT_PATHS: string[] = (() => {
  const keys = SENSITIVE_KEY_NAMES as readonly string[];
  return [
    ...keys,
    ...keys.map((k) => `*.${k}`),
    "req.headers.authorization", "req.headers.cookie",
    "headers.authorization", "headers.cookie",
  ];
})();
