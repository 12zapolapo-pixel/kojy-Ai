/**
 * Billing Router
 * OWNERSHIP: apps/api/src/modules/billing
 *
 * FIX APPLIED (Phase 3):
 * - getNudge: input was captured from outer scope (undefined at runtime).
 *   Handler now correctly destructures { input, ctx }.
 * - getPortalUrl: was declared as .mutation() but performs a read-side-effect
 *   action to create a portal session. Kept as mutation since Stripe creates
 *   a new session object on every call (not idempotent for GET semantics).
 */

import { z }         from "zod";
import { eq, and }   from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, permittedProc } from "../../trpc.js";
import { resolveOrgId } from "../../utils/resolveOrgId.js"; // M-08/M-13: single canonical implementation
import { schema }    from "../../db/client.js"; // FIX-2: schema re-exported from client.ts
import {
  createUpgradeCheckout,
  getUpgradeNudge,
  validateCouponCode,
} from "@kojyai/billing";
import type { NudgeTrigger } from "@kojyai/billing";
import { getRedis }  from "../../utils/redis.js";
import Stripe        from "stripe";
import type { UserTier } from "@kojyai/shared/types";

// ─── Stripe client (lazy — null if not configured) ───────────────────────────

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" })
  : null;

// ─── Router ───────────────────────────────────────────────────────────────────

export const billingRouter = router({

  /** Returns the org's active subscription or null if on free plan */
  getSubscription: permittedProc("billing:read")
    .query(async ({ ctx }) => {
      const orgId = await resolveOrgId(ctx);

      const [sub] = await ctx.db
        .select()
        .from(schema.subscriptions)
        .where(eq(schema.subscriptions.orgId, orgId))
        .limit(1);

      return sub ?? null;
    }),

  /** Returns usage records for the current billing period */
  getUsage: permittedProc("billing:read")
    .query(async ({ ctx }) => {
      const orgId = await resolveOrgId(ctx);

      const period  = new Date().toISOString().slice(0, 7); // "YYYY-MM"
      // Filter by period IN SQL (served by usage_org_period_idx on (org_id,
      // period)). This used to select every row the org had ever produced —
      // unbounded and growing every month — then discard all but the current
      // month in JS.
      const records = await ctx.db
        .select()
        .from(schema.usageRecords)
        .where(and(
          eq(schema.usageRecords.orgId, orgId),
          eq(schema.usageRecords.period, period),
        ));

      return { records, period };
    }),

  /** Creates a Stripe Checkout session — returns the hosted payment URL */
  createCheckout: permittedProc("billing:upgrade")
    .input(z.object({
      targetPlan: z.enum(["starter", "pro", "elite", "enterprise"]),
      couponCode: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      if (!stripe) {
        throw new TRPCError({
          code:    "INTERNAL_SERVER_ERROR",
          message: "Stripe is not configured. Set STRIPE_SECRET_KEY in your environment.",
        });
      }

      const orgId = await resolveOrgId(ctx);

      const result = await createUpgradeCheckout(stripe, {
        orgId:      orgId,
        orgUuid:    String(orgId),
        email:      ctx.user.email,
        targetPlan: input.targetPlan as UserTier,
        successUrl: `${process.env.FRONTEND_URL ?? "http://localhost:5173"}/settings/billing?success=true`,
        cancelUrl:  `${process.env.FRONTEND_URL ?? "http://localhost:5173"}/settings/billing`,
        ...(input.couponCode ? { couponCode: input.couponCode } : {}),
      });

      if (!result.success) {
        throw new TRPCError({
          code:    "BAD_REQUEST",
          message: result.error ?? "Checkout session creation failed",
        });
      }

      return { checkoutUrl: result.checkoutUrl! };
    }),

  /** Validates a coupon code before checkout */
  validateCoupon: permittedProc("billing:read")
    .input(z.object({
      code:       z.string().min(1).max(50),
      targetPlan: z.string(),
    }))
    .query(async ({ input }) => {
      // Redis optional — gracefully degrades if unavailable
      const redis = getRedis();
      return validateCouponCode(redis, input.code, input.targetPlan as UserTier);
    }),

  /**
   * Returns the upgrade nudge for a given trigger and the user's current plan.
   *
   * FIX: Previously { ctx } only — `input` was undefined at runtime.
   * Now correctly destructures { input, ctx } from the handler argument.
   */
  getNudge: permittedProc("billing:read")
    .input(z.object({
      trigger: z.string().min(1),
    }))
    .query(async ({ input, ctx }) => {
      return getUpgradeNudge(input.trigger as NudgeTrigger, ctx.user.tier);
    }),

  /**
   * Creates a Stripe Customer Portal session.
   * Returns the portal URL — frontend redirects there for self-serve billing.
   */
  getPortalUrl: permittedProc("billing:manage")
    .mutation(async ({ ctx }) => {
      if (!stripe) {
        throw new TRPCError({
          code:    "INTERNAL_SERVER_ERROR",
          message: "Stripe is not configured",
        });
      }

      const [user] = await ctx.db
        .select({ stripeCustomerId: schema.users.stripeCustomerId })
        .from(schema.users)
        .where(eq(schema.users.id, ctx.user.id))
        .limit(1);

      if (!user?.stripeCustomerId) {
        throw new TRPCError({
          code:    "NOT_FOUND",
          message: "No Stripe billing account found. Complete a checkout first.",
        });
      }

      const session = await stripe.billingPortal.sessions.create({
        customer:   user.stripeCustomerId,
        return_url: `${process.env.FRONTEND_URL ?? "http://localhost:5173"}/settings/billing`,
      });

      return { url: session.url };
    }),

  /**
   * Webhook receiver — called by Stripe to notify of payment events.
   * Verifies signature, deduplicates by event ID, updates subscription state.
   *
   * NOTE (L-30: this used to describe an Express setup this app doesn't use):
   * Stripe signs the EXACT bytes of the request body, so the webhook can't be a
   * tRPC procedure. It is a native Hono route in boot.ts —
   *   app.post("/stripe/webhook", ...)  reads the raw body via c.req.arrayBuffer()
   * and passes that Buffer plus the `stripe-signature` header to
   * handleStripeWebhook() in billing/webhook.ts (which verifies, dedupes by event
   * id, and updates subscription state). boot.ts also caps this route's body size.
   *
   * This procedure only reports configuration status, for the admin dashboard.
   */
  webhookStatus: permittedProc("admin:read_all")
    .query(() => {
      return {
        configured:    !!process.env.STRIPE_WEBHOOK_SECRET,
        endpointPath:  "/stripe/webhook",
        eventsHandled: [
          "checkout.session.completed",
          "customer.subscription.updated",
          "customer.subscription.deleted",
          "invoice.payment_failed",
          "invoice.payment_succeeded",
        ],
      };
    }),
});
