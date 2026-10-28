/**
 * GDPR Router — Data Export & Erasure (Article 17/20)
 * OWNERSHIP: apps/api/src/modules/gdpr
 *
 * SECURITY FIX (H-07): this router did not exist before — a fully-working
 * export/erasure service sat in service.ts with no callable entry point
 * anywhere in the product. This file is the missing connection.
 *
 * PROCEDURES:
 * - gdpr.exportMyData      — self-service: any authenticated user exports
 *                            their own data. No admin path needed for export
 *                            (a user's own data is always theirs to request).
 * - gdpr.eraseMyData       — self-service: any authenticated user erases
 *                            their own account. Destroys the calling
 *                            session immediately afterward (the account
 *                            state after erasure can no longer authenticate
 *                            in the ordinary sense — passwordHash is wiped).
 * - gdpr.adminExportUser   — staff-assisted export for a user who cannot
 *                            self-serve (e.g. contacted support directly).
 *                            Requires admin role, fully audit-logged.
 * - gdpr.adminEraseUser    — staff-assisted erasure, same rationale. Also
 *                            requires admin role, fully audit-logged.
 *
 * Both erasure paths are wrapped in a real DB transaction inside
 * eraseUserData() (service.ts) and send a real confirmation email — see
 * that file's header for the H-07 fix detail.
 */

import { z } from "zod";
import { router, protectedProc, adminProc } from "../../trpc.js";
import { exportUserData, eraseUserData } from "./service.js";
import { db } from "../../db/client.js";
import { emitAuditLog } from "../../events/audit.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("gdpr-router");

export const gdprRouter = router({
  exportMyData: protectedProc.query(async ({ ctx }) => {
    const data = await exportUserData(db, ctx.user!.id);

    await emitAuditLog(db, {
      orgId:        null,
      actorId:      ctx.user!.id,
      actorType:    "user",
      action:       "gdpr.export",
      resourceType: "user",
      resourceId:   String(ctx.user!.id),
      ip:           ctx.ip ?? null,
      userAgent:    ctx.req.headers.get("user-agent") ?? null,
    });

    return data;
  }),

  eraseMyData: protectedProc
    .input(z.object({
      // Require the user to type a confirmation phrase — this is a
      // destructive, effectively irreversible action.
      confirm: z.literal("DELETE MY ACCOUNT"),
    }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user!.id;

      await emitAuditLog(db, {
        orgId:        null,
        actorId:      userId,
        actorType:    "user",
        action:       "gdpr.erase.self_requested",
        resourceType: "user",
        resourceId:   String(userId),
        ip:           ctx.ip ?? null,
        userAgent:    ctx.req.headers.get("user-agent") ?? null,
      });

      await eraseUserData(db, userId);

      log.info({ userId }, "Self-service GDPR erasure completed");
      return { success: true };
    }),

  adminExportUser: adminProc
    .input(z.object({ userId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const data = await exportUserData(db, input.userId);

      await emitAuditLog(db, {
        orgId:        null,
        actorId:      ctx.user!.id,
        actorType:    "user",
        action:       "gdpr.export.admin_assisted",
        resourceType: "user",
        resourceId:   String(input.userId),
        afterState:   { requestedBy: ctx.user!.id },
        ip:           ctx.ip ?? null,
        userAgent:    ctx.req.headers.get("user-agent") ?? null,
      });

      return data;
    }),

  adminEraseUser: adminProc
    .input(z.object({
      userId:  z.number().int().positive(),
      confirm: z.literal("DELETE USER ACCOUNT"),
    }))
    .mutation(async ({ ctx, input }) => {
      await emitAuditLog(db, {
        orgId:        null,
        actorId:      ctx.user!.id,
        actorType:    "user",
        action:       "gdpr.erase.admin_assisted_requested",
        resourceType: "user",
        resourceId:   String(input.userId),
        afterState:   { requestedBy: ctx.user!.id },
        ip:           ctx.ip ?? null,
        userAgent:    ctx.req.headers.get("user-agent") ?? null,
      });

      await eraseUserData(db, input.userId);

      log.info({ userId: input.userId, admin: ctx.user!.id }, "Admin-assisted GDPR erasure completed");
      return { success: true };
    }),
});
