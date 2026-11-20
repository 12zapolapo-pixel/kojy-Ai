/**
 * Phase 4: the stabilizer checks itself — the same bug counts once however
 * many visitors hit it, the check-up groups errors and marks new ones, and a
 * crash loop never stops the bot for good: it goes back to the code that last
 * ran fine, or is started less and less often while Kojy works on the cause.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { crashLocation, crashSignature, normalizeError } from "../../../apps/runner/src/agent/autoFix.js";
import { describeKinds, groupErrors } from "../../../apps/runner/src/agent/checkup.js";

const tb = (user: string, line = 302) => [
  "Traceback (most recent call last):",
  '  File "/app/venvs/u1/lib/python3.11/site-packages/highrise/__main__.py", line 199, in bot_runner',
  '    tg.create_task(bot.on_chat(user, message))',
  `  File "/app/projects/u1/highrise_bot/bot.py", line ${line}, in on_chat`,
  "    coins = self.balances[user.username]",
  `KeyError: '${user}'`,
];

describe("the same bug", () => {
  it("has one signature whoever hit it, even after a fix moved its line", () => {
    expect(normalizeError("KeyError: 'amy'")).toBe("KeyError: '…'");
    expect(normalizeError("ValueError: invalid literal for int() with base 10: '12abc' (id 4411)")).toBe("ValueError: invalid literal for int() with base N: '…' (id N)");
    expect(crashLocation(tb("amy"))).toBe("highrise_bot/bot.py:302 in on_chat");
    expect(crashSignature(tb("amy"))).toBe(crashSignature(tb("bob", 305)));
    expect(crashSignature(tb("amy"))).not.toBe(crashSignature(["Traceback (most recent call last):", '  File "/app/projects/u1/bot.py", line 9, in on_tip', "TypeError: bad"]));
  });
});

describe("check-up error groups", () => {
  const line = (l: string, ts = 1000) => ({ ts, stream: "stderr", line: l });
  it("counts one traceback kind once per occurrence, and other error lines by their text", () => {
    const lines = [
      ...tb("amy").map((l) => line(l, 1000)),
      { ts: 1500, stream: "stdout", line: "INFO all good" },
      ...tb("bob", 302).map((l) => line(l, 2000)),
      ...tb("cat", 302).map((l) => line(l, 3000)),
      line("ERROR: Error(message='timeout', do_not_reconnect=False)", 4000),
    ];
    const kinds = groupErrors(lines);
    expect(kinds).toHaveLength(2);
    expect(kinds[0]).toMatchObject({ count: 3, where: "highrise_bot/bot.py:302 in on_chat", example: "KeyError: 'amy'", firstTs: 1000, lastTs: 3000 });
    expect(kinds[1]).toMatchObject({ count: 1, where: "" });
  });

  it("marks kinds that weren't there at the last check-up as new", () => {
    const kinds = groupErrors(tb("amy").map((l) => ({ ts: 1, stream: "stderr", line: l })));
    expect(describeKinds(kinds, new Set())).toMatch(/^- ×1 NEW at highrise_bot\/bot\.py:302 in on_chat: KeyError: 'amy'$/);
    expect(describeKinds(kinds, new Set([kinds[0]!.key]))).not.toContain("NEW");
    expect(describeKinds(kinds, null)).not.toContain("NEW"); // first check-up: nothing to compare with
  });
});

describe("a crash loop", () => {
  const root = mkdtempSync(path.join(tmpdir(), "kojy-loop-"));
  const updates: Record<string, unknown>[] = [];
  let row: Record<string, unknown> = { desiredState: "running", restartCount: 9, autoFix: false };
  const db = {
    select: () => { const q = { from() { return q; }, where() { return q; }, limit: async () => [row] }; return q; },
    update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => { updates.push(v); } }) }),
    insert: () => ({ values: async () => undefined }),
  };
  let m: typeof import("../../../apps/runner/src/supervisor.js");
  let LIMIT: number;
  beforeAll(async () => {
    process.env.PROJECTS_DIR = path.join(root, "projects");
    process.env.VENVS_DIR = path.join(root, "venvs");
    process.env.RUNNER_SANDBOX = "off";
    mkdirSync(path.join(root, "projects"), { recursive: true });
    m = await import("../../../apps/runner/src/supervisor.js");
    LIMIT = m.CRASH_LOOP_LIMIT;
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  type Internals = { crashStreak: Map<string, number>; restartTimers: Map<string, NodeJS.Timeout>; onExit(u: string, r: unknown, c: number, sig: null): Promise<void> };
  const run = () => ({ startedAt: Date.now(), stopping: false, project: { id: 1, orgId: 1, ownerId: 1, name: "Japalo" } });

  it("is never stopped for good: past CRASH_LOOP_LIMIT it's started less and less often while Kojy keeps working on it", async () => {
    row = { desiredState: "running", restartCount: 9, autoFix: false };
    const sup = new m.Supervisor(db as never);
    const s = sup as unknown as Internals;
    let fixes = 0;
    sup.onCrash = () => { fixes++; };
    const delays: number[] = [];
    vi.spyOn(s as unknown as { startLater(u: string, sec: number): void }, "startLater").mockImplementation((_u, sec) => { delays.push(sec); });
    s.crashStreak.set("u1", LIMIT - 2);
    for (let i = 0; i < 5; i++) await s.onExit("u1", run(), 1, null);
    expect(delays).toEqual([60, 300, 900, 1800, 1800]);
    expect(updates.some((u) => u.desiredState === "stopped")).toBe(false);
    expect(String(updates.filter((u) => u.status === "crashed").at(-1)!.statusMessage)).toMatch(/^Crashed \d+ times in a row.*KojyAI keeps trying \(next in 30 min\) while Kojy works on the cause/);
    expect(fixes).toBe(5); // Kojy is told about every one
  });

});
