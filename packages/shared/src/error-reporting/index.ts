/**
 * Error reporting to Sentry for the Node services, without the Sentry SDK.
 * OWNERSHIP: packages/shared/src/error-reporting
 *
 * Measured 2026-11-03: @sentry/node 11.10 adds ~70 MB to a Node process even
 * with a minimal setup (~23 MB for @sentry/core alone), and the server runs
 * three Node services in ~900 MB. Errors are rare, so this sends Sentry's own
 * event format directly: errors logged at error/fatal level (each service's
 * logger calls reportFromLog) and crashes, with the stack trace, service and
 * module. Log fields go through the shared redaction, and secret-looking text
 * (keys, tokens, passwords in URLs) is masked. No request bodies or headers.
 *
 * Off unless SENTRY_DSN is set. At most 20 events a minute per process, and
 * the same error at most once a minute.
 */

import { redactSensitive } from "../logging/redaction.js";

interface Config {
  dsn: string;
  endpoint: string;
  auth: string;
  service: string;
  environment: string;
  release: string | undefined;
}

interface Frame { function: string; filename: string; abs_path: string; lineno: number; colno: number; in_app: boolean }
interface ExceptionValue { type: string; value: string; stacktrace?: { frames: Frame[] } }
export interface SentryEvent {
  event_id: string;
  timestamp: number;
  platform: "node";
  level: "error" | "fatal";
  logger?: string;
  environment: string;
  release?: string;
  tags: Record<string, string>;
  message?: { formatted: string };
  exception?: { values: ExceptionValue[] };
  extra?: Record<string, unknown>;
}

let config: Config | null = null;
const pending = new Set<Promise<void>>();
const lastSent = new Map<string, number>();
let windowStart = 0;
let sentInWindow = 0;
const MAX_PER_MINUTE = 20;
const SAME_ERROR_GAP_MS = 60_000;

/** Sentry's envelope endpoint and auth header for a DSN, or null if it isn't one. */
export function parseDsn(dsn: string): { endpoint: string; auth: string } | null {
  try {
    const u = new URL(dsn);
    const parts = u.pathname.split("/").filter(Boolean);
    const project = parts.pop();
    if (!u.username || !project || !/^\d+$/.test(project) || !/^https?:$/.test(u.protocol)) return null;
    const prefix = parts.length ? `/${parts.join("/")}` : "";
    return {
      endpoint: `${u.protocol}//${u.host}${prefix}/api/${project}/envelope/`,
      auth: `Sentry sentry_version=7, sentry_key=${u.username}, sentry_client=kojyai-reporter/1.0`,
    };
  } catch {
    return null;
  }
}

/** Turns reporting on for this process when SENTRY_DSN (or `dsn`) is set. Returns whether it's on. */
export function configureErrorReporting(opts: { service: string; dsn?: string; environment?: string; release?: string }): boolean {
  const dsn = (opts.dsn ?? process.env.SENTRY_DSN ?? "").trim();
  const parsed = dsn ? parseDsn(dsn) : null;
  config = parsed
    ? { ...parsed, dsn, service: opts.service, environment: opts.environment ?? process.env.NODE_ENV ?? "production", release: opts.release ?? process.env.KOJY_RELEASE }
    : null;
  return config !== null;
}

export const errorReportingEnabled = (): boolean => config !== null;

const SECRET_SHAPES: [RegExp, string][] = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]"],
  [/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g, "[REDACTED]"], // JWT
  [/\b(?:sk|pk|rk|gsk|csk|ghp|gho|ghs|ghu|github_pat|xox[abpr])[-_][A-Za-z0-9_-]{10,}/g, "[REDACTED]"],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, "[REDACTED]"], // Google API key
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"], // AWS access key id
  [/(\/\/[^/\s:@]+:)[^@\s/]+@/g, "$1[REDACTED]@"], // password in a URL
  [/([?&](?:key|token|secret|password|api_?key|access_token|sig|signature)=)[^&\s"']+/gi, "$1[REDACTED]"],
  [/\b[A-Za-z0-9]{32,}\b/g, "[REDACTED]"], // long random strings (keys without a known prefix)
];

/** Masks text that looks like a secret. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const [re, replacement] of SECRET_SHAPES) out = out.replace(re, replacement);
  return out;
}

const V8_FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/;

/** A V8 stack as Sentry frames, oldest call first (Sentry's order), innermost 50 kept. */
export function stackFrames(stack: string | undefined): Frame[] {
  const frames: Frame[] = [];
  for (const line of (stack ?? "").split("\n")) {
    const m = V8_FRAME.exec(line);
    if (!m) continue;
    const filename = m[2]!.replace(/^file:\/\//, "");
    frames.push({
      function: (m[1] ?? "").replace(/^async /, "") || "<anonymous>",
      filename, abs_path: filename, lineno: Number(m[3]), colno: Number(m[4]),
      in_app: !/node_modules|^node:|^internal\//.test(filename),
    });
  }
  return frames.reverse().slice(-50);
}

function exceptionValues(err: unknown): ExceptionValue[] {
  const values: ExceptionValue[] = [];
  let current: unknown = err;
  // The error and up to two `cause`s; Sentry lists the one finally raised last.
  for (let i = 0; i < 3 && current !== undefined && current !== null; i++) {
    if (current instanceof Error) {
      const frames = stackFrames(current.stack);
      values.unshift({ type: current.name || "Error", value: scrubSecrets(current.message).slice(0, 2000), ...(frames.length ? { stacktrace: { frames } } : {}) });
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      values.unshift({ type: "Error", value: scrubSecrets(typeof current === "string" ? current : safeJson(current)).slice(0, 2000) });
      break;
    }
  }
  return values;
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
}

function scrubDeep(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return scrubSecrets(v).slice(0, 1000);
  if (v instanceof Error) return scrubSecrets(`${v.name}: ${v.message}`);
  if (!v || typeof v !== "object" || depth > 4) return v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => scrubDeep(x, depth + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, 30).map(([k, x]) => [k, scrubDeep(x, depth + 1)]));
}

/** The Sentry event for an error (or, with no error, a logged message). */
export function buildEvent(
  err: unknown,
  opts: { level?: "error" | "fatal"; message?: string; module?: string; extra?: Record<string, unknown> },
  where: { service: string; environment: string; release?: string | undefined },
): SentryEvent {
  return {
    event_id: crypto.randomUUID().replace(/-/g, ""),
    timestamp: Date.now() / 1000,
    platform: "node",
    level: opts.level ?? "error",
    ...(opts.module ? { logger: opts.module } : {}),
    environment: where.environment,
    ...(where.release ? { release: where.release } : {}),
    tags: { service: where.service, ...(opts.module ? { module: opts.module } : {}) },
    ...(opts.message ? { message: { formatted: scrubSecrets(opts.message).slice(0, 1000) } } : {}),
    ...(err !== undefined && err !== null ? { exception: { values: exceptionValues(err) } } : {}),
    ...(opts.extra && Object.keys(opts.extra).length ? { extra: scrubDeep(redactSensitive(opts.extra)) as Record<string, unknown> } : {}),
  };
}

const fingerprint = (e: SentryEvent) => {
  const last = e.exception?.values.at(-1);
  const top = last?.stacktrace?.frames.at(-1);
  return `${e.tags.service}|${last?.type ?? ""}|${last?.value ?? e.message?.formatted ?? ""}|${top ? `${top.filename}:${top.lineno}` : ""}`;
};

/** Sends an error to Sentry (in the background). A no-op when reporting is off. */
export function reportError(
  err: unknown,
  opts: { level?: "error" | "fatal"; message?: string; module?: string; extra?: Record<string, unknown> } = {},
): void {
  const c = config;
  if (!c) return;
  const event = buildEvent(err, opts, c);
  const now = Date.now();
  const fp = fingerprint(event);
  if ((lastSent.get(fp) ?? 0) > now - SAME_ERROR_GAP_MS) return;
  if (now - windowStart > 60_000) { windowStart = now; sentInWindow = 0; }
  if (sentInWindow >= MAX_PER_MINUTE) return;
  sentInWindow++;
  lastSent.set(fp, now);
  if (lastSent.size > 500) lastSent.delete(lastSent.keys().next().value!);
  const body = `${JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString(), dsn: c.dsn })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}\n`;
  const p: Promise<void> = fetch(c.endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-sentry-envelope", "x-sentry-auth": c.auth },
    body,
    signal: AbortSignal.timeout(8000),
  }).then(() => undefined, () => undefined).finally(() => pending.delete(p));
  pending.add(p);
}

/**
 * For each service's pino logger (hooks.logMethod): errors logged at error
 * (50) or fatal (60) level go to Sentry. Pino's call shapes: (obj, msg?) with
 * the error in obj.err / obj.error, (err, msg?) or (msg).
 */
export function reportFromLog(args: unknown[], level: number, module?: string): void {
  if (!config || level < 50) return;
  const [first, second] = args;
  const message = typeof first === "string" ? first : typeof second === "string" ? second : undefined;
  let err: unknown;
  let extra: Record<string, unknown> | undefined;
  if (first instanceof Error) err = first;
  else if (first && typeof first === "object") {
    const { err: e1, error: e2, ...rest } = first as Record<string, unknown>;
    err = e1 ?? e2;
    extra = rest;
  }
  reportError(err, { level: level >= 60 ? "fatal" : "error", ...(message ? { message } : {}), ...(module ? { module } : {}), ...(extra ? { extra } : {}) });
}

/** Waits (up to `timeoutMs`) for reports still being sent — before the process exits. */
export async function flushErrors(timeoutMs = 2000): Promise<void> {
  if (!pending.size) return;
  await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, timeoutMs).unref())]);
}

/**
 * When reporting is on: a crash (uncaught exception or unhandled rejection)
 * is reported, then the process exits with code 1 as Node would have — after
 * at most 2 s for the report to go out.
 */
export function installCrashReporting(): void {
  if (!config) return;
  const crash = (err: unknown, message: string) => {
    reportError(err, { level: "fatal", message });
    console.error(err);
    void flushErrors(2000).finally(() => process.exit(1));
  };
  process.on("uncaughtException", (err) => crash(err, "Uncaught exception"));
  process.on("unhandledRejection", (reason) => crash(reason, "Unhandled promise rejection"));
}

/** For tests. */
export function _resetErrorReportingForTests(): void {
  config = null;
  pending.clear();
  lastSent.clear();
  windowStart = 0;
  sentInWindow = 0;
}
