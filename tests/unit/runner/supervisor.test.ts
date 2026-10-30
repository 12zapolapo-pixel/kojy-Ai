import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const notify = vi.hoisted(() => ({ notifyUser: vi.fn(), sendAlert: vi.fn() }));
// The file the runner's "@kojyai/db" resolves to (the package name doesn't resolve from tests/).
vi.mock("../../../packages/db/src/index.ts", () => ({
  ActivityRecorder: class { record() {} async stop() {} },
  notifyUser: notify.notifyUser,
  sendAlert: notify.sendAlert,
}));

const work = mkdtempSync(path.join(tmpdir(), "kojy-supervisor-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("runner: a bot kicked out of its room", () => {
  it("is stopped and marked with why when Highrise says its account logged in somewhere else", async () => {
    process.env.PROJECTS_DIR = path.join(work, "projects");
    process.env.VENVS_DIR = path.join(work, "venvs");
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
