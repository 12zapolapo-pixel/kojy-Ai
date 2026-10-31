import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const work = mkdtempSync(path.join(tmpdir(), "kojy-quality-"));
process.env.PROJECTS_DIR = path.join(work, "projects");
afterAll(() => rmSync(work, { recursive: true, force: true }));

const { forgivingReplace, replaceLines, parseIssues, projectMap, formatIssues } = await import("../../../apps/runner/src/agent/codeQuality.js");
const { parseSteps } = await import("../../../apps/runner/src/agent/mockRoom.js");
const { evaluate, toTest, parseRefusals } = await import("../../../apps/runner/src/agent/botTests.js");
const { unifiedDiff, parseReview } = await import("../../../apps/runner/src/agent/review.js");
const { findProblem, Agent } = await import("../../../apps/runner/src/agent/agent.js");
const { snapshotProject } = await import("../../../packages/shared/src/projects/index.js");
const { testSettings } = await import("../../../apps/runner/src/agent/tools.js");

describe("forgiving edits", () => {
  const file = "class Bot:\n    async def on_chat(self, user, message):\n        if message == \"!hi\":\n            await self.highrise.chat(\"hi\")\n";

  it("replaces an exact match", () => {
    const r = forgivingReplace(file, 'await self.highrise.chat("hi")', 'await self.highrise.chat("hello")');
    expect(r.ok && r.text).toContain('chat("hello")');
  });

  it("fixes the indentation when the AI copied it wrong", () => {
    const r = forgivingReplace(file, 'if message == "!hi":\n    await self.highrise.chat("hi")', 'if message == "!hey":\n    await self.highrise.chat("hey")');
    expect(r.ok).toBe(true);
    expect(r.ok && r.text).toContain('        if message == "!hey":\n            await self.highrise.chat("hey")');
  });

  it("shows the closest lines when nothing matches", () => {
    const r = forgivingReplace(file, 'if message == "!hi":\n    await self.highrise.chat("bye")', "x");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/Closest place \(1 of 2 lines match\), lines 3-6/);
  });

  it("refuses an ambiguous match", () => {
    expect(forgivingReplace("a\na\n", "a", "b").ok).toBe(false);
  });

  it("replaces line ranges", () => {
    const r = replaceLines("1\n2\n3\n4", 2, 3, "two\nthree\nmore");
    expect(r.ok && r.text).toBe("1\ntwo\nthree\nmore\n4");
    expect(replaceLines("1\n2", 2, 5, "x").ok).toBe(false);
  });
});

describe("code checker output", () => {
  it("keeps real bugs as errors and treats may-be-Error/None as warnings", () => {
    const mypy = [
      'bot.py:12: error: Item "RoomPermissions" of "RoomPermissions | Error" has no attribute "owner"  [union-attr]',
      'bot.py:12: error: Item "Error" of "RoomPermissions | Error" has no attribute "owner"  [union-attr]',
      'bot.py:19: error: "Highrise" has no attribute "send_chat"; maybe "send_channel"?  [attr-defined]',
      'bot.py:30: error: Value of type "list[Any] | None" is not indexable  [index]',
      'bot.py:40: error: Need type annotation for "x"  [var-annotated]',
    ].join("\n");
    const issues = parseIssues(mypy, "mypy");
    expect(issues.map((i) => `${i.line}:${i.severity}`)).toEqual(["12:error", "12:warning", "19:error", "30:warning"]);
    const flakes = parseIssues("bot.py:19:49: undefined name 'usr'\nbot.py:1:1: 'os' imported but unused", "pyflakes");
    expect(flakes).toEqual([expect.objectContaining({ line: 19, severity: "error", message: "undefined name 'usr'" })]);
    expect(formatIssues([...issues, ...flakes])).toMatch(/^Errors[\s\S]*bot\.py:19: undefined name 'usr'[\s\S]*Warnings/);
  });
});

describe("project map", () => {
  it("lists files, functions with lines and chat commands, but not tests", () => {
    const dir = path.join(process.env.PROJECTS_DIR!, "map-1");
    mkdirSync(path.join(dir, "tests"), { recursive: true });
    writeFileSync(path.join(dir, "bot.py"), 'class DJ:\n    async def on_chat(self, u, m):\n        if m == "!request": pass\n        if m == "!skip": pass\n');
    writeFileSync(path.join(dir, "tests", "test_bot.py"), "def test_x(): pass\n");
    const map = projectMap("map-1");
    expect(map).toBe("bot.py (5 lines): class DJ L1, on_chat L2 · commands: !request !skip");
  });
});

describe("test room steps and checks", () => {
  it("turns steps into timed events from different people", () => {
    const { events } = parseSteps(["owner: !clear", "!help", "whisper mod: psst", "join newbie", "tip newbie 50", "wait 4", "leave newbie"]);
    expect(events.map((e) => [e.type, e.user, e.at])).toEqual([
      ["chat", "owner", 3000], ["chat", "tester", 5000], ["chat", "mod", 7000], ["join", "newbie", 9000], ["tip", "newbie", 11000], ["leave", "newbie", 17000],
    ]);
    expect(events[2]).toMatchObject({ whisper: true, message: "psst" });
  });

  it("checks what the bot did", () => {
    const result = { connected: true, exitedEarly: false, exitCode: null, output: [], errors: [],
      actions: ["(visitor says: !request X)", "say: Added: X", "whisper to visitor: only the owner", "emote dance-floss", "say: Added: Y"] };
    const out = evaluate(["says: added: x", "whispers: owner", "not says: cleared", "does: emote", "count says: added = 2", "says: nope", "no errors", "bogus"], result);
    expect(out.map((c) => c.ok)).toEqual([true, true, true, true, true, false, true, false]);
  });

  it("validates saved tests and refusals", () => {
    expect(toTest({ name: "x", steps: ["!a"] }, testSettings)).toMatch(/at least one check/);
    expect(toTest({ name: "x", steps: ["!a"], expect: ["says: a"], env: ["A=1", "HIGHRISE_ROOM_ID=x"] }, testSettings)).toEqual({ name: "x", steps: ["!a"], expect: ["says: a"], env: { A: "1" } });
    expect(parseRefusals(["ChangeRoomPrivilegeRequest=You can't edit this room.", "rm -rf=x"])).toEqual({ ChangeRoomPrivilegeRequest: "You can't edit this room." });
  });
});

describe("diff and review", () => {
  it("shows a unified diff with context", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const after = before.replace("line 10", "line ten").replace("line 18", "line 18\nnew line");
    const d = unifiedDiff(before, after);
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
    expect(d.diff).toContain("-line 10\n+line ten");
    expect(d.diff).toContain("+new line");
    expect(d.diff.split("\n").filter((l) => l.startsWith("@@"))).toEqual(["@@ -7,7 +7,7 @@", "@@ -16,5 +16,6 @@"]); // 8 lines apart: two hunks
  });

  it("reads the reviewer's JSON, even with text around it", () => {
    const r = parseReview('Sure:\n{"problems":[{"severity":"high","file":"bot.py","line":12,"problem":"owner doesn\'t exist on RoomPermissions","fix":"compare user.id to the room owner"}],"summary":"one bug"}');
    expect(r.problems).toEqual([{ severity: "high", file: "bot.py", line: 12, problem: "owner doesn't exist on RoomPermissions", fix: "compare user.id to the room owner" }]);
    expect(parseReview("no json").problems).toEqual([]);
  });
});

describe("watching a bot after a restart", () => {
  const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ status: "running", statusMessage: null }] }) }) }) };
  const log = (uuid: string, lines: [string, string][]) => {
    const dir = path.join(process.env.PROJECTS_DIR!, ".logs");
    mkdirSync(dir, { recursive: true });
    for (const [stream, line] of lines) appendFileSync(path.join(dir, `${uuid}.log`), JSON.stringify({ ts: Date.now(), stream, line }) + "\n");
  };

  it("spots a crash, and an error from a changed file, but not an old error elsewhere", async () => {
    const since = Date.now() - 1;
    log("w1", [["stderr", "[kojy] Error in on_chat; skipped it, the bot stays in the room."], ["stderr", "Traceback (most recent call last):"],
      ["stderr", '  File "/app/projects/w1/other.py", line 3, in on_chat'], ["stderr", "KeyError: 'x'"]]);
    expect(await findProblem(db as any, "w1", since, ["bot.py"])).toBeNull();
    log("w1", [["stderr", "[kojy] Error in on_chat; skipped it, the bot stays in the room."], ["stderr", "Traceback (most recent call last):"],
      ["stderr", '  File "/app/projects/w1/bot.py", line 9, in on_chat'], ["stderr", "AttributeError: 'RoomPermissions' object has no attribute 'owner'"]]);
    expect(await findProblem(db as any, "w1", since, ["bot.py"])).toMatch(/^A command failed in code this change touched:[\s\S]*has no attribute 'owner'/);
    log("w2", [["stderr", "Traceback (most recent call last):"], ["stderr", "RuntimeError: boom"], ["system", "✖ Bot exited (code 1) after 3s — restarting in 5s"]]);
    expect(await findProblem(db as any, "w2", since, [])).toMatch(/^The bot crashed:\nTraceback[\s\S]*boom/);
  });
});

describe("rollback and the job queue", () => {
  it("puts the old code back but keeps Kojy's tests and spec, then restarts and tells Kojy", async () => {
    const uuid = "rb-1";
    const dir = path.join(process.env.PROJECTS_DIR!, uuid);
    mkdirSync(path.join(dir, ".kojy"), { recursive: true });
    writeFileSync(path.join(dir, "bot.py"), "good = True\n");
    const snap = snapshotProject(uuid, "before");
    writeFileSync(path.join(dir, "bot.py"), "good = False\n");
    writeFileSync(path.join(dir, "new.py"), "x = 1\n");
    writeFileSync(path.join(dir, ".kojy", "tests.json"), "[\"new test\"]\n");
    const handle = vi.fn(async () => {});
    const added: string[] = [];
    const agent: any = new Agent({} as any, { handle } as any, null);
    agent.add = async (_s: unknown, _r: string, content: string, kind: string) => { added.push(`${kind}: ${content}`); return {}; };
    agent.run = vi.fn(async () => {});
    await agent.rollback(uuid, { id: 1, ownerId: 7, name: "DJ" }, snap.id, "The bot crashed:\nboom");
    expect(readFileSync(path.join(dir, "bot.py"), "utf8")).toBe("good = True\n");
    expect(existsSync(path.join(dir, "new.py"))).toBe(false);
    expect(readFileSync(path.join(dir, ".kojy", "tests.json"), "utf8")).toBe("[\"new test\"]\n");
    expect(handle).toHaveBeenCalledWith(uuid, "restart");
    expect(added[0]).toMatch(/^rollback: The change you just made broke the bot[\s\S]*boom/);
    expect(agent.run).toHaveBeenCalledWith(uuid);
  });

  it("runs 2 jobs at once and queues the rest in order", async () => {
    const agent: any = new Agent({ update: () => ({ set: () => ({ where: async () => {} }) }) } as any, {} as any, null);
    const order: string[] = [];
    const gates = new Map<string, () => void>();
    agent.runOnce = (uuid: string) => new Promise<void>((resolve) => { order.push(`start ${uuid}`); gates.set(uuid, () => { order.push(`end ${uuid}`); resolve(); }); });
    const runs = ["a", "b", "c", "d"].map((u) => agent.run(u));
    await new Promise((r) => setTimeout(r, 20));
    expect(agent.jobs()).toEqual({ running: ["a", "b"], queued: ["c", "d"] });
    gates.get("a")!();
    await new Promise((r) => setTimeout(r, 20));
    expect(agent.jobs()).toEqual({ running: ["b", "c"], queued: ["d"] });
    for (const u of ["b", "c"]) gates.get(u)!();
    await new Promise((r) => setTimeout(r, 20));
    gates.get("d")!();
    await Promise.all(runs);
    expect(order).toEqual(["start a", "start b", "end a", "start c", "end b", "end c", "start d", "end d"]);
    expect(agent.jobs()).toEqual({ running: [], queued: [] });
  });
});
