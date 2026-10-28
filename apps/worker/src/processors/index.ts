/**
 * Worker Processors — All Domains
 * OWNERSHIP: apps/worker/src/processors
 *
 * ARCHITECTURE:
 * The worker does NOT import from apps/api at all.
 * Bot lifecycle actions (start/stop/restart) are coordinated via:
 *   - DB status updates  → the API's runtime manager polls DB and reacts
 *   - Redis pub/sub      → publishBotEvent() signals the API WS gateway
 *
 * This keeps the worker fully independent from the API process.
 */

import type { Job }          from "bullmq";
import { db, schema }        from "../db/client.js";
import { getRedis, getRedisPublisher, publishBotEvent, publishBotControl } from "../services/redis.js";
import { notifyUser, sendAlert } from "@kojyai/db";
import { createLogger }      from "../services/logger.js";
import { eq, and, lt, gte }  from "drizzle-orm"; // FIX-20: gte added for analytics lower bound
import { compressBatch, groupMemoriesForCompression } from "@kojyai/engine/memory";
import { scoreSentiment }    from "@kojyai/engine/intelligence";

const log       = createLogger("processors");
// ─── Memory Compression ───────────────────────────────────────────────────────

export async function processMemoryCompression(job: Job): Promise<void> {
  const { botId, type } = job.data as { botId?: string; type: string };
  log.info({ botId, type }, "Memory compression starting");

  const conditions: any[] = [eq(schema.botMemories.compressionState, "raw")];
  if (botId) {
    const [bot] = await db.select({ id: schema.bots.id, orgId: schema.bots.orgId })
      .from(schema.bots).where(eq(schema.bots.uuid, botId)).limit(1);
    if (bot) conditions.push(eq(schema.botMemories.botId, bot.id));
  }

  const rawMemories = await db.select().from(schema.botMemories)
    .where(and(...conditions)).limit(200);
  if (rawMemories.length < 3) { log.info("Not enough raw memories to compress"); return; }

  const byBot = new Map<number, typeof rawMemories>();
  for (const m of rawMemories) {
    if (!byBot.has(m.botId)) byBot.set(m.botId, []);
    byBot.get(m.botId)!.push(m);
  }

  for (const [bid, mems] of byBot) {
    const [bot] = await db.select({ uuid: schema.bots.uuid, orgId: schema.bots.orgId })
      .from(schema.bots).where(eq(schema.bots.id, bid)).limit(1);
    if (!bot) continue;

    const batches = groupMemoriesForCompression(mems as any, bot.uuid, String(bot.orgId));

    for (const batch of batches) {
      const result = await compressBatch(batch);
      if (!result.success) { log.warn({ error: result.error }, "Batch compression failed"); continue; }

      await db.insert(schema.botMemories).values({
        uuid:             `cmp-${Date.now()}`,
        botId:            bid,
        orgId:            bot.orgId,
        type:             "semantic",
        summary:          result.summary,
        importance:       result.avgImportance,
        compressionState: "compressed",
        relatedEntities:  [],
      });

      await Promise.all(batch.memories.map((m) =>
        db.update(schema.botMemories)
          .set({ compressionState: "compressed" })
          .where(eq(schema.botMemories.id, parseInt(m.id))),
      ));

      log.info({ botId: bot.uuid, memories: result.memoriesCompressed, tokens: result.tokensUsed }, "Batch compressed");
    }
  }
}

// ─── Analytics Aggregation ────────────────────────────────────────────────────

export async function processAnalyticsAggregation(job: Job): Promise<void> {
  const { period } = job.data as { period: "hour" | "day" | "week" | "month" };
  log.info({ period }, "Analytics aggregation starting");

  const orgs = await db.select({ id: schema.organizations.id })
    .from(schema.organizations).where(eq(schema.organizations.status, "active"));

  for (const org of orgs) {
    const now         = new Date();
    const periodStart = new Date(now);

    if (period === "hour")  periodStart.setMinutes(0, 0, 0);
    if (period === "day")   periodStart.setHours(0, 0, 0, 0);
    if (period === "week")  { periodStart.setDate(periodStart.getDate() - periodStart.getDay()); periodStart.setHours(0,0,0,0); }
    if (period === "month") { periodStart.setDate(1); periodStart.setHours(0, 0, 0, 0); }

    // FIX-20: lower bound added — previously only lt(now) meant full-history scans
    // on busy orgs, hitting the 10_000 limit before recent rows were reached.
    const interactions = await db.select().from(schema.interactions)
      .where(and(
        eq(schema.interactions.orgId, org.id),
        gte(schema.interactions.createdAt, periodStart),
        lt(schema.interactions.createdAt, now),
      ))
      .limit(10_000);

    const totalMessages = interactions.length;
    const avgSentiment  = interactions.reduce((s, i) => s + (i.sentiment ?? 0), 0) / Math.max(interactions.length, 1);

    await db.insert(schema.analyticsSnapshots).values({
      orgId:       org.id,
      metricType:  "messages",
      metricValue: totalMessages,
      dimensions:  { avgSentiment },
      period:      period as any,
      periodStart,
    }).onConflictDoUpdate({
      target: [schema.analyticsSnapshots.orgId, schema.analyticsSnapshots.botId, schema.analyticsSnapshots.metricType,
               schema.analyticsSnapshots.period, schema.analyticsSnapshots.periodStart],
      set: { metricValue: totalMessages },
    }).catch(() => null);
  }
}

// ─── Notification Delivery ────────────────────────────────────────────────────

export async function processNotificationDelivery(job: Job): Promise<void> {
  const { userId, type, title, body, actionUrl } = job.data as {
    userId: number; type: string; title: string; body: string; actionUrl?: string;
  };

  const [row] = await db.insert(schema.notifications).values({
    userId, type: type as any, title, body, actionUrl: actionUrl ?? null,
  }).returning({ id: schema.notifications.id });

  const redis = getRedisPublisher();
  if (redis) {
    // SECURITY FIX (H-16): userId was available in this function's own
    // scope the whole time (used two lines above for the DB insert) but was
    // never attached to the live push event — meaning every notification
    // for any user broadcast to every connected client. Now included.
    await redis.publish("system", JSON.stringify({
      type: "notification", userId, notificationId: String(row!.id), title, body, notificationType: type, ts: Date.now(),
    }));
  }
}

// ─── Churn Prediction ─────────────────────────────────────────────────────────

export async function processChurnPrediction(job: Job): Promise<void> {
  log.info("Churn prediction sweep starting");
  const orgs = await db.select({ id: schema.organizations.id })
    .from(schema.organizations).where(eq(schema.organizations.status, "active")).limit(50);

  for (const org of orgs) {
    const bots = await db.select({
      id: schema.bots.id, status: schema.bots.status, lastSeen: schema.bots.lastSeen,
    }).from(schema.bots).where(eq(schema.bots.orgId, org.id));

    const onlineCount = bots.filter((b) => b.status === "online").length;
    const riskScore   = bots.length === 0 ? 0 : 1 - (onlineCount / bots.length);

    await db.insert(schema.analyticsSnapshots).values({
      orgId:       org.id,
      metricType:  "churn_risk_avg",
      metricValue: riskScore,
      dimensions:  { botCount: bots.length, onlineCount },
      period:      "day",
      periodStart: new Date(),
    }).onConflictDoUpdate({
      target: [schema.analyticsSnapshots.orgId, schema.analyticsSnapshots.botId, schema.analyticsSnapshots.metricType,
               schema.analyticsSnapshots.period, schema.analyticsSnapshots.periodStart],
      set: { metricValue: riskScore },
    }).catch(() => null);
  }

  log.info({ orgsProcessed: orgs.length }, "Churn prediction sweep complete");
}

// ─── Relationship Update ──────────────────────────────────────────────────────

export async function processRelationshipUpdate(job: Job): Promise<void> {
  const { botId, targetId, targetType, sentiment } = job.data as {
    botId: number; targetId: number; targetType: string; sentiment: number;
  };

  const [existing] = await db.select().from(schema.botRelationships)
    .where(and(eq(schema.botRelationships.botId, botId), eq(schema.botRelationships.targetId, targetId)))
    .limit(1);

  const DELTA = 0.03 * sentiment;

  if (existing) {
    await db.update(schema.botRelationships).set({
      trust:            Math.max(-1, Math.min(1, existing.trust + DELTA)),
      affinity:         Math.max(-1, Math.min(1, existing.affinity + DELTA * 1.5)),
      loyalty:          Math.max(0,  Math.min(1, existing.loyalty + 0.005)),
      interactionCount: existing.interactionCount + 1,
      lastUpdated:      new Date(),
    }).where(eq(schema.botRelationships.id, existing.id));
  } else {
    await db.insert(schema.botRelationships).values({
      botId, targetType, targetId, type: "neutral",
      trust: DELTA, loyalty: 0.01, affinity: DELTA * 1.5, interactionCount: 1,
    }).catch(() => null);
  }
}

// ─── Moderation Scan ──────────────────────────────────────────────────────────

export async function processModerationScan(job: Job): Promise<void> {
  const { content, botId, userId } = job.data as {
    content: string; botId: number; userId: number; roomId: number;
  };

  const { scanToxicityFast, scanToxicityDeep } = await import("@kojyai/security");
  const fastResult = scanToxicityFast(content);

  // SECURITY FIX (H-20): escalate borderline ("warn") results to the
  // AI-based deep scan for a more accurate verdict — previously only the
  // fast regex tier ever ran, and only its "block" outcome (score > 0.7)
  // was recorded; a "warn"-tier message (0.3–0.7) that a deep scan would
  // confirm as genuinely toxic was silently allowed through with no record
  // at all.
  let finalResult = fastResult;
  if (fastResult.action === "warn") {
    finalResult = await scanToxicityDeep(content);
  }

  if (finalResult.isToxic && (finalResult.action === "block" || finalResult.action === "warn")) {
    log.warn({ botId, userId, categories: finalResult.categories, escalated: fastResult.action === "warn" }, "Toxic content detected");
    const [bot] = await db.select({ orgId: schema.bots.orgId }).from(schema.bots).where(eq(schema.bots.id, botId)).limit(1);
    await db.insert(schema.securityEvents).values({
      orgId:    bot?.orgId ?? null,
      severity: finalResult.action === "block" ? "medium" : "low",
      category: "toxicity", actorId: userId,
      ip:       "unknown",
      payload:  { content: content.slice(0, 100), categories: finalResult.categories, score: finalResult.score, escalatedToDeepScan: fastResult.action === "warn" },
      resolved: false,
    });
  }
}

// ─── Backup Automation ────────────────────────────────────────────────────────
//
// pg_dump (custom format, already compressed) → BACKUP_DIR, newest
// BACKUP_KEEP_DAYS kept. Optionally also copied to S3 when S3_BUCKET (or
// AWS_S3_BUCKET) is set — a single-server install backs up to its own disk
// volume and never needs a cloud bucket.
//   BACKUP_DIR        default /app/backups (a docker volume in production)
//   BACKUP_KEEP_DAYS  default 14
// Restore: pg_restore --clean --if-exists -d "$DATABASE_URL" <file>.dump

const BACKUP_FILE = /^kojyai-(\d{4}-\d{2}-\d{2})T\d{2}-\d{2}-\d{2}-\d{3}Z\.dump$/;

export async function processBackupAutomation(job: Job): Promise<void> {
  // No shell anywhere: every external command is spawned array-form, and the
  // database password only ever travels in the child's environment.
  const { spawn, execFile } = await import("child_process");
  const { promisify }       = await import("util");
  const { mkdirSync, readdirSync, statSync, unlinkSync } = await import("fs");
  const path = await import("path");
  const execFileAsync = promisify(execFile);

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is required for backup automation");

  const backupDir = process.env.BACKUP_DIR ?? "/app/backups";
  const keepDays  = Math.max(1, Number(process.env.BACKUP_KEEP_DAYS ?? 14) || 14);
  const bucket    = process.env.S3_BUCKET ?? process.env.AWS_S3_BUCKET;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName  = `kojyai-${timestamp}.dump`;
  const dumpFile  = path.join(backupDir, fileName);

  // pg_dump takes the connection as discrete args so the password never
  // appears in a process listing.
  const url = new URL(dbUrl);
  const args = [
    `--host=${url.hostname}`,
    `--port=${url.port || "5432"}`,
    `--username=${decodeURIComponent(url.username)}`,
    "--format=custom",
    "--no-owner",
    `--file=${dumpFile}`,
    "--",
    url.pathname.replace(/^\//, ""),
  ];

  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  log.info({ dumpFile, jobId: job.id }, "Backup starting");

  try {
    await new Promise<void>((resolve, reject) => {
      const dump = spawn("pg_dump", args, {
        env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      dump.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 4000) stderr += chunk.toString(); });
      dump.on("error", reject);
      dump.on("close", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`pg_dump failed (${code ?? signal}): ${stderr.trim()}`));
      });
    });

    const { size } = statSync(dumpFile);
    log.info({ dumpFile, sizeBytes: size }, "pg_dump complete");

    if (bucket) {
      const region = process.env.AWS_REGION ?? "us-east-1";
      await execFileAsync("aws", [
        "s3", "cp", dumpFile, `s3://${bucket}/backups/${fileName}`,
        "--region", region, "--storage-class", "STANDARD_IA", "--no-progress",
      ]);
      log.info({ bucket, fileName }, "Backup copied to S3");
    }
    // A backup you can't restore isn't a backup: check the archive reads
    // back, and once a week (or when BACKUP_RESTORE_TEST=always) restore it
    // into a throwaway database and count the rows.
    const pgEnv = { ...process.env, PGPASSWORD: decodeURIComponent(url.password) };
    const conn = [`--host=${url.hostname}`, `--port=${url.port || "5432"}`, `--username=${decodeURIComponent(url.username)}`];
    const { stdout: listing } = await execFileAsync("pg_restore", ["--list", dumpFile], { maxBuffer: 32 * 1024 * 1024 });
    const entries = listing.split("\n").filter((l) => /^\d+;/.test(l)).length;
    if (entries < 10) throw new Error(`Backup looks empty (${entries} entries)`);

    let drill: Record<string, number> | null = null;
    if (process.env.BACKUP_RESTORE_TEST === "always" || new Date().getUTCDay() === 0) {
      const scratch = `kojyai_restore_check_${Date.now()}`;
      try {
        await execFileAsync("createdb", [...conn, scratch], { env: pgEnv });
        await execFileAsync("pg_restore", [...conn, "--no-owner", `--dbname=${scratch}`, dumpFile], { env: pgEnv, maxBuffer: 32 * 1024 * 1024 });
        const { stdout } = await execFileAsync("psql", [...conn, "--dbname", scratch, "-At", "-c",
          "select (select count(*) from users), (select count(*) from bots), (select count(*) from bot_projects), (select count(*) from project_secrets)"], { env: pgEnv });
        const [users, bots, projects, secrets] = stdout.trim().split("|").map(Number);
        drill = { users: users!, bots: bots!, projects: projects!, secrets: secrets! };
        log.info({ drill }, "Restore drill passed");
      } finally {
        await execFileAsync("dropdb", [...conn, "--if-exists", scratch], { env: pgEnv }).catch((e) => log.warn({ err: e }, "Couldn't drop restore-check database"));
      }
    }
    await getRedis()?.set("backup:last", JSON.stringify({ ok: true, file: fileName, size, at: Date.now(), entries, drill, drillAt: drill ? Date.now() : null }));
  } catch (err) {
    try { unlinkSync(dumpFile); } catch { /* nothing written */ }
    log.error({ err }, "Backup automation failed");
    const message = err instanceof Error ? err.message.slice(0, 300) : String(err);
    await getRedis()?.set("backup:last", JSON.stringify({ ok: false, at: Date.now(), error: message })).catch(() => undefined);
    if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
      const owners = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.role, "superadmin"));
      for (const o of owners) await notifyUser(db, o.id, "system", "Database backup failed", message, "/infrastructure");
      void sendAlert(`⚠️ KojyAI database backup failed: ${message}`);
    }
    throw err; // Let BullMQ retry per CRITICAL_JOB_OPTIONS
  }

  // Prune local backups past the retention window. Only files matching the
  // exact name this job writes are ever considered.
  try {
    const cutoff = new Date(Date.now() - keepDays * 24 * 3600 * 1000).toISOString().slice(0, 10);
    let pruned = 0;
    for (const name of readdirSync(backupDir)) {
      const m = BACKUP_FILE.exec(name);
      if (m && m[1]! < cutoff) {
        unlinkSync(path.join(backupDir, name));
        pruned++;
      }
    }
    log.info({ pruned, keepDays }, "Backup prune complete");
    // Analytics events older than 180 days (ANALYTICS_KEEP_DAYS) aren't shown anywhere.
    const keepActivity = Math.max(7, Number(process.env.ANALYTICS_KEEP_DAYS ?? 180) || 180);
    await db.delete(schema.botActivity).where(lt(schema.botActivity.createdAt, new Date(Date.now() - keepActivity * 86_400_000)));
  } catch (pruneErr) {
    // Best-effort: a prune failure must never fail a backup that succeeded.
    log.warn({ err: pruneErr }, "Backup prune failed (non-fatal)");
  }
}

// ─── Email Send ───────────────────────────────────────────────────────────────

// ─── Email template builder ───────────────────────────────────────────────────

interface EmailTemplate {
  subject:  string;
  html:     string;
  text:     string;
}

export function buildTemplate(type: string, data: Record<string, unknown> = {}): EmailTemplate {
  // SECURITY FIX (L-33): botName (and plan/link) come from user-controlled data and
  // were interpolated straight into HTML — a bot named `<img src=x onerror=...>` or
  // `</strong><a href="https://phish">` became markup in an email sent FROM our
  // domain (phishing / content injection; many clients also render remote images).
  // Everything interpolated into the HTML body is escaped; hrefs must be http(s);
  // values used in the plain-text SUBJECT are stripped of CR/LF (header injection).
  const escapeHtml = (v: string): string =>
    v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  const oneLine = (v: string): string => v.replace(/[\r\n\u2028\u2029]+/g, " ").trim().slice(0, 200);
  const hrefOf = (raw: string, fallback: string): string => {
    if (!raw) return fallback;
    try {
      const u = new URL(raw);
      return u.protocol === "https:" || u.protocol === "http:" ? escapeHtml(u.href) : "#";
    } catch { return "#"; }
  };

  const link      = String(data.link ?? "");
  const botPlain  = oneLine(String(data.botName ?? "your bot"));
  const planPlain = oneLine(String(data.plan ?? ""));
  const botName   = escapeHtml(botPlain);   // HTML-safe, for bodies
  const plan      = escapeHtml(planPlain);  // HTML-safe, for bodies
  const amount  = typeof data.amount === "number"
    ? `$${(data.amount / 100).toFixed(2)}`
    : "an outstanding amount";

  const base = (subject: string, body: string): EmailTemplate => ({
    subject,
    html: `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:520px;margin:40px auto;color:#0a0a1a">
<div style="background:linear-gradient(135deg,#7c3aed,#00b8f5);padding:24px;border-radius:12px 12px 0 0">
  <h1 style="color:#fff;margin:0;font-size:20px">KOJY<span style="color:#22d3a5">AI</span></h1>
</div>
<div style="background:#f9f9ff;padding:32px;border-radius:0 0 12px 12px;border:1px solid #e0e0f0">
  <p style="font-size:15px;line-height:1.6;color:#333">${body}</p>
  <p style="font-size:12px;color:#999;margin-top:32px">© ${new Date().getFullYear()} KOJYAI · AI-powered game civilizations</p>
</div></body></html>`,
    text: `${subject}

${body}

© ${new Date().getFullYear()} KOJYAI`,
  });

  switch (type) {
    case "verify_email":
      return base(
        "Verify your KOJYAI account",
        `Welcome aboard! Enter this code on the sign-in page to activate your account:<br><br>
<div style="font-size:28px;letter-spacing:6px;font-weight:700;font-family:monospace">${String(data["code"] ?? "").replace(/\D/g, "")}</div><br>
<a href="${hrefOf(link, "#")}" style="display:inline-block;background:#7c3aed;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Open sign-in →</a><br><br>
The code expires in 24 hours. If you didn't sign up for KOJYAI, ignore this email.`
      );

    case "welcome":
      return base(
        "Welcome to KOJYAI — your AI civilization awaits",
        `Your account is now active. Head to the Mission Control dashboard to create your first AI bot and watch it come to life in Highrise.<br><br>
<a href="${hrefOf(link, "https://app.kojyai.com")}" style="display:inline-block;background:#22d3a5;color:#0a0a1a;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Open Dashboard →</a>`
      );

    case "password_reset":
      return base(
        "Reset your KOJYAI password",
        `We received a request to reset your password. Click below to choose a new one.<br><br>
<a href="${hrefOf(link, "#")}" style="display:inline-block;background:#7c3aed;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Reset Password →</a><br><br>
This link expires in <strong>1 hour</strong>. If you didn't request a reset, you can safely ignore this email.`
      );

    case "billing_upgraded":
      return base(
        `You're now on the ${planPlain} plan 🎉`,
        `Your subscription has been upgraded to <strong>${plan}</strong>. Your new bot quota and features are active immediately.<br><br>
<a href="https://app.kojyai.com/settings/billing" style="display:inline-block;background:#22d3a5;color:#0a0a1a;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">View Plan Details →</a>`
      );

    case "billing_due":
      return base(
        "Action required — payment due on KOJYAI",
        `A payment of <strong>${amount}</strong> is due on your KOJYAI subscription. Please update your payment method to avoid service interruption.<br><br>
<a href="https://app.kojyai.com/settings/billing" style="display:inline-block;background:#ef4444;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Update Payment →</a>`
      );

    case "simulation_done":
      return base(
        "Your simulation is complete — KOJYAI",
        `Your simulation has finished running. View the full results, agent decision logs, and behavioral insights in the Simulation Studio.<br><br>
<a href="${hrefOf(link, "https://app.kojyai.com/simulation")}" style="display:inline-block;background:#00b8f5;color:#0a0a1a;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">View Results →</a>`
      );

    case "bot_offline":
      return base(
        `${botPlain} went offline — KOJYAI`,
        `Your bot <strong>${botName}</strong> has gone offline unexpectedly. Check Mission Control for the latest status and error details.<br><br>
<a href="${hrefOf(link, "https://app.kojyai.com/mission-control")}" style="display:inline-block;background:#f59e0b;color:#0a0a1a;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Open Mission Control →</a>`
      );

    // SECURITY/COMPLIANCE FIX (H-07): this case previously did not exist —
    // gdpr/service.ts's own comment claimed a "final confirmation email"
    // was sent, but nothing implemented it, and it fell through to the
    // generic default template with no GDPR-specific content at all.
    case "gdpr_erasure_confirmed":
      return base(
        "Your KOJYAI data has been erased",
        `As requested, your personal data on KOJYAI has been erased in accordance with GDPR Article 17 (Right to Erasure). Your account, bots, memories, and message history have been anonymized or deleted. Some records are retained in anonymized form only where required for legal/audit obligations.<br><br>
This is a confirmation that the erasure request submitted on ${new Date().toUTCString()} has completed. If you did not request this, contact support immediately.`
      );

    // FIX (found while implementing H-07, adjacent gap): "gdpr_cancel_stripe"
    // was enqueued from gdpr/service.ts's erasure flow but had no template
    // case here, silently falling through to the generic default.
    case "gdpr_cancel_stripe":
      return base(
        "Your KOJYAI subscription has been cancelled",
        `As part of processing your data erasure request, your active KOJYAI subscription has been cancelled. No further charges will occur. This is an automated confirmation — no action is needed from you.`
      );

    default:
      return base("KOJYAI Notification", "You have a new notification from KOJYAI.");
  }
}

export async function processEmailSend(job: Job): Promise<void> {
  const { type, email, data } = job.data as {
    type:   string;
    email:  string;
    data?:  Record<string, unknown>;
  };

  if (!email || !email.includes("@")) {
    log.warn({ type, email }, "Email send skipped — invalid address");
    return;
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is not set — email delivery is disabled. Set it in .env");
  }

  const tpl = buildTemplate(type, data ?? {});

  log.info({ type, to: email, subject: tpl.subject }, "Sending email");

  const response = await fetch("https://api.resend.com/emails", {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from:    "KOJYAI <noreply@kojyai.com>",
      to:      [email],
      subject: tpl.subject,
      html:    tpl.html,
      text:    tpl.text,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "unknown");
    // Throw so BullMQ retries the job
    throw new Error(`Resend API error ${response.status}: ${body}`);
  }

  const result = await response.json() as { id?: string };
  log.info({ type, to: email, messageId: result.id }, "Email sent successfully");
}

// ─── Bot Lifecycle ────────────────────────────────────────────────────────────
// The worker does NOT control bot loops directly (those run in the API process).
// Instead: update DB status → API runtime manager polls and reacts.
// Publish Redis event → API WS gateway fans out to connected clients.

export async function processBotLifecycle(job: Job): Promise<void> {
  const { action, botId, payload } = job.data as {
    action: "start" | "stop" | "restart" | "health_check" | "broadcast";
    botId:  string;
    payload?: Record<string, unknown>;
  };
  log.info({ action, botId }, "Bot lifecycle");

  const [bot] = await db.select().from(schema.bots).where(eq(schema.bots.uuid, botId)).limit(1);
  if (!bot) { log.error({ botId }, "Bot not found"); return; }

  switch (action) {
    case "start": {
      // Mark as "connecting" in DB — the API runtime manager (subscribed to
      // bot_control:*) performs the actual Highrise connection.
      await db.update(schema.bots).set({ status: "connecting" }).where(eq(schema.bots.id, bot.id));
      await publishBotControl(botId, "start");
      log.info({ botId }, "Bot start requested via DB + Redis");
      break;
    }
    case "stop": {
      await db.update(schema.bots).set({ status: "offline" }).where(eq(schema.bots.id, bot.id));
      await publishBotControl(botId, "stop");
      log.info({ botId }, "Bot stop requested");
      break;
    }
    case "restart": {
      await db.update(schema.bots).set({ status: "connecting" }).where(eq(schema.bots.id, bot.id));
      await publishBotControl(botId, "restart");
      log.info({ botId }, "Bot restart requested");
      break;
    }
    case "health_check": {
      const isStale = bot.lastHeartbeat
        ? Date.now() - new Date(bot.lastHeartbeat).getTime() > 90_000
        : true;
      if (isStale && bot.status === "online") {
        log.warn({ botId }, "Bot heartbeat stale — marking as error");
        await db.update(schema.bots).set({ status: "error", connectionError: "Heartbeat timeout" })
          .where(eq(schema.bots.id, bot.id));
        await publishBotEvent(botId, { type: "bot_status", botId, status: "error", error: "Heartbeat timeout", ts: Date.now() });
      }
      break;
    }
    case "broadcast": {
      const message = String(payload?.message ?? "");
      await publishBotControl(botId, "broadcast", { message });
      log.info({ botId, message }, "Broadcast requested");
      break;
    }
    default:
      log.warn({ action }, "Unknown lifecycle action");
  }
}
