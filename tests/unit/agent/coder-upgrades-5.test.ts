/**
 * Kojy round 5, run for real on a project folder (no sandbox): modify_data
 * (with its backup and restore), wait_for_logs, lint_code, call_function,
 * http_request's checks, the undefined-name note after an edit, and the
 * automatic-fix limits.
 */
import { mkdirSync, mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// node:sqlite through require: vite doesn't know the module yet.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const root = mkdtempSync(path.join(tmpdir(), "kojy-r5-"));
const uuid = "55555555-5555-4555-8555-555555555555";
const hasRuff = spawnSync(process.env.KOJY_RUFF ?? "ruff", ["--version"]).status === 0;

let tools: typeof import("../../../apps/runner/src/agent/tools.js");
let ops: typeof import("../../../apps/runner/src/agent/opsTools.js");
let files: typeof import("../../../packages/shared/src/projects/files.js");
let ctx: import("../../../apps/runner/src/agent/tools.js").ToolContext;
let running = true;

beforeAll(async () => {
  process.env.PROJECTS_DIR = path.join(root, "projects");
  process.env.VENVS_DIR = path.join(root, "venvs");
  process.env.RUNNER_SANDBOX = "off";
  vi.resetModules();
  tools = await import("../../../apps/runner/src/agent/tools.js");
  ops = await import("../../../apps/runner/src/agent/opsTools.js");
  files = await import("../../../packages/shared/src/projects/files.js");
  files.ensureProjectDir(uuid);
  const dir = files.projectDir(uuid);
  mkdirSync(path.join(dir, "data"), { recursive: true });
  const db = new DatabaseSync(path.join(dir, "data", "bot.db"));
  db.exec("CREATE TABLE players (name TEXT PRIMARY KEY, coins INTEGER); INSERT INTO players VALUES ('amy', 10), ('bob', 5);");
  db.close();
  files.writeProjectFile(uuid, "shop.py", [
    "import asyncio", "",
    "def price(item, qty=1):", "    return {'sword': 10}[item] * qty", "",
    "async def slow_total(items):", "    await asyncio.sleep(0)", "    print('adding', len(items))", "    return sum(price(i) for i in items)", "",
    "class Shop:", "    @staticmethod", "    def name():", "        return 'The Shop'", "",
  ].join("\n"));
  const supervisor = {
    ensureVenv: async () => "python3",
    botEnv: async () => ({ PATH: process.env.PATH, HOME: root, API_TOKEN: "very-secret-value-1" }),
    secrets: async () => ({ API_TOKEN: "very-secret-value-1" }),
    isRunning: () => running,
  };
  ctx = { db: {} as never, supervisor: supervisor as never, project: { id: 1, uuid, orgId: 1, entrypoint: "run: python main.py" } as never, snapshotted: false, changedFiles: new Set() };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const run = (name: string, args: Record<string, unknown>) => tools.runTool(name, args, ctx);
const coins = (name: string) => {
  const db = new DatabaseSync(path.join(files.projectDir(uuid), "data", "bot.db"), { readOnly: true });
  try { return (db.prepare("SELECT coins FROM players WHERE name = ?").get(name) as { coins: number } | undefined)?.coins; } finally { db.close(); }
};

describe("modify_data", () => {
  it("changes rows after making a backup", async () => {
    const r = await run("modify_data", { sql: "UPDATE players SET coins = coins + 100 WHERE name = 'amy'" });
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("Changed 1 row in data/bot.db");
    expect(coins("amy")).toBe(110);
    expect(ops.dataBackups(uuid)).toHaveLength(1);
  });

  it("refuses what isn't one row change: reads, schema changes, two statements, UPDATE without WHERE", async () => {
    for (const sql of ["SELECT * FROM players", "DROP TABLE players", "UPDATE players SET coins = 0; DELETE FROM players WHERE 1", "UPDATE players SET coins = 0", "ATTACH 'x' AS y"]) {
      expect((await run("modify_data", { sql })).ok, sql).toBe(false);
    }
    expect(coins("bob")).toBe(5);
  });

  it("a failing statement changes nothing and leaves no backup", async () => {
    const r = await run("modify_data", { sql: "UPDATE nope SET x = 1 WHERE 1=1" });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/SQLite error: .*no such table/);
    expect(ops.dataBackups(uuid)).toHaveLength(1);
  });

  it("restore puts the newest backup back — only with the bot stopped", async () => {
    running = true;
    expect((await run("modify_data", { restore: true })).output).toMatch(/Stop the bot first/);
    running = false;
    const r = await run("modify_data", { restore: true });
    expect(r.ok).toBe(true);
    expect(coins("amy")).toBe(10);
    expect((await run("modify_data", { restore: true })).summary).toBe("No data backup");
    running = true;
  });
});

describe("wait_for_logs", () => {
  const logFile = () => path.join(process.env.PROJECTS_DIR!, ".logs", `${uuid}.log`);
  const say = (line: string) => appendFileSync(logFile(), `${JSON.stringify({ ts: Date.now(), stream: "stdout", line })}\n`);

  it("finds a line printed just before the call, case-insensitively, among several texts", async () => {
    mkdirSync(path.dirname(logFile()), { recursive: true });
    say("starting up");
    say("Logged in as KojyBot");
    const r = await run("wait_for_logs", { text: "ready|logged IN", seconds: 3 });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("Logged in as KojyBot");
  });

  it("waits for a line that comes later", async () => {
    setTimeout(() => say("Connected to room"), 1200);
    const r = await run("wait_for_logs", { text: "connected to room", seconds: 6 });
    expect(r.ok).toBe(true);
  });

  it("stops early on a traceback", async () => {
    setTimeout(() => { say("Traceback (most recent call last):"); say("ValueError: bad"); }, 500);
    const r = await run("wait_for_logs", { text: "never-printed-xyz", seconds: 6 });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe("An error came before it");
  });

  it("ignores what came before the newest start, and gives up after the time", async () => {
    appendFileSync(logFile(), `${JSON.stringify({ ts: Date.now(), stream: "system", line: "▶ Starting run: python main.py" })}\n`);
    const r = await run("wait_for_logs", { text: "nothing-like-this", seconds: 2 });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe("Waited 2s: not seen");
  });

  it("scanForText treats texts literally (no regex)", () => {
    expect(ops.scanForText(["a.b"], ["(a+)+$"])).toEqual({});
    expect(ops.scanForText(["x a.b y"], ["A.B"]).found).toBe("x a.b y");
  });
});

describe("call_function", () => {
  it("calls a function with args and kwargs and shows the result", async () => {
    const r = await run("call_function", { module: "shop", function: "price", args: ["sword"], kwargs: { qty: 3 } });
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/RETURNED \(int, [\d.]+ ms\): 30/);
    expect(r.summary).toBe("Called shop.price() → int");
  });

  it("awaits async functions and shows what they printed", async () => {
    const r = await run("call_function", { module: "shop", function: "slow_total", args: [["sword", "sword"]] });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("PRINTED:\nadding 2");
    expect(r.output).toMatch(/RETURNED \(int, .*\): 20/);
  });

  it("calls Class.method and reports errors with the bot's own frames", async () => {
    expect((await run("call_function", { module: "shop", function: "Shop.name" })).output).toContain("'The Shop'");
    const bad = await run("call_function", { module: "shop", function: "price", args: ["axe"] });
    expect(bad.ok).toBe(false);
    expect(bad.summary).toBe("shop.price() raised KeyError");
    expect(bad.output).toMatch(/RAISED: KeyError: 'axe'/);
    expect(bad.output).toMatch(/shop\.py", line 4, in price/);
  });

  it("refuses names that aren't module or function names", async () => {
    expect((await run("call_function", { module: "os; rm", function: "x" })).ok).toBe(false);
    expect((await run("call_function", { module: "shop", function: "a.b.c" })).ok).toBe(false);
  });
});

describe("lint_code", () => {
  it("finds tokens written into the code, without ruff too", () => {
    // Fake tokens, put together here so no token-shaped text sits in the repository (GitHub's push protection).
    const discord = ["MTA4", "NzY1NDMyMTA5ODc2NTQz", ".GaBcDe.", "abcdefghijklmnopqrstuvwxyz0123"].join("");
    const groq = ["gs", "k_", "abcdefghijklmnopqrstuvwxyz12"].join("");
    const found = ops.hardcodedTokens("bot.py", `X = 1\nTOKEN = "${discord}"\nKEY = "${groq}"\n`);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatch(/^- bot\.py:2: a Discord bot token/);
    expect(found[1]).toMatch(/^- bot\.py:3: an API key/);
    expect(ops.hardcodedTokens("bot.py", "TOKEN = os.environ['TOKEN']\n")).toEqual([]);
  });

  it.skipIf(!hasRuff)("groups security, bug and complexity findings with file and line", async () => {
    files.writeProjectFile(uuid, "risky.py", [
      "import subprocess, sqlite3",
      `API_KEY = "${["s", "k-", "abcdefghijklmnopqrstuvwxyz123456"].join("")}"`,
      "def run(cmd, name, db: sqlite3.Connection, items=[]):",
      "    subprocess.call(cmd, shell=True)",
      "    db.execute(f\"SELECT * FROM players WHERE name = '{name}'\")",
      "    return items", "",
    ].join("\n"));
    const r = await run("lint_code", {});
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/Security \(\d+\):/);
    expect(r.output).toMatch(/risky\.py:2: an API key/);
    expect(r.output).toMatch(/risky\.py:4: .*\(S60[24]\)/);
    expect(r.output).toMatch(/risky\.py:5: .*\(S608\)/);
    expect(r.output).toMatch(/Likely bugs \(\d+\):[\s\S]*risky\.py:3: .*\(B006\)/);
    const onlyBugs = await run("lint_code", { focus: "bugs", path: "risky.py" });
    expect(onlyBugs.output).not.toMatch(/Security/);
    rmSync(path.join(files.projectDir(uuid), "risky.py"));
  });
});

describe("edits report names that don't exist", () => {
  it.skipIf(!hasRuff)("a typo'd name gets a note at once", async () => {
    const r = await run("write_file", { path: "typo.py", content: "def f(x):\n    return lenn(x)\n" });
    expect(r.output).toMatch(/⚠ typo\.py uses names that aren't defined or imported anywhere in it: line 2: Undefined name `lenn`/);
    expect(r.summary).toMatch(/needs a fix/);
    const ok = await run("edit_file", { path: "typo.py", old_text: "lenn(", new_text: "len(" });
    expect(ok.output).not.toMatch(/⚠/);
  });
});

describe("http_request", () => {
  it("refuses private addresses and bad methods before sending anything", async () => {
    expect((await run("http_request", { url: "http://127.0.0.1:8080/x" })).ok).toBe(false);
    expect((await run("http_request", { url: "http://localhost/admin", method: "POST" })).output).toMatch(/public/);
    expect((await run("http_request", { url: "https://example.com", method: "TRACE" })).summary).toBe("Invalid method");
  });
});

describe("the new tools and automatic fixes", () => {
  it("changing data, web requests and calling functions are owner-only", async () => {
    const { automaticTools, automaticRefusal, AUTOMATIC_RUN_LOCKED } = await import("../../../apps/runner/src/agent/autoFix.js");
    for (const t of ["modify_data", "http_request", "call_function"]) {
      expect(AUTOMATIC_RUN_LOCKED[t], t).toBeTruthy();
      expect(automaticRefusal("crash", t, {}, () => "")).toMatch(/Not allowed in an automatic fix/);
    }
    const names = automaticTools(tools.TOOL_SPECS).map((t) => t.function.name);
    for (const t of ["modify_data", "http_request", "call_function", "lint_code", "wait_for_logs"]) expect(names).not.toContain(t);
  });

  it("Kojy is told about them", async () => {
    const { BOT_CHAT_TOOLS, systemPrompt } = await import("../../../apps/runner/src/agent/prompt.js");
    for (const t of ["modify_data", "wait_for_logs", "http_request", "lint_code", "call_function"]) expect(BOT_CHAT_TOOLS).toContain(t);
    expect(systemPrompt({ projectName: "x", entrypoint: "", status: "stopped", secrets: [], memories: [], fileCount: 1 })).toMatch(/give amy 100 coins.*modify_data/);
  });
});

