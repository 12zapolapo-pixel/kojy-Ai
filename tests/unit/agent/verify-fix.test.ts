/**
 * KojyAI's own checks of an automatic fix (verifyFix.ts): the code loads, the
 * crash replayed in a test room happens on the old code and not on the fixed
 * code (or at least nothing new breaks), and no saved test that passed breaks.
 * And what the agent does with the verdict: a fix that passes is kept (its
 * replay saved as a test) and watched; one that fails is undone and tried again.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tracebackSignatures, crashSignature } from "../../../apps/runner/src/agent/autoFix.js";

const root = mkdtempSync(path.join(tmpdir(), "kojy-verify-"));
const uuid = "55555555-5555-4555-8555-555555555555";
type Table = object;
const tableName = (t: Table) => (t as Record<symbol, string>)[Symbol.for("drizzle:Name")] ?? "";
let rows: Record<string, Record<string, unknown>[]> = {};
const deleted: unknown[] = [];
const db = {
  select: () => {
    let table = "";
    const q = {
      from(t: Table) { table = tableName(t); return q; },
      where() { return q; }, orderBy() { return q; }, limit() { return q; },
      then(ok: (v: unknown[]) => unknown, fail: (e: unknown) => unknown) { return Promise.resolve(rows[table] ?? []).then(ok, fail); },
    };
    return q;
  },
  update: () => ({ set: () => ({ where: async () => undefined }) }),
  delete: () => ({ where: async (w: unknown) => { deleted.push(w); } }),
  insert: (t: Table) => ({
    values: (values: Record<string, unknown>) => {
      const row = { id: 100 + (rows[tableName(t)]?.length ?? 0), ...values };
      (rows[tableName(t)] ??= []).push(row);
      const done = Promise.resolve(undefined);
      return { returning: async () => [row], onConflictDoUpdate: async () => undefined, then: done.then.bind(done) };
    },
  }),
};

let verify: typeof import("../../../apps/runner/src/agent/verifyFix.js");
let files: typeof import("../../../packages/shared/src/projects/files.js");
let Agent: typeof import("../../../apps/runner/src/agent/agent.js").Agent;
beforeAll(async () => {
  process.env.PROJECTS_DIR = root;
  process.env.GROQ_API_KEY = "gsk_fake-test-key";
  process.env.AGENT_LIVE_CHECK_MS = "3000";
  vi.resetModules();
  verify = await import("../../../apps/runner/src/agent/verifyFix.js");
  files = await import("../../../packages/shared/src/projects/files.js");
  ({ Agent } = await import("../../../apps/runner/src/agent/agent.js"));
});
afterAll(() => { delete process.env.GROQ_API_KEY; rmSync(root, { recursive: true, force: true }); });

const crashLines = (user: string) => [
  "Traceback (most recent call last):",
  '  File "bot.py", line 3, in on_chat',
  "    x = self.coins[user.username]",
  `KeyError: '${user}'`,
];
const signature = crashSignature(crashLines("tester"));

describe("finding the errors in a test room's output", () => {
  it("finds each traceback, and the real error inside an exception group", () => {
    const out = [
      "[kojy] Connected to Highrise", ...crashLines("amy"), "(bot says) hi",
      "Traceback (most recent call last):", '  File "shop.py", line 9, in buy', "    price = PRICES[item]", "KeyError: 'sword'",
      "  + Exception Group Traceback (most recent call last):", "  |   File \"/usr/lib/python3.11/asyncio/taskgroups.py\", line 145, in __aexit__",
      "  | ExceptionGroup: unhandled errors in a TaskGroup (1 sub-exception)", "  +-+---------------- 1 ----------------",
      "    | Traceback (most recent call last):", '    |   File "bot.py", line 3, in on_chat', "    |     x = self.coins[user.username]", "    | KeyError: 'bob'",
      "    +------------------------------------",
      "[kojy] done",
    ];
    expect(tracebackSignatures(out)).toEqual([signature, crashSignature(["Traceback (most recent call last):", '  File "shop.py", line 9, in buy', "KeyError: 'sword'"]), signature]);
  });
});

describe("what's replayed", () => {
  it("the event of the handler that failed; a crash while starting just starts", () => {
    expect(verify.replayEvents({ handler: "on_chat", command: "!coins" }, "in_room")).toEqual([{ type: "chat", user: "tester", message: "!coins" }]);
    expect(verify.replayEvents({ handler: "on_user_leave" }, "in_room")).toEqual([{ type: "join", user: "visitor" }, { type: "leave", user: "visitor" }]);
    expect(verify.replayEvents(undefined, "import")).toEqual([{ type: "wait", seconds: 4 }]);
    expect(verify.replayEvents({ handler: "on_moderate" }, "in_room")).toBeNull(); // the test room can't do that one
  });
});

describe("checkFix", () => {
  const project = { id: 1, uuid, orgId: 1, name: "Japalo", ownerId: 7, entrypoint: "bot:Bot" };
  const ctx = () => ({ db, supervisor: {}, project, snapshotted: true, changedFiles: new Set<string>() }) as never;
  let snapshotId = "";
  beforeAll(() => {
    files.ensureProjectDir(uuid);
    files.writeProjectFile(uuid, "bot.py", "before the fix\n");
    files.writeProjectFile(uuid, "data/coins.json", "{}");
    snapshotId = files.snapshotProject(uuid, "Before Kojy: automatic crash fix").id;
    files.writeProjectFile(uuid, "bot.py", "after the fix\n");
  });
  const room = (output: string[], extra: Record<string, unknown> = {}) => ({ connected: true, exitedEarly: false, exitCode: null, actions: [], output, errors: [], ...extra });
  /** The test room runs the old code (the extracted snapshot) and the fixed code (the project). */
  const deps = (old: string[], now: string[], tool: Record<string, { ok: boolean; summary?: string; output?: string }> = {}, extraOld = {}, extraNow = {}) => ({
    runTool: vi.fn(async (name: string) => ({ ok: true, summary: "", output: "", ...tool[name] })),
    replay: vi.fn(async (_ctx: unknown, _events: unknown, dir: string) => {
      const code = readFileSync(path.join(dir, "bot.py"), "utf8");
      return code.startsWith("before") ? room(old, extraOld) : room(now, extraNow);
    }),
  });
  const fix = () => ({ signature, snapshotId, event: { handler: "on_chat", command: "!coins" }, phase: "in_room" });

  it("proves a fix: the replay crashed on the old code (with its data) and not on the fixed code", async () => {
    rows = {};
    const d = deps(crashLines("tester"), ["(bot says) tester has 0 coins"]);
    const r = await verify.checkFix(ctx(), fix(), d as never);
    expect(r).toMatchObject({ ok: true, proven: true, events: [{ type: "chat", user: "tester", message: "!coins" }] });
    expect(r.steps).toEqual(["✓ the code loads", "✓ replayed in a test room: it crashed before the fix and not after"]);
    expect(d.replay).toHaveBeenCalledTimes(2);
  });

  it("fails when the crash still happens, when the code doesn't load, or when the fix brings a new error", async () => {
    rows = {};
    expect(await verify.checkFix(ctx(), fix(), deps(crashLines("tester"), crashLines("tester")) as never))
      .toMatchObject({ ok: false, failure: "the crash still happens when it's replayed in a test room" });
    expect(await verify.checkFix(ctx(), fix(), deps([], [], { check_code: { ok: false, summary: "Code check: syntax errors" } }) as never))
      .toMatchObject({ ok: false, failure: "the code check failed (Code check: syntax errors)" });
    const other = ["Traceback (most recent call last):", '  File "bot.py", line 5, in on_chat', "TypeError: unsupported operand"];
    const r = await verify.checkFix(ctx(), fix(), deps([], other) as never);
    expect(r.ok).toBe(false);
    expect(r.failure).toMatch(/^the fixed code has a new error in the test room \(TypeError/);
  });

  it("a crash the replay can't reproduce isn't proof, but the fix still has to run there without new errors", async () => {
    rows = {};
    const r = await verify.checkFix(ctx(), fix(), deps(["(bot says) hi"], ["(bot says) hi"]) as never);
    expect(r).toMatchObject({ ok: true, proven: false });
    expect(r.steps.at(-1)).toBe("✓ replayed in a test room without errors (the crash itself didn't show there)");
  });

  it("a crash while starting is proven by the old code never getting into the room", async () => {
    rows = {};
    const r = await verify.checkFix(ctx(), { ...fix(), phase: "import", event: {} }, deps(crashLines("x"), [], {}, { connected: false, exitedEarly: true }) as never);
    expect(r).toMatchObject({ ok: true, proven: true });
  });

  it("saved tests: one that passed before and fails now fails the fix; one that already failed doesn't", async () => {
    rows = { room_tests: [{ name: "coins", lastResult: "passed" }, { name: "dance", lastResult: "failed" }] };
    const broke = await verify.checkFix(ctx(), fix(), deps(crashLines("tester"), [], { run_saved_tests: { ok: false, output: "FAIL coins: Tested in a fake room: errors\nFAIL dance: x" } }) as never);
    expect(broke).toMatchObject({ ok: false, failure: "saved test that passed before now fails: coins" });
    const fine = await verify.checkFix(ctx(), fix(), deps(crashLines("tester"), [], { run_saved_tests: { ok: false, output: "PASS coins: ok\nFAIL dance: x" } }) as never);
    expect(fine).toMatchObject({ ok: true });
    expect(fine.steps.at(-1)).toBe("✓ saved tests: none broken by the fix (1 were already failing)");
  });

  it("keeps a proving replay as a saved test, at most 5 of its own per bot", async () => {
    rows = { room_tests: Array.from({ length: 6 }, (_, i) => ({ id: i + 1, name: `auto: crash ${i}` })) };
    deleted.length = 0;
    await verify.saveRegressionTest(ctx(), "!coins crash", [{ type: "chat", user: "tester", message: "!coins" }]);
    expect(rows.room_tests!.at(-1)).toMatchObject({ name: "auto: !coins crash", lastResult: "passed", events: [{ type: "chat", user: "tester", message: "!coins" }] });
    expect(deleted.length).toBe(2); // the oldest of the 7 automatic ones beyond 5
  });
});

describe("the agent and the checks", () => {
  function setup() {
    rows = { bot_projects: [{ id: 1, uuid, orgId: 1, name: "Japalo", ownerId: 7, autoFix: true, desiredState: "running", entrypoint: "bot:Bot" }], project_messages: [], agent_work_log: [], room_tests: [] };
    files.writeProjectFile(uuid, "bot.py", "before the fix\n");
    const supervisor = { onCrash: undefined as undefined | ((u: string, s: number, t: string[], i: unknown) => void), isRunning: vi.fn(() => true), handle: vi.fn(async () => undefined) };
    const agent = new Agent(db as never, supervisor as never, null);
    const run = vi.spyOn(agent, "run").mockImplementation(async () => {
      files.writeProjectFile(uuid, "bot.py", "after the fix\n"); // Kojy's edit
      rows.agent_work_log = [{ status: "done", summary: "Used .get() so a new visitor has 0 coins.", files: [{ path: "bot.py", change: "edited" }], actions: ["read_file", "edit_file", "check_code"] }];
      return { outcome: "done", ended: null, aiUnavailable: false };
    });
    vi.spyOn(agent, "liveCheck").mockResolvedValue({ ok: true, why: "the bot is back in its room with the fix" });
    const fire = async () => {
      supervisor.onCrash!(uuid, 1, crashLines("amy"), { id: 9, category: "code", phase: "in_room", data: { report: { event: { handler: "on_chat", command: "!coins" } } } });
      await new Promise((r) => setTimeout(r, 60));
    };
    const messages = () => rows.project_messages!.map((m) => String(m.content));
    return { agent, run, fire, messages };
  }

  it("a fix that passes is kept, said so in the chat, watched, and its replay saved as a test", async () => {
    const { agent, fire, messages } = setup();
    agent.checkFix = vi.fn(async () => ({ ok: true, steps: ["✓ the code loads", "✓ replayed in a test room: it crashed before the fix and not after"], proven: true, events: [{ type: "chat" as const, user: "tester", message: "!coins" }] }));
    await fire();
    expect(agent.checkFix).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ signature: crashSignature(crashLines("amy")), event: { handler: "on_chat", command: "!coins" }, phase: "in_room" }));
    expect(readFileSync(path.join(root, uuid, "bot.py"), "utf8")).toBe("after the fix\n");
    expect(messages()).toContainEqual(expect.stringMatching(/^🔎 KojyAI checked the fix:\n- ✓ the code loads\n- ✓ replayed in a test room: it crashed before the fix and not after\n- ✓ the bot is back in its room with the fix$/));
    expect((agent as unknown as { watching: Map<string, unknown> }).watching.has(uuid)).toBe(true);
    expect(rows.room_tests).toContainEqual(expect.objectContaining({ name: "auto: !coins crash" }));
  });

  it("a fix that fails is undone and tried again at once, told why; failing again, the next try waits", async () => {
    const { agent, run, fire, messages } = setup();
    agent.checkFix = vi.fn(async () => ({ ok: false, steps: ["✓ the code loads", "✗ the crash still happens when it's replayed in a test room"], failure: "the crash still happens when it's replayed in a test room", proven: false }));
    await fire();
    await new Promise((r) => setTimeout(r, 100));
    expect(messages()).toContainEqual(expect.stringMatching(/^↶ The fix didn't pass KojyAI's checks \(the crash still happens when it's replayed in a test room\), so I put the code back as it was\. I'm trying again now/));
    const requests = rows.project_messages!.filter((m) => m.kind === "crash").map((m) => String(m.content));
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatch(/An earlier automatic fix for this crash was undone because KojyAI's checks found that the crash still happens when it's replayed in a test room/);
    // The second attempt failed too: the third waits.
    expect(run).toHaveBeenCalledTimes(2);
    expect(messages().at(-1)).toMatch(/I'm trying again at about \d\d:\d\d UTC/);
    expect(readFileSync(path.join(root, uuid, "bot.py"), "utf8")).toBe("before the fix\n");
  });
});

describe("the live check: the real bot, with the fix, back in its room", () => {
  const logFile = () => path.join(root, ".logs", `${uuid}.log`);
  const log = (stream: string, line: string, ts = Date.now()) => appendFileSync(logFile(), JSON.stringify({ ts, stream, line }) + "\n");
  let snapshotId = "";
  beforeAll(() => {
    mkdirSync(path.join(root, ".logs"), { recursive: true });
    files.writeProjectFile(uuid, "bot.py", "before\n");
    snapshotId = files.snapshotProject(uuid, "Before Kojy: automatic crash fix").id;
    files.writeProjectFile(uuid, "bot.py", "after\n");
    const changed = (Date.now() - 60_000) / 1000;
    utimesSync(path.join(root, uuid, "bot.py"), changed, changed); // the fix was written a minute ago
  });
  const make = (onRestart: () => void = () => undefined) => {
    const supervisor = { isRunning: vi.fn(() => true), handle: vi.fn(async () => { onRestart(); }) };
    rows = { bot_projects: [] };
    return { agent: new Agent(db as never, supervisor as never, null), supervisor };
  };
  const project = { id: 1, uuid, entrypoint: "bot:Bot" } as never;

  it("Kojy already restarted it after the change and it connected: no extra restart", async () => {
    writeFileSync(logFile(), "");
    log("system", "▶ Starting bot:Bot", Date.now() - 30_000);
    log("stdout", "[kojy] Connected to Highrise (connection c1)", Date.now() - 25_000);
    const { agent, supervisor } = make();
    expect(await agent.liveCheck(uuid, project, snapshotId)).toEqual({ ok: true, why: "the bot is back in its room with the fix" });
    expect(supervisor.handle).not.toHaveBeenCalled();
  });

  it("still running the code from before the fix: restarted, and has to connect", async () => {
    writeFileSync(logFile(), "");
    log("system", "▶ Starting bot:Bot", Date.now() - 3600_000);
    const { agent, supervisor } = make(() => { log("system", "▶ Starting bot:Bot"); log("stdout", "[kojy] Connected to Highrise"); });
    expect(await agent.liveCheck(uuid, project, snapshotId)).toMatchObject({ ok: true });
    expect(supervisor.handle).toHaveBeenCalledWith(uuid, "restart");
  });

  it("crashing right after starting with the fix fails it", async () => {
    writeFileSync(logFile(), "");
    const { agent } = make(() => { log("system", "▶ Starting bot:Bot"); log("system", "✖ Bot exited (code 1) after 1s — restarting in 5s"); });
    expect(await agent.liveCheck(uuid, project, snapshotId)).toEqual({ ok: false, why: "the bot crashed right after starting with the fix" });
  });
});
