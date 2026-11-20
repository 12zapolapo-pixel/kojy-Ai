/**
 * Whether a Python bot is really in its Highrise room, as the website shows
 * it. "Running" only means its process is up; the runner keeps the
 * launcher's latest room check on the project (in_room, presence_at, see
 * apps/runner/src/presence.ts). A check that's too old doesn't count: a bot
 * whose checks stopped is "not confirmed", never quietly "in the room".
 * OWNERSHIP: apps/api/src/modules/projects
 */

import { isStartCommand } from "@kojyai/shared/projects";

/** in: in its room · out: not in it · unconfirmed: no recent check · not_tracked: a start command (no launcher). null when not running. */
export type RoomState = "in" | "out" | "unconfirmed" | "not_tracked" | null;

/** Checks come every minute and an unchanged one is written every 5: older than this, it's stale. */
const FRESH_MS = 7 * 60_000;

export function roomState(p: { status: string; entrypoint: string; inRoom: boolean | null; presenceAt: Date | null }, now = Date.now()): RoomState {
  if (p.status !== "running") return null;
  if (isStartCommand(p.entrypoint)) return "not_tracked";
  if (p.inRoom === null || !p.presenceAt || now - p.presenceAt.getTime() > FRESH_MS) return "unconfirmed";
  return p.inRoom ? "in" : "out";
}

/** Whether the bot runner is alive (its heartbeat is fresh): when it isn't, every status shown may be out of date. */
export function runnerAlive(heartbeat: string | null | undefined, now = Date.now()): boolean {
  try {
    const beat = heartbeat ? (JSON.parse(heartbeat) as { ts?: number }) : null;
    return !!beat?.ts && now - beat.ts < 45_000;
  } catch {
    return false;
  }
}
