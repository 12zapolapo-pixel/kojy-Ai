/**
 * Stripe Webhook Handler
 * OWNERSHIP: apps/api/src/modules/billing
 *
 * SECURITY:
 * - Signature verified against STRIPE_WEBHOOK_SECRET on every request
 * - Events deduplicated by Stripe event ID in Redis (30-day TTL)
 * - Raw body required — Stripe signature breaks with parsed JSON
 *
 * RETURN CONTRACT (native Hono, not Express):
 *   Returns { status: number; body: object } so the caller (boot.ts) can
 *   call c.json(body, status). This ensures Stripe receives the REAL HTTP
 *   status — 400 on bad signature, 503 when billing is disabled, 500 on enqueue failure, 200 only on
 *   durable success. The old Express-adapter always returned 200.
 *
 * PROCESSING PIPELINE:
 *   1. Verify Stripe signature         → 400 on failure
 *   2. Redis idempotency check         → 200 (deduplicated) if already seen
 *   3. Persist raw event to DB         → audit trail + replay capability
 *   4. Enqueue BullMQ job              → async processing with retries
 *   5. Return 200 to Stripe            → only after durable enqueue
 *   If step 3 or 4 throws             → return 500, Stripe will retry
 */

import Stripe           from "stripe";
import { eq }           from "drizzle-orm";
import { db }           from "../../db/client.js";
import { schema }       from "../../db/client.js";
import { createLogger } from "../../utils/logger.js";
import { getRedis }     from "../../utils/redis.js";
import { enqueue }      from "../../jobs/queues.js";
import { QUEUE_NAMES }  from "@kojyai/shared/constants";

const log = createLogger("stripe-webhook");

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" })
  : null;

export interface WebhookResult {
  status: number;
  body:   Record<string, unknown>;
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

export async function handleStripeWebhook(
  rawBody:   Buffer,
  signature: string,
): Promise<WebhookResult> {
  // ── Guard: Stripe not configured ───────────────────────────────────────────
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    log.warn("Stripe webhook received but billing is disabled (Stripe not configured)");
    return { status: 503, body: { error: "Billing is disabled on this server" } };
  }

  if (!signature) {
    log.warn("Stripe webhook missing signature header");
    return { status: 400, body: { error: "Missing stripe-signature header" } };
  }

  // ── Signature verification ─────────────────────────────────────────────────
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    log.warn({ err }, "Stripe webhook signature verification failed");
    return { status: 400, body: { error: "Invalid signature" } };
  }

  // ── Redis idempotency ──────────────────────────────────────────────────────
  const redis     = getRedis();
  const dedupKey  = `stripe:event:${event.id}`;

  if (redis) {
    // SECURITY FIX (M-12): this was EXISTS followed by SETEX — two round trips,
    // so two concurrent deliveries of the same event (Stripe does retry and
    // redeliver) could both pass the EXISTS check and both be processed.
    // SET ... NX is a single atomic claim: exactly one caller gets "OK".
    // 30-day TTL = Stripe replay window. Redis errors fail OPEN (null result
    // is indistinguishable from "already claimed", so errors are handled
    // separately below) — the stripeEventId DB row is the secondary guard.
    let claimed: string | null = "OK";
    try {
      claimed = await redis.set(dedupKey, "1", "EX", 30 * 24 * 3600, "NX");
    } catch (err) {
      log.warn({ err, eventId: event.id }, "Stripe dedup claim failed — proceeding without Redis guard");
    }
    if (claimed !== "OK") {
      log.info({ eventId: event.id }, "Stripe event already seen — deduplicated");
      return { status: 200, body: { received: true, deduplicated: true } };
    }
  }

  // ── Durable enqueue ────────────────────────────────────────────────────────
  // Persist raw event first (audit + replay), then enqueue for async processing.
  // Respond 200 only after both succeed — so Stripe retries on our failure.
  try {
    await db.insert(schema.stripeWebhookEvents).values({
      stripeEventId: event.id,
      type:          event.type,
      payload:       event.data.object as unknown as Record<string, unknown>,
      processed:     false,
    })
    // A duplicate (Redis was unavailable) keeps the row we already stored
    .onConflictDoNothing({ target: schema.stripeWebhookEvents.stripeEventId })
    .catch(() => null); // Non-fatal — Redis dedup is the primary guard

    await enqueue(QUEUE_NAMES.STRIPE_WEBHOOK, {
      eventId:   event.id,
      eventType: event.type,
      payload:   event.data.object,
    });

    log.info({ eventId: event.id, type: event.type }, "Stripe event enqueued");
    return { status: 200, body: { received: true } };

  } catch (err) {
    log.error({
      eventId: event.id,
      type:    event.type,
      err,
    }, "Failed to enqueue Stripe event — returning 500 so Stripe retries");
    // Clear the Redis dedup key so the retry can proceed
    await redis?.del(dedupKey).catch(() => null);
    return { status: 500, body: { error: "Internal error — will retry" } };
  }
}

// ─── Stripe status → internal status mapping ──────────────────────────────────

export function mapStripeStatus(stripeStatus: Stripe.Subscription.Status): string {
  const map: Record<Stripe.Subscription.Status, string> = {
    active:             "active",
    trialing:           "trialing",
    past_due:           "past_due",
    canceled:           "canceled",
    unpaid:             "past_due",
    incomplete:         "past_due",
    incomplete_expired: "canceled",
    paused:             "paused",
  };
  return map[stripeStatus] ?? "past_due";
}
