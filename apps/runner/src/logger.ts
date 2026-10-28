/**
 * Logger — Pino structured logging (runner service)
 * OWNERSHIP: apps/runner
 *
 * L-28: the API and worker each keep their OWN pino instance (so the `service`
 * tag is correct and neither process imports the other), but the redaction
 * POLICY is not defined here — it lives once, in @kojyai/shared/logging, and
 * this file only binds it to pino. Change what gets redacted there, not here.
 * (This replaces two header comments that each claimed to be authoritative.)
 */

import pino from "pino";
import { LOG_REDACT_PATHS, redactSensitive } from "@kojyai/shared/logging";

const isDev = process.env.NODE_ENV !== "production";

const base = pino({
  level:  process.env.LOG_LEVEL ?? (isDev ? "debug" : "info"),
  ...(isDev ? {
    transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" } },
  } : {}),
  base:       { service: "kojyai-runner" },
  timestamp:  pino.stdTimeFunctions.isoTime,
  // L-27: recursive, case-insensitive redaction at any depth (pino's own paths
  // are case-sensitive and one wildcard level deep). Original paths stay as a
  // second, cheap layer.
  formatters: { log: (obj: Record<string, unknown>) => redactSensitive(obj) },
  redact:     LOG_REDACT_PATHS,
});

export function createLogger(module: string) {
  return base.child({ module });
}

export { base as rootLogger };
