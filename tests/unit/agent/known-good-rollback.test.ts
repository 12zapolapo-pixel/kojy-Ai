/**
 * A bot that keeps crashing after its code changed goes back to the code it
 * last ran fine with — by itself, with the newer code kept in Undo and the
 * bot's data left as it is — instead of being paused until the owner acts.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const root = mkdtempSync(path.join(tmpdir(), "kojy-known-good-"));
let row: Record<string, unknown> = {};
const db = {
  select: () => { const q = { from() { return q; }, where() { return q; }, limit: async () => [row] }; return q; },
  update: () => ({ set: () => ({ where: async () => undefined }) }),
  insert: () => ({ values: async () => undefined }),
};
let m: typeof import("../../../apps/runner/src/supervisor.js");
let files: typeof import("../../../packages/shared/src/projects/files.js");
let LIMIT: number;
beforeAll(async () => {
  process.env.PROJECTS_DIR = path.join(root, "projects");
  process.env.VENVS_DIR = path.join(root, "venvs");
  process.env.RUNNER_SANDBOX = "off";
  mkdirSync(path.join(root, "projects"), { recursive: true });
  m = await import("../../../apps/runner/src/supervisor.js");
  files = await import("../../../packages/shared/src/projects/files.js");
  LIMIT = m.CRASH_LOOP_LIMIT;
}, 30_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));
type Internals = { crashStreak: Map<string, number>; onExit(u: string, r: unknown, c: number, sig: null): Promise<void> };
const run = () => ({ startedAt: Date.now(), stopping: false, project: { id: 1, orgId: 1, ownerId: 1, name: "Japalo" } });

describe("a crash loop after a code change", () => {
  it("goes back to the code that last ran fine when the code changed since (the newer code stays in Undo)", async () => {
    const uuid = "22222222-2222-4222-8222-222222222222";
    const dir = files.projectDir(uuid);
    mkdirSync(path.join(dir, "data"), { recursive: true });
    writeFileSync(path.join(dir, "bot.py"), "print('works')\n");
    writeFileSync(path.join(dir, "data", "coins.json"), "{\"amy\": 1}");
    expect(files.saveKnownGood(uuid)).toBe(true);
    // Then the code changed and broke; the bot's data kept changing too.
    writeFileSync(path.join(dir, "bot.py"), "print('broken'\n");
    writeFileSync(path.join(dir, "new_feature.py"), "x = 1\n");
    writeFileSync(path.join(dir, "data", "coins.json"), "{\"amy\": 5}");

    row = { desiredState: "running", restartCount: 9, autoFix: true };
    const sup = new m.Supervisor(db as never);
    const s = sup as unknown as Internals;
    const restored: string[] = [];
    sup.onCodeRestored = (_u, note) => { restored.push(note); };
    let fixes = 0;
    sup.onCrash = () => { fixes++; };
    const update = vi.spyOn(sup.incidents, "update").mockResolvedValue(undefined);
    vi.spyOn(sup.incidents, "record").mockResolvedValue({ id: 3, category: "code", summary: "SyntaxError in bot.py" } as never);
    const delays: number[] = [];
    vi.spyOn(s as unknown as { startLater(u: string, sec: number): void }, "startLater").mockImplementation((_u, sec) => { delays.push(sec); });
    s.crashStreak.set(uuid, LIMIT - 1);
    await s.onExit(uuid, run(), 1, null);

    expect(readFileSync(path.join(dir, "bot.py"), "utf8")).toBe("print('works')\n");
    expect(existsSync(path.join(dir, "new_feature.py"))).toBe(false);
    expect(readFileSync(path.join(dir, "data", "coins.json"), "utf8")).toBe("{\"amy\": 5}"); // data stays as it is
    expect(delays).toEqual([3]);
    expect(fixes).toBe(0); // nothing to fix in the code that's back
    expect(restored[0]).toMatch(/^KojyAI put back the code that last ran fine \(kept .* UTC\) because it crashed \d+ times in a row \(SyntaxError in bot\.py\)\. The newer code is saved in Undo/);
    expect(update).toHaveBeenCalledWith(3, expect.objectContaining({ state: "fixed" }), "Put back the code that last ran fine");
    const undo = files.listSnapshots(uuid)[0]!;
    expect(undo.reason).toMatch(/^Before KojyAI put back the code that last ran fine/);
    // Nothing more to go back to: the code is the code that ran fine.
    expect(files.restoreKnownGood(uuid, "again")).toBeNull();
  });
  it("is left alone when automatic fixes are off (the owner's choice)", async () => {
    const uuid = "33333333-3333-4333-8333-333333333333";
    const dir = files.projectDir(uuid);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "bot.py"), "print('works')\n");
    files.saveKnownGood(uuid);
    writeFileSync(path.join(dir, "bot.py"), "print('broken'\n");
    row = { desiredState: "running", restartCount: 9, autoFix: false };
    const sup = new m.Supervisor(db as never);
    vi.spyOn(sup.incidents, "update").mockResolvedValue(undefined);
    vi.spyOn(sup.incidents, "record").mockResolvedValue({ id: 4, category: "code" } as never);
    vi.spyOn(sup as unknown as { startLater(u: string, sec: number): void }, "startLater").mockImplementation(() => undefined);
    (sup as unknown as Internals).crashStreak.set(uuid, LIMIT - 1);
    await (sup as unknown as Internals).onExit(uuid, run(), 1, null);
    expect(readFileSync(path.join(dir, "bot.py"), "utf8")).toBe("print('broken'\n");
  });
});
