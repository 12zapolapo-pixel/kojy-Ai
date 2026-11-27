/**
 * Kojy round 6: smart tool loading, and the speed/quality tools, measured
 * before and after on a deliberately bad bot.
 *
 * Part 1 — tool loading: tokens each AI step costs for typical owner
 * requests, all tools vs the tools the request needs.
 * Part 2 — a slow, messy bot is measured with the new tools, fixed the way
 * Kojy is told to (profile → fix → benchmark; code_metrics/type_check/
 * lint_code; optimize_query), and measured again.
 * KOJY_REPORT=<file> writes every number to that file as JSON.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const root = mkdtempSync(path.join(tmpdir(), "kojy-r6-"));
const uuid = "66666666-6666-4666-8666-666666666666";
const has = (cmd: string) => spawnSync(cmd, ["--version"]).status === 0;
const hasRuff = has(process.env.KOJY_RUFF ?? "ruff"), hasMypy = has(process.env.KOJY_MYPY ?? "mypy");
const report: Record<string, unknown> = {};

let tools: typeof import("../../../apps/runner/src/agent/tools.js");
let files: typeof import("../../../packages/shared/src/projects/files.js");
let ctx: import("../../../apps/runner/src/agent/tools.js").ToolContext;

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
    botEnv: async () => ({ PATH: process.env.PATH, HOME: root }),
    secrets: async () => ({}),
    isRunning: () => false,
    pidOf: () => process.pid,
  };
  ctx = { db: {} as never, supervisor: supervisor as never, project: { id: 1, uuid, orgId: 1, entrypoint: "run: python bot.py" } as never, snapshotted: false, changedFiles: new Set() };
});
afterAll(() => {
  if (process.env.KOJY_REPORT) writeFileSync(process.env.KOJY_REPORT, JSON.stringify(report, null, 2));
  rmSync(root, { recursive: true, force: true });
});

const run = (name: string, args: Record<string, unknown>) => tools.runTool(name, args, ctx);
const num = (re: RegExp, text: string) => Number(re.exec(text)?.[1] ?? NaN);

// ── Part 1: tool loading ─────────────────────────────────────────────────────

describe("smart tool loading", () => {
  it("sends far fewer tokens per step, and every owner request fits the free Groq lane", async () => {
    const { MEMORY_TOOL_SPECS } = await import("../../../apps/runner/src/agent/workLog.js");
    const { estimateTokens } = await import("../../../apps/runner/src/agent/groq.js");
    const { systemPrompt } = await import("../../../apps/runner/src/agent/prompt.js");
    const { toolsForStep } = await import("../../../apps/runner/src/agent/agent.js");
    const all = [...tools.TOOL_SPECS, ...MEMORY_TOOL_SPECS];
    const prompt = estimateTokens(systemPrompt({ projectName: "Japalo", entrypoint: "bot:Bot", status: "running", secrets: ["HIGHRISE_BOT_TOKEN"], memories: [], fileCount: 8 }));
    const allTokens = estimateTokens(JSON.stringify(all));
    const requests = ["hi, how are you?", "add a !dance command", "the bot crashed, fix it", "give amy 100 coins", "make the bot faster and clean up the code", "add a weather command using an API", "set up my discord bot token"];
    const rows = requests.map((text) => {
      const picked = toolsForStep(all, [{ role: "user", content: text }], new Set(), "highrise");
      return { request: text, tools: picked.length, tokens: estimateTokens(JSON.stringify(picked)) };
    });
    const discordPrompt = estimateTokens(systemPrompt({ projectName: "Japalo", entrypoint: "run: python main.py", status: "running", secrets: ["DISCORD_TOKEN"], memories: [], fileCount: 8 }));
    report.toolLoading = { allTools: all.length, allToolTokens: allTokens, promptTokens: prompt, discordPromptTokens: discordPrompt, perRequest: rows };
    for (const r of rows) {
      expect(r.tokens).toBeLessThan(allTokens * 0.8);
      // Everyday requests: instructions + tools leave room for history and the answer under Groq's 7,500 tokens a request.
      if (!/faster and clean/.test(r.request)) expect(prompt + r.tokens, r.request).toBeLessThan(6800);
    }
    expect(Math.max(...rows.map((r) => r.tokens))).toBeLessThan(allTokens);
  });

  it("keeps tools used earlier in the request, and load_tools adds a group", async () => {
    const { toolsForStep } = await import("../../../apps/runner/src/agent/agent.js");
    const { loadToolsResult } = await import("../../../apps/runner/src/agent/toolsets.js");
    const names = (t: { function: { name: string } }[]) => t.map((x) => x.function.name);
    const history = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "", tool_calls: [{ id: "1", type: "function" as const, function: { name: "modify_data", arguments: "{}" } }] },
    ];
    const loaded = new Set<string>();
    const first = names(toolsForStep(tools.TOOL_SPECS, history, loaded));
    expect(first).toContain("modify_data");
    expect(first).toContain("load_tools");
    expect(first).not.toContain("profile_code");
    expect(loadToolsResult({ groups: ["quality"] }, loaded).ok).toBe(true);
    expect(names(toolsForStep(tools.TOOL_SPECS, history, loaded))).toEqual(expect.arrayContaining(["profile_code", "benchmark", "code_metrics", "type_check"]));
    expect(loadToolsResult({ groups: ["nope"] }, loaded).ok).toBe(false);
  });

  it("an automatic crash fix still gets its own small set", async () => {
    const { automaticTools } = await import("../../../apps/runner/src/agent/autoFix.js");
    const names = automaticTools(tools.TOOL_SPECS).map((t) => t.function.name);
    for (const t of ["profile_code", "benchmark", "optimize_query", "code_metrics", "type_check", "bot_resources"]) expect(names).not.toContain(t);
  });
});

// ── Part 2: a bad bot, before and after ──────────────────────────────────────

const BEFORE = `import asyncio
import sqlite3
import time

DB = "data/bot.db"


def leaderboard(players):
    ranked = []
    for name in players:
        pos = 0
        for other in ranked:
            if players[other] > players[name]:
                pos += 1
        ranked.insert(pos, name)
    result = []
    for name in ranked:
        if name not in result:
            result.append(name)
    return result[:10]


def coins_of(db, name):
    row = db.execute(f"SELECT coins FROM players WHERE name = '{name}'").fetchone()
    return row[0] if row else 0


def recent_tips(db, name):
    return db.execute("SELECT amount FROM tips WHERE sender = ? ORDER BY ts DESC LIMIT 5", (name,)).fetchall()


def bonus(level: int) -> int:
    return "5" * level


def old_rewards(x):
    return x * 2


async def on_chat(db, players, user, message):
    reply = None
    if message.startswith("!top"):
        reply = ", ".join(leaderboard(players))
    elif message.startswith("!coins"):
        if user in players:
            if players[user] > 0:
                reply = f"{user} has {coins_of(db, user)}"
            else:
                reply = "no coins"
        else:
            reply = "who?"
    elif message.startswith("!tips"):
        tips = recent_tips(db, user)
        if tips:
            if len(tips) > 3:
                reply = "big tipper"
            else:
                reply = "thanks"
        else:
            reply = "no tips"
    elif message.startswith("!daily"):
        if user in players and players[user] < 100 or user == "admin":
            players[user] = players.get(user, 0) + 10
            reply = "daily added"
        else:
            reply = "come back tomorrow"
    elif message.startswith("!help"):
        reply = "commands: !top !coins !tips !daily"
    time.sleep(0.15)  # "cooldown"
    return reply


def report_a(players):
    total = 0
    for name in players:
        total += players[name]
    avg = total / max(len(players), 1)
    print("total", total)
    print("average", avg)
    return total, avg


def report_b(players):
    total = 0
    for name in players:
        total += players[name]
    avg = total / max(len(players), 1)
    print("total", total)
    print("average", avg)
    return total, avg
`;

const AFTER = `import asyncio
import heapq
import sqlite3

DB = "data/bot.db"


def leaderboard(players: dict[str, int]) -> list[str]:
    return heapq.nlargest(10, players, key=players.__getitem__)


def coins_of(db: sqlite3.Connection, name: str) -> int:
    row = db.execute("SELECT coins FROM players WHERE name = ?", (name,)).fetchone()
    return row[0] if row else 0


def recent_tips(db: sqlite3.Connection, name: str) -> list[tuple[int]]:
    return db.execute("SELECT amount FROM tips WHERE sender = ? ORDER BY ts DESC LIMIT 5", (name,)).fetchall()


def bonus(level: int) -> int:
    return 5 * level


def coins_reply(db, players, user):
    if user not in players:
        return "who?"
    return f"{user} has {coins_of(db, user)}" if players[user] > 0 else "no coins"


def tips_reply(db, players, user):
    tips = recent_tips(db, user)
    if not tips:
        return "no tips"
    return "big tipper" if len(tips) > 3 else "thanks"


def daily_reply(db, players, user):
    if (user in players and players[user] < 100) or user == "admin":
        players[user] = players.get(user, 0) + 10
        return "daily added"
    return "come back tomorrow"


COMMANDS = {
    "!top": lambda db, players, user: ", ".join(leaderboard(players)),
    "!coins": coins_reply,
    "!tips": tips_reply,
    "!daily": daily_reply,
    "!help": lambda db, players, user: "commands: !top !coins !tips !daily",
}


async def on_chat(db, players, user, message):
    handler = COMMANDS.get(message.split(" ", 1)[0])
    reply = handler(db, players, user) if handler else None
    await asyncio.sleep(0.15)  # cooldown without freezing the bot
    return reply


def report(players: dict[str, int]) -> tuple[int, float]:
    total = sum(players.values())
    avg = total / max(len(players), 1)
    print("total", total)
    print("average", avg)
    return total, avg
`;

/** The bot's data: 3,000 players and 20,000 tips (no index on tips.sender). */
function makeDatabase(dir: string) {
  mkdirSync(path.join(dir, "data"), { recursive: true });
  const db = new DatabaseSync(path.join(dir, "data", "bot.db"));
  db.exec("CREATE TABLE players (name TEXT, coins INTEGER); CREATE TABLE tips (sender TEXT, amount INTEGER, ts INTEGER);");
  db.exec("BEGIN");
  const p = db.prepare("INSERT INTO players VALUES (?, ?)"), t = db.prepare("INSERT INTO tips VALUES (?, ?, ?)");
  for (let i = 0; i < 3000; i++) p.run(`p${i}`, (i * 7919) % 5000);
  for (let i = 0; i < 20000; i++) t.run(`p${i % 3000}`, (i * 31) % 500, i);
  db.exec("COMMIT");
  db.close();
}

const SETUP = "import random\nrandom.seed(1)\nfrom bot import leaderboard\nplayers = {f'p{i}': random.randint(0, 10**6) for i in range(3000)}";
const QUERY_SETUP = "import sqlite3\ndb = sqlite3.connect('data/bot.db')\nfrom bot import recent_tips";

describe("before and after, on a slow and messy bot", () => {
  const measure = async (phase: "before" | "after") => {
    const out: Record<string, unknown> = {};
    const lb = await run("benchmark", { setup: SETUP, code: "result = leaderboard(players)", seconds: 1 });
    out.leaderboardPerRun = /^([\d.]+ (?:s|ms|µs)) per run/m.exec(lb.output)?.[1];
    const q = await run("benchmark", { setup: QUERY_SETUP, code: "result = [recent_tips(db, f'p{i}') for i in range(0, 3000, 30)]", seconds: 1 });
    out.tipQueries100PerRun = /^([\d.]+ (?:s|ms|µs)) per run/m.exec(q.output)?.[1];
    const prof = await run("profile_code", { code: "import asyncio, sqlite3\nfrom bot import on_chat\ndb = sqlite3.connect('data/bot.db')\nplayers = {'amy': 5}\nawait on_chat(db, players, 'amy', '!coins')" });
    out.profile = prof.summary;
    out.eventLoopBlocks = num(/BLOCKED THE EVENT LOOP (\d+)/, prof.output) || 0;
    const metrics = await run("code_metrics", {});
    out.qualityScore = num(/Quality score (\d+)\/100/, metrics.output);
    out.avgComplexity = num(/Average complexity (\d+(?:\.\d+)?)\./, metrics.output);
    out.maxComplexity = num(/Most complex:\n- [^\n]*complexity (\d+)/, metrics.output);
    out.duplicates = (metrics.output.match(/^- .* = /gm) ?? []).length + (/Duplicated code/.test(metrics.output) ? 1 : 0);
    out.unused = (/Probably unused[^\n]*\n((?:- .*\n?)*)/.exec(metrics.output)?.[1] ?? "").split("\n").filter(Boolean).length;
    if (hasRuff) {
      const lint = await run("lint_code", {});
      out.lintFindings = num(/(\d+) finding/, lint.summary) || 0;
      out.securityFindings = num(/\((\d+) security\)/, lint.summary) || 0;
    }
    if (hasMypy) {
      const types = await run("type_check", { path: "bot.py" });
      out.typeErrors = num(/(\d+) likely bugs?/, types.output) || 0;
    }
    const plans = await run("optimize_query", {});
    out.queriesScanningEveryRow = num(/Query plans: (\d+) of/, plans.summary);
    report[phase] = out;
    return { out, plans };
  };

  it("measures, fixes, measures again — and every number gets better", async () => {
    const dir = files.projectDir(uuid);
    makeDatabase(dir);
    writeFileSync(path.join(dir, "bot.py"), BEFORE);
    const { out: before, plans } = await measure("before");
    expect(before.eventLoopBlocks).toBeGreaterThan(0);
    expect(plans.output).toMatch(/SLOW: reads every row of tips \(20000 rows\)/);
    expect(plans.output).toMatch(/CREATE INDEX IF NOT EXISTS "idx_tips_sender_ts" ON "tips" \("sender", "ts"\)/);

    // The old and new leaderboard, side by side: faster, and the same answer.
    writeFileSync(path.join(dir, "old_bot.py"), BEFORE);
    writeFileSync(path.join(dir, "bot.py"), AFTER);
    const lb = await run("benchmark", {
      setup: "import random\nrandom.seed(1)\nimport old_bot, bot\nplayers = {f'p{i}': random.randint(0, 10**6) for i in range(3000)}",
      baseline: "result = old_bot.leaderboard(players)", code: "result = bot.leaderboard(players)", seconds: 1,
    });
    expect(lb.output).toMatch(/Same `result` from both: yes/);
    report.leaderboardSpeedup = /RESULT: (.*)/.exec(lb.output)?.[1];
    expect(lb.output).toMatch(/RESULT: the new version is [\d.]+× faster/);
    rmSync(path.join(dir, "old_bot.py"));

    // The slow query: the index optimize_query suggested.
    const idx = await run("optimize_query", { create_index: true });
    expect(idx.ok).toBe(true);
    report.indexes = idx.output.split("\n").filter((l) => l.startsWith("Created ") || l.startsWith("Time per run") || / → .*faster/.test(l));

    const { out: after } = await measure("after");
    expect(after.eventLoopBlocks).toBe(0);
    expect(after.queriesScanningEveryRow).toBeLessThan(before.queriesScanningEveryRow as number);
    expect(after.qualityScore as number).toBeGreaterThan(before.qualityScore as number);
    expect(after.maxComplexity as number).toBeLessThan(before.maxComplexity as number);
    expect(after.unused as number).toBeLessThan(before.unused as number);
    if (hasRuff) expect(after.securityFindings as number).toBeLessThan(before.securityFindings as number);
    if (hasMypy) {
      expect(before.typeErrors as number).toBeGreaterThan(0);
      expect(after.typeErrors).toBe(0);
    }
  }, 240_000);
});

describe("the tools' own checks", () => {
  it("benchmark says when the new code gives a different answer", async () => {
    const r = await run("benchmark", { baseline: "result = sorted([3, 1, 2])", code: "result = [3, 1, 2]", seconds: 0.5 });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/Same `result` from both: NO/);
    expect(r.summary).toMatch(/results differ/);
  });

  it("optimize_query only takes one read or change, and finds queries in code", async () => {
    expect((await run("optimize_query", { sql: "DROP TABLE tips" })).ok).toBe(false);
    const { queriesInCode, indexColumns, fullScans } = await import("../../../apps/runner/src/agent/perfTools.js");
    expect(queriesInCode('db.execute("SELECT a FROM t WHERE b = ?", (x,))\ndb.execute(f"UPDATE t SET a = 1 WHERE id = {i}")')).toEqual(["SELECT a FROM t WHERE b = ?", "UPDATE t SET a = 1 WHERE id = ?"]);
    expect(indexColumns("SELECT * FROM tips WHERE sender = ? AND amount > 5 ORDER BY ts DESC LIMIT 5", ["sender", "amount", "ts"])).toEqual(["sender", "ts", "amount"]);
    expect(fullScans(["SCAN tips", "SCAN players USING INDEX idx", "SEARCH t USING INDEX i (a=?)"])).toEqual(["tips"]);
  });

  it("bot_resources reads a real process's CPU and memory", async () => {
    const r = await run("bot_resources", {});
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/over 5s: CPU [\d.]+% of one core on average \(peak [\d.]+%\), memory [\d.]+ MB \([\d.]+ MB at the start\), \d+ threads/);
  });

  it("profile_code and benchmark refuse what they can't run", async () => {
    expect((await run("profile_code", {})).ok).toBe(false);
    expect((await run("benchmark", { code: "" })).ok).toBe(false);
  });
});
