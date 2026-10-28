/**
 * Migration Script: Encrypt plaintext Highrise API keys at rest
 * OWNERSHIP: apps/api/src/scripts
 *
 * Run ONCE after deploying the encryption change:
 *   npx tsx apps/api/src/scripts/migrate-encrypt-api-keys.ts
 *
 * PREREQUISITES:
 *   - ENCRYPTION_KEY env var must be set (same value that will be used in prod)
 *   - DATABASE_URL env var must be set
 *   - Take a DB backup before running
 *
 * What it does:
 *   1. Selects all bots with highriseApiKey values
 *   2. Encrypts plaintext values in-place
 *   3. L-26 / KEY ROTATION: re-encrypts values that are encrypted under an OLD key
 *      (anything not under the current ENCRYPTION_KEY_ID) with the current key
 *   4. Reports counts (migrated / rotated / already-current / errors)
 *
 * Idempotent: safe to run multiple times — won't double-encrypt.
 */

import "dotenv/config";
import { eq }      from "drizzle-orm";
import { createDb } from "@kojyai/db";
import * as schema from "../db/schemas/schema.js";
import { migrateKey, isEncrypted, needsReencryption, reencryptApiKey } from "@kojyai/shared/crypto";

async function main() {
  const { db, pool } = await createDb({
    url: process.env.DATABASE_URL!,
    max: 1,
    log: { info: (m) => console.log(m), warn: (o, m) => console.warn(m ?? "", o) },
  });

  console.log("🔍 Scanning bot API keys for plaintext values...");

  const bots = await db
    .select({ id: schema.bots.id, highriseApiKey: schema.bots.highriseApiKey })
    .from(schema.bots);

  let migrated = 0;
  let rotated  = 0;
  let skipped  = 0;
  let errors   = 0;

  for (const bot of bots) {
    try {
      if (isEncrypted(bot.highriseApiKey)) {
        if (!needsReencryption(bot.highriseApiKey)) { skipped++; continue; }
        // Encrypted under a retired key (or legacy format after ENCRYPTION_KEY_ID was set).
        // reencryptApiKey() decrypts with the matching key first, so a wrong/missing
        // previous key surfaces here as an error instead of silently losing the value.
        await db.update(schema.bots).set({ highriseApiKey: reencryptApiKey(bot.highriseApiKey) }).where(eq(schema.bots.id, bot.id));
        rotated++;
        continue;
      }

      const encrypted = migrateKey(bot.highriseApiKey);

      await db
        .update(schema.bots)
        .set({ highriseApiKey: encrypted })
        .where(eq(schema.bots.id, bot.id));

      migrated++;
    } catch (err) {
      console.error(`  ❌ Failed to migrate bot ${bot.id}:`, err);
      errors++;
    }
  }

  console.log(`\n✅ Migration complete:`);
  console.log(`   Migrated : ${migrated} (plaintext -> encrypted)`);
  console.log(`   Rotated  : ${rotated} (old key -> current key)`);
  console.log(`   Skipped  : ${skipped} (already under the current key)`);
  console.log(`   Errors   : ${errors}`);

  if (errors > 0) {
    console.log("\n⚠️  Some keys failed — check logs above. Do NOT deploy until all keys are encrypted.");
    process.exit(1);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
