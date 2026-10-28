/**
 * GDPR Service — Data Export & Erasure
 * OWNERSHIP: apps/api/src/modules/gdpr
 *
 * Implements GDPR Article 17 (right to erasure) and Article 20 (data portability).
 *
 * This service owns the actual DB queries. The packages/security/src/index.ts
 * exportUserData/deleteUserData functions define the contract; this module
 * implements it using the API's db instance and schema.
 *
 * Audit logs are retained even after deletion (legal obligation).
 * PII in audit logs is replaced with a GDPR-anonymized placeholder.
 *
 * USAGE:
 *   import { exportUserData, eraseUserData } from "./gdpr/service.js"
 *   // Called from the settings router or an admin procedure
 */

import { eq, and, inArray } from "drizzle-orm";
import type { GdprExportData } from "@kojyai/security";
import { schema }   from "../../db/client.js"; // FIX-2: schema re-exported from client.ts
import { enqueue }  from "../../jobs/queues.js";
import { QUEUE_NAMES } from "@kojyai/shared/constants";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("gdpr-service");

// ─── Export (Article 20 — Data Portability) ───────────────────────────────────

export async function exportUserData(
  db:     any,
  userId: number,
): Promise<GdprExportData> {
  log.info({ userId }, "GDPR export requested");

  const [user] = await db
    .select({
      id:          schema.users.id,
      uuid:        schema.users.uuid,
      email:       schema.users.email,
      username:    schema.users.username,
      displayName: schema.users.displayName,
      avatarUrl:   schema.users.avatarUrl,
      role:        schema.users.role,
      tier:        schema.users.tier,
      locale:      schema.users.locale,
      timezone:    schema.users.timezone,
      createdAt:   schema.users.createdAt,
      lastLoginAt: schema.users.lastLoginAt,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  if (!user) throw new Error(`User ${userId} not found`);

  // Resolve all org IDs and bot IDs owned by this user — used to scope every
  // subsequent query correctly. This is the single authoritative scope resolution.
  const orgMemberships = await db
    .select({ orgId: schema.orgMembers.orgId })
    .from(schema.orgMembers)
    .where(eq(schema.orgMembers.userId, userId));

  const orgIds  = orgMemberships.map((m: { orgId: number }) => m.orgId);
  const userBotRows = await db
    .select({ id: schema.bots.id })
    .from(schema.bots)
    .where(eq(schema.bots.ownerId, userId));
  const botIds = userBotRows.map((b: { id: number }) => b.id);

  // Fetch all data in parallel
  const [bots, memories, interactions, auditLogs, relationships] = await Promise.all([
    // Bots owned directly by this user
    db.select({
      uuid:        schema.bots.uuid,
      name:        schema.bots.name,
      status:      schema.bots.status,
      runtimeMode: schema.bots.runtimeMode,
      createdAt:   schema.bots.createdAt,
      // NOTE: highriseApiKey is intentionally excluded from GDPR export
      // (it is a third-party secret, not personal data)
    })
      .from(schema.bots)
      .where(eq(schema.bots.ownerId, userId)),

    // BUG-GDPR-1 FIX: memories were scoped with botMemories.orgId == user.id
    // (user ID ≠ org ID). Now correctly scoped through the user's owned bots.
    botIds.length > 0
      ? db.select({
          type:      schema.botMemories.type,
          summary:   schema.botMemories.summary,
          createdAt: schema.botMemories.createdAt,
        })
          .from(schema.botMemories)
          .where(inArray(schema.botMemories.botId, botIds))
          .limit(5_000)
      : Promise.resolve([]),

    // Interactions where this user was the human participant
    db.select({
      role:      schema.interactions.role,
      content:   schema.interactions.content,
      createdAt: schema.interactions.createdAt,
    })
      .from(schema.interactions)
      .where(eq(schema.interactions.userId, userId))
      .limit(10_000),

    // Audit log entries initiated by this user
    db.select({
      action:       schema.auditLogs.action,
      resourceType: schema.auditLogs.resourceType,
      createdAt:    schema.auditLogs.createdAt,
    })
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.actorId, userId))
      .limit(1_000),

    // BUG-GDPR-2 FIX: relationships had NO filter at all — returned up to 5,000
    // rows from every bot in the system. Now correctly scoped to user-owned bots.
    botIds.length > 0
      ? db.select({
          targetId:         schema.botRelationships.targetId,
          type:             schema.botRelationships.type,
          trust:            schema.botRelationships.trust,
          affinity:         schema.botRelationships.affinity,
          interactionCount: schema.botRelationships.interactionCount,
        })
          .from(schema.botRelationships)
          .where(inArray(schema.botRelationships.botId, botIds))
          .limit(5_000)
      : Promise.resolve([]),
  ]);

  log.info({
    userId,
    bots:          bots.length,
    memories:      memories.length,
    interactions:  interactions.length,
    auditLogs:     auditLogs.length,
    relationships: relationships.length,
  }, "GDPR export compiled");

  return {
    user: {
      ...user,
      exportedAt: new Date().toISOString(),
      note: "This export contains all personal data KOJYAI holds for your account.",
    },
    bots,
    memories,
    interactions,
    auditLogs,
    relationships,
  };
}

// ─── Erase (Article 17 — Right to Erasure) ────────────────────────────────────

export async function eraseUserData(
  db:     any,
  userId: number,
): Promise<void> {
  log.info({ userId }, "GDPR erasure starting");

  const ANONYMOUS_PLACEHOLDER = "[deleted]";
  const ANONYMOUS_EMAIL       = `deleted-${userId}@gdpr.kojyai.com`;

  // SECURITY/COMPLIANCE FIX (H-07): capture the real email BEFORE
  // anonymizing so the confirmation email (sent after the transaction
  // commits, below) can actually reach the user — mirrors exactly what the
  // old step-8 comment claimed happened but never did.
  const [userBeforeErasure] = await db
    .select({ email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const realEmail = userBeforeErasure?.email;

  let stripeSubToCancel: string | null = null;

  // SECURITY/COMPLIANCE FIX (H-07): the whole erasure is now one DB
  // transaction. Previously each of these eight steps ran independently —
  // if step 4 (say) threw after steps 1–3 had already committed, the user
  // would be left in a half-erased, inconsistent state (anonymized profile,
  // but memories/relationships/interactions/sessions still present) with no
  // way to detect or recover from that short of manual DB inspection.
  await db.transaction(async (tx: any) => {
    // 1. Anonymize the user record — retain row for FK integrity but remove all PII
    await tx
      .update(schema.users)
      .set({
        email:        ANONYMOUS_EMAIL,
        username:     `${ANONYMOUS_PLACEHOLDER}-${userId}`,
        displayName:  ANONYMOUS_PLACEHOLDER,
        avatarUrl:    null,
        passwordHash: "[GDPR-ERASED]",
        status:       "suspended",
        stripeCustomerId: null,
        lastLoginIp:  null,
      })
      .where(eq(schema.users.id, userId));

    // 2. Delete bot memories (high-PII content)
    const userBots = await tx
      .select({ id: schema.bots.id })
      .from(schema.bots)
      .where(eq(schema.bots.ownerId, userId));

    for (const bot of userBots) {
      await tx.delete(schema.botMemories).where(eq(schema.botMemories.botId, bot.id));
      await tx.delete(schema.botRelationships).where(eq(schema.botRelationships.botId, bot.id));
    }

    // 3. Delete user interactions (message content)
    await tx.delete(schema.interactions).where(eq(schema.interactions.userId, userId));

    // 4. Delete sessions
    await tx.delete(schema.sessions).where(eq(schema.sessions.userId, userId));

    // 5. Delete OTP codes
    await tx.delete(schema.otpCodes).where(eq(schema.otpCodes.userId, userId));

    // 6. NOTE (bug found via live end-to-end testing, first time this code
    // path had ever actually executed): audit_logs.actorId is NOT NULL by
    // deliberate schema design (see schema.ts's own comment on that
    // column) — unlike security_events.actorId, which is nullable. The
    // original version of this step tried to set actorId: null here, which
    // the DB has never actually permitted, and separately tried to set
    // actorType: "deleted_user" (12 characters) into a varchar(10) column.
    // Both were unreachable/broken. Neither is actually needed: step 1
    // above anonymizes the user row IN PLACE (same id, PII scrubbed) rather
    // than deleting it, specifically to preserve FK integrity — so
    // audit_logs.actorId already points at a row with no recoverable PII
    // once step 1 has run. No further action is needed here.

    // 7. Resolve (but don't yet enqueue — see below) any active subscription
    // to cancel. We resolve it inside the transaction so we're reading a
    // consistent snapshot, but the actual queue enqueue happens AFTER the
    // transaction commits (queueing is not transactional with MySQL, and
    // enqueueing a cancellation for a user whose erasure then rolls back
    // would be its own bug).
    const [sub] = await tx
      .select({ stripeSubscriptionId: schema.subscriptions.stripeSubscriptionId })
      .from(schema.subscriptions)
      .innerJoin(schema.orgMembers, eq(schema.subscriptions.orgId, schema.orgMembers.orgId))
      .where(and(
        eq(schema.orgMembers.userId, userId),
        eq(schema.subscriptions.status, "active"),
      ))
      .limit(1);

    if (sub?.stripeSubscriptionId) {
      stripeSubToCancel = sub.stripeSubscriptionId;
    }

    log.info({
      userId,
      botsAnonymized:  userBots.length,
      memoriesDeleted: true,
      sessionsCleared: true,
    }, "GDPR erasure transaction committing");
  });

  // Post-commit side effects — only reached if the transaction above fully
  // succeeded. Both queued as fire-and-forget; a failure here means a retry
  // of the email/cancellation, never a retry of the erasure itself.
  if (stripeSubToCancel) {
    // M-11: erasure is already committed and cannot be rolled back, so a queue
    // failure is logged at error level (a live Stripe subscription now belongs
    // to an anonymized user and needs manual cancellation) rather than thrown.
    try {
      await enqueue(QUEUE_NAMES.EMAIL_SEND, {
        type:  "gdpr_cancel_stripe",
        data:  { subscriptionId: stripeSubToCancel },
        email: ANONYMOUS_EMAIL,
      });
    } catch (err) {
      log.error({ err, userId, subscriptionId: stripeSubToCancel }, "GDPR erasure: Stripe cancellation could not be queued — CANCEL MANUALLY");
    }
  }

  // SECURITY/COMPLIANCE FIX (H-07): the confirmation email is now real —
  // sent to the address captured before anonymization, using the
  // "gdpr_erasure_confirmed" template added in apps/worker's email processor.
  if (realEmail) {
    try {
      await enqueue(QUEUE_NAMES.EMAIL_SEND, {
        type:  "gdpr_erasure_confirmed",
        data:  {},
        email: realEmail,
      });
    } catch (err) {
      log.error({ err, userId }, "GDPR erasure: confirmation email could not be queued");
    }
  } else {
    log.warn({ userId }, "GDPR erasure: no email on file to send confirmation to");
  }

  log.info({
    userId,
    auditLogsRetained: true,
  }, "GDPR erasure complete");
}
