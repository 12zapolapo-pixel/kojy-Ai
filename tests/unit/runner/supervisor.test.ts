import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

const notify = vi.hoisted(() => ({ notifyUser: vi.fn(), sendAlert: vi.fn() }));
// The file the runner's "@kojyai/db" resolves to (the package name doesn't resolve from tests/).
vi.mock("../../../packages/db/src/index.ts", () => ({
  ActivityRecorder: class { record() {} async stop() {} },
  notifyUser: notify.notifyUser,
  sendAlert: notify.sendAlert,
}));

const work = mkdtempSync(path.join(tmpdir(), "kojy-supervisor-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
// Read when the supervisor module loads (imported inside the tests, after this).
process.env.PROJECTS_DIR = path.join(work, "projects");
process.env.VENVS_DIR = path.join(work, "venvs");

describe("runner: a bot kicked out of its room", () => {
  it("is stopped and marked with why when Highrise says its account logged in somewhere else", async () => {
    const { Supervisor } = await import("../../../apps/runner/src/supervisor.js");

    const updates: Record<string, unknown>[] = [];
    const db = { update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => { updates.push(v); } }) }) };
    const supervisor = new Supervisor(db as any);

    // A running bot, as start() leaves it.
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => { setImmediate(() => child.emit("exit", null, "SIGTERM")); return true; }) });
    (supervisor as any).procs.set("u1", { child, startedAt: Date.now(), stopping: false, project: { id: 1, orgId: 1, ownerId: 7, name: "Japalo" } });
    (supervisor as any).tails.set("u1", []);

    supervisor.console("u1", "stdout", "ERROR: Multilogin closing connection with ID: 6cebe651");
    supervisor.console("u1", "stdout", "ERROR: Multilogin closing connection with ID: 6cebe651"); // handled once
    await new Promise((r) => setTimeout(r, 50));

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(updates).toContainEqual({ desiredState: "stopped" });
    expect(updates).toContainEqual({ status: "error", statusMessage: expect.stringMatching(/logged in somewhere else/) });
    expect(notify.notifyUser).toHaveBeenCalledWith(db, 7, "bot_error", "Japalo was kicked out of the room", expect.stringMatching(/Stop the other copy/), "/studio/p/u1");
  });
});

describe("runner: an error in a bot's hook", () => {
  it("leaves the bot running and goes to Kojy once it happens again", async () => {
    const { Supervisor } = await import("../../../apps/runner/src/supervisor.js");
    const supervisor = new Supervisor({} as any);
    const calls: unknown[][] = [];
    supervisor.onCrash = (...args) => { calls.push(args); };

    // The launcher's reports arrive on the bot's fd 3.
    const reports = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdio: [null, null, null, reports], kill: vi.fn() });
    (supervisor as any).readActivity("u1", { child, startedAt: Date.now(), stopping: false, project: { id: 1, orgId: 1, ownerId: 7, name: "Japalo" } });
    const trace = "Traceback (most recent call last):\n  File \"bot.py\", line 393, in on_chat\nhighrise.ResponseError: You can't edit this room.\n";
    const error = () => new Promise((r) => reports.write(JSON.stringify({ k: "error", hook: "on_chat", trace }) + "\n", () => setImmediate(r)));

    await error();
    expect(calls).toEqual([]); // once can be a fluke
    await error();
    expect(calls).toEqual([["u1", 2, trace.split("\n"), "error"]]);
    await error();
    expect(calls).toHaveLength(1); // Kojy already has it
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe("runner: room insights", () => {
  it("saves which commands people use and how they went, and Kojy reads them", async () => {
    const { Supervisor } = await import("../../../apps/runner/src/supervisor.js");
    const { runTool } = await import("../../../apps/runner/src/agent/tools.js");
    const supervisor = new Supervisor({} as any);
    const reports = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdio: [null, null, null, reports], kill: vi.fn() });
    const uuid = "6b0f2b4e-1c1a-4e8e-9a51-0d3f6a1b2c3d";
    (supervisor as any).readActivity(uuid, { child, startedAt: Date.now(), stopping: false, project: { id: 1, orgId: 1, ownerId: 7, name: "DJ" } });
    const send = (c: string, r: string) => new Promise((ok) => reports.write(JSON.stringify({ k: "cmd", c, r }) + "\n", () => setImmediate(ok)));
    for (let i = 0; i < 5; i++) await send("!dance", "silent");
    await send("!request", "ok");
    await send("!request", "error");
    await send("bad command with spaces", "ok"); // ignored
    supervisor.flushInsights();

    const r = await runTool("room_insights", {}, { project: { uuid } } as any);
    expect(r.output).toMatch(/2 different commands, 7 uses/);
    expect(r.output).toMatch(/Tried but never answered[^\n]*\n!dance × 5/);
    expect(r.output).toMatch(/Failing \(errors\):\n!request: 1 of 2 failed/);
  });
});
