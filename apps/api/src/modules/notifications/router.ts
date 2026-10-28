/**
 * Notifications Router
 * OWNERSHIP: apps/api/src/modules/notifications
 */

import { z }         from "zod";
import { eq, and, desc, isNull, sql } from "drizzle-orm";
import { router, protectedProc } from "../../trpc.js";
import { schema }    from "../../db/client.js"; // FIX-2: schema re-exported from client.ts

export const notificationsRouter = router({

  list: protectedProc
    .input(z.object({ limit: z.number().min(1).max(100).default(50), unreadOnly: z.boolean().default(false) }))
    .query(async ({ input, ctx }) => {
      const conditions: any[] = [eq(schema.notifications.userId, ctx.user.id)];
      if (input.unreadOnly) conditions.push(isNull(schema.notifications.readAt));

      const notifications = await ctx.db
        .select()
        .from(schema.notifications)
        .where(and(...conditions))
        .orderBy(desc(schema.notifications.createdAt))
        .limit(input.limit);

      // L-20: the count used to be derived from the (limit-capped, possibly
      // unreadOnly-filtered) page above, so it topped out at `limit` and read 0
      // whenever the newest N were all read. Count the real total in SQL.
      const [{ unread }] = await ctx.db
        .select({ unread: sql<number>`COUNT(*)`.mapWith(Number) })
        .from(schema.notifications)
        .where(and(eq(schema.notifications.userId, ctx.user.id), isNull(schema.notifications.readAt))) as [{ unread: number }];

      return { notifications, unreadCount: Number(unread) };
    }),

  markRead: protectedProc
    // L-21: parseInt("12abc") === 12 and parseInt("abc") === NaN (-> a query on
    // NaN). Accept a number or a digits-only string and reject everything else.
    .input(z.object({ id: z.union([z.number().int().positive(), z.string().regex(/^\d{1,10}$/)]).transform(Number).pipe(z.number().int().positive().max(2_147_483_647)) }))
    .mutation(async ({ input, ctx }) => {
      await ctx.db.update(schema.notifications)
        .set({ readAt: new Date() })
        .where(and(eq(schema.notifications.userId, ctx.user.id), eq(schema.notifications.id, input.id)));
      return { success: true };
    }),

  markAllRead: protectedProc
    .mutation(async ({ ctx }) => {
      await ctx.db.update(schema.notifications)
        .set({ readAt: new Date() })
        .where(and(eq(schema.notifications.userId, ctx.user.id), isNull(schema.notifications.readAt)));
      return { success: true };
    }),
});
