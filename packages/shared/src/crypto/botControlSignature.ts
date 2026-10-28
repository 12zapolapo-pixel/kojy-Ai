/**
 * bot_control:* Message Signing — HMAC-SHA256
 * OWNERSHIP: packages/shared/src/crypto
 *
 * SECURITY FIX (C-03, defense-in-depth): handleControlCommand() in
 * apps/api/src/modules/bots/runtime-manager.ts trusts every message on
 * `bot_control:{botUuid}` completely, by design — the API layer is
 * supposed to be the only thing that ever publishes there. That design is
 * only as strong as Redis access control actually is. Requiring
 * REDIS_PASSWORD in production (see apps/api/src/boot.ts and
 * apps/worker/src/boot.ts) is the primary fix; this is the second layer —
 * even a compromised or misconfigured Redis ACL that lets something reach
 * PUBLISH on `bot_control:*` still can't make the runtime manager act on
 * it, because it can't produce a valid signature without ENCRYPTION_KEY.
 *
 * Deliberately reuses ENCRYPTION_KEY (already required, already a real
 * 256-bit secret present in both apps/api's and apps/worker's environment)
 * rather than introducing a new shared secret to provision and rotate.
 * HMAC-SHA256 is a distinct, standard use of that key material (message
 * authentication, not encryption) — using a dedicated derived subkey rather
 * than the raw key directly, so this can never be confused with or
 * substituted for the AES-GCM key used by apiKeys.ts.
 *
 * Every bot_control:* publisher signs; the one subscriber
 * (initBotControlSubscriber in runtime-manager.ts) verifies before acting
 * and drops anything unsigned, expired, or with a bad signature.
 */

import { createHmac, timingSafeEqual, createHash } from "crypto";

const MAX_MESSAGE_AGE_MS = 30_000; // clock skew + normal publish latency tolerance

function getSigningKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "ENCRYPTION_KEY must be set to a 64-character hex string (32 bytes) to sign bot_control messages. " +
      "Generate with: openssl rand -hex 32",
    );
  }
  // Derive a distinct subkey via SHA-256 domain separation — this HMAC key
  // is never the literal AES-GCM key used for API-key encryption.
  return createHash("sha256").update(`bot-control-hmac:${hex}`).digest();
}

export interface BotControlEnvelope {
  action:  string;
  payload?: Record<string, unknown> | undefined;
  ts:      number;
  sig:     string;
}

/** Builds and signs a bot_control message. `ts` is always set here, never trusted from a caller. */
export function signBotControlMessage(
  botUuid: string,
  action:  string,
  payload?: Record<string, unknown>,
): string {
  const ts = Date.now();
  const signable = `${botUuid}:${action}:${JSON.stringify(payload ?? {})}:${ts}`;
  const sig = createHmac("sha256", getSigningKey()).update(signable).digest("hex");
  const envelope: BotControlEnvelope = { action, payload, ts, sig };
  return JSON.stringify(envelope);
}

export type VerifyResult =
  | { ok: true; action: string; payload?: Record<string, unknown> | undefined }
  | { ok: false; reason: "malformed" | "unsigned" | "bad-signature" | "expired" };

/** Verifies a raw bot_control message string. Never throws — always returns a discriminated result. */
export function verifyBotControlMessage(botUuid: string, raw: string): VerifyResult {
  let parsed: Partial<BotControlEnvelope>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (typeof parsed.action !== "string" || typeof parsed.sig !== "string" || typeof parsed.ts !== "number") {
    return { ok: false, reason: "unsigned" };
  }

  if (Math.abs(Date.now() - parsed.ts) > MAX_MESSAGE_AGE_MS) {
    return { ok: false, reason: "expired" };
  }

  let expectedSig: Buffer;
  let actualSig: Buffer;
  try {
    const signable = `${botUuid}:${parsed.action}:${JSON.stringify(parsed.payload ?? {})}:${parsed.ts}`;
    expectedSig = createHmac("sha256", getSigningKey()).update(signable).digest();
    actualSig = Buffer.from(parsed.sig, "hex");
  } catch {
    return { ok: false, reason: "bad-signature" };
  }

  if (expectedSig.length !== actualSig.length || !timingSafeEqual(expectedSig, actualSig)) {
    return { ok: false, reason: "bad-signature" };
  }

  return { ok: true, action: parsed.action, payload: parsed.payload };
}
