/**
 * Daily check-up — once a day, for bots that have it switched on, look at
 * the last 24 hours: crashes and Python errors from the console log, plus
 * how busy the room was. A clean day gets a one-line note in the bot's chat
 * (no AI used); a day with errors starts Kojy on them with a plan-first
 * request (so nothing changes without the owner's approval).
 * OWNERSHIP: apps/runner/src/agent
 */

import { and, eq, gte, isNull, lt, or, count } from "drizzle-orm";
import type { Database } from "@kojyai/db";
import { botProjects, botActivity, projectMessages } from "@kojyai/db/schema";
import { readLogs } from "@kojyai/shared/projects";
import { createLogger } from "../logger.js";

const log = createLogger("checkup");
const DAY = 86_400_000;

export async function runCheckups(db: Database, startAgent: (uuid: string) => void): Promise<void> {
  const due = await db.select().from(botProjects)
    .where(and(eq(botProjects.dailyCheckup, true), or(isNull(botProjects.lastCheckupAt), lt(botProjects.lastCheckupAt, new Date(Date.now() - DAY)))));
  for (const project of due) {
    try {
      await checkOne(db, project, startAgent);
    } catch (err) {
      log.warn({ err, project: project.uuid }, "Check-up failed");
    }
  }
}

async function checkOne(db: Database, project: typeof botProjects.$inferSelect, startAgent: (uuid: string) => void): Promise<void> {
  const since = Date.now() - DAY;
  await db.update(botProjects).set({ lastCheckupAt: new Date() }).where(eq(botProjects.id, project.id));

  const counts = await db.select({ kind: botActivity.kind, n: count() }).from(botActivity)
    .where(and(eq(botActivity.source, "project"), eq(botActivity.sourceId, project.id), gte(botActivity.createdAt, new Date(since))))
    .groupBy(botActivity.kind);
  const n = (k: string) => Number(counts.find((c) => c.kind === k)?.n ?? 0);

  // Errors printed in the last day (the log keeps the latest ~2 MB).
  const lines = readLogs(project.uuid, 0, 2 * 1024 * 1024).lines.filter((l) => l.ts >= since);
  const errorLines = lines.filter((l) => l.stream === "stderr" && /(Traceback|Error|Exception)/.test(l.line) && !/\bINFO\b/.test(l.line));
  const distinct = [...new Set(errorLines.map((l) => l.line.trim()))].slice(0, 12);
  const thread = `project:${project.id}`;
  const summary = `${n("chat") + n("whisper")} messages, ${n("reply")} replies, ${n("join")} joins, ${n("crash")} crashes`;

  if (!distinct.length && n("crash") === 0) {
    await db.insert(projectMessages).values({ thread, projectId: project.id, role: "assistant", kind: "event",
      content: `🩺 Daily check-up: no errors in the last 24 hours (${summary}).` });
    return;
  }
  await db.insert(projectMessages).values({ thread, projectId: project.id, role: "user", kind: "checkup",
    content: `Daily check-up for the last 24 hours: ${summary}. Errors seen:\n${distinct.join("\n") || "(crashes without a printed error)"}\n\nFind what causes them. If a fix is needed, explain it in one or two sentences and use propose_plan — don't change anything until I approve. If it's harmless or outside the bot (e.g. Highrise was down), just say so.` });
  startAgent(project.uuid);
}
