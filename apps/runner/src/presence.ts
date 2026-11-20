/**
 * Presence — whether each bot is really in its Highrise room, not just
 * running. "Running" only ever meant the process was up (on a bot host: the
 * server was on); a bot could sit outside its room for days with the website
 * showing it healthy.
 * OWNERSHIP: apps/runner
 *
 * The launcher checks the room every minute and reports each check
 * ("presence": in the room or not, why, the room's name). This keeps the
 * latest one per bot, writes it to bot_projects (in_room, room_name,
 * presence_note, presence_at) for the website, and learns when Highrise lists
 * a bot among its room's users (room_lists_bot), which makes the launcher's
 * check stricter from the bot's next start.
 *
 * It also notices when the checks stop coming — the launcher hung, never
 * started (a stuck install on a bot host), or an old launcher without them —
 * and has the supervisor restart the bot: a bot KojyAI can't see working isn't
 * left "running" forever.
 */

import { eq } from "drizzle-orm";
import type { Database } from "@kojyai/db";
import { botProjects } from "@kojyai/db/schema";
import { createLogger } from "./logger.js";

const log = createLogger("presence");

/** No room check for this long (after the first one): no longer confirmed in the room. */
export const QUIET_NOTE_MS = Number(process.env.PRESENCE_QUIET_NOTE_MS ?? 4 * 60_000);
/** No room check for this long (after the first one): restarted. */
export const SILENT_MS = Number(process.env.PRESENCE_SILENT_MS ?? 10 * 60_000);
/**
 * A run's first check may take longer (installing packages on a bot host,
 * the bot's code loading): the host's install gives up at 20 minutes and the
 * launcher's startup watch at 5. Counted from the start whatever the bot
 * prints meanwhile — an old launcher stuck reconnecting prints all the time
 * and never checks the room.
 */
export const STARTUP_SILENT_MS = Number(process.env.PRESENCE_STARTUP_SILENT_MS ?? 30 * 60_000);
/** An unchanged state is written again this often, so presence_at shows the checks still come. */
const REFRESH_MS = 5 * 60_000;

export interface PresenceEvent {
  inRoom: boolean;
  /** Why it isn't in the room (or "connected"). */
  why: string | null;
  room: string | null;
  owner: string | null;
  /** Whether Highrise listed the bot among the room's users (null: not known). */
  listed: boolean | null;
}

const str = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.replace(/[\r\n]+/g, " ").slice(0, n) : null);

/** A presence line from the launcher, checked (it comes from the bot's own process); null when it isn't one. */
export function parsePresence(raw: unknown): PresenceEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.k !== "presence" || typeof r.in_room !== "boolean") return null;
  return { inRoom: r.in_room, why: str(r.why, 300), room: str(r.room, 120), owner: str(r.owner, 64), listed: typeof r.listed === "boolean" ? r.listed : null };
}

interface Current extends PresenceEvent { at: number; since: number }

export interface PresenceHooks {
  isRunning(uuid: string): boolean;
  /** The bot got into its room (again): problems about it not being there can close. */
  backInRoom(uuid: string, projectId: number): void;
  /** No room check for too long: restart it. `times` = silences in a row. */
  silent(uuid: string, why: string, times: number): void;
}

/** Writes at most what changed; a database problem never breaks anything else. */
type Save = (uuid: string, set: Partial<typeof botProjects.$inferInsert>) => Promise<void>;

export class PresenceTracker {
  private current = new Map<string, Current>();
  /** Bots whose room is checked (launcher bots only), with the project and when this run started. */
  private runs = new Map<string, { projectId: number; since: number; inRoomOnce: boolean; quietNoted: boolean; silenced: boolean }>();
  private saved = new Map<string, { key: string; at: number }>();
  private learned = new Set<string>();
  private silences = new Map<string, number>();
  private save: Save;

  constructor(db: Database, private hooks: PresenceHooks, save?: Save) {
    this.save = save ?? (async (uuid, set) => {
      try { await db.update(botProjects).set(set).where(eq(botProjects.uuid, uuid)); } catch (err) { log.warn({ err, uuid }, "Could not save the bot's room status"); }
    });
  }

  /**
   * A run started (or KojyAI started watching one on its bot host). `checked`
   * is false for start commands: no launcher, so nothing reports the room.
   */
  started(uuid: string, projectId: number, checked: boolean): void {
    this.current.delete(uuid);
    this.saved.delete(uuid);
    if (!checked) {
      this.runs.delete(uuid);
      void this.save(uuid, { inRoom: null, presenceNote: "Room checks aren't available for a start command (run: …)", presenceAt: null });
      return;
    }
    const now = Date.now();
    this.runs.set(uuid, { projectId, since: now, inRoomOnce: false, quietNoted: false, silenced: false });
    void this.save(uuid, { inRoom: null, presenceNote: "Getting into the room…", presenceAt: new Date(now) });
  }

  /** Stopped (by the owner or KojyAI, or moved): nothing to check any more. */
  stopped(uuid: string): void {
    this.forget(uuid);
    this.silences.delete(uuid);
    void this.save(uuid, { inRoom: null, presenceNote: null, presenceAt: null });
  }

  /** The process exited by itself: not in the room; it starts again with a new run. */
  exited(uuid: string): void {
    this.forget(uuid);
    void this.save(uuid, { inRoom: false, presenceNote: "Not running — starting again", presenceAt: new Date() });
  }

  /** Whether this run has been in its room at least once. */
  everInRoom(uuid: string): boolean {
    return this.runs.get(uuid)?.inRoomOnce ?? false;
  }

  /** The latest check (null when none in this run). */
  get(uuid: string): (PresenceEvent & { at: number; since: number }) | null {
    return this.current.get(uuid) ?? null;
  }

  /** Bots whose room is checked, and how many of them are out of it now (for telling a Highrise outage apart). */
  counts(now = Date.now()): { checked: number; out: string[] } {
    const out: string[] = [];
    let checked = 0;
    for (const [uuid] of this.runs) {
      if (!this.hooks.isRunning(uuid)) continue;
      checked++;
      const c = this.current.get(uuid);
      if (c && !c.inRoom && now - c.at < SILENT_MS) out.push(uuid);
    }
    return { checked, out };
  }

  /** A room check from the launcher. `roomListsBot`: what the database already knows. */
  async report(uuid: string, ev: PresenceEvent, roomListsBot?: boolean): Promise<void> {
    const run = this.runs.get(uuid);
    if (!run) return; // not a run we check (stopped meanwhile, or a start command)
    const now = Date.now();
    const prev = this.current.get(uuid);
    const room = ev.room ?? prev?.room ?? null;
    this.current.set(uuid, { ...ev, room, owner: ev.owner ?? prev?.owner ?? null, at: now, since: prev && prev.inRoom === ev.inRoom ? prev.since : now });
    run.quietNoted = false;
    run.silenced = false;
    this.silences.delete(uuid);
    if (ev.inRoom && (!prev || !prev.inRoom)) {
      run.inRoomOnce = true;
      this.hooks.backInRoom(uuid, run.projectId);
    }
    if (ev.listed === true && !this.learned.has(uuid)) {
      this.learned.add(uuid);
      if (!roomListsBot) await this.save(uuid, { roomListsBot: true });
    }
    // Write what changed (the reason without its counters), or every few minutes so presence_at stays fresh.
    const key = `${ev.inRoom}|${room}|${(ev.inRoom ? "" : ev.why ?? "").replace(/\d+/g, "#")}`;
    const last = this.saved.get(uuid);
    if (last && last.key === key && now - last.at < REFRESH_MS) return;
    this.saved.set(uuid, { key, at: now });
    const note = ev.inRoom ? null : ev.why ?? "Not in the room";
    await this.save(uuid, { inRoom: ev.inRoom, roomName: room, presenceNote: note, presenceAt: new Date(now) });
  }

  /**
   * Every minute: a bot whose room checks stopped coming isn't confirmed in
   * its room any more, and after a while it's restarted.
   */
  tick(now = Date.now()): void {
    for (const [uuid, run] of this.runs) {
      if (!this.hooks.isRunning(uuid) || run.silenced) continue;
      const c = this.current.get(uuid);
      // Before the first check, the time since the start counts — not the time since its last output.
      const lastSign = c ? c.at : run.since;
      const quiet = now - lastSign;
      const limit = c ? SILENT_MS : STARTUP_SILENT_MS;
      if (c && quiet >= QUIET_NOTE_MS && !run.quietNoted) {
        run.quietNoted = true;
        void this.save(uuid, { inRoom: null, presenceNote: `No room check from the bot for ${Math.round(quiet / 60_000)} min — not confirmed in its room` });
      }
      if (quiet >= limit) {
        run.silenced = true;
        const times = (this.silences.get(uuid) ?? 0) + 1;
        this.silences.set(uuid, times);
        const why = c
          ? `No room check from the bot for ${Math.round(quiet / 60_000)} min (its checks stopped: the bot or its launcher hung)`
          : `No sign of the bot getting into its room ${Math.round(quiet / 60_000)} min after it started (its launcher never reported)`;
        this.hooks.silent(uuid, why, times);
      }
    }
  }

  private forget(uuid: string): void {
    this.current.delete(uuid);
    this.runs.delete(uuid);
    this.saved.delete(uuid);
  }
}
