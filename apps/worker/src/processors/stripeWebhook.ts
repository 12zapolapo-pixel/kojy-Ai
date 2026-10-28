/**
 * Stripe Webhook Processor
 * OWNERSHIP: apps/worker/src/processors
 *
 * Processes enqueued Stripe webhook events durably.
 * The API handler receives the raw Stripe event, verifies the signature,
 * persists the raw event, then enqueues this job — ensuring Stripe gets
 * a fast 200 response and we process asynchronously with full retry logic.
 *
 * RETRY STRATEGY: CRITICAL_JOB_OPTIONS (5 attempts, 2min fixed backoff)
 * Billing events must not be dropped — Stripe has a 72h retry window.
 *
 * EVENTS HANDLED:
 *   checkout.session.completed      → activate subscription
 *   customer.subscription.updated  → sync plan / status changes
 *   customer.subscription.deleted  → downgrade to free
 *   invoice.payment_failed          → mark past_due, notify user
 *   invoice.payment_succeeded       → clear past_due status
 *   payment_intent.succeeded        → deliver paid marketplace item (FIX-AUDIT:
 *                                     previously only confirmDelivery's manual
 *                                     superadmin procedure could do this —
 *                                     customers who paid got nothing automatically)
 *   payment_intent.payment_failed   → mark marketplace purchase failed
 */

import type { Job } from "bullmq";
import { eq, and, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { createLogger } from "../services/logger.js";
import { getRedisPublisher } from "../services/redis.js";
import { QUEUE_NAMES } from "@kojyai/shared/constants";

const log = createLogger("stripe-webhook-processor");

interface StripeWebhookJobData {
  eventId:   string;
  eventType: string;
  payload:   Record<string, unknown>;
}

// ─── Tier → plan limit mapping (mirrors billing/router.ts) ───────────────────

const PLAN_LIMITS: Record<string, { maxBots: number; maxRooms: number }> = {
  free:       { maxBots: 1,   maxRooms: 1   },
  starter:    { maxBots: 3,   maxRooms: 5   },
  pro:        { maxBots: 10,  maxRooms: 25  },
  elite:      { maxBots: 50,  maxRooms: 100 },
  enterprise: { maxBots: 999, maxRooms: 999 },
};

// FIX-AUDIT: noUncheckedIndexedAccess (tsconfig.base.json) types every access
// into PLAN_LIMITS — including PLAN_LIMITS.free — as possibly undefined, since
// the declared type is Record<string, T>. The `!` here is safe: `free` is a
// literal key on the object above and is always present. resolvePlanLimits()
// centralizes the safe fallback so call sites don't repeat the assertion.
const DEFAULT_PLAN_LIMITS: { maxBots: number; maxRooms: number } = PLAN_LIMITS.free!;

function resolvePlanLimits(plan: string): { maxBots: number; maxRooms: number } {
  return PLAN_LIMITS[plan] ?? DEFAULT_PLAN_LIMITS;
}

// ─── Processor ────────────────────────────────────────────────────────────────

export async function processStripeWebhook(job: Job<StripeWebhookJobData>): Promise<void> {
  const { eventId, eventType, payload } = job.data;
  log.info({ eventId, eventType }, "Processing Stripe webhook event");

  try {
    switch (eventType) {

      case "checkout.session.completed": {
        const session = payload as {
          metadata?: { orgId?: string; targetPlan?: string };
          customer?: string;
          subscription?: string;
          customer_email?: string;
        };

        const { orgId, targetPlan } = session.metadata ?? {};
        if (!orgId || !targetPlan) {
          log.warn({ eventId }, "checkout.session.completed missing metadata");
          break;
        }

        const orgIdNum = parseStrictInt(orgId);
        if (!orgIdNum) {
          log.error({ orgId, eventId }, "checkout.session.completed: invalid orgId in metadata");
          break;
        }

        const limits = resolvePlanLimits(targetPlan);

        // Update org plan + bot quota
        await db.update(schema.organizations)
          .set({ plan: targetPlan as any, botQuota: limits.maxBots })
          .where(eq(schema.organizations.id, orgIdNum));

        // Upsert subscription record
        const now = new Date();
        const periodEnd = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
        await db.insert(schema.subscriptions).values({
          uuid:                 `sub-${Date.now()}`,
          orgId:                orgIdNum,
          plan:                 targetPlan as any,
          status:               "active",
          stripeSubscriptionId: String(session.subscription ?? ""),
          stripeCustomerId:     String(session.customer ?? ""),
          currentPeriodStart:   now,
          currentPeriodEnd:     periodEnd,
          cancelAtPeriodEnd:    false,
          limits:               limits as any,
        }).onConflictDoUpdate({
          target: schema.subscriptions.orgId,
          set: {
            plan:                 targetPlan as any,
            status:               "active",
            stripeSubscriptionId: String(session.subscription ?? ""),
            stripeCustomerId:     String(session.customer ?? ""),
            limits:               limits as any,
          },
        });

        // Update the user's tier
        const [member] = await db.select({ userId: schema.orgMembers.userId })
          .from(schema.orgMembers)
          .where(and(eq(schema.orgMembers.orgId, orgIdNum)))
          .limit(1);

        if (member) {
          await db.update(schema.users)
            .set({ tier: targetPlan as any, stripeCustomerId: String(session.customer ?? "") })
            .where(eq(schema.users.id, member.userId));
        }

        log.info({ orgId, plan: targetPlan }, "Subscription activated via checkout");
        break;
      }

      case "customer.subscription.updated": {
        const sub = payload as {
          id?: string;
          status?: string;
          cancel_at_period_end?: boolean;
          current_period_end?: number;
          current_period_start?: number;
          items?: { data?: Array<{ price?: { id?: string } }> };
        };

        const stripeStatus = mapStripeStatus(sub.status ?? "");
        // Map Stripe price ID → our plan name so the org/user tier stays in sync.
        // Without this, plan changes made via Stripe portal or admin adjustments
        // were only reflected in subscription.status — org.plan and user.tier drifted.
        const priceId  = sub.items?.data?.[0]?.price?.id ?? "";
        const newPlan  = priceIdToPlan(priceId);

        // Build the update payload for subscriptions table
        const subscriptionUpdate: Record<string, unknown> = {
          status:            stripeStatus,
          cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
        };
        if (sub.current_period_end) {
          subscriptionUpdate.currentPeriodEnd = new Date(sub.current_period_end * 1000);
        }
        if (sub.current_period_start) {
          subscriptionUpdate.currentPeriodStart = new Date(sub.current_period_start * 1000);
        }
        if (newPlan) {
          subscriptionUpdate.plan = newPlan;
        }

        await db.update(schema.subscriptions)
          .set(subscriptionUpdate as any)
          .where(eq(schema.subscriptions.stripeSubscriptionId, String(sub.id ?? "")));

        // Sync plan down to org + user tier when the plan actually changed
        if (newPlan) {
          const limits = resolvePlanLimits(newPlan);

          // Get org from subscription record
          const [dbSub] = await db
            .select({ orgId: schema.subscriptions.orgId })
            .from(schema.subscriptions)
            .where(eq(schema.subscriptions.stripeSubscriptionId, String(sub.id ?? "")))
            .limit(1);

          if (dbSub) {
            await db.update(schema.organizations)
              .set({ plan: newPlan as any, botQuota: limits.maxBots })
              .where(eq(schema.organizations.id, dbSub.orgId));

            // Update the org owner's tier
            const [member] = await db
              .select({ userId: schema.orgMembers.userId })
              .from(schema.orgMembers)
              .where(eq(schema.orgMembers.orgId, dbSub.orgId))
              .limit(1);

            if (member) {
              await db.update(schema.users)
                .set({ tier: newPlan as any })
                .where(eq(schema.users.id, member.userId));
            }
          }
        }

        log.info({
          subscriptionId: sub.id,
          status: stripeStatus,
          plan: newPlan ?? "(unchanged — unrecognized price ID)",
        }, "Subscription updated — plan and tier synced");
        break;
      }

      case "customer.subscription.deleted": {
        const sub = payload as { id?: string; metadata?: { orgId?: string } };
        const orgId = sub.metadata?.orgId;

        if (orgId) {
          const orgIdNum = parseStrictInt(orgId);
          if (orgIdNum) {
            // Downgrade org to free
            await db.update(schema.organizations)
              .set({ plan: "free", botQuota: DEFAULT_PLAN_LIMITS.maxBots })
              .where(eq(schema.organizations.id, orgIdNum));

            await db.update(schema.subscriptions)
              .set({ status: "canceled", plan: "free", limits: DEFAULT_PLAN_LIMITS as any })
              .where(eq(schema.subscriptions.orgId, orgIdNum));

            // Downgrade user tier
            const [member] = await db.select({ userId: schema.orgMembers.userId })
              .from(schema.orgMembers)
              .where(eq(schema.orgMembers.orgId, orgIdNum))
              .limit(1);

            if (member) {
              await db.update(schema.users)
                .set({ tier: "free" })
                .where(eq(schema.users.id, member.userId));
            }

            log.info({ orgId }, "Subscription canceled — org downgraded to free");
          }
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = payload as {
          subscription?: string;
          customer_email?: string;
        };

        await db.update(schema.subscriptions)
          .set({ status: "past_due" })
          .where(eq(schema.subscriptions.stripeSubscriptionId, String(invoice.subscription ?? "")));

        // SECURITY FIX (H-17): resolve the actual affected user before
        // publishing — this previously broadcast "your payment could not be
        // processed" to every logged-in user on the platform, not just the
        // organization whose payment actually failed. Same org→userId
        // resolution pattern already used above for subscription.deleted.
        const [failedSub] = await db.select({ orgId: schema.subscriptions.orgId })
          .from(schema.subscriptions)
          .where(eq(schema.subscriptions.stripeSubscriptionId, String(invoice.subscription ?? "")))
          .limit(1);

        const [payingMember] = failedSub
          ? await db.select({ userId: schema.orgMembers.userId })
              .from(schema.orgMembers)
              .where(eq(schema.orgMembers.orgId, failedSub.orgId))
              .limit(1)
          : [undefined];

        // Publish notification via Redis so the API WS gateway can push to the user
        const pub = getRedisPublisher();
        if (pub && payingMember) {
          await pub.publish("system", JSON.stringify({
            type: "notification",
            userId: payingMember.userId,
            notificationType: "billing_due",
            title: "Payment Failed",
            body: "Your payment could not be processed. Please update your billing details.",
            ts: Date.now(),
          })).catch(() => null);
        } else if (pub) {
          log.warn({ subscription: invoice.subscription }, "payment_intent.failed: could not resolve an org member to notify — skipping live push (DB status update above still applied)");
        }

        log.warn({ subscription: invoice.subscription }, "Invoice payment failed");
        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = payload as { subscription?: string };

        await db.update(schema.subscriptions)
          .set({ status: "active" })
          .where(eq(schema.subscriptions.stripeSubscriptionId, String(invoice.subscription ?? "")));

        log.info({
          subscription: invoice.subscription,
        }, "Invoice payment succeeded — subscription re-activated");
        break;
      }

      // FIX-AUDIT: marketplace.purchase (apps/api/src/modules/marketplace/router.ts)
      // creates a Stripe PaymentIntent for paid items but nothing ever confirmed
      // delivery on success — confirmDelivery was superadmin-only and manual.
      // A customer could pay via Stripe and receive nothing until someone
      // noticed and ran it by hand. This case closes that gap.
      case "payment_intent.succeeded": {
        const intent = payload as {
          id?: string;
          metadata?: { purchaseUuid?: string };
        };

        const purchaseUuid = intent.metadata?.purchaseUuid;
        if (!purchaseUuid) {
          // Not every payment_intent on the Stripe account is necessarily a
          // marketplace purchase (e.g. could be a future non-marketplace use
          // of PaymentIntents) — skip rather than error.
          log.info({ eventId }, "payment_intent.succeeded with no purchaseUuid metadata — skipping");
          break;
        }

        await deliverPaidMarketplacePurchase(purchaseUuid, String(intent.id ?? ""));
        break;
      }

      case "payment_intent.payment_failed": {
        const intent = payload as { metadata?: { purchaseUuid?: string } };
        const purchaseUuid = intent.metadata?.purchaseUuid;
        if (!purchaseUuid) break;

        await db.update(schema.marketplacePurchases)
          .set({ status: "failed" })
          .where(eq(schema.marketplacePurchases.uuid, purchaseUuid));

        log.warn({ purchaseUuid, eventId }, "Marketplace purchase payment failed");
        break;
      }

      default:
        log.info({ eventType, eventId }, "Unhandled Stripe event type — skipping");
    }

    // Mark event as processed in the audit table
    await db.update(schema.stripeWebhookEvents)
      .set({ processed: true, processedAt: new Date() })
      .where(eq(schema.stripeWebhookEvents.stripeEventId, eventId))
      .catch(() => null); // Non-critical — don't fail the job if audit update fails

  } catch (err) {
    log.error({ eventId, eventType, err }, "Stripe webhook processing failed");

    // Record the error in the audit table before re-throwing (BullMQ will retry)
    await db.update(schema.stripeWebhookEvents)
      .set({ error: err instanceof Error ? err.message : String(err) })
      .where(eq(schema.stripeWebhookEvents.stripeEventId, eventId))
      .catch(() => null);

    throw err; // Re-throw so BullMQ retries the job
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseStrictInt(val: string): number | null {
  const n = parseInt(val, 10);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function mapStripeStatus(status: string): string {
  const map: Record<string, string> = {
    active:             "active",
    trialing:           "trialing",
    past_due:           "past_due",
    canceled:           "canceled",
    unpaid:             "past_due",
    incomplete:         "past_due",
    incomplete_expired: "canceled",
    paused:             "paused",
  };
  return map[status] ?? "past_due";
}

/**
 * Maps a Stripe price ID back to our plan name.
 * Price IDs are read from env so they can differ between dev/prod without code changes.
 * Returns null if the price ID is unknown — callers treat null as "plan unchanged."
 */
function priceIdToPlan(priceId: string): string | null {
  if (!priceId) return null;
  const priceMap: Record<string, string> = {
    [process.env.STRIPE_PRICE_STARTER    ?? ""]: "starter",
    [process.env.STRIPE_PRICE_PRO        ?? ""]: "pro",
    [process.env.STRIPE_PRICE_ELITE      ?? ""]: "elite",
    [process.env.STRIPE_PRICE_ENTERPRISE ?? ""]: "enterprise",
  };
  // Remove the empty-string key that appears when env vars are not set
  delete priceMap[""];
  return priceMap[priceId] ?? null;
}

// ─── Marketplace Delivery (FIX-AUDIT) ──────────────────────────────────────────
//
// Mirrors deliverMarketplaceItem() in apps/api/src/modules/marketplace/router.ts.
// Kept as a separate worker-local copy rather than a shared import — the worker
// deliberately owns its own DB pool and does not import from apps/api (see
// db/client.ts header comment). If this drifts from the API's version again,
// that's the tradeoff of duplication; it's the same tradeoff already accepted
// for PLAN_LIMITS and the schema file itself.

async function deliverPaidMarketplacePurchase(purchaseUuid: string, stripePaymentIntentId: string): Promise<void> {
  const [purchase] = await db
    .select()
    .from(schema.marketplacePurchases)
    .where(eq(schema.marketplacePurchases.uuid, purchaseUuid))
    .limit(1);

  if (!purchase) {
    log.error({ purchaseUuid, stripePaymentIntentId }, "payment_intent.succeeded: no matching marketplacePurchases row");
    return;
  }

  // Idempotency — Stripe may redeliver the same event (and BullMQ may retry)
  if (purchase.status === "completed") {
    log.info({ purchaseUuid }, "Marketplace purchase already delivered — skipping");
    return;
  }

  const [item] = await db
    .select()
    .from(schema.marketplaceItems)
    .where(eq(schema.marketplaceItems.id, purchase.itemId))
    .limit(1);

  if (!item) {
    log.error({ purchaseUuid, itemId: purchase.itemId }, "payment_intent.succeeded: marketplace item no longer exists");
    return;
  }

  await db
    .update(schema.marketplacePurchases)
    .set({
      status: "completed",
      deliveredAt: new Date(),
      stripePaymentIntentId,
    })
    .where(eq(schema.marketplacePurchases.uuid, purchaseUuid));

  await db
    .update(schema.marketplaceItems)
    .set({ purchaseCount: sql`${schema.marketplaceItems.purchaseCount} + 1` })
    .where(eq(schema.marketplaceItems.id, item.id));

  // Get buyer's primary org (same "first membership" rule as the API's version)
  const [member] = await db
    .select({ orgId: schema.orgMembers.orgId })
    .from(schema.orgMembers)
    .where(eq(schema.orgMembers.userId, purchase.buyerId))
    .orderBy(schema.orgMembers.joinedAt)
    .limit(1);

  if (!member) {
    log.warn({ purchaseUuid, buyerId: purchase.buyerId }, "payment_intent.succeeded: buyer has no org — purchase marked complete but not delivered");
    return;
  }

  switch (item.type) {
    case "bot_config":
    case "personality":
    case "template":
      await db.insert(schema.orgLibraryItems).values({
        orgId:    member.orgId,
        itemId:   item.id,
        itemType: item.type,
        config:   item.metadata,
      }).catch(() => null); // Duplicate = already delivered
      break;

    case "plugin":
      await db.insert(schema.orgPlugins).values({
        orgId:    member.orgId,
        pluginId: item.id,
        enabled:  true,
      }).catch(() => null);
      break;

    case "rental": {
      const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000); // 30 days
      await db.insert(schema.orgRentals).values({
        orgId:     member.orgId,
        itemId:    item.id,
        expiresAt,
      }).catch(() => null);
      break;
    }
  }

  log.info({
    purchaseUuid, itemId: item.id, itemType: item.type, buyerId: purchase.buyerId,
  }, "Marketplace purchase delivered via payment_intent.succeeded");
}
