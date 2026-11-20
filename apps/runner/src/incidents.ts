/**
 * Incidents — every problem a Python bot had, kept in bot_incidents: one row
 * per kind of problem (its signature), counted each time it happens again.
 * OWNERSHIP: apps/runner
 *
 * The supervisor records every exit nobody asked for (here or on a bot host);
 * the automatic fixes (agent.ts) move the incident along — queued, fixing,
 * waiting for an AI, watching a fix, fixed — and write in `note` what happens
 * next or why nothing does. The bot page shows them as "Problems", and Kojy
 * sees them in get_logs.
 *
 * classifyExit() decides what kind of problem an exit was from the console
 * lines it left. Only "code" and "frozen" are bugs Kojy fixes in the code;
 * the network being away isn't a bug, a missing secret value is something
 * only the owner has.
 */

import { and, desc, eq, inArray, lt, notInArray, sql } from "drizzle-orm";
import type { Database } from "@kojyai/db";
import { botIncidents, type IncidentData } from "@kojyai/db/schema";
import { createLogger } from "./logger.js";
import { crashExcerpt, crashLocation, crashSignature, isNetworkFailure, lastException, normalizeError } from "./agent/autoFix.js";
import { CONNECTED_PREFIX } from "./agent/botHealth.js";

const log = createLogger("incidents");

export type IncidentCategory =
  | "code" | "frozen" | "not_in_room" | "network" | "highrise_refused"
  | "missing_secret" | "missing_package" | "out_of_memory" | "unknown";
export type IncidentPhase = "import" | "startup" | "in_room" | "unknown";
export type IncidentState = "open" | "queued" | "fixing" | "waiting_for_ai" | "watching" | "fixed" | "ignored" | "needs_owner";
export type Incident = typeof botIncidents.$inferSelect;

/** States an automatic fix owns: a new occurrence doesn't reset them. */
export const WORKING_STATES: IncidentState[] = ["queued", "fixing", "waiting_for_ai", "watching"];
/** Bugs in the bot's own code — what Kojy fixes. */
export const FIXABLE = new Set<IncidentCategory>(["code", "frozen"]);

export interface ExitInfo {
  /** The bot's last console lines (stdout and stderr). */
  tail: string[];
  /** How it stopped: "code 1", "SIGKILL", "code 3, out of memory (512 MB limit)". */
  how: string;
  /** How long it ran (ms). */
  ranForMs: number;
}

export interface Classified {
  signature: string;
  category: IncidentCategory;
  phase: IncidentPhase;
  /** The error with names and numbers taken out (safe for the AI and the page). */
  summary: string;
  /** One real error line (for the owner). */
  example: string;
  fatal: boolean;
  /** The state and note it starts in, before an automatic fix looks at it. */
  state: IncidentState;
  note: string;
}

/** A run this long counts as having been in the room even when its "connected" line scrolled away. */
const IN_ROOM_AFTER_MS = 120_000;
const LOAD_FAILED = "[kojy] Can't load ";
const NO_ROOM_SECRETS = "[kojy] Add HIGHRISE_ROOM_ID and HIGHRISE_BOT_TOKEN";
const WATCHDOG = "[kojy] Watchdog:";
const SECRET_READ = /\b(?:os\.)?environ\s*\[|\benviron\.get\s*\(|\bgetenv\s*\(/;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** "bot.py:302 in on_join" → "on_join (bot.py)". */
function where(location: string): string {
  const m = /^(.*):\d+ in (.+)$/.exec(location);
  return m ? `${m[2]} (${m[1]})` : location;
}

/** What kind of problem an exit was, from the console lines it left. */
export function classifyExit(info: ExitInfo): Classified {
  const tail = info.tail.map((l) => l.trimEnd());
  const text = (prefix: string) => tail.find((l) => l.trim().startsWith(prefix));
  const connected = tail.some((l) => l.startsWith(CONNECTED_PREFIX));
  const ex = lastException(tail);
  const hasTraceback = crashExcerpt(tail) !== "";
  const phase: IncidentPhase = text(LOAD_FAILED) ? "import"
    : connected || info.ranForMs >= IN_ROOM_AFTER_MS ? "in_room"
    : hasTraceback ? "startup" : "unknown";
  const base = { phase, fatal: true, example: clip(ex, 240) };

  if (text(NO_ROOM_SECRETS)) {
    return { ...base, signature: "config:room-and-token", category: "missing_secret", summary: "HIGHRISE_ROOM_ID or HIGHRISE_BOT_TOKEN is missing", example: NO_ROOM_SECRETS,
      state: "needs_owner", note: "Add HIGHRISE_ROOM_ID and HIGHRISE_BOT_TOKEN in the bot's Secrets — only you have these values." };
  }
  if (hasTraceback && ex) {
    const location = crashLocation(tail);
    const summary = clip(`${normalizeError(ex)}${location ? ` in ${where(location)}` : ""}`, 300);
    if (isNetworkFailure(tail)) {
      const type = /^[\w.]+/.exec(ex.replace(/^[\s|+-]+/, ""))?.[0] ?? "network";
      return { ...base, signature: `network:${type}`, category: "network", summary,
        state: "ignored", note: "The network or Highrise was away — not a bug in the code. The bot restarts by itself." };
    }
    if (/^MemoryError\b/.test(ex)) {
      return { ...base, signature: crashSignature(tail), category: "out_of_memory", summary, state: "open", note: "The bot ran out of memory." };
    }
    const missingModule = /^ModuleNotFoundError: No module named '([\w.]+)'/.exec(ex);
    if (missingModule && phase === "import" && !location.startsWith(`${missingModule[1]!.split(".")[0]}.py`)) {
      const name = missingModule[1]!.split(".")[0]!;
      return { ...base, signature: `package:${name}`, category: "missing_package", summary: `The Python package for "${name}" isn't installed`,
        state: "open", note: `The bot imports "${name}", which isn't installed.` };
    }
    const missingKey = /^KeyError: '([A-Z][A-Z0-9_]{1,80})'$/.exec(ex);
    if (missingKey && tail.slice(-12).some((l) => SECRET_READ.test(l))) {
      const key = missingKey[1]!;
      return { ...base, signature: `secret:${key}`, category: "missing_secret", summary: `The secret ${key} isn't set`, example: ex,
        state: "needs_owner", note: `The bot reads ${key}, which isn't in its Secrets — add it there (only you have the value).` };
    }
    const frozen = /^BotFrozenError\b/.test(ex);
    return { ...base, signature: crashSignature(tail), category: frozen ? "frozen" : "code", summary, state: "open", note: "" };
  }
  if (text(WATCHDOG)) {
    return { ...base, signature: "watchdog:not_in_room", category: "not_in_room", summary: "Wasn't really in the room (Highrise didn't answer)", example: clip(text(WATCHDOG)!, 240),
      state: "ignored", note: "It wasn't really in the room any more, so the watchdog restarted it — not a bug in the code." };
  }
  if (/out of memory|SIGKILL/i.test(info.how)) {
    return { ...base, signature: "exit:out_of_memory", category: "out_of_memory", summary: "Killed for using too much memory", example: info.how,
      state: "open", note: "It was killed for using too much memory." };
  }
  const refused = [...tail].reverse().find((l) => l.startsWith("ERROR: ") && l !== "ERROR: reconnecting...");
  if (refused && !connected) {
    return { ...base, signature: `refused:${normalizeError(refused.replace(/ closing connection with ID: .*$/, ""))}`, category: "highrise_refused",
      summary: clip(normalizeError(refused), 300), example: clip(refused, 240),
      state: "needs_owner", note: "Highrise refused the bot. Check HIGHRISE_BOT_TOKEN and HIGHRISE_ROOM_ID in its Secrets." };
  }
  const how = info.how.replace(/\d+/g, "N");
  return { ...base, signature: `exit:${how}`, category: "unknown", summary: `Stopped without an error message (${info.how})`, example: info.how,
    state: "open", note: `It stopped without printing an error (${info.how}), so there's nothing in the code to go on yet. It was started again.` };
}

/** What changes on an incident (and, optionally, a line for its timeline). */
export interface IncidentPatch {
  state?: IncidentState;
  note?: string | null;
  retryAt?: Date | null;
  attempt?: boolean;
  fixSnapshotId?: string | null;
  fixFiles?: Record<string, string> | null;
  watchUntil?: Date | null;
}

const MAX_TIMELINE = 20;
/** Finished incidents older than this are removed. */
const KEEP_MS = 30 * 86_400_000;
const MAX_PER_PROJECT = 200;

/** Reads and writes bot_incidents. A database problem never breaks crash handling: it's logged and skipped. */
export class IncidentLedger {
  constructor(private db: Database) {}

  /** Counts an occurrence (a new incident, or one more of a known one) and returns the incident. */
  async record(projectId: number, c: Classified, exit: string, report?: Record<string, unknown>): Promise<Incident | null> {
    try {
      const [before] = await this.db.select({ state: botIncidents.state }).from(botIncidents)
        .where(and(eq(botIncidents.projectId, projectId), eq(botIncidents.signature, c.signature))).limit(1);
      const now = new Date();
      const working = sql.join(WORKING_STATES.map((s) => sql`${s}`), sql`, `);
      const [row] = await this.db.insert(botIncidents).values({
        projectId, signature: c.signature, category: c.category, phase: c.phase, fatal: c.fatal, state: c.state, note: c.note || null,
        summary: c.summary, example: c.example, data: { exit, timeline: [{ at: now.getTime(), what: "First seen" }], ...(report ? { report } : {}) },
      }).onConflictDoUpdate({
        target: [botIncidents.projectId, botIncidents.signature],
        set: {
          count: sql`${botIncidents.count} + 1`, lastSeenAt: now, category: c.category, phase: c.phase, fatal: c.fatal, summary: c.summary, example: c.example,
          // An automatic fix working on it keeps its state; otherwise it starts again (a fixed problem that comes back is open again).
          state: sql`CASE WHEN ${botIncidents.state} IN (${working}) THEN ${botIncidents.state} ELSE ${c.state} END`,
          note: sql`CASE WHEN ${botIncidents.state} IN (${working}) THEN ${botIncidents.note} ELSE ${c.note || null} END`,
        },
      }).returning();
      if (!row) return null;
      if (before) {
        const data: IncidentData = { ...(row.data ?? {}), exit, ...(report ? { report } : {}) };
        if (before.state === "fixed") pushTimeline(data, "Came back after it was fixed");
        await this.db.update(botIncidents).set({ data }).where(eq(botIncidents.id, row.id));
        row.data = data;
      }
      return row;
    } catch (err) {
      log.warn({ err, projectId }, "Could not record the incident");
      return null;
    }
  }

  /** Moves an incident along; `what` goes on its timeline. No-op without an id. */
  async update(id: number | null | undefined, patch: IncidentPatch, what?: string): Promise<void> {
    if (!id) return;
    try {
      const set: Record<string, unknown> = {};
      if (patch.state !== undefined) set.state = patch.state;
      if (patch.note !== undefined) set.note = patch.note === null ? null : clip(patch.note, 400);
      if (patch.retryAt !== undefined) set.retryAt = patch.retryAt;
      if (patch.fixSnapshotId !== undefined) set.fixSnapshotId = patch.fixSnapshotId;
      if (patch.fixFiles !== undefined) set.fixFiles = patch.fixFiles;
      if (patch.watchUntil !== undefined) set.watchUntil = patch.watchUntil;
      if (patch.attempt) { set.attempts = sql`${botIncidents.attempts} + 1`; set.lastAttemptAt = new Date(); }
      if (what) {
        const [row] = await this.db.select({ data: botIncidents.data }).from(botIncidents).where(eq(botIncidents.id, id)).limit(1);
        const data: IncidentData = { ...(row?.data ?? {}) };
        pushTimeline(data, what);
        set.data = data;
      }
      if (Object.keys(set).length) await this.db.update(botIncidents).set(set).where(eq(botIncidents.id, id));
    } catch (err) {
      log.warn({ err, id }, "Could not update the incident");
    }
  }

  /** A bot's incidents, the most recently seen first. */
  async list(projectId: number, limit = 50): Promise<Incident[]> {
    return this.db.select().from(botIncidents).where(eq(botIncidents.projectId, projectId)).orderBy(desc(botIncidents.lastSeenAt)).limit(limit);
  }

  /** Signatures an automatic fix is working on for this bot. */
  async workingOn(projectId: number): Promise<Set<string>> {
    try {
      const rows = await this.db.select({ signature: botIncidents.signature }).from(botIncidents)
        .where(and(eq(botIncidents.projectId, projectId), inArray(botIncidents.state, WORKING_STATES)));
      return new Set(rows.map((r) => r.signature));
    } catch {
      return new Set();
    }
  }

  /**
   * After a KojyAI restart: what was being worked on in memory is gone, so it
   * says so instead of looking busy forever. It's worked on again when it
   * happens again.
   */
  async resetAfterRestart(): Promise<void> {
    try {
      await this.db.update(botIncidents).set({ state: "open", retryAt: null, note: "KojyAI restarted while Kojy was working on this; it's fixed again when it happens again." })
        .where(inArray(botIncidents.state, ["queued", "fixing", "waiting_for_ai"]));
      await this.db.update(botIncidents).set({ state: "fixed", watchUntil: null, note: "Fixed by Kojy (KojyAI restarted before the fix could be watched to the end)." })
        .where(eq(botIncidents.state, "watching"));
    } catch (err) {
      log.warn({ err }, "Could not reset incidents after a restart");
    }
  }

  /** Removes finished incidents nobody has seen for a month, and keeps at most 200 per bot. */
  async prune(): Promise<void> {
    try {
      await this.db.delete(botIncidents).where(and(lt(botIncidents.lastSeenAt, new Date(Date.now() - KEEP_MS)), notInArray(botIncidents.state, WORKING_STATES)));
      await this.db.execute(sql`DELETE FROM bot_incidents WHERE id IN (
        SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY last_seen_at DESC) AS n FROM bot_incidents) ranked WHERE n > ${MAX_PER_PROJECT})`);
    } catch (err) {
      log.warn({ err }, "Could not prune incidents");
    }
  }
}

function pushTimeline(data: IncidentData, what: string): void {
  data.timeline = [...(data.timeline ?? []), { at: Date.now(), what: clip(what, 300) }].slice(-MAX_TIMELINE);
}

/** One line per incident for Kojy's get_logs (the newest first; finished and ignored ones left out). */
export function describeIncidents(rows: Incident[], now: number): string {
  const shown = rows.filter((r) => r.state !== "ignored" && (r.state !== "fixed" || now - r.lastSeenAt.getTime() < 86_400_000)).slice(0, 8);
  return shown.map((r) => {
    const ago = Math.max(0, Math.round((now - r.lastSeenAt.getTime()) / 60_000));
    return `- [${r.state}] ×${r.count} ${r.summary} (last ${ago < 90 ? `${ago} min` : `${Math.round(ago / 60)} h`} ago${r.attempts ? `, ${r.attempts} automatic fix${r.attempts > 1 ? "es" : ""} tried` : ""})${r.note ? ` — ${r.note}` : ""}`;
  }).join("\n");
}
