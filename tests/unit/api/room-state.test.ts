/**
 * What the website says about a Python bot's room (room.ts): "running" only
 * means the process is up, so the room is said apart — from the runner's
 * latest check, and a check that's too old never counts as "in the room".
 */
import { describe, expect, it } from "vitest";
import { roomState, runnerAlive } from "../../../apps/api/src/modules/projects/room.js";

const now = Date.parse("2026-11-20T15:00:00Z");
const bot = (p: Partial<{ status: string; entrypoint: string; inRoom: boolean | null; presenceAt: Date | null }>) =>
  ({ status: "running", entrypoint: "highrise_bot.bot:HighriseRoomBot", inRoom: true, presenceAt: new Date(now - 60_000), ...p });

describe("roomState", () => {
  it("in or not in the room, from a recent check", () => {
    expect(roomState(bot({}), now)).toBe("in");
    expect(roomState(bot({ inRoom: false }), now)).toBe("out");
  });

  it("a check that's too old, or none yet, is 'not confirmed' — never quietly 'in the room'", () => {
    expect(roomState(bot({ presenceAt: new Date(now - 20 * 60_000) }), now)).toBe("unconfirmed");
    expect(roomState(bot({ inRoom: null }), now)).toBe("unconfirmed");
    expect(roomState(bot({ presenceAt: null }), now)).toBe("unconfirmed");
  });

  it("nothing to say when it isn't running; a start command can't be checked", () => {
    expect(roomState(bot({ status: "crashed" }), now)).toBeNull();
    expect(roomState(bot({ entrypoint: "run: python main.py" }), now)).toBe("not_tracked");
  });
});

describe("runnerAlive", () => {
  it("only with a fresh heartbeat", () => {
    expect(runnerAlive(JSON.stringify({ ts: now - 10_000 }), now)).toBe(true);
    expect(runnerAlive(JSON.stringify({ ts: now - 120_000 }), now)).toBe(false);
    expect(runnerAlive(null, now)).toBe(false);
    expect(runnerAlive("not json", now)).toBe(false);
  });
});
