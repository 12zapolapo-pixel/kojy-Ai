/**
 * Whether each bot is really in its room (PresenceTracker), and what the
 * supervisor does with it: the website gets the latest room check; a bot
 * whose checks stop coming is restarted; runs that keep ending out of the
 * room are counted however long each lasted and the owner is told what to
 * check (unless Highrise is down for everyone); a page that says "running"
 * for a bot KojyAI isn't running is put right.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PresenceTracker, QUIET_NOTE_MS, SILENT_MS, STARTUP_SILENT_MS, parsePresence } from "../../../apps/runner/src/presence.js";

function tracker(running = true) {
  const saves: { uuid: string; set: Record<string, unknown> }[] = [];
  const hooks = { isRunning: vi.fn(() => running), backInRoom: vi.fn(), silent: vi.fn() };
  const t = new PresenceTracker({} as never, hooks, async (uuid, set) => { saves.push({ uuid, set: set as Record<string, unknown> }); });
  return { t, saves, hooks };
}
const inRoom = { inRoom: true, why: null, room: "Japalo's Lounge", owner: "o1", listed: null };
const out = (why: string) => ({ inRoom: false, why, room: null, owner: null, listed: null });

describe("room checks", () => {
  it("are checked like any bot output", () => {
    expect(parsePresence({ k: "presence", in_room: true, room: "Lounge", listed: true, why: "connected" })).toEqual({ inRoom: true, why: "connected", room: "Lounge", owner: null, listed: true });
    expect(parsePresence({ k: "presence" })).toBeNull();
    expect(parsePresence({ k: "chat", in_room: true })).toBeNull();
    expect(parsePresence({ k: "presence", in_room: false, why: "x".repeat(1000) })!.why!.length).toBe(300);
  });

  it("the website gets each change: getting in, in the room (with its name), out and why", async () => {
    const { t, saves, hooks } = tracker();
    t.started("u1", 1, true);
    expect(saves.at(-1)!.set).toMatchObject({ inRoom: null, presenceNote: "Getting into the room…" });
    await t.report("u1", inRoom);
    expect(saves.at(-1)!.set).toMatchObject({ inRoom: true, roomName: "Japalo's Lounge", presenceNote: null });
    expect(hooks.backInRoom).toHaveBeenCalledWith("u1", 1);
    expect(t.everInRoom("u1")).toBe(true);
    const before = saves.length;
    await t.report("u1", inRoom); // the same again: not written every minute
    expect(saves.length).toBe(before);
    await t.report("u1", out("reconnecting to Highrise for 61s"));
    expect(saves.at(-1)!.set).toMatchObject({ inRoom: false, presenceNote: "reconnecting to Highrise for 61s", roomName: "Japalo's Lounge" });
    await t.report("u1", out("reconnecting to Highrise for 121s")); // only the counter changed
    expect(saves.length).toBe(before + 1);
    await t.report("u1", inRoom);
    expect(hooks.backInRoom).toHaveBeenCalledTimes(2);
  });

  it("learns once that Highrise lists this bot in its room (the launcher's check gets stricter from then on)", async () => {
    const { t, saves } = tracker();
    t.started("u1", 1, true);
    await t.report("u1", { ...inRoom, listed: true });
    await t.report("u1", { ...inRoom, listed: true });
    expect(saves.filter((s) => s.set.roomListsBot === true)).toHaveLength(1);
  });

  it("a start command has no launcher to check the room: said so, nothing expected", async () => {
    const { t, saves, hooks } = tracker();
    t.started("u1", 1, false);
    expect(saves.at(-1)!.set).toMatchObject({ inRoom: null, presenceNote: "Room checks aren't available for a start command (run: …)" });
    t.tick(Date.now() + STARTUP_SILENT_MS * 2);
    expect(hooks.silent).not.toHaveBeenCalled();
  });
});

describe("checks that stop coming", () => {
  it("not confirmed in the room after a few quiet minutes, restarted after ten; a check resets it", async () => {
    const { t, saves, hooks } = tracker();
    t.started("u1", 1, true);
    await t.report("u1", inRoom);
    const at = Date.now();
    t.tick(at + QUIET_NOTE_MS + 1000);
    expect(saves.at(-1)!.set).toMatchObject({ inRoom: null });
    expect(String(saves.at(-1)!.set.presenceNote)).toMatch(/^No room check from the bot for \d+ min — not confirmed in its room$/);
    expect(hooks.silent).not.toHaveBeenCalled();
    t.tick(at + SILENT_MS + 1000);
    expect(hooks.silent).toHaveBeenCalledWith("u1", expect.stringMatching(/^No room check from the bot for \d+ min \(its checks stopped/), 1);
    t.tick(at + SILENT_MS + 120_000);
    expect(hooks.silent).toHaveBeenCalledTimes(1); // once per silence

    // Restarted, and quiet again before its first check: the second time in a row.
    t.started("u1", 1, true);
    t.tick(Date.now() + STARTUP_SILENT_MS + 1000);
    expect(hooks.silent).toHaveBeenLastCalledWith("u1", expect.stringMatching(/its launcher never reported/), 2);
  });

  it("before its first check, the bot's output counts as busy starting (a long package install on a bot host)", () => {
    const { t, hooks } = tracker();
    t.started("u1", 1, true);
    const at = Date.now();
    t.tick(at + SILENT_MS + 1000);
    expect(hooks.silent).not.toHaveBeenCalled(); // the startup allowance is longer
    vi.useFakeTimers({ now: at + STARTUP_SILENT_MS - 60_000, toFake: ["Date"] });
    t.output("u1");
    vi.useRealTimers();
    t.tick(at + STARTUP_SILENT_MS + 1000);
    expect(hooks.silent).not.toHaveBeenCalled();
  });

  it("a stopped bot, or one that exited, isn't watched", () => {
    const { t, hooks } = tracker();
    t.started("u1", 1, true);
    t.stopped("u1");
    t.started("u2", 2, true);
    t.exited("u2");
    t.tick(Date.now() + STARTUP_SILENT_MS * 2);
    expect(hooks.silent).not.toHaveBeenCalled();
  });
});

describe("the supervisor and the room", () => {
  const root = mkdtempSync(path.join(tmpdir(), "kojy-presence-sup-"));
  const updates: Record<string, unknown>[] = [];
  let projectRows: Record<string, unknown>[] = [];
  const db = {
    select: () => { const q = { from() { return q; }, where() { return q; }, limit: async () => projectRows, then: (ok: (v: unknown[]) => unknown) => Promise.resolve(projectRows).then(ok) }; return q; },
    update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => { updates.push(v); } }) }),
    insert: () => ({ values: async () => undefined }),
  };
  let m: typeof import("../../../apps/runner/src/supervisor.js");
  beforeAll(async () => {
    process.env.PROJECTS_DIR = path.join(root, "projects");
    process.env.VENVS_DIR = path.join(root, "venvs");
    process.env.RUNNER_SANDBOX = "off";
    mkdirSync(path.join(root, "projects"), { recursive: true });
    m = await import("../../../apps/runner/src/supervisor.js");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  type Internals = {
    onExit(u: string, r: unknown, c: number, sig: null): Promise<void>; onReport(u: string, p: unknown, raw: unknown): void;
    restartTimers: Map<string, NodeJS.Timeout>; start(u: string, why?: string): Promise<void>; silent(u: string, why: string, times: number): Promise<void>;
  };
  const project = { id: 1, orgId: 1, ownerId: 7, name: "Japalo" };
  const run = (ranFor: number) => ({ startedAt: Date.now() - ranFor, stopping: false, project });
  const notInRoom = (alerted = false) => ({ id: 9, category: "not_in_room", signature: "watchdog:offline", summary: "Wasn't in its room", note: "It wasn't in its room (the bot hasn't been connected to Highrise for 301s), so it was started again.", data: alerted ? { alertedAt: 1 } : {} });

  function make() {
    const sup = new m.Supervisor(db as never);
    const record = vi.spyOn(sup.incidents, "record");
    const update = vi.spyOn(sup.incidents, "update").mockResolvedValue(undefined);
    const resolve = vi.spyOn(sup.incidents, "resolveRoomTrouble").mockResolvedValue(undefined);
    return { sup, s: sup as unknown as Internals, record, update, resolve };
  }

  it("bots restarted every few minutes because they can't get into their room: the owner is told what to check — once", async () => {
    projectRows = [{ desiredState: "running", restartCount: 0 }];
    const { s, record, update } = make();
    record.mockResolvedValue(notInRoom() as never);
    // Each run lasted six minutes (the watchdog's limit): "healthy" for the crash streak, never in the room.
    await s.onExit("u1", run(6 * 60_000), 4, null);
    expect(update.mock.calls.some(([, patch]) => (patch as { state?: string }).state === "needs_owner")).toBe(false);
    await s.onExit("u1", run(6 * 60_000), 4, null);
    const escalated = update.mock.calls.find(([, patch]) => (patch as { state?: string }).state === "needs_owner")!;
    expect(String((escalated[1] as { note: string }).note)).toMatch(/^2 runs in a row ended without the bot in its room \(wasn't in its room \(the bot hasn't been connected to Highrise for 301s\)\)\. If other bots are fine, check HIGHRISE_BOT_TOKEN and HIGHRISE_ROOM_ID/);
    expect(update).toHaveBeenCalledWith(9, { alerted: true });
    // The third time: already told (kept on the incident), so not told again.
    record.mockResolvedValue(notInRoom(true) as never);
    update.mockClear();
    await s.onExit("u1", run(6 * 60_000), 4, null);
    expect(update).not.toHaveBeenCalledWith(9, { alerted: true });
    for (const t of s.restartTimers.values()) clearTimeout(t);
  });

  it("Highrise refusing the bot again and again is tried less often, and never paused for good", async () => {
    projectRows = [{ desiredState: "running", restartCount: 0 }];
    const { s, record } = make();
    record.mockResolvedValue({ ...notInRoom(true), category: "highrise_refused", note: "Highrise refused the bot's connection (HTTP 403)." } as never);
    const delays: number[] = [];
    const startLater = vi.spyOn(s as unknown as { startLater(u: string, sec: number): void }, "startLater").mockImplementation((_u, sec) => { delays.push(sec); });
    for (let i = 0; i < 12; i++) await s.onExit("u2", run(1000), 5, null); // quick exits: a crash streak too
    expect(delays.slice(0, 2)).toEqual([5, 120]);
    expect(delays.at(-1)).toBe(1800);
    expect(delays).toHaveLength(12); // still tried after 10 in a row: not paused
    startLater.mockRestore();
  });

  it("when most bots are out of their rooms at once, it's Highrise or the network: no owner is told to check secrets", async () => {
    projectRows = [{ desiredState: "running", restartCount: 0 }];
    const { sup, s, record, update } = make();
    vi.spyOn(sup, "isRunning").mockReturnValue(true);
    for (const u of ["a", "b", "c"]) { sup.presence.started(u, 1, true); await sup.presence.report(u, out("reconnecting to Highrise for 61s")); }
    record.mockResolvedValue(notInRoom() as never);
    await s.onExit("a", run(6 * 60_000), 4, null);
    await s.onExit("a", run(6 * 60_000), 4, null);
    expect(update).not.toHaveBeenCalledWith(9, { alerted: true });
    expect(update.mock.calls.some(([, patch]) => /Most bots are out of their rooms right now/.test(String((patch as { note?: string }).note)))).toBe(true);
    for (const t of s.restartTimers.values()) clearTimeout(t);
  });

  it("room checks from the launcher reach the website, and back in the room closes the room problems", async () => {
    projectRows = [{ desiredState: "running", restartCount: 0 }];
    const { sup, s, resolve } = make();
    sup.presence.started("u3", 3, true);
    updates.length = 0;
    s.onReport("u3", project, { k: "presence", in_room: true, room: "Japalo's Lounge", listed: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(updates).toContainEqual(expect.objectContaining({ inRoom: true, roomName: "Japalo's Lounge" }));
    expect(updates).toContainEqual({ roomListsBot: true });
    expect(resolve).toHaveBeenCalledWith(3);
  });

  it("a bot whose checks stopped is restarted, and the owner told when it keeps happening", async () => {
    projectRows = [{ id: 4, uuid: "u4", orgId: 1, ownerId: 7, name: "Japalo", desiredState: "running" }];
    const { sup, s, record, update } = make();
    record.mockResolvedValue({ id: 11, data: {} } as never);
    const handle = vi.spyOn(sup, "handle").mockResolvedValue(undefined);
    await s.silent("u4", "No room check from the bot for 10 min", 1);
    expect(record).toHaveBeenCalledWith(4, expect.objectContaining({ category: "silent", state: "open" }), "no room checks");
    expect(handle).toHaveBeenCalledWith("u4", "restart");
    await s.silent("u4", "No room check from the bot for 10 min", 2);
    expect(record).toHaveBeenLastCalledWith(4, expect.objectContaining({ category: "silent", state: "needs_owner" }), "no room checks");
    expect(update).toHaveBeenCalledWith(11, { alerted: true });
  });

  it("a page that says running for a bot KojyAI isn't running is put right: started again (or shown stopped)", async () => {
    const { s } = make();
    const start = vi.spyOn(s, "start").mockResolvedValue(undefined);
    projectRows = [
      { uuid: "ghost", status: "running", desiredState: "running", updatedAt: new Date() },
      { uuid: "left", status: "running", desiredState: "stopped", updatedAt: new Date() },
      { uuid: "stuck", status: "crashed", desiredState: "running", updatedAt: new Date(Date.now() - 20 * 60_000) },
      { uuid: "fresh-crash", status: "crashed", desiredState: "running", updatedAt: new Date() },
    ];
    updates.length = 0;
    await (s as unknown as { reconcile(): Promise<void> }).reconcile();
    expect(start.mock.calls.map((c) => c[0]).sort()).toEqual(["ghost", "stuck"]);
    expect(updates).toContainEqual(expect.objectContaining({ status: "stopped" }));
  });
});
