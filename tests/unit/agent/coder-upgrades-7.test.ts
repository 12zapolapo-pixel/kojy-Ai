/**
 * Kojy round 7: round 6's tools, sharpened.
 *
 * - tool loading: group words match whole words only; a model that calls a
 *   tool that wasn't sent gets it and is asked again (no lost answer).
 * - profile_code: hottest lines, slow library calls traced to the bot line,
 *   repeat, and placeholder secrets (never the real ones).
 * - benchmark: noise-aware verdict, memory, and growth with data size.
 * - code_metrics: before → after, renamed copies.
 * - type_check: likely bugs apart from type-hint notes, cache kept.
 * - optimize_query: index order, time before → after, WAL + statistics,
 *   several databases, a bot on an outside host.
 * - bot_resources: memory change between checks.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const root = mkdtempSync(path.join(tmpdir(), "kojy-r7-"));
const uuid = "77777777-7777-4777-8777-000000000007";
const hasMypy = spawnSync(process.env.KOJY_MYPY ?? "mypy", ["--version"]).status === 0;
const SECRET = "very-secret-value-r7";

let tools: typeof import("../../../apps/runner/src/agent/tools.js");
let files: typeof import("../../../packages/shared/src/projects/files.js");
let ctx: import("../../../apps/runner/src/agent/tools.js").ToolContext;
let host: string | null = null;
let running = false;

beforeAll(async () => {
  process.env.PROJECTS_DIR = path.join(root, "projects");
  process.env.VENVS_DIR = path.join(root, "venvs");
  process.env.RUNNER_SANDBOX = "off";
  vi.resetModules();
  tools = await import("../../../apps/runner/src/agent/tools.js");
  files = await import("../../../packages/shared/src/projects/files.js");
  files.ensureProjectDir(uuid);
  const supervisor = {
    ensureVenv: async () => "python3",
    botEnv: async () => ({ PATH: process.env.PATH, HOME: root, API_TOKEN: SECRET }),
    secrets: async () => ({ API_TOKEN: SECRET, ROOM_ID: "12345" }),
    isRunning: () => running,
    pidOf: () => process.pid,
    hostNote: () => host,
  };
  ctx = { db: {} as never, supervisor: supervisor as never, project: { id: 1, uuid, orgId: 1, entrypoint: "run: python bot.py" } as never, snapshotted: false, changedFiles: new Set() };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const run = (name: string, args: Record<string, unknown>) => tools.runTool(name, args, ctx);
const dir = () => files.projectDir(uuid);
const write = (rel: string, text: string) => { mkdirSync(path.dirname(path.join(dir(), rel)), { recursive: true }); writeFileSync(path.join(dir(), rel), text); };

// ── tool loading ─────────────────────────────────────────────────────────────

describe("tool groups match whole words", () => {
  it("doesn't load a group for a word inside another word", async () => {
    const { groupsFor } = await import("../../../apps/runner/src/agent/toolsets.js");
    expect(groupsFor("add a prefix command to my program")).not.toContain("quality"); // "ram" in program
    expect(groupsFor("add a prefix command to my program")).not.toContain("debug"); // "fix" in prefix
    expect(groupsFor("this is important")).not.toContain("setup"); // "import"
    expect(groupsFor("make the greeting comfortable")).not.toContain("data"); // "table"
    expect(groupsFor("when someone types !help, answer")).not.toContain("quality"); // "types"
    expect(groupsFor("make the bot better at greeting")).not.toContain("quality");
  });

  it("still loads the right groups for real requests", async () => {
    const { groupsFor } = await import("../../../apps/runner/src/agent/toolsets.js");
    expect(groupsFor("the bot is slow and laggy")).toContain("quality");
    expect(groupsFor("it uses too much RAM".toLowerCase())).toContain("quality");
    expect(groupsFor("fix the crash")).toEqual(expect.arrayContaining(["debug"]));
    expect(groupsFor("give amy 100 coins")).toContain("data");
    expect(groupsFor("add my discord token")).toContain("setup");
    expect(groupsFor("make it dance")).toContain("emotes");
    expect(groupsFor("clean up the code")).toEqual(["quality"]); // not code + quality
  });
});

describe("a model that calls a tool that wasn't sent", () => {
  let server: Server;
  const asked: string[][] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const names = ((JSON.parse(body) as { tools?: { function: { name: string } }[] }).tools ?? []).map((t) => t.function.name);
        asked.push(names);
        if (!names.includes("profile_code")) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "tool call validation failed: attempted to call tool 'profile_code' which was not in request.tools", type: "invalid_request_error", code: "tool_use_failed" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "profile_code", arguments: "{\"module\":\"shop\",\"function\":\"top\"}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("gets the tool added and is asked again on the same AI", async () => {
    const saved = { ...process.env };
    for (const k of Object.keys(process.env)) if (/^(AGENT_API_KEYS?|MISTRAL_API_KEY|LITELLM_|CEREBRAS_|SAMBANOVA_|GITHUB_MODELS_|OPENROUTER_|GONKAROUTER_)/.test(k)) delete process.env[k];
    process.env.GROQ_API_KEY = "gsk-test-not-real";
    process.env.GROQ_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      vi.resetModules();
      const ai = await import("../../../apps/runner/src/agent/groq.js");
      ai._resetAiStateForTests();
      const all = (await import("../../../apps/runner/src/agent/tools.js")).TOOL_SPECS;
      const sent = all.filter((t) => t.function.name === "read_file");
      const more = all.filter((t) => t.function.name !== "read_file");
      const out = await ai.chat({ messages: [{ role: "user", content: "profile it" }], tools: sent, moreTools: more });
      expect(out.message.tool_calls?.[0]?.function.name).toBe("profile_code");
      expect(asked[0]).toEqual(["read_file"]);
      expect(asked[1]).toEqual(["read_file", "profile_code"]);
    } finally {
      process.env = saved;
      vi.resetModules();
    }
  });

  it("missingToolIn only adds tools that exist and weren't sent", async () => {
    const { missingToolIn } = await import("../../../apps/runner/src/agent/groq.js");
    const spec = (name: string) => ({ type: "function" as const, function: { name, description: "", parameters: {} } });
    const msg = "tool call validation failed: attempted to call tool 'benchmark' which was not in request.tools";
    expect(missingToolIn(msg, [spec("read_file")], [spec("benchmark")])?.function.name).toBe("benchmark");
    expect(missingToolIn(msg, [spec("benchmark")], [spec("benchmark")])).toBeNull();
    expect(missingToolIn(msg.replace("benchmark", "rm_everything"), [], [spec("benchmark")])).toBeNull();
  });
});

// ── profile_code ─────────────────────────────────────────────────────────────

describe("profile_code", () => {
  beforeAll(() => {
    write("shop.py", [
      "import os, time, asyncio",
      "TOKEN = os.environ['API_TOKEN']  # read on import",
      "ROOM = int(os.environ['ROOM_ID'])",
      "",
      "def crunch(n):",
      "    total = 0",
      "    for i in range(n):",
      "        total += i * i % 7",
      "    return total",
      "",
      "def cooldown():",
      "    time.sleep(0.12)",
      "",
      "async def on_chat(msg):",
      "    crunch(300000)",
      "    cooldown()",
      "    await asyncio.sleep(0)",
      "    return TOKEN[:4]",
      "",
      "def quick(x):",
      "    return x * 2",
      "",
    ].join("\n"));
  });

  it("finds the hottest line, the blocking call and the bot code that made it — with placeholder secrets", async () => {
    const r = await run("profile_code", { module: "shop", function: "on_chat", args: ["hi"] });
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/Hottest lines of the bot's own code[^\n]*\n\s+[\d.]+%\s+shop\.py:[78] in crunch/);
    expect(r.output).toMatch(/time\.sleep>?: [\d.]+ ms in 1 call — from shop\.py:11 cooldown/);
    expect(r.output).toMatch(/BLOCKED THE EVENT LOOP 1 time/);
    expect(r.output).toMatch(/likely cause: .*time\.sleep.*from shop\.py:11 cooldown/);
    expect(r.output).not.toContain(SECRET);
    expect(r.summary).toMatch(/hottest shop\.py:[78]/);
  });

  it("repeat calls a quick function many times", async () => {
    const r = await run("profile_code", { module: "shop", function: "quick", args: [3], repeat: 500 });
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/per call, 500 calls/);
  });
});

// ── benchmark ────────────────────────────────────────────────────────────────

describe("benchmark", () => {
  it("calls the same code no real difference, and says which uses less memory", async () => {
    const same = await run("benchmark", { setup: "data = list(range(2000))", baseline: "result = sum(data)", code: "result = sum(data)", seconds: 0.5 });
    expect(same.output).toMatch(/RESULT: no real difference \(the timings overlap; runs vary ±\d+%\)/);
    const mem = await run("benchmark", { setup: "data = list(range(20000))", baseline: "result = len([x * 2 for x in data])", code: "result = sum(1 for x in data)", seconds: 0.5 });
    expect(mem.output).toMatch(/Memory: the new version uses [\d.]+× less/);
    expect(mem.output).toMatch(/Same `result` from both: yes/);
  });

  it("measures how the time grows with the data: O(n²) vs O(n)", async () => {
    const r = await run("benchmark", {
      setup: "data = list(range(n))",
      baseline: "result = sum(1 for x in data if data.count(x) == 1)",
      code: "result = len(set(data))",
      sizes: [250, 500, 1000, 2000], seconds: 1,
    });
    expect(r.ok).toBe(true);
    const k = (label: string) => Number(new RegExp(`^${label}: [^\\n]*\\n  → grows like n\\^([\\d.]+)`, "m").exec(r.output)?.[1]);
    expect(k("baseline")).toBeGreaterThan(1.6); // quadratic
    expect(k("new")).toBeLessThan(1.4); // linear
    expect(r.output).toMatch(/quadratic, O\(n²\)/);
    expect(r.output).toMatch(/RESULT: at n=2000 the new version is [\d.]+× faster/);
    expect(r.summary).toMatch(/^Benchmark: grows like n\^/);
  }, 60_000);
});

// ── code_metrics ─────────────────────────────────────────────────────────────

const MESSY = `def handle(msg, user, players, db, log, cfg, extra):
    if msg == "a":
        if user:
            if players:
                if db:
                    if log:
                        return 1
    elif msg == "b" or msg == "c" or msg == "d":
        return 2
    elif msg == "e":
        for p in players:
            if p and user and db:
                return 3
    elif msg == "f":
        return 4
    return 0


def total_a(xs):
    t = 0
    for x in xs:
        t += x
    print(t)
    return t


def total_b(items):
    total = 0
    for it in items:
        total += it
    print(total)
    return total
`;
const CLEAN = `ANSWERS = {"b": 2, "c": 2, "d": 2, "f": 4}


def handle(msg, user, players, db):
    if msg == "a":
        return 1 if user and players and db else 0
    if msg == "e":
        return 3 if any(p and user and db for p in players) else 0
    return ANSWERS.get(msg, 0)


def total(xs):
    t = sum(xs)
    print(t)
    return t
`;

describe("code_metrics", () => {
  it("finds copies with renamed variables", async () => {
    write("messy.py", MESSY);
    const r = await run("code_metrics", { path: "messy.py" });
    expect(r.output).toMatch(/same code with renamed variables[^\n]*\n- messy\.py:\d+ total_a ≈ messy\.py:\d+ total_b/);
    expect(r.output).toMatch(/handle: .*nested 5 deep.*7 arguments|handle: .*7 arguments/);
  });

  it("compare='request' shows before → after for this request", async () => {
    ctx.snapshotted = false; ctx.snapshotId = undefined;
    expect((await run("code_metrics", { compare: "request" })).summary).toBe("Nothing to compare yet");
    await run("write_file", { path: "messy.py", content: CLEAN });
    const r = await run("code_metrics", { path: "messy.py", compare: "request" });
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/Quality score: (\d+) → (\d+) \(better\)/);
    expect(r.output).toMatch(/Worst complexity: \d+ → \d+ \(better\)/);
    expect(r.output).toMatch(/Copied code: 1 → 0 \(better\)/);
    expect(r.output).toMatch(/Complexity changed: handle \d+ → \d+/);
    expect(r.output).toMatch(/Removed functions: total_a, total_b/);
  });

  it("compare='last_working' uses the version that last ran fine", async () => {
    files.saveKnownGood(uuid);
    write("messy.py", MESSY);
    const r = await run("code_metrics", { path: "messy.py", compare: "last_working" });
    expect(r.output).toMatch(/Quality score: \d+ → \d+ \(worse\)/);
    write("messy.py", CLEAN);
  });
});

// ── type_check ───────────────────────────────────────────────────────────────

describe("type_check", () => {
  it.skipIf(!hasMypy)("keeps likely bugs apart from type-hint notes, says what each kind means, and keeps its cache", async () => {
    write("typed.py", "def f(a: int) -> int:\n    return a + 'x'\n\n\nseen = []\n\n\ndef g(name: str | None) -> int:\n    return len(name)\n");
    const r = await run("type_check", { path: "typed.py" });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/2 likely bugs/);
    expect(r.output).toMatch(/operator ×1 — an operation between types that don't mix/);
    expect(r.output).toMatch(/arg-type ×1 — a value of the wrong type is passed/);
    expect(r.output).toMatch(/1 type-hint note too/);
    expect(existsSync(path.join(process.env.VENVS_DIR!, uuid, ".mypy_cache"))).toBe(true);
    rmSync(path.join(dir(), "typed.py"));
  }, 120_000);

  it("readMypy sorts mypy's lines", async () => {
    const { readMypy } = await import("../../../apps/runner/src/agent/perfTools.js");
    const r = readMypy("bot.py:3: error: Item \"None\" of \"str | None\" has no attribute \"upper\"  [union-attr]\nbot.py:9: error: Need type annotation for \"x\"  [var-annotated]\n");
    expect([...r.bugs.keys()]).toEqual(["union-attr"]);
    expect(r.hints).toBe(1);
  });
});

// ── optimize_query ───────────────────────────────────────────────────────────

describe("optimize_query", () => {
  beforeAll(() => {
    mkdirSync(path.join(dir(), "data"), { recursive: true });
    const db = new DatabaseSync(path.join(dir(), "data", "bot.db"));
    db.exec("CREATE TABLE tips (sender TEXT, amount INTEGER, ts INTEGER);");
    db.exec("BEGIN");
    const t = db.prepare("INSERT INTO tips VALUES (?, ?, ?)");
    for (let i = 0; i < 20000; i++) t.run(`p${i % 3000}`, i % 500, i);
    db.exec("COMMIT");
    db.close();
    const other = new DatabaseSync(path.join(dir(), "data", "games.db"));
    other.exec("CREATE TABLE rounds (player TEXT, score INTEGER); INSERT INTO rounds VALUES ('amy', 3);");
    other.close();
    write("store.py", [
      "def recent(db, name):",
      "    return db.execute(\"SELECT amount FROM tips WHERE sender = ? AND amount > 10 ORDER BY ts DESC LIMIT 5\", (name,)).fetchall()",
      "def best(gdb):",
      "    return gdb.execute(\"SELECT score FROM rounds WHERE player = ?\", ('amy',)).fetchall()",
      "",
    ].join("\n"));
  });

  it("orders index columns: equality, then sort, then range", async () => {
    const { indexColumns } = await import("../../../apps/runner/src/agent/perfTools.js");
    expect(indexColumns("SELECT * FROM tips WHERE sender = ? AND amount > 5 ORDER BY ts DESC LIMIT 5", ["sender", "amount", "ts"])).toEqual(["sender", "ts", "amount"]);
  });

  it("plans each query on the database that has its tables, with times and health", async () => {
    const r = await run("optimize_query", {});
    expect(r.output).toMatch(/data\/bot\.db \(tips 20000 rows\):\n⚠ SELECT amount FROM tips/);
    expect(r.output).toMatch(/data\/games\.db \(rounds 1 rows\):\n· SELECT score FROM rounds[^\n]*\n[^\n]*\n   reads every row of rounds — fine at 1 row, slow once it grows: index suggested/);
    expect(r.summary).toBe("Query plans: 1 of 2 scan every row"); // the 1-row table isn't counted as slow
    expect(r.output).toMatch(/SLOW: reads every row of tips \(20000 rows\) · [\d.]+ (ms|µs) per run/);
    expect(r.output).toMatch(/CREATE INDEX IF NOT EXISTS "idx_tips_sender_ts_amount" ON "tips" \("sender", "ts", "amount"\)/);
    expect(r.output).toMatch(/Health: journal mode is delete: WAL lets the bot read while it writes/);
    expect(r.output).toMatch(/the planner has no statistics yet/);
  });

  it("create_index + tune: indexes, WAL, statistics — and the time before → after", async () => {
    const r = await run("optimize_query", { create_index: true, tune: true, db: "data/bot.db" });
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/Created 1 index: "idx_tips_sender_ts_amount"/);
    expect(r.output).toMatch(/journal mode WAL, planner statistics updated \(ANALYZE\)/);
    const m = /: ([\d.]+) (ms|µs) → ([\d.]+) (ms|µs) \((\d+)× faster\)/.exec(r.output);
    expect(m).not.toBeNull();
    expect(Number(m![5])).toBeGreaterThan(5);
    expect(r.output).toMatch(/put these in the bot's startup code[\s\S]*db\.execute\('CREATE INDEX IF NOT EXISTS "idx_tips_sender_ts_amount"/);
    const again = await run("optimize_query", { db: "data/bot.db" });
    expect(again.output).toMatch(/✓ SELECT amount FROM tips[\s\S]*fast: uses an index/);
    expect(again.output).not.toMatch(/Health:/);
    expect(again.output).toMatch(/1 query in the code uses another of the bot's databases/);
    expect(again.output).not.toMatch(/no such table/);
  });

  it("won't change the copy of a database that lives on an outside host", async () => {
    host = "the bot host (server s1)";
    const r = await run("optimize_query", { create_index: true });
    host = null;
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/runs on an outside host[\s\S]*CREATE INDEX IF NOT EXISTS/);
  });
});

// ── bot_resources ────────────────────────────────────────────────────────────

describe("bot_resources", () => {
  it("measures over a few seconds and reports the memory change since the last check", async () => {
    const first = await run("bot_resources", { seconds: 3 });
    expect(first.output).toMatch(/over 3s: CPU [\d.]+% of one core on average \(peak [\d.]+%\), memory [\d.]+ MB/);
    const hold = Buffer.alloc(80 * 1048576, 1);
    const second = await run("bot_resources", { seconds: 3 });
    expect(second.output).toMatch(/Memory: \+[\d.]+ MB since the last check \d+s ago/);
    expect(hold.length).toBeGreaterThan(0);
  });

  it("memoryTrend calls steady growth a leak and a restart a restart", async () => {
    const { memoryTrend } = await import("../../../apps/runner/src/agent/perfTools.js");
    const MB = 1048576;
    expect(memoryTrend({ at: 0, rss: 100 * MB, pid: 1 }, { at: 10 * 60_000, rss: 160 * MB, pid: 1 })).toMatch(/\+60\.0 MB since the last check 10\.0 min ago \(6\.0 MB\/min\) — GROWING/);
    expect(memoryTrend({ at: 0, rss: 100 * MB, pid: 1 }, { at: 10 * 60_000, rss: 101 * MB, pid: 1 })).toMatch(/steady/);
    expect(memoryTrend({ at: 0, rss: 100 * MB, pid: 1 }, { at: 60_000, rss: 300 * MB, pid: 2 })).toMatch(/restarted/);
    expect(memoryTrend(undefined, { at: 0, rss: 1, pid: 1 })).toBe("");
  });
});
