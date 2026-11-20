/**
 * The runner's side of the launcher's crash reports: a report is checked
 * like any bot output, classified the same way its console traceback would
 * be (same signature), and routed — a crash's report waits for the exit, an
 * error the bot survived goes to Kojy right away while the bot keeps running.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { classifyExit, parseReport, reportToTail, type CrashReport } from "../../../apps/runner/src/incidents.js";
import { crashExcerpt, crashSignature } from "../../../apps/runner/src/agent/autoFix.js";

const keyError: CrashReport = {
  k: "crash", fatal: true, phase: "in_room", type: "KeyError", line: "KeyError: 'amy'", connected: true,
  frames: [
    { file: "highrise_bot/bot.py", line: 120, func: "on_chat", code: "await self.highrise.chat(self.lookup(user.username))" },
    { file: "highrise_bot/bot.py", line: 302, func: "lookup", code: "return self.coins[name]" },
  ],
  event: { handler: "on_chat", command: "!coins" },
};

describe("crash reports", () => {
  it("are checked like any bot output: junk is dropped, long text clipped, nothing but known fields kept", () => {
    expect(parseReport({ k: "chat" })).toBeNull();
    expect(parseReport("crash")).toBeNull();
    const r = parseReport({ k: "error", type: "X".repeat(500), line: "ValueError: " + "a".repeat(2000), frames: [{ file: "a.py", line: 3, func: "f" }, { nope: 1 }, "x"], evil: "rm -rf", times: 7 })!;
    expect(r.k).toBe("error");
    expect(r.fatal).toBe(false);
    expect(r.type!.length).toBeLessThanOrEqual(120);
    expect(r.line!.length).toBeLessThanOrEqual(600);
    expect(r.frames).toEqual([{ file: "a.py", line: 3, func: "f" }]);
    expect(r.times).toBe(7);
    expect(r).not.toHaveProperty("evil");
  });

  it("written out as a traceback, give Kojy the same excerpt and the same signature as the console would", () => {
    const tail = reportToTail(keyError);
    const console = [
      "Traceback (most recent call last):",
      '  File "/app/projects/u1/highrise_bot/bot.py", line 120, in on_chat',
      "    await self.highrise.chat(self.lookup(user.username))",
      '  File "/app/projects/u1/highrise_bot/bot.py", line 302, in lookup',
      "    return self.coins[name]",
      "KeyError: 'amy'",
    ];
    expect(crashExcerpt(tail)).toContain("in lookup");
    expect(crashSignature(tail)).toBe(crashSignature(console));
    expect(classifyExit({ tail: [], how: "code 1", ranForMs: 1000, report: keyError }).signature).toBe(classifyExit({ tail: console, how: "code 1", ranForMs: 1000 }).signature);
  });

  it("decide the incident: phase from the report, a survived error isn't fatal, the cause is kept for Kojy", () => {
    const c = classifyExit({ tail: [], how: "code 1", ranForMs: 1000, report: keyError });
    expect(c).toMatchObject({ category: "code", phase: "in_room", fatal: true, summary: "KeyError: '…' in lookup (highrise_bot/bot.py)" });
    const survived = classifyExit({ tail: [], how: "kept running", ranForMs: 0, report: { ...keyError, k: "error", fatal: false } });
    expect(survived).toMatchObject({ category: "code", fatal: false, signature: c.signature });
    const withCause = reportToTail({ ...keyError, cause: { line: "ValueError: invalid literal for int() with base 10: 'x'", frame: { file: "shop.py", line: 4, func: "price" } } });
    expect(withCause.join("\n")).toMatch(/ValueError[\s\S]*During handling of the above exception[\s\S]*KeyError: 'amy'/);
  });

  it("Highrise refusing the session is the owner's to check; Highrise closing a session it had accepted is not a bug", () => {
    const refused = classifyExit({ tail: [], how: "code 5", ranForMs: 2000, report: { k: "crash", fatal: true, type: "SessionEnded", line: "ERROR: Invalid room id or api token closing connection with ID: x", connected: false, frames: [] } });
    expect(refused).toMatchObject({ category: "highrise_refused", state: "needs_owner", signature: "refused:ERROR: Invalid room id or api token" });
    const ended = classifyExit({ tail: [], how: "code 5", ranForMs: 600_000, report: { k: "crash", fatal: true, type: "SessionEnded", line: "Websocket error, exiting.", connected: true, frames: [] } });
    expect(ended).toMatchObject({ category: "network", state: "ignored" });
  });

  it("the watchdog's reports keep their kinds", () => {
    expect(classifyExit({ tail: [], how: "code 4", ranForMs: 400_000, report: { k: "crash", fatal: true, type: "NotInRoom", line: "[kojy] Watchdog: Highrise didn't answer 3 room checks in a row", connected: true, frames: [] } }).category).toBe("not_in_room");
    expect(classifyExit({ tail: [], how: "code 3", ranForMs: 70_000, report: { k: "crash", fatal: true, type: "BotFrozenError", line: "BotFrozenError: stuck for 61s", connected: true, frames: [{ file: "weather.py", line: 40, func: "fetch", code: "time.sleep(30)" }] } }).category).toBe("frozen");
  });
});

describe("the supervisor and reports", () => {
  const root = mkdtempSync(path.join(tmpdir(), "kojy-reports-"));
  const db = {
    select: () => { const q = { from() { return q; }, where() { return q; }, limit: async () => [{ desiredState: "running", restartCount: 0 }] }; return q; },
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    insert: () => ({ values: async () => undefined }),
  };
  let sup: InstanceType<typeof import("../../../apps/runner/src/supervisor.js").Supervisor>;
  beforeAll(async () => {
    process.env.PROJECTS_DIR = path.join(root, "projects");
    process.env.VENVS_DIR = path.join(root, "venvs");
    process.env.RUNNER_SANDBOX = "off";
    mkdirSync(path.join(root, "projects"), { recursive: true });
    const m = await import("../../../apps/runner/src/supervisor.js");
    sup = new m.Supervisor(db as never);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  type Internals = { onReport(u: string, p: unknown, raw: unknown): void; onExit(u: string, r: unknown, c: number, sig: null): Promise<void>; restartTimers: Map<string, NodeJS.Timeout> };
  const project = { id: 1, orgId: 1, ownerId: 1, name: "Japalo" };

  it("an error the bot survived goes to Kojy right away, as an incident that isn't fatal", async () => {
    const record = vi.spyOn(sup.incidents, "record").mockResolvedValue({ id: 5, category: "code" } as never);
    const seen: unknown[][] = [];
    sup.onBotError = (...args) => { seen.push(args); };
    (sup as unknown as Internals).onReport("u1", project, { ...keyError, k: "error", times: 3 });
    await new Promise((r) => setTimeout(r, 10));
    expect(record).toHaveBeenCalledWith(1, expect.objectContaining({ fatal: false, category: "code" }), "kept running", expect.objectContaining({ k: "error" }), 3);
    expect(seen).toHaveLength(1);
    expect((seen[0]![1] as string[]).at(-1)).toBe("KeyError: 'amy'");
    expect(seen[0]![2]).toEqual({ id: 5, category: "code" });
    record.mockRestore();
  });

  it("a crash's report is used when the bot exits: the incident is classified from it and Kojy gets its traceback", async () => {
    const record = vi.spyOn(sup.incidents, "record").mockResolvedValue({ id: 6, category: "code", summary: "KeyError: '…' in lookup (highrise_bot/bot.py)" } as never);
    const crashes: unknown[][] = [];
    sup.onCrash = (...args) => { crashes.push(args); };
    (sup as unknown as Internals).onReport("u2", project, keyError);
    await (sup as unknown as Internals).onExit("u2", { startedAt: Date.now() - 5000, stopping: false, project }, 1, null);
    expect(record).toHaveBeenCalledWith(1, expect.objectContaining({ phase: "in_room", category: "code" }), "code 1", expect.objectContaining({ k: "crash", line: "KeyError: 'amy'" }));
    expect(crashes).toHaveLength(1);
    expect((crashes[0]![2] as string[]).join("\n")).toContain('File "highrise_bot/bot.py", line 302, in lookup');
    clearTimeout((sup as unknown as Internals).restartTimers.get("u2"));
    record.mockRestore();
  });
});
