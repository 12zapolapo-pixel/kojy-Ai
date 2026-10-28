/**
 * Billing Package — Monetization Systems
 *
 * SKILLS: 36 (Subscriptions), 38 (Affiliate), 39 (Usage Billing),
 *         40 (White-Label), 41 (Bot Rental), 43 (Revenue Dashboard),
 *         44 (Coupons), 45 (Upgrade Nudge), 47 (Performance Reports)
 *
 * OWNERSHIP: packages/billing
 * LAYER: Business — all revenue-related logic
 *
 * ARCHITECTURE:
 * - Stripe is the payment processor — no raw card data ever touches our DB
 * - Subscription state kept in subscriptions table (source of truth: Stripe)
 * - Stripe webhooks → update local state (idempotent, replayed safely)
 * - Usage metering: API records usage_records, Stripe reports at period end
 * - Feature gates checked via subscription limits, NOT hardcoded plan names
 *
 * WEBHOOK SECURITY:
 * - Stripe-Signature header verified on every webhook
 * - Events deduplicated by Stripe event ID in Redis
 * - Failed webhook processing retried up to 3x before alerting
 *
 * FAILURE HANDLING:
 * - Stripe unavailable: payment fails gracefully, user sees error
 * - Webhook processing fails: logged to DLQ, admin can replay
 * - Usage record write fails: logged separately, reconciled nightly
 */

import type { UserTier } from "@kojyai/shared/types";
import { PLAN_LIMITS } from "@kojyai/shared/constants";

// ─── SKILL #36: Tiered Subscription Engine ───────────────────────────────────

export interface SubscriptionUpgradeResult {
  success:        boolean;
  checkoutUrl?:   string;
  error?:         string;
  newPlan?:       UserTier;
}

/**
 * Creates a Stripe Checkout session for plan upgrade.
 * Returns the checkout URL — frontend redirects to Stripe-hosted page.
 * On success, Stripe fires checkout.session.completed webhook.
 */
export async function createUpgradeCheckout(
  stripe: any,
  input: {
    orgId:      number;
    orgUuid:    string;
    email:      string;
    targetPlan: UserTier;
    successUrl: string;
    cancelUrl:  string;
    couponCode?: string;
  },
): Promise<SubscriptionUpgradeResult> {
  const priceId = getStripePriceIds()[input.targetPlan]; // FIX-17: use lazy getter that throws on placeholder
  if (!priceId) {
    return { success: false, error: `No Stripe price for plan: ${input.targetPlan}` };
  }

  try {
    const sessionParams: any = {
      mode:                "subscription",
      payment_method_types: ["card"],
      customer_email:       input.email,
      line_items:          [{ price: priceId, quantity: 1 }],
      success_url:          `${input.successUrl}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:           input.cancelUrl,
      metadata:             { orgId: String(input.orgId), orgUuid: input.orgUuid, targetPlan: input.targetPlan },
    };

    if (input.couponCode) {
      // Validate coupon first
      try {
        const coupon = await stripe.promotionCodes.list({ code: input.couponCode, limit: 1 });
        if (coupon.data[0]) {
          sessionParams.discounts = [{ promotion_code: coupon.data[0].id }];
        }
      } catch {
        // Invalid coupon — proceed without discount
      }
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    return { success: true, checkoutUrl: session.url };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Stripe error" };
  }
}

// ─── Stripe Price IDs — fail fast if missing or still placeholder ─────────────
// FIX-17: never fall back to placeholder strings. If a price env var is missing
// at boot, the billing module must refuse to operate rather than silently
// attaching the wrong (or fake) price to a Stripe subscription call.

function requireStripePrice(name: string): string {
  const v = process.env[name];
  if (!v || v.includes("placeholder") || v.trim() === "") {
    throw new Error(
      `[billing] Required Stripe price env var "${name}" is missing or still a placeholder. ` +
      `Set it in .env before starting the server.`,
    );
  }
  return v;
}

// Evaluated lazily so the server can still boot in test/dev envs that
// intentionally skip billing. Actual Stripe calls will throw if accessed
// without real price IDs.
let _stripePriceIds: Partial<Record<UserTier, string>> | null = null;

function getStripePriceIds(): Partial<Record<UserTier, string>> {
  if (!_stripePriceIds) {
    _stripePriceIds = {
      starter:    requireStripePrice("STRIPE_PRICE_STARTER"),
      pro:        requireStripePrice("STRIPE_PRICE_PRO"),
      elite:      requireStripePrice("STRIPE_PRICE_ELITE"),
      enterprise: requireStripePrice("STRIPE_PRICE_ENTERPRISE"),
    };
  }
  return _stripePriceIds;
}

// ─── SKILL #39: Usage-Based Billing ──────────────────────────────────────────

export type UsageResourceType =
  | "ai_messages"
  | "simulation_minutes"
  | "storage_gb"
  | "bot_hours"
  | "api_calls";

export interface UsageRecord {
  orgId:        number;
  botId?:       number;
  resourceType: UsageResourceType;
  quantity:     number;
  period:       string; // "2025-01"
}

export interface UsageSummary {
  period:     string;
  records:    Array<{ resourceType: string; quantity: number; cost: number }>;
  totalCost:  number;
  limits:     typeof PLAN_LIMITS.free;
  overages:   Array<{ resourceType: string; overageAmount: number; overageCost: number }>;
}

/** Cost per unit for usage-based billing (in cents) */
const USAGE_COSTS: Record<UsageResourceType, number> = {
  ai_messages:         0.001, // $0.001 per message over limit
  simulation_minutes:  0.02,  // $0.02 per minute over limit
  storage_gb:          0.10,  // $0.10 per GB over limit
  bot_hours:           0.005, // $0.005 per bot-hour over limit
  api_calls:           0.0001,// $0.0001 per API call over limit
};

export function calculateOverageCost(
  quantity: number,
  limit: number,
  resourceType: UsageResourceType,
): number {
  const overage = Math.max(0, quantity - limit);
  return overage * (USAGE_COSTS[resourceType] ?? 0);
}

// ─── SKILL #44: Coupon & Promo Engine ────────────────────────────────────────

export interface CouponValidationResult {
  valid:        boolean;
  discountPct?: number;
  discountAmt?: number;
  appliesTo?:   UserTier[];
  error?:       string;
}

/**
 * Validates a coupon code locally before sending to Stripe.
 * Local validation is fast and prevents unnecessary Stripe API calls.
 * Final authoritative validation always happens on Stripe side.
 */
export async function validateCouponCode(
  redis: any,
  code: string,
  targetPlan: UserTier,
): Promise<CouponValidationResult> {
  const cacheKey = `coupon:${code.toUpperCase()}`;

  // Check Redis cache (coupons cached for 5 minutes by the API after a real Stripe lookup)
  if (redis) {
    const cached = await redis.get(cacheKey).catch(() => null);
    if (cached) {
      const data = JSON.parse(cached) as CouponValidationResult;
      if (!data.valid) return data;
      if (data.appliesTo && !data.appliesTo.includes(targetPlan)) {
        return { valid: false, error: `Coupon not valid for ${targetPlan} plan` };
      }
      return data;
    }
  }

  // No cached result — we cannot validate without a Stripe instance here.
  // Return invalid so the UI does NOT show a discount that hasn't been confirmed.
  // Stripe performs the authoritative check at checkout; the UI should call the
  // API's billing.validateCoupon tRPC procedure (which has the Stripe instance)
  // before showing any discount UI to the user.
  //
  // Returning valid: true here was a BUG — it let the frontend show a "discount applied"
  // message for any arbitrary string the user typed, misleading users.
  return {
    valid: false,
    error: "Coupon not verified — please wait while we check your code",
  };
}

// ─── SKILL #45: Freemium Upgrade Nudge ───────────────────────────────────────

export type NudgeTrigger =
  | "bot_limit_reached"
  | "simulation_limit_reached"
  | "analytics_gated"
  | "advanced_ai_gated"
  | "whitelist_gated"
  | "export_gated";

export interface UpgradeNudge {
  trigger:     NudgeTrigger;
  currentPlan: UserTier;
  targetPlan:  UserTier;
  headline:    string;
  description: string;
  ctaLabel:    string;
  urgency:     "low" | "medium" | "high";
}

/**
 * Returns the appropriate upgrade nudge for a given trigger and current plan.
 * Used by the frontend to show contextual upgrade prompts.
 */
export function getUpgradeNudge(
  trigger: NudgeTrigger,
  currentPlan: UserTier,
): UpgradeNudge | null {
  const nextPlan = getNextPlan(currentPlan);
  if (!nextPlan) return null; // Already on highest plan

  const nudges: Record<NudgeTrigger, UpgradeNudge> = {
    bot_limit_reached: {
      trigger,
      currentPlan,
      targetPlan:  nextPlan,
      headline:    "Bot limit reached",
      description: `Upgrade to ${capitalize(nextPlan)} to deploy more bots and scale your AI operations.`,
      ctaLabel:    "Upgrade Plan",
      urgency:     "high",
    },
    simulation_limit_reached: {
      trigger,
      currentPlan,
      targetPlan:  nextPlan,
      headline:    "Simulation quota used",
      description: "Run unlimited simulations with a Pro or Elite plan.",
      ctaLabel:    "Unlock Simulations",
      urgency:     "medium",
    },
    analytics_gated: {
      trigger,
      currentPlan,
      targetPlan:  "pro",
      headline:    "Advanced analytics are Pro+",
      description: "Access funnel analysis, retention cohorts, and ROI tracking with Pro.",
      ctaLabel:    "Upgrade to Pro",
      urgency:     "low",
    },
    advanced_ai_gated: {
      trigger,
      currentPlan,
      targetPlan:  "pro",
      headline:    "Unlock Claude Sonnet",
      description: "Pro plan unlocks Claude Sonnet for smarter, more capable bots.",
      ctaLabel:    "Upgrade for Better AI",
      urgency:     "medium",
    },
    whitelist_gated: {
      trigger,
      currentPlan,
      targetPlan:  "elite",
      headline:    "White-label is Elite+",
      description: "Brand the platform as your own with an Elite or Enterprise plan.",
      ctaLabel:    "Go Elite",
      urgency:     "low",
    },
    export_gated: {
      trigger,
      currentPlan,
      targetPlan:  "starter",
      headline:    "Export requires Starter+",
      description: "Upgrade to download your analytics data in CSV and JSON formats.",
      ctaLabel:    "Upgrade to Starter",
      urgency:     "low",
    },
  };

  return nudges[trigger] ?? null;
}

function getNextPlan(current: UserTier): UserTier | null {
  const progression: UserTier[] = ["free", "starter", "pro", "elite", "enterprise"];
  const idx = progression.indexOf(current);
  return idx >= 0 && idx < progression.length - 1 ? progression[idx + 1]! : null;
}

// ─── SKILL #47: Performance Reports ──────────────────────────────────────────

export interface PerformanceReport {
  period:         { start: string; end: string };
  orgId:          number;
  botSummaries:   BotPerformanceSummary[];
  totalMessages:  number;
  avgHealthScore: number;
  topPerformer:   string | null;
  recommendations: string[];
  generatedAt:    string;
}

export interface BotPerformanceSummary {
  botId:           string;
  botName:         string;
  messages:        number;
  uniqueUsers:     number;
  avgSentiment:    number;
  uptimeHours:     number;
  healthScore:     number;
  loyalUsers:      number;
}

/**
 * Generates a human-readable performance report for an org.
 * Called weekly by the report scheduler worker job.
 * Output is stored as a marketplace_item-style report and emailed to org owner.
 */
export function generateReportRecommendations(
  summaries: BotPerformanceSummary[],
): string[] {
  const recommendations: string[] = [];

  const lowHealth = summaries.filter((b) => b.healthScore < 3);
  if (lowHealth.length > 0) {
    recommendations.push(
      `${lowHealth.length} bot(s) have low health scores. Check error logs and consider restarting.`,
    );
  }

  const lowEngagement = summaries.filter((b) => b.avgSentiment < -0.2);
  if (lowEngagement.length > 0) {
    recommendations.push(
      `${lowEngagement.length} bot(s) have negative average sentiment. Review personality settings.`,
    );
  }

  const highUptimeBots = summaries.filter((b) => b.uptimeHours > 160);
  if (highUptimeBots.length > 0) {
    recommendations.push(
      `${highUptimeBots.length} bot(s) have run continuously for 7+ days. Consider scheduled restarts.`,
    );
  }

  if (summaries.every((b) => b.uniqueUsers < 10)) {
    recommendations.push(
      "All bots have low unique user counts. Consider adding more rooms or adjusting greeting messages.",
    );
  }

  return recommendations;
}

// ─── SKILL #41: Bot Rental System ────────────────────────────────────────────

export interface BotRentalListing {
  itemId:       string;
  botName:      string;
  description:  string;
  dailyRate:    number;   // in cents
  weeklyRate:   number;
  personalityDnaSnapshot: object;
  availableFrom: string;
  availableTo:   string | null;
}

export interface RentalAgreement {
  id:           string;
  listingId:    string;
  renterId:     number;
  renteeId:     number;
  startDate:    string;
  endDate:      string;
  totalCost:    number;
  status:       "pending" | "active" | "completed" | "cancelled";
}

/**
 * Creates a bot rental agreement and charges the renter.
 * Bot personality DNA is snapshotted at rental start.
 * Renter gets full bot control for the rental period.
 * After rental ends, bot returns to owner with memories intact.
 */
export function calculateRentalCost(
  listing: BotRentalListing,
  startDate: Date,
  endDate:   Date,
): number {
  const days = Math.ceil((endDate.getTime() - startDate.getTime()) / (24 * 3600 * 1000));
  const weeks = Math.floor(days / 7);
  const remainingDays = days % 7;
  return weeks * listing.weeklyRate + remainingDays * listing.dailyRate;
}

// ─── SKILL #40: Enterprise White-Label ───────────────────────────────────────

export interface WhiteLabelConfig {
  orgId:        number;
  brandName:    string;
  logoUrl:      string;
  primaryColor: string;
  accentColor:  string;
  domain:       string;
  hideKojyaiBranding: boolean;
  customLoginPage:    boolean;
}

export function applyWhiteLabelConfig(
  config: WhiteLabelConfig,
): Record<string, string> {
  return {
    "--brand-primary":   config.primaryColor,
    "--brand-accent":    config.accentColor,
    "--brand-name":      config.brandName,
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
