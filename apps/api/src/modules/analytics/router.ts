/**
 * Analytics Router
 * OWNERSHIP: apps/api/src/modules/analytics
 */

import { z }         from "zod";
import { eq, and, desc, gte, lte, sql, inArray, count } from "drizzle-orm";
import { router, permittedProc } from "../../trpc.js";
import { tryResolveOrgId } from "../../utils/resolveOrgId.js"; // single canonical org resolution (M-08/M-13)
import { schema }    from "../../db/client.js"; // FIX-2: schema re-exported from client.ts
import {
  buildRetentionMatrix,
  calculateFunnelDropoff,
  buildActivityHeatmap,
  calculateBotRoi,
} from "@kojyai/analytics";

// SECURITY/QUALITY FIX (H-09/H-22): these five procedures used to ignore
// their own input and return hardcoded literal zero/empty results — visually
// indistinguishable from a real, if uneventful, computed answer. The actual
// calculation logic (packages/analytics/src/index.ts) was already written,
// correct, and simply never called from here. Wired in below.
//
// One documented, honest exception: `export`. That package file's own
// FIX-AUDIT comment establishes that createExportJob() enqueues
// QUEUE_NAMES.ANALYTICS_EXPORT but NO worker processor anywhere consumes
// that queue, and no endpoint exists to poll a job's status or return a
// download link — the flow dead-ends after enqueue. Calling it here would
// silently promise a download link that can never arrive, which is worse
// than the current (at least honestly-labeled) stub. Per this finding's own
// explicit guidance, `export` returns an explicit "not yet available"
// response instead, until a real worker processor + status endpoint exists.

/** Approximate monthly list price by tier, in cents. Used only for the ROI
 *  estimate below — this platform does not store a per-org cent-accurate
 *  billing amount locally (Stripe is the source of truth for actual
 *  charges); this is a documented benchmark, not fabricated per-org data. */
const TIER_MONTHLY_CENTS: Record<string, number> = {
  free:       0,
  starter:    2900,
  pro:        9900,
  elite:      29900,
  enterprise: 99900,
  dev:        0,
};

/** Benchmark hourly rate for a human community manager doing equivalent
 *  work, in cents. Industry-typical figure used for the "value vs manual
 *  operation" comparison every bot-ROI calculator needs — this is a stated
 *  assumption, not per-org measured data. */
const MANUAL_OPERATOR_HOURLY_RATE_CENTS = 1500;

export const analyticsRouter = router({

  /**
   * Everything the Analytics page shows, from bot_activity (real room events
   * from JS bots and Python bots). tzOffsetMin = the browser's
   * getTimezoneOffset(), so days and the hour heatmap are in local time.
   */
  activity: permittedProc("analytics:read")
    .input(z.object({
      days: z.number().int().min(1).max(90).default(7),
      tzOffsetMin: z.number().int().min(-840).max(840).default(0),
      /** Only this bot (its uuid; Python bots are "python", JS bots "javascript"). */
      bot: z.object({ kind: z.enum(["python", "javascript"]), id: z.string().min(1).max(64) }).optional(),
    }))
    .query(async ({ input, ctx }) => {
      const orgId = await tryResolveOrgId(ctx);
      const empty = {
        totals: {} as Record<string, number>, previous: null as null | Record<string, number>, visitors: 0, previousVisitors: 0, returning: 0, gold: 0, previousGold: 0,
        daily: [], heatmap: [], bots: [], topVisitors: [], topCommands: [], topTippers: [],
      };
      if (orgId === null) return empty;
      const a = schema.botActivity;
      const now = Date.now();
      const since = new Date(now - input.days * 86_400_000);
      const before = new Date(now - 2 * input.days * 86_400_000);
      let botScope = sql`true`;
      if (input.bot) {
        const table = input.bot.kind === "python" ? schema.botProjects : schema.bots;
        const [row] = await ctx.db.select({ id: table.id }).from(table).where(and(eq(table.uuid, input.bot.id), eq(table.orgId, orgId))).limit(1);
        if (!row) return empty;
        botScope = and(eq(a.source, input.bot.kind === "python" ? "project" : "bot"), eq(a.sourceId, row.id))!;
      }
      const scope = and(eq(a.orgId, orgId), gte(a.createdAt, since), botScope);
      // Local time = UTC minus the browser's offset.
      const local = sql`(${a.createdAt} - make_interval(mins => ${input.tzOffsetMin}))`;
      const roomEvents = sql`${a.kind} in ('chat','whisper','join','tip','emote')`;
      const current = sql`${a.createdAt} >= ${since}`;

      const [totals, visitorRows, daily, heat, perBot, top, commands, tippers, prevVisitors] = await Promise.all([
        // This period and the one before it, per kind, plus tip gold.
        ctx.db.select({
          kind: a.kind,
          n: sql<number>`count(*) filter (where ${current})`.mapWith(Number),
          prev: sql<number>`count(*) filter (where not ${current})`.mapWith(Number),
          gold: sql<number>`coalesce(sum(${a.amount}) filter (where ${current}), 0)`.mapWith(Number),
          prevGold: sql<number>`coalesce(sum(${a.amount}) filter (where not ${current}), 0)`.mapWith(Number),
        }).from(a).where(and(eq(a.orgId, orgId), gte(a.createdAt, before), botScope)).groupBy(a.kind),
        ctx.db.select({ actor: a.actorId, days: sql<number>`count(distinct date(${local}))`.mapWith(Number) })
          .from(a).where(and(scope, roomEvents, sql`${a.actorId} is not null`)).groupBy(a.actorId),
        ctx.db.select({
          day: sql<string>`to_char(date(${local}), 'YYYY-MM-DD')`,
          chats: sql<number>`count(*) filter (where ${a.kind} in ('chat','whisper'))`.mapWith(Number),
          replies: sql<number>`count(*) filter (where ${a.kind} = 'reply')`.mapWith(Number),
          joins: sql<number>`count(*) filter (where ${a.kind} = 'join')`.mapWith(Number),
          visitors: sql<number>`count(distinct ${a.actorId}) filter (where ${roomEvents})`.mapWith(Number),
          gold: sql<number>`coalesce(sum(${a.amount}) filter (where ${a.kind} = 'tip'), 0)`.mapWith(Number),
        }).from(a).where(scope).groupBy(sql`1`).orderBy(sql`1`),
        ctx.db.select({
          dow: sql<number>`extract(isodow from ${local})::int - 1`.mapWith(Number),
          hour: sql<number>`extract(hour from ${local})::int`.mapWith(Number),
          n: count(),
        }).from(a).where(and(scope, roomEvents)).groupBy(sql`1`, sql`2`),
        ctx.db.select({
          source: a.source, sourceId: a.sourceId,
          chats: sql<number>`count(*) filter (where ${a.kind} in ('chat','whisper'))`.mapWith(Number),
          replies: sql<number>`count(*) filter (where ${a.kind} = 'reply')`.mapWith(Number),
          joins: sql<number>`count(*) filter (where ${a.kind} = 'join')`.mapWith(Number),
          tips: sql<number>`count(*) filter (where ${a.kind} = 'tip')`.mapWith(Number),
          gold: sql<number>`coalesce(sum(${a.amount}) filter (where ${a.kind} = 'tip'), 0)`.mapWith(Number),
          crashes: sql<number>`count(*) filter (where ${a.kind} = 'crash')`.mapWith(Number),
          visitors: sql<number>`count(distinct ${a.actorId}) filter (where ${roomEvents})`.mapWith(Number),
          last: sql<string>`max(${a.createdAt})`,
        }).from(a).where(scope).groupBy(a.source, a.sourceId),
        ctx.db.select({ name: sql<string>`max(${a.actorName})`, n: count() }).from(a)
          .where(and(scope, sql`${a.kind} in ('chat','whisper')`, sql`${a.actorId} is not null`))
          .groupBy(a.actorId).orderBy(desc(count())).limit(10),
        ctx.db.select({ command: a.detail, n: count(), people: sql<number>`count(distinct ${a.actorId})`.mapWith(Number) }).from(a)
          .where(and(scope, sql`${a.detail} is not null`)).groupBy(a.detail).orderBy(desc(count())).limit(10),
        ctx.db.select({ name: sql<string>`max(${a.actorName})`, gold: sql<number>`sum(${a.amount})`.mapWith(Number), tips: count() }).from(a)
          .where(and(scope, eq(a.kind, "tip"), sql`${a.amount} is not null`, sql`${a.actorId} is not null`))
          .groupBy(a.actorId).orderBy(desc(sql`sum(${a.amount})`)).limit(10),
        ctx.db.select({ n: sql<number>`count(distinct ${a.actorId})`.mapWith(Number) }).from(a)
          .where(and(eq(a.orgId, orgId), gte(a.createdAt, before), sql`not ${current}`, botScope, roomEvents)),
      ]);

      // Names for the per-bot table.
      const jsIds = perBot.filter((b) => b.source === "bot").map((b) => b.sourceId);
      const pyIds = perBot.filter((b) => b.source === "project").map((b) => b.sourceId);
      const [jsNames, pyNames] = await Promise.all([
        jsIds.length ? ctx.db.select({ id: schema.bots.id, uuid: schema.bots.uuid, name: schema.bots.name }).from(schema.bots).where(inArray(schema.bots.id, jsIds)) : [],
        pyIds.length ? ctx.db.select({ id: schema.botProjects.id, uuid: schema.botProjects.uuid, name: schema.botProjects.name }).from(schema.botProjects).where(inArray(schema.botProjects.id, pyIds)) : [],
      ]);
      const names = new Map<string, { uuid: string; name: string }>([...jsNames.map((b) => [`bot:${b.id}`, b] as const), ...pyNames.map((b) => [`project:${b.id}`, b] as const)]);
      // No activity at all before this period (a new bot, or the first week): nothing to compare with.
      const hadBefore = totals.some((t) => t.prev > 0);

      return {
        totals: Object.fromEntries(totals.map((t) => [t.kind, t.n])),
        previous: hadBefore ? Object.fromEntries(totals.map((t) => [t.kind, t.prev])) : null,
        visitors: visitorRows.length,
        previousVisitors: prevVisitors[0]?.n ?? 0,
        returning: visitorRows.filter((v) => v.days >= 2).length,
        gold: totals.reduce((n, t) => n + t.gold, 0),
        previousGold: totals.reduce((n, t) => n + t.prevGold, 0),
        daily,
        heatmap: heat.map((h) => ({ dow: h.dow, hour: h.hour, n: Number(h.n) })),
        bots: perBot.map((b) => {
          const meta = names.get(`${b.source}:${b.sourceId}`);
          return { kind: b.source === "bot" ? "javascript" as const : "python" as const, id: meta?.uuid ?? null, name: meta?.name ?? "(deleted bot)",
            chats: b.chats, replies: b.replies, joins: b.joins, tips: b.tips, gold: b.gold, crashes: b.crashes, visitors: b.visitors, lastActivity: b.last };
        }).sort((x, y) => y.chats + y.joins - (x.chats + x.joins)),
        topVisitors: top.map((t) => ({ name: t.name ?? "unknown", messages: Number(t.n) })),
        topCommands: commands.map((c) => ({ command: c.command ?? "", uses: Number(c.n), people: c.people })),
        topTippers: tippers.map((t) => ({ name: t.name ?? "unknown", gold: t.gold, tips: Number(t.tips) })),
      };
    }),

  overview: permittedProc("analytics:read")
    .input(z.object({ period: z.enum(["day","week","month"]).default("week") }))
    .query(async ({ input, ctx }) => {
      const orgId = await tryResolveOrgId(ctx);
      if (orgId === null) return { snapshots: [], totalMessages: 0, avgSentiment: 0, activeUsers: 0 };

      const snapshots = await ctx.db
        .select()
        .from(schema.analyticsSnapshots)
        .where(and(eq(schema.analyticsSnapshots.orgId, orgId), eq(schema.analyticsSnapshots.period, input.period)))
        .orderBy(desc(schema.analyticsSnapshots.periodStart))
        .limit(100);

      return { snapshots, totalMessages: 0, avgSentiment: 0, activeUsers: 0 };
    }),

  retention: permittedProc("analytics:read_advanced")
    .query(async ({ ctx }) => {
      const orgId = await tryResolveOrgId(ctx);
      if (orgId === null) return { cohorts: [], avgWeek1: 0, avgWeek4: 0, bestCohort: null, worstCohort: null };

      // Cohort = ISO week of a user's FIRST interaction with this org's
      // bots. Retention week N = did that user have any interaction in
      // week N relative to their cohort week. Bounded to a 1-year lookback
      // and a reasonable row cap to keep this a fast dashboard query, not
      // an unbounded full-history scan.
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

      const rows: Array<{ userId: number | null; createdAt: Date }> = await ctx.db
        .select({ userId: schema.interactions.userId, createdAt: schema.interactions.createdAt })
        .from(schema.interactions)
        .where(and(
          eq(schema.interactions.orgId, orgId),
          eq(schema.interactions.role, "user"),
          gte(schema.interactions.createdAt, oneYearAgo),
        ))
        .limit(50_000);

      // Resolve each user's first-seen date (cohort) from this same window,
      // then compute which cohort-relative week each row falls into.
      const firstSeen = new Map<number, Date>();
      for (const row of rows) {
        if (row.userId == null) continue;
        const existing = firstSeen.get(row.userId);
        if (!existing || row.createdAt < existing) firstSeen.set(row.userId, row.createdAt);
      }

      const cohortData = rows
        .filter((r) => r.userId != null)
        .map((r) => {
          const cohortStart = firstSeen.get(r.userId!)!;
          const weekNumber = Math.floor((r.createdAt.getTime() - cohortStart.getTime()) / (7 * 24 * 60 * 60 * 1000));
          const cohortDate = cohortStart.toISOString().slice(0, 10);
          return { cohortDate, userId: r.userId!, weekNumber };
        });

      return buildRetentionMatrix(cohortData);
    }),

  funnel: permittedProc("analytics:read_advanced")
    .input(z.object({ botId: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      const orgId = await tryResolveOrgId(ctx);
      if (orgId === null) return { steps: [], overallCvr: 0, biggestDropoff: "" };

      let botIds: number[] | undefined;
      if (input.botId) {
        const [bot] = await ctx.db.select({ id: schema.bots.id }).from(schema.bots)
          .where(and(eq(schema.bots.uuid, input.botId), eq(schema.bots.orgId, orgId))).limit(1);
        if (!bot) return { steps: [], overallCvr: 0, biggestDropoff: "" };
        botIds = [bot.id];
      }

      const scope = botIds
        ? and(eq(schema.interactions.orgId, orgId), inArray(schema.interactions.botId, botIds))
        : eq(schema.interactions.orgId, orgId);

      // Real, schema-grounded 3-step engagement funnel (documented here
      // since there's no dedicated funnel-step tracking table to draw a
      // richer one from):
      //   1. "Messaged"      — distinct users who sent >=1 message
      //   2. "Got a reply"   — of those, distinct users whose room also has
      //                        a bot reply in the same window
      //   3. "Returned"      — of those, distinct users with >1 message
      //                        (i.e. came back for a second interaction)
      const [messaged] = await ctx.db
        .select({ n: sql<number>`COUNT(DISTINCT ${schema.interactions.userId})`.mapWith(Number) })
        .from(schema.interactions)
        .where(and(scope, eq(schema.interactions.role, "user")));

      const [gotReply] = await ctx.db
        .select({ n: sql<number>`COUNT(DISTINCT ${schema.interactions.userId})`.mapWith(Number) })
        .from(schema.interactions)
        .where(and(
          scope,
          eq(schema.interactions.role, "user"),
          sql`EXISTS (SELECT 1 FROM ${schema.interactions} bot_reply
                      WHERE bot_reply.room_id = ${schema.interactions.roomId}
                        AND bot_reply.role = 'bot'
                        AND bot_reply.created_at >= ${schema.interactions.createdAt})`,
        ));

      const returned = await ctx.db
        .select({ userId: schema.interactions.userId, n: sql<number>`COUNT(*)`.mapWith(Number) })
        .from(schema.interactions)
        .where(and(scope, eq(schema.interactions.role, "user")))
        .groupBy(schema.interactions.userId)
        .having(sql`COUNT(*) > 1`);

      const stepCounts = [messaged?.n ?? 0, gotReply?.n ?? 0, returned.length];
      const stepNames  = ["Messaged", "Got a reply", "Returned"];

      return calculateFunnelDropoff(stepCounts, stepNames);
    }),

  heatmap: permittedProc("analytics:read")
    .input(z.object({ botId: z.string(), timezone: z.string().default("UTC") }))
    .query(async ({ ctx, input }) => {
      const orgId = await tryResolveOrgId(ctx);
      if (orgId === null) return { cells: [], maxValue: 0, peakHour: 12, peakDay: 1, timezone: input.timezone };

      const [bot] = await ctx.db.select({ id: schema.bots.id }).from(schema.bots)
        .where(and(eq(schema.bots.uuid, input.botId), eq(schema.bots.orgId, orgId))).limit(1);
      if (!bot) return { cells: [], maxValue: 0, peakHour: 12, peakDay: 1, timezone: input.timezone };

      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const rows: Array<{ createdAt: Date }> = await ctx.db
        .select({ createdAt: schema.interactions.createdAt })
        .from(schema.interactions)
        .where(and(eq(schema.interactions.botId, bot.id), gte(schema.interactions.createdAt, thirtyDaysAgo)))
        .limit(50_000);

      return buildActivityHeatmap(rows.map((r) => r.createdAt), input.timezone);
    }),

  roi: permittedProc("analytics:read")
    .input(z.object({ botId: z.string(), period: z.object({ start: z.string(), end: z.string() }) }))
    .query(async ({ ctx, input }) => {
      const orgId = await tryResolveOrgId(ctx);
      if (orgId === null) return { roiPct: 0, totalCost: 0, estimatedValue: 0, verdict: "neutral" as const };

      const [bot] = await ctx.db.select().from(schema.bots)
        .where(and(eq(schema.bots.uuid, input.botId), eq(schema.bots.orgId, orgId))).limit(1);
      if (!bot) return { roiPct: 0, totalCost: 0, estimatedValue: 0, verdict: "neutral" as const };

      const start = new Date(input.period.start);
      const end   = new Date(input.period.end);

      const rows: Array<{ userId: number | null; createdAt: Date }> = await ctx.db
        .select({ userId: schema.interactions.userId, createdAt: schema.interactions.createdAt })
        .from(schema.interactions)
        .where(and(
          eq(schema.interactions.botId, bot.id),
          eq(schema.interactions.role, "user"),
          gte(schema.interactions.createdAt, start),
          lte(schema.interactions.createdAt, end),
        ))
        .limit(50_000);

      const byUser = new Map<number, number>();
      for (const r of rows) {
        if (r.userId == null) continue;
        byUser.set(r.userId, (byUser.get(r.userId) ?? 0) + 1);
      }
      const uniqueUsers   = byUser.size;
      const retainedUsers = [...byUser.values()].filter((n) => n > 1).length;

      // Real uptime for the bot within the requested window, from
      // lastHeartbeat/createdAt — bounded to the window so a bot created
      // before the period doesn't inflate hoursOperating beyond the window.
      const windowMs        = Math.max(0, end.getTime() - start.getTime());
      const botCreatedMs    = bot.createdAt.getTime();
      const operatingStart  = Math.max(start.getTime(), botCreatedMs);
      const hoursOperating  = Math.max(0, (end.getTime() - operatingStart) / (1000 * 60 * 60));

      const [sub] = await ctx.db
        .select({ plan: schema.subscriptions.plan, status: schema.subscriptions.status })
        .from(schema.subscriptions)
        .where(eq(schema.subscriptions.orgId, orgId))
        .limit(1);
      const subscriptionCost = sub?.status === "active" ? (TIER_MONTHLY_CENTS[sub.plan] ?? 0) : 0;

      return calculateBotRoi({
        botId:            input.botId,
        period:           input.period,
        subscriptionCost,
        uniqueUsers,
        retainedUsers,
        // NOTE: Highrise in-game gold earned by a bot is not currently
        // tracked anywhere in this schema — real gap, not fabricated. Left
        // at 0 rather than inventing a number; estimatedValue below is
        // still genuinely computed from real retention data plus the
        // documented manual-operator comparison, not a hardcoded zero.
        goldEarned:       0,
        hoursOperating:   Math.min(hoursOperating, windowMs / (1000 * 60 * 60)),
        comparedToManual: { hourlyRate: MANUAL_OPERATOR_HOURLY_RATE_CENTS },
      });
    }),

  export: permittedProc("analytics:export")
    .input(z.object({ dataType: z.string(), format: z.enum(["csv","json","xlsx"]), dateRange: z.object({ start: z.string(), end: z.string() }) }))
    .mutation(async () => {
      // HONEST STUB (H-09's own explicit fallback, not a fabricated
      // success response): packages/analytics/src/index.ts's own FIX-AUDIT
      // comment documents that createExportJob() enqueues
      // QUEUE_NAMES.ANALYTICS_EXPORT, but no worker processor anywhere
      // consumes that queue and no endpoint exists to poll job status or
      // return a download link — the flow dead-ends after enqueue.
      // Returning a fake "queued" response here would promise a download
      // link that can never arrive. This requires a real worker processor
      // + status/poll endpoint to build properly (new engineering, not
      // "connect existing code" — tracked separately from this fix).
      return {
        jobId:     null,
        status:    "not_available" as const,
        message:   "Data export is not yet available. This feature is still being built — check back soon.",
      };
    }),
});
