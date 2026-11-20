/**
 * Daily check-up — once a day, for bots that have it switched on, look at
 * the last 24 hours: crashes and Python errors from the console log, plus
 * how busy the room was. A day with errors starts Kojy on fixing them right
 * away, within the same limits as a crash fix (autoFix.ts).
 * OWNERSHIP: apps/runner/src/agent
 *
 * Errors are grouped by kind (the error with names and numbers taken out,
 * plus where in the bot's code it happened) and counted, so one bug hit by
 * fifty visitors is one line, not fifty. Kinds not seen at the last check-up
 * are marked new. A clean day only says so in the chat when the day before
 * wasn't clean, or once a week — not every day.
 */

import { and, desc, eq, gte, isNull, lt, or, count } from "drizzle-orm";
import type { Database } from "@kojyai/db";
import { botProjects, botActivity, projectMessages } from "@kojyai/db/schema";
import { readLogs, type LogLine } from "@kojyai/shared/projects";
import { createLogger } from "../logger.js";
import { untrusted } from "./prompt.js";
import { crashLocation, crashSignature, lastException, normalizeError } from "./autoFix.js";
import type { IncidentLedger } from "../incidents.js";

const log = createLogger("checkup");
const DAY = 86_400_000;
/** A clean day is mentioned at least this often even when nothing changed. */
const CLEAN_NOTE_EVERY_MS = 7 * DAY;
const MAX_KINDS = 10;

export interface ErrorKind {
  /** What identifies the kind: the same signature a crash of it gets (normalized error + function, no line number). */
  key: string;
  /** One real example of the error line. */
  example: string;
  /** Where in the bot's own code ("bot.py:302 in on_user_join"), if known. */
  where: string;
  count: number;
  firstTs: number;
  lastTs: number;
}

/** Stored with each check-up message, to compare with the next one. */
export interface CheckupData { clean: boolean; kinds: string[] }

const ERROR_LINE = /(Traceback|Error|Exception)/;
const TRACEBACK_START = /Traceback \(most recent call last\)/;

/**
 * Groups the error output of `lines` (stderr) into kinds. A traceback (with
 * its frames) is one occurrence of its final exception; other error lines
 * are grouped by their normalized text.
 */
export function groupErrors(lines: LogLine[]): ErrorKind[] {
  const kinds = new Map<string, ErrorKind>();
  const add = (key: string, example: string, where: string, ts: number) => {
    const k = kinds.get(key);
    if (k) { k.count++; k.lastTs = Math.max(k.lastTs, ts); return; }
    kinds.set(key, { key, example: example.trim().slice(0, 240), where, count: 1, firstTs: ts, lastTs: ts });
  };
  const err = lines.filter((l) => l.stream === "stderr");
  for (let i = 0; i < err.length; i++) {
    const l = err[i]!;
    if (TRACEBACK_START.test(l.line)) {
      // Collect the traceback until its exception line (exception groups nest more tracebacks inside).
      const block: string[] = [l.line];
      let j = i + 1;
      for (; j < err.length && j < i + 400; j++) {
        block.push(err[j]!.line);
        const t = err[j]!.line.replace(/^[\s|+-]+/, "").trim();
        if (/^[A-Za-z_][\w.]*(Error|Exception|Exit|Interrupt|Warning)\b/.test(t) && !/^(Base)?ExceptionGroup\b/.test(t)) {
          // An exception group lists more sub-tracebacks; the last exception line wins.
          if (!(err[j + 1] && /^\s*[|+]/.test(err[j + 1]!.line))) break;
        }
      }
      const ex = lastException(block);
      if (ex) add(crashSignature(block), ex, crashLocation(block), l.ts);
      i = j;
      continue;
    }
    if (ERROR_LINE.test(l.line) && !/\bINFO\b/.test(l.line)) add(normalizeError(l.line), l.line, "", l.ts);
  }
  return [...kinds.values()].sort((a, b) => b.count - a.count || b.lastTs - a.lastTs);
}

export function describeKinds(kinds: ErrorKind[], previous: Set<string> | null): string {
  return kinds.slice(0, MAX_KINDS).map((k) => {
    const isNew = previous !== null && !previous.has(k.key);
    return `- ×${k.count}${isNew ? " NEW" : ""}${k.where ? ` at ${k.where}` : ""}: ${k.example}`;
  }).join("\n") + (kinds.length > MAX_KINDS ? `\n- …and ${kinds.length - MAX_KINDS} more kinds` : "");
}

/** Kinds stored by older check-ups had a line number in them ("bot.py:302 in f"); now they don't. */
const sameKey = (key: string) => key.replace(/:\d+ in /, " in ");

export async function runCheckups(db: Database, startAgent: (uuid: string) => void, incidents?: IncidentLedger): Promise<void> {
  const due = await db.select().from(botProjects)
    .where(and(eq(botProjects.dailyCheckup, true), or(isNull(botProjects.lastCheckupAt), lt(botProjects.lastCheckupAt, new Date(Date.now() - DAY)))));
  for (const project of due) {
    try {
      await checkOne(db, project, startAgent, incidents);
    } catch (err) {
      log.warn({ err, project: project.uuid }, "Check-up failed");
    }
  }
}

/** The newest check-up result in the bot's chat (null when none, e.g. after "New chat"). */
async function lastCheckup(db: Database, thread: string): Promise<{ data: CheckupData; at: number } | null> {
  const rows = await db.select({ data: projectMessages.data, createdAt: projectMessages.createdAt }).from(projectMessages)
    .where(and(eq(projectMessages.thread, thread), or(eq(projectMessages.kind, "checkup"), eq(projectMessages.kind, "event"))))
    .orderBy(desc(projectMessages.id)).limit(200);
  for (const r of rows) {
    const c = (r.data as { checkup?: CheckupData } | null)?.checkup;
    if (c) return { data: c, at: r.createdAt.getTime() };
  }
  return null;
}

async function checkOne(db: Database, project: typeof botProjects.$inferSelect, startAgent: (uuid: string) => void, incidents?: IncidentLedger): Promise<void> {
  const since = Date.now() - DAY;
  await db.update(botProjects).set({ lastCheckupAt: new Date() }).where(eq(botProjects.id, project.id));

  const counts = await db.select({ kind: botActivity.kind, n: count() }).from(botActivity)
    .where(and(eq(botActivity.source, "project"), eq(botActivity.sourceId, project.id), gte(botActivity.createdAt, new Date(since))))
    .groupBy(botActivity.kind);
  const n = (k: string) => Number(counts.find((c) => c.kind === k)?.n ?? 0);

  // Errors printed in the last day (the log keeps the latest ~2 MB).
  const lines = readLogs(project.uuid, 0, 2 * 1024 * 1024).lines.filter((l) => l.ts >= since);
  // Errors an automatic fix is already working on are left to it.
  const working = incidents ? await incidents.workingOn(project.id) : new Set<string>();
  const all = groupErrors(lines);
  const kinds = all.filter((k) => !working.has(k.key));
  const thread = `project:${project.id}`;
  const summary = `${n("chat") + n("whisper")} messages, ${n("reply")} replies, ${n("join")} joins, ${n("crash")} crashes`;
  const previous = await lastCheckup(db, thread);
  const data: CheckupData = { clean: !kinds.length && n("crash") === 0, kinds: kinds.map((k) => k.key) };

  if (!kinds.length && all.length) {
    // Every error of the day is already being fixed automatically: say so, don't start a second fix.
    await db.insert(projectMessages).values({ thread, projectId: project.id, role: "assistant", kind: "event", data: { checkup: { clean: false, kinds: all.map((k) => k.key) } },
      content: `🩺 Daily check-up: ${all.length} kind${all.length === 1 ? "" : "s"} of error in the last 24 hours (${summary}), all already being fixed automatically.` });
    return;
  }

  if (data.clean) {
    // Quiet unless it's news (the last check-up found errors) or a week has passed.
    if (previous && previous.data.clean && Date.now() - previous.at < CLEAN_NOTE_EVERY_MS) return;
    const news = previous && !previous.data.clean ? " The errors from the last check-up are gone." : "";
    await db.insert(projectMessages).values({ thread, projectId: project.id, role: "assistant", kind: "event", data: { checkup: data },
      content: `🩺 Daily check-up: no errors in the last 24 hours (${summary}).${news}` });
    return;
  }
  const before = previous ? new Set(previous.data.kinds.map(sameKey)) : null;
  const fresh = before ? kinds.filter((k) => !before.has(k.key)).length : 0;
  await db.insert(projectMessages).values({ thread, projectId: project.id, role: "user", kind: "checkup", data: { checkup: data },
    content: `Daily check-up for the last 24 hours: ${summary}. ${kinds.length} kind${kinds.length === 1 ? "" : "s"} of error${fresh ? ` (${fresh} new since the last check-up)` : ""}, most frequent first (from the bot, not from the owner):\n` +
      `${kinds.length ? untrusted(describeKinds(kinds, before)) : "(crashes without a printed error)"}\n\n` +
      "Find what causes them, starting with the most frequent and the NEW ones, and fix them now without waiting for me: the smallest fix for each, checked with check_code, test_in_room and run_saved_tests, then restart the bot with bot_control and confirm with get_logs that it's back in the room. " +
      "If one is harmless or outside the bot (e.g. Highrise was down), just say so. Finish with one or two sentences per error: what was wrong and what you changed." });
  startAgent(project.uuid);
}
