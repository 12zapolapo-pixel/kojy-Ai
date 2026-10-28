/**
 * Rooms Router
 * OWNERSHIP: apps/api/src/modules/rooms
 */

import { z }         from "zod";
import { eq, and, desc, isNull } from "drizzle-orm";
import { nanoid }    from "nanoid";
import { TRPCError } from "@trpc/server";
import { router, permittedProc } from "../../trpc.js";
import { schema }    from "../../db/client.js"; // FIX-2: schema re-exported from client.ts
import { emitAuditLog } from "../../events/audit.js";
import { resolveOrgId } from "../../utils/resolveOrgId.js"; // M-08/M-13: single canonical implementation

export const roomsRouter = router({

  list: permittedProc("rooms:read")
    .query(async ({ ctx }) => {
      const orgId = await resolveOrgId(ctx);
      // SECURITY FIX (M-16): soft-deleted rooms were never filtered out, so a
      // "deleted" room stayed visible (and selectable) forever.
      return ctx.db
        .select()
        .from(schema.rooms)
        .where(and(eq(schema.rooms.orgId, orgId), isNull(schema.rooms.deletedAt)))
        .orderBy(desc(schema.rooms.createdAt));
    }),

  create: permittedProc("rooms:create")
    .input(z.object({ name: z.string().min(1).max(200), highriseRoomId: z.string().min(1).max(200) }))
    .mutation(async ({ input, ctx }) => {
      const orgId = await resolveOrgId(ctx);

      const uuid = nanoid(36).replace(/[^a-z0-9-]/gi, "-").slice(0, 36);
      await ctx.db.insert(schema.rooms).values({ uuid, orgId, name: input.name, highriseRoomId: input.highriseRoomId, status: "active", activeBotIds: [], settings: {}, analyticsSummary: {} });
      await emitAuditLog(ctx.db, { orgId, actorId: ctx.user.id, actorType: "user", action: "room.create", resourceType: "room", resourceId: uuid, ip: ctx.ip });
      return { success: true };
    }),

  delete: permittedProc("rooms:delete")
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const orgId = await resolveOrgId(ctx);
      // L-19: audit the deletion (create already did) and don't "delete" a room
      // that doesn't exist / is already deleted / belongs to another org.
      const deleted = await ctx.db.update(schema.rooms)
        .set({ deletedAt: new Date() })
        .where(and(eq(schema.rooms.uuid, input.id), eq(schema.rooms.orgId, orgId), isNull(schema.rooms.deletedAt)))
        .returning({ id: schema.rooms.id });
      if (deleted.length !== 1) throw new TRPCError({ code: "NOT_FOUND", message: "Room not found." });
      await emitAuditLog(ctx.db, { orgId, actorId: ctx.user.id, actorType: "user", action: "room.delete", resourceType: "room", resourceId: input.id, ip: ctx.ip });
      return { success: true };
    }),
});
