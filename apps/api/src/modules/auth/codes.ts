/**
 * One-time codes (email verification, password reset) and their delivery.
 * OWNERSHIP: apps/api/src/modules/auth
 *
 * Until email is configured (RESEND_API_KEY), codes are written to the API
 * log instead of queued, so a single-owner install still works:
 *   docker compose logs api | grep "code for"
 */

import { randomInt } from "crypto";
import { schema } from "../../db/client.js";
import { enqueue, QUEUE_NAMES } from "../../jobs/queues.js";
import { createLogger } from "../../utils/logger.js";
import type { Database } from "@kojyai/db";

const log = createLogger("auth-codes");

export type CodePurpose = "verify_email" | "password_reset";

const TTL_MS: Record<CodePurpose, number> = {
  verify_email:   24 * 60 * 60_000,
  password_reset: 60 * 60_000,
};

/** Stores a fresh 6-digit code for the user and returns it. */
export async function issueCode(db: Database, userId: number, purpose: CodePurpose): Promise<string> {
  // randomInt is cryptographically secure; Math.random() must never be used here.
  const code = randomInt(100_000, 1_000_000).toString();
  await db.insert(schema.otpCodes).values({
    userId, code, purpose, used: false, expiresAt: new Date(Date.now() + TTL_MS[purpose]),
  });
  return code;
}

/** Codes go to the log only in development or with LOG_EMAIL_CODES=true. */
export function codesMayBeLogged(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.LOG_EMAIL_CODES === "true";
}

/**
 * Emails the code, or logs it when email isn't set up. Never throws: callers
 * return a generic response either way, so failures must not reveal whether
 * an address is registered.
 */
export async function deliverCode(purpose: CodePurpose, email: string, code: string): Promise<void> {
  const base = process.env.APP_URL ?? process.env.FRONTEND_URL ?? "";
  const link = purpose === "password_reset"
    ? `${base}/auth/reset-password?email=${encodeURIComponent(email)}&code=${code}`
    : `${base}/login?verify=${encodeURIComponent(email)}`;

  if (!process.env.RESEND_API_KEY) {
    // SECURITY FIX (V-08): this used to write every live code — including
    // password-reset codes — into the log text (where key-based redaction
    // can't see it) in production too, so anyone who could read the logs
    // could take over any account. Now only in development, or when the
    // operator explicitly opts in for a server without email.
    if (codesMayBeLogged()) {
      log.warn({ purpose, email }, `Email is not configured (RESEND_API_KEY) — ${purpose} code for ${email}: ${code}`);
    } else {
      log.error({ purpose, email }, `A ${purpose} code was issued but email is not configured, so it was NOT sent. Set RESEND_API_KEY (or, temporarily and only if you alone can read the logs, LOG_EMAIL_CODES=true).`);
    }
    return;
  }
  try {
    await enqueue(QUEUE_NAMES.EMAIL_SEND, { type: purpose, email, data: { code, link } });
  } catch (err) {
    log.error({ err, purpose }, "Code email could not be queued");
  }
}
