/**
 * The key a bot uses to control its own KojyAI Radio station (queue a song,
 * skip). The runner gives it to the bot as KOJY_RADIO_TOKEN; the API checks
 * it. Derived from ENCRYPTION_KEY with its own label, so it is never the
 * encryption key itself and differs per bot.
 * OWNERSHIP: packages/shared/src/crypto
 */

import { createHash, createHmac, timingSafeEqual } from "crypto";

function radioKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) throw new Error("ENCRYPTION_KEY must be set (64 hex characters) for radio tokens.");
  return createHash("sha256").update(`kojy-radio-token:${hex}`).digest();
}

/** The radio key for one bot (by its project uuid). */
export function radioToken(projectUuid: string): string {
  return createHmac("sha256", radioKey()).update(`radio:${projectUuid}`).digest("hex");
}

/** Whether `token` is that bot's radio key (constant-time). */
export function checkRadioToken(projectUuid: string, token: string | undefined | null): boolean {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return false;
  return timingSafeEqual(Buffer.from(radioToken(projectUuid), "hex"), Buffer.from(token, "hex"));
}
