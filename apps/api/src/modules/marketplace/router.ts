/**
 * Marketplace Router
 * OWNERSHIP: apps/api/src/modules/marketplace
 */
import { z }         from "zod";
import { eq, and, desc, sql } from "drizzle-orm";
import { nanoid }    from "nanoid";
import { TRPCError } from "@trpc/server";
import { router, protectedProc, permittedProc, superadminProc } from "../../trpc.js";
import { schema }    from "../../db/client.js"; // FIX-2: schema re-exported from client.ts
import { assessFraudRisk } from "@kojyai/security";
import { emitSecurityEvent } from "../../events/audit.js";
import { getRedis } from "../../utils/redis.js";

// The frontend (MarketplacePage.tsx) treats `id` as the string UUID for
// React keys and routing (`/marketplace/${item.id}`) — it also merges API
// results with a hardcoded FEATURED_ITEMS array using small numeric-looking
// string ids ("1".."6"). Returning the raw numeric DB primary key here
// collided with those (React key `1` === `"1"`), causing duplicate-key
// warnings and ambiguous item detail routing.
function sanitizeMarketplaceItem<T extends Record<string, unknown> & { id: unknown; uuid: string }>(
  item: T,
): Omit<T, "id"> & { id: string } {
  const { id: _numericId, ...safe } = item;
  return { ...safe, id: item.uuid };
}

// L-18: price is stored in CENTS in an INT column. It used to accept any number —
// fractional cents, 1e308, Infinity-adjacent values — which breaks the integer
// column and anything computed from it (Stripe amounts, payouts).
const MAX_PRICE_CENTS = 1_000_000; // $10,000.00

export const marketplaceRouter = router({

  list: protectedProc
    .input(z.object({ type: z.enum(["bot_config","personality","plugin","template","rental","all"]).default("all"), limit: z.number().min(1).max(50).default(24), cursor: z.number().optional() }))
    .query(async ({ input, ctx }) => {
      const conditions: any[] = [eq(schema.marketplaceItems.status, "published")];
      if (input.type !== "all") conditions.push(eq(schema.marketplaceItems.type, input.type));

      const items = await ctx.db.select().from(schema.marketplaceItems)
        .where(and(...conditions)).orderBy(desc(schema.marketplaceItems.purchaseCount))
        .limit(input.limit + 1).offset(input.cursor ?? 0);

      return { items: items.slice(0, input.limit).map(sanitizeMarketplaceItem), hasMore: items.length > input.limit, nextCursor: items.length > input.limit ? (input.cursor ?? 0) + input.limit : undefined };
    }),

  get: protectedProc
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const [item] = await ctx.db.select().from(schema.marketplaceItems).where(and(eq(schema.marketplaceItems.uuid, input.id), eq(schema.marketplaceItems.status, "published"))).limit(1);
      if (!item) throw new TRPCError({ code: "NOT_FOUND" });
      return sanitizeMarketplaceItem(item);
    }),

  publish: permittedProc("marketplace:sell")
    .input(z.object({ type: z.enum(["bot_config","personality","plugin","template","rental"]), title: z.string().min(1).max(200), description: z.string().max(2000), price: z.number().int("Price must be a whole number of cents.").min(0).max(MAX_PRICE_CENTS), metadata: z.record(z.unknown()).default({}) }))
    .mutation(async ({ input, ctx }) => {
      const uuid = nanoid(36).replace(/[^a-z0-9-]/gi, "-").slice(0, 36);
      await ctx.db.insert(schema.marketplaceItems).values({ uuid, sellerId: ctx.user.id, type: input.type, title: input.title, description: input.description, price: input.price, metadata: input.metadata, status: "draft" });
      return { success: true, uuid };
    }),

  purchase: permittedProc("marketplace:purchase")
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const [item] = await ctx.db
        .select()
        .from(schema.marketplaceItems)
        .where(and(eq(schema.marketplaceItems.uuid, input.id), eq(schema.marketplaceItems.status, "published")))
        .limit(1);

      if (!item) throw new TRPCError({ code: "NOT_FOUND" });

      // ── Idempotency: prevent double-purchase of the same item ──────────────
      const [existingPurchase] = await ctx.db
        .select({ id: schema.marketplacePurchases.id })
        .from(schema.marketplacePurchases)
        .where(and(
          eq(schema.marketplacePurchases.buyerId, ctx.user.id),
          eq(schema.marketplacePurchases.itemId, item.id),
          eq(schema.marketplacePurchases.status, "completed"),
        ))
        .limit(1);

      if (existingPurchase) {
        throw new TRPCError({ code: "CONFLICT", message: "You already own this item." });
      }

      // SECURITY FIX (H-21): assessFraudRisk() (packages/security) was
      // fully implemented — transaction-velocity + IP-multi-account
      // scoring — with zero callers anywhere in the app, despite its own
      // header documenting the marketplace as an intended consumer. Wired
      // in here, ahead of both the free and paid delivery paths, since
      // velocity-based farming abuse is possible on free items too, not
      // just paid ones.
      const fraudSignals = await assessFraudRisk(getRedis(), {
        userId: ctx.user.id,
        amount: item.price,
        ip:     ctx.ip ?? "unknown",
      });

      if (fraudSignals.action === "block") {
        await emitSecurityEvent(ctx.db, {
          orgId:    null,
          severity: "high",
          category: "fraud",
          actorId:  ctx.user.id,
          ip:       ctx.ip ?? "unknown",
          payload:  { reasons: fraudSignals.reasons, score: fraudSignals.score, itemId: item.id },
        });
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "This purchase could not be completed. Please try again later or contact support." });
      }

      if (fraudSignals.action === "review") {
        // Allowed, but flagged for staff visibility — matches FraudSignals'
        // own documented "review" tier (friction, not an outright block).
        await emitSecurityEvent(ctx.db, {
          orgId:    null,
          severity: "low",
          category: "fraud",
          actorId:  ctx.user.id,
          ip:       ctx.ip ?? "unknown",
          payload:  { reasons: fraudSignals.reasons, score: fraudSignals.score, itemId: item.id, flaggedOnly: true },
        });
      }

      // ── Free item: deliver immediately ─────────────────────────────────────
      if (item.price === 0) {
        const purchaseUuid = nanoid(21);

        // M-15: deliver FIRST. Delivery is idempotent (duplicates are ignored)
        // and now throws on real failure — so a failure can no longer leave a
        // "completed" purchase record behind for something never delivered.
        await deliverMarketplaceItem(ctx.db, item, ctx.user.id);

        await ctx.db.insert(schema.marketplacePurchases).values({
          uuid:     purchaseUuid,
          itemId:   item.id,
          buyerId:  ctx.user.id,
          price:    0,
          status:   "completed",
          deliveredAt: new Date(),
        });

        // Increment purchase counter
        await ctx.db
          .update(schema.marketplaceItems)
          .set({ purchaseCount: sql`${schema.marketplaceItems.purchaseCount} + 1` })
          .where(eq(schema.marketplaceItems.id, item.id));

        return { success: true, free: true, purchaseUuid, message: "Item added to your library." };
      }

      // ── Paid item: create Stripe payment intent ─────────────────────────────
      const stripeKey = process.env.STRIPE_SECRET_KEY;
      if (!stripeKey || process.env.BILLING_DISABLED === "true") {
        // Billing is off on this server (the default): only free items can be taken.
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Payments are switched off on this server, so only free items can be added." });
      }

      const Stripe = (await import("stripe")).default;
      const stripe  = new Stripe(stripeKey, { apiVersion: "2024-06-20" });

      const purchaseUuid = nanoid(21);

      // Create a pending purchase record first (idempotency + audit)
      await ctx.db.insert(schema.marketplacePurchases).values({
        uuid:    purchaseUuid,
        itemId:  item.id,
        buyerId: ctx.user.id,
        price:   item.price,
        status:  "pending",
      });

      // Create Stripe PaymentIntent
      const paymentIntent = await stripe.paymentIntents.create({
        amount:   item.price,   // price stored in cents
        currency: "usd",
        metadata: {
          purchaseUuid,
          itemId:   String(item.id),
          buyerId:  String(ctx.user.id),
          itemType: item.type,
        },
        description: `KOJYAI Marketplace: ${item.title}`,
      });

      // FIX-AUDIT: stripePaymentIntentId was never written despite existing in
      // the schema for exactly this purpose — the column was permanently null,
      // which also meant the worker's payment_intent.succeeded handler had no
      // reliable column to reconcile against (it falls back to metadata.purchaseUuid,
      // but support/ops lookups by intent ID need this column populated too).
      await ctx.db
        .update(schema.marketplacePurchases)
        .set({ stripePaymentIntentId: paymentIntent.id })
        .where(eq(schema.marketplacePurchases.uuid, purchaseUuid));

      return {
        success:       true,
        free:          false,
        purchaseUuid,
        clientSecret:  paymentIntent.client_secret,
        message:       "Complete payment to receive your item.",
      };
    }),

  // ── Deliver marketplace item after Stripe webhook confirms payment ──────────
  // NOTE: the Stripe webhook (apps/worker/src/processors/stripeWebhook.ts,
  // payment_intent.succeeded) does NOT call this procedure — it has its own
  // independent, mirrored delivery path (see that file's own comment: "Mirrors
  // deliverMarketplaceItem() in apps/api/src/modules/marketplace/router.ts").
  // This procedure's only real remaining purpose is the manual-override case
  // its own original comment described: platform support staff unsticking a
  // genuinely stuck purchase.
  //
  // SECURITY FIX (H-08): was permittedProc("marketplace:admin"), which
  // packages/shared/src/permissions/rbac.ts grants to every organization's
  // own "admin" role — not just platform superadmins. That meant any org
  // admin who obtained a purchase UUID belonging to a DIFFERENT org's
  // pending, unpaid purchase (leaked link, shared support thread, or handed
  // it directly by a buyer trying to avoid paying) could force that
  // purchase to "completed" and trigger delivery, entirely bypassing Stripe
  // payment confirmation — with zero check that the purchase belonged to
  // the caller's own org. Restricted to superadminProc, matching what this
  // procedure's own documentation always said it was actually for.
  confirmDelivery: superadminProc
    .input(z.object({ purchaseUuid: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const [purchase] = await ctx.db
        .select()
        .from(schema.marketplacePurchases)
        .where(eq(schema.marketplacePurchases.uuid, input.purchaseUuid))
        .limit(1);

      if (!purchase) throw new TRPCError({ code: "NOT_FOUND" });
      if (purchase.status === "completed") return { success: true, alreadyDelivered: true };

      const [item] = await ctx.db
        .select()
        .from(schema.marketplaceItems)
        .where(eq(schema.marketplaceItems.id, purchase.itemId))
        .limit(1);

      if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "Item not found." });

      // M-15: deliver BEFORE marking completed. The early
      // `status === "completed"` return above means a purchase marked
      // completed can never be retried — so if delivery fails after that
      // status write, the buyer has paid and can never receive the item.
      // Delivery is idempotent, so a retry after failure is safe.
      await deliverMarketplaceItem(ctx.db, item, purchase.buyerId);

      await ctx.db
        .update(schema.marketplacePurchases)
        .set({ status: "completed", deliveredAt: new Date() })
        .where(eq(schema.marketplacePurchases.uuid, input.purchaseUuid));

      await ctx.db
        .update(schema.marketplaceItems)
        .set({ purchaseCount: sql`${schema.marketplaceItems.purchaseCount} + 1` })
        .where(eq(schema.marketplaceItems.id, item.id));

      return { success: true, alreadyDelivered: false };
    }),
});


// ─── Delivery Helper ──────────────────────────────────────────────────────────

/**
 * True only for a MySQL duplicate-key violation (the buyer already owns the
 * item). Checks err.cause too, since newer drizzle versions wrap driver errors.
 *
 * SECURITY/RELIABILITY FIX (M-15): every delivery insert used to end in
 * `.catch(() => null)` — which swallowed ANY failure (deadlock, connection
 * loss, bad data), not just duplicates — while the caller had already marked
 * the purchase "completed". A buyer could pay and silently receive nothing.
 */
function isDuplicateKeyError(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "ER_DUP_ENTRY" || e?.cause?.code === "ER_DUP_ENTRY";
}

/** Swallow ONLY duplicate-key errors ("already delivered"); rethrow the rest. */
function ignoreDuplicate(err: unknown): null {
  if (isDuplicateKeyError(err)) return null;
  throw err;
}

/**
 * Delivers a purchased marketplace item to the buyer.
 * Strategy depends on item type:
 *  - bot_config / personality / template: copy metadata to buyer's org config
 *  - plugin: add to org's enabled plugins list
 *  - rental: create a time-limited access record
 */
async function deliverMarketplaceItem(db: any, item: any, buyerId: number): Promise<void> {
  // Get buyer's primary org
  const [member] = await db
    .select({ orgId: schema.orgMembers.orgId })
    .from(schema.orgMembers)
    .where(eq(schema.orgMembers.userId, buyerId))
    .orderBy(schema.orgMembers.joinedAt)
    .limit(1);

  if (!member) {
    // M-15: was a silent `return` after the purchase was already marked
    // completed. Fail loudly so the caller doesn't record a phantom delivery.
    throw new Error(`Marketplace delivery failed: buyer ${buyerId} has no organization`);
  }

  switch (item.type) {
    case "bot_config":
    case "personality":
    case "template":
      // Store the item config in the buyer's org library
      await db.insert(schema.orgLibraryItems).values({
        orgId:    member.orgId,
        itemId:   item.id,
        itemType: item.type,
        config:   item.metadata,
      }).catch(ignoreDuplicate); // Duplicate = already delivered
      break;

    case "plugin":
      await db.insert(schema.orgPlugins).values({
        orgId:    member.orgId,
        pluginId: item.id,
        enabled:  true,
      }).catch(ignoreDuplicate);
      break;

    case "rental": {
      const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000); // 30 days
      await db.insert(schema.orgRentals).values({
        orgId:     member.orgId,
        itemId:    item.id,
        expiresAt,
      }).catch(ignoreDuplicate);
      break;
    }
  }
}
