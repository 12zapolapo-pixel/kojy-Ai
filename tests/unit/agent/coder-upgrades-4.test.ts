/**
 * Kojy round 4, run for real on a project folder (no sandbox): the syntax
 * check after every Python change, edit_lines, rename_symbol, trace_error,
 * run_unit_tests (built-in runner), restore_file, format_code, add_package's
 * requirements.txt handling, and the automatic-fix limits for them.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const root = mkdtempSync(path.join(tmpdir(), "kojy-r4-"));
const uuid = "99999999-9999-4999-8999-999999999999";
const hasRuff = spawnSync(process.env.KOJY_RUFF ?? "ruff", ["--version"]).status === 0;

let tools: typeof import("../../../apps/runner/src/agent/tools.js");
let dev: typeof import("../../../apps/runner/src/agent/devTools.js");
let files: typeof import("../../../packages/shared/src/projects/files.js");
let ctx: import("../../../apps/runner/src/agent/tools.js").ToolContext;

const SHOP = `PRICES = {"sword": 10, "shield": 7}


def price(item):
    # price of an item
    return PRICES[item]


def total(items):
    return sum(price(i) for i in items)


def label(item):
    return f"{item} costs {price(item)}"
`;

beforeAll(async () => {
  process.env.PROJECTS_DIR = path.join(root, "projects");
  process.env.VENVS_DIR = path.join(root, "venvs");
  process.env.RUNNER_SANDBOX = "off";
  vi.resetModules();
  tools = await import("../../../apps/runner/src/agent/tools.js");
  dev = await import("../../../apps/runner/src/agent/devTools.js");
  files = await import("../../../packages/shared/src/projects/files.js");
  files.ensureProjectDir(uuid);
  files.writeProjectFile(uuid, "shop.py", SHOP);
  files.writeProjectFile(uuid, "main.py", 'from shop import price, total\n\nprint("price", price("sword"))\n');
  const supervisor = {
    ensureVenv: async () => "python3",
    botEnv: async () => ({ PATH: process.env.PATH, HOME: root }),
    secrets: async () => ({}),
  };
  ctx = { db: {} as never, supervisor: supervisor as never, project: { id: 1, uuid, orgId: 1, entrypoint: "run: python main.py" } as never, snapshotted: false, changedFiles: new Set() };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const run = (name: string, args: Record<string, unknown>) => tools.runTool(name, args, ctx);
const read = (rel: string) => readFileSync(path.join(files.projectDir(uuid), rel), "utf8");
const fresh = () => { ctx.snapshotted = false; ctx.snapshotId = undefined; ctx.changedFiles.clear(); };

describe("every Python change is parsed at once", () => {
  it("edit_file that breaks the syntax says so, with the line", async () => {
    fresh();
    files.writeProjectFile(uuid, "tmp.py", "def f():\n    return 1\n");
    const r = await run("edit_file", { path: "tmp.py", old_text: "return 1", new_text: "return (1" });
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/⚠ tmp\.py doesn't parse now \(line \d+: .*\)/);
    expect(r.summary).toMatch(/syntax error/);
    const fixed = await run("edit_file", { path: "tmp.py", old_text: "return (1", new_text: "return 1" });
    expect(fixed.output).not.toMatch(/doesn't parse/);
  });

  it("write_file of a first part allows for the rest still to come", async () => {
    const r = await run("write_file", { path: "part.py", content: "def f():\n    x = [\n" });
    expect(r.output).toMatch(/If you're still writing it in parts, finish it first/);
    expect((await run("write_file", { path: "notes.txt", content: "def (" })).output).not.toMatch(/parse/);
  });
});

describe("edit_lines", () => {
  it("replaces a line range when the guard line matches, and shows the region", async () => {
    fresh();
    const r = await run("edit_lines", { path: "shop.py", start_line: 6, end_line: 6, first_line: "return PRICES[item]", new_text: "    return PRICES.get(item, 0)" });
    expect(r.ok).toBe(true);
    expect(read("shop.py")).toContain("return PRICES.get(item, 0)");
    expect(r.output).toMatch(/6\|     return PRICES\.get\(item, 0\)/);
    expect(r.diff).toContain("+    return PRICES.get(item, 0)");
  });

  it("refuses when the lines moved, and shows where they are now", async () => {
    const r = await run("edit_lines", { path: "shop.py", start_line: 2, end_line: 2, first_line: "def price(item):", new_text: "x" });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/the lines moved/);
    expect(r.output).toContain("4| def price(item):");
  });

  it("refuses lines that aren't in the file", async () => {
    expect((await run("edit_lines", { path: "shop.py", start_line: 500, end_line: 501, first_line: "", new_text: "x" })).ok).toBe(false);
  });
});

describe("rename_symbol", () => {
  it("renames the name in code only — not in strings or comments — across files", async () => {
    fresh();
    const r = await run("rename_symbol", { old_name: "price", new_name: "item_price" });
    expect(r.ok).toBe(true);
    const shop = read("shop.py"), main = read("main.py");
    expect(shop).toContain("def item_price(item):");
    expect(shop).toContain("sum(item_price(i) for i in items)");
    expect(shop).toContain("# price of an item"); // comment untouched
    expect(main).toContain("from shop import item_price, total");
    expect(main).toContain('print("price", item_price("sword"))'); // the string stays
    expect(r.diff).toContain("+def item_price(item):");
    expect(ctx.changedFiles.has("main.py")).toBe(true);
  });

  it("reports names inside f-strings (Python 3.11 keeps them as one piece) or renames them (3.12+)", async () => {
    const shop = read("shop.py");
    const r = await run("rename_symbol", { old_name: "item_price", new_name: "price_of" });
    expect(r.ok).toBe(true);
    const after = read("shop.py");
    // Either the f-string was renamed by the tokenizer, or Kojy is told where it is.
    expect(after.includes("{price_of(item)}") || r.output.includes("inside f-strings")).toBe(true);
    expect(shop).not.toEqual(after);
  });

  it("refuses names that aren't Python names", async () => {
    expect((await run("rename_symbol", { old_name: "a-b", new_name: "c" })).ok).toBe(false);
    expect((await run("rename_symbol", { old_name: "nothere_xyz", new_name: "y" })).ok).toBe(false);
  });
});

describe("restore_file", () => {
  it("puts one file back as it was before this request; the others stay", async () => {
    const r = await run("restore_file", { path: "main.py" });
    expect(r.ok).toBe(true);
    expect(read("main.py")).toContain("from shop import price, total");
    expect(read("shop.py")).toContain("def price_of(item):");
    const again = await run("restore_file", { path: "main.py" });
    expect(again.output).toMatch(/already as it was/);
  });

  it("a file created in this request is removed", async () => {
    await run("write_file", { path: "new_thing.py", content: "x = 1\n" });
    const r = await run("restore_file", { path: "new_thing.py" });
    expect(r.output).toMatch(/didn't exist before this request, so it was removed/);
    expect(existsSync(path.join(files.projectDir(uuid), "new_thing.py"))).toBe(false);
  });

  it("from=last_working uses the version that last ran fine", async () => {
    expect((await run("restore_file", { path: "shop.py", from: "last_working" })).output).toMatch(/No version that ran fine/);
    files.saveKnownGood(uuid);
    files.writeProjectFile(uuid, "shop.py", "broken = True\n");
    const r = await run("restore_file", { path: "shop.py", from: "last_working" });
    expect(r.ok).toBe(true);
    expect(read("shop.py")).toContain("def price_of(item):");
  });
});

describe("trace_error", () => {
  it("finds the newest traceback and shows the code of each step in the bot's files", async () => {
    const dir = files.projectDir(uuid);
    const logDir = path.join(process.env.PROJECTS_DIR!, ".logs");
    mkdirSync(logDir, { recursive: true });
    const line = (l: string) => `${JSON.stringify({ ts: Date.now(), stream: "stderr", line: l })}\n`;
    writeFileSync(path.join(logDir, `${uuid}.log`), [
      "Traceback (most recent call last):", '  File "/old.py", line 1, in x', "ValueError: old one",
      "started", "Traceback (most recent call last):",
      `  File "${dir}/main.py", line 3, in <module>`, '    print("price", price("sword"))',
      `  File "${dir}/shop.py", line 1, in price_of`, "    broken",
      "KeyError: 'axe'", "after it",
    ].map(line).join(""));
    const r = await run("trace_error", {});
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("Read the newest error: KeyError: 'axe'");
    expect(r.output).not.toContain("old one");
    expect(r.output).toContain("<untrusted_bot_output>");
    expect(r.output).toMatch(/shop\.py:1\n→\s+1\| /);
    expect(r.output).toMatch(/main\.py:3\n/);
    expect(r.output.indexOf("shop.py:1")).toBeLessThan(r.output.indexOf("main.py:3")); // innermost first
  });

  it("lastTraceback stops at the exception line", () => {
    expect(dev.lastTraceback(["a", "Traceback (most recent call last):", '  File "x.py", line 2, in f', "    y", "NameError: name 'y' is not defined", "next"]))
      .toEqual(["Traceback (most recent call last):", '  File "x.py", line 2, in f', "    y", "NameError: name 'y' is not defined"]);
  });
});

describe("run_unit_tests (built-in runner)", () => {
  it("says when there are no tests", async () => {
    expect((await run("run_unit_tests", {})).summary).toBe("No unit tests yet");
  });

  it("runs test_ functions (async too) and TestCase classes, and shows failures", async () => {
    files.writeProjectFile(uuid, "tests/test_shop.py", [
      "import asyncio, unittest",
      "from shop import price_of, total",
      "def test_price():\n    assert price_of('sword') == 10",
      "def test_total_wrong():\n    assert total(['sword', 'shield']) == 99",
      "async def test_async():\n    await asyncio.sleep(0)\n    assert True",
      "def test_fixture(tmp_path):\n    pass",
      "class T(unittest.TestCase):\n    def test_ok(self):\n        self.assertEqual(1, 1)",
      "",
    ].join("\n"));
    const r = await run("run_unit_tests", {});
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/^Unit tests: \d+ passed, 1 failed/);
    // pytest (when installed) runs the async test too, with or without pytest-asyncio.
    expect(r.output).not.toMatch(/async def functions are not natively supported/);
    if (/Built-in runner/.test(r.output)) {
      expect(r.summary).toBe("Unit tests: 3 passed, 1 failed, 1 skipped");
      expect(r.output).toContain("PASS tests/test_shop.py::test_async");
      expect(r.output).toContain("FAIL tests/test_shop.py::test_total_wrong");
      expect(r.output).toMatch(/AssertionError: assert failed: assert total\(\['sword', 'shield'\]\) == 99/);
      expect(r.output).toMatch(/SKIP tests\/test_shop\.py::test_fixture \(uses pytest fixtures/);
    }
    const only = await run("run_unit_tests", { match: "price" });
    expect(only.ok).toBe(true);
  });
});

describe("the built-in runner itself (used when pytest isn't installed)", () => {
  it("runs sync, async and TestCase tests, skips fixture tests, and reports the failing assert", () => {
    const work = mkdtempSync(path.join(tmpdir(), "kojy-tr-"));
    try {
      mkdirSync(path.join(work, "tests"));
      writeFileSync(path.join(work, "calc.py"), "def add(a, b):\n    return a + b\n");
      writeFileSync(path.join(work, "tests", "test_calc.py"), [
        "import asyncio, unittest", "from calc import add",
        "def test_add():\n    assert add(2, 2) == 4",
        "def test_wrong():\n    assert add(2, 2) == 5",
        "async def test_async():\n    await asyncio.sleep(0)",
        "def test_needs(tmp_path):\n    pass",
        "class C(unittest.TestCase):\n    def test_eq(self):\n        self.assertEqual(add(1, 1), 2)\n    def test_bad(self):\n        self.assertEqual(add(1, 1), 3)", "",
      ].join("\n"));
      writeFileSync(path.join(work, "tests", "test_broken.py"), "import nothing_here_xyz\n");
      const runner = path.join(process.cwd(), "apps/runner/src/testrunner.py");
      const r = spawnSync("python3", [runner], { cwd: work, encoding: "utf8" });
      expect(r.stdout).toContain("PASS tests/test_calc.py::test_add");
      expect(r.stdout).toContain("PASS tests/test_calc.py::test_async");
      expect(r.stdout).toContain("PASS tests/test_calc.py::C.test_eq");
      expect(r.stdout).toContain("FAIL tests/test_calc.py::C.test_bad");
      expect(r.stdout).toContain("FAIL tests/test_broken.py (didn't load)");
      expect(r.stdout).toMatch(/SKIP tests\/test_calc\.py::test_needs \(uses pytest fixtures/);
      expect(r.stdout).toContain("AssertionError: assert failed: assert add(2, 2) == 5");
      expect(r.stdout).toContain("ModuleNotFoundError: No module named 'nothing_here_xyz'");
      expect(r.stdout.trim().split("\n").pop()).toBe("RESULT 3 3 1");
      const k = spawnSync("python3", [runner, "-k", "add"], { cwd: work, encoding: "utf8" });
      expect(k.stdout).toContain("PASS tests/test_calc.py::test_add");
      expect(k.stdout).not.toContain("test_async");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe("format_code", () => {
  it.skipIf(!hasRuff)("tidies a file's layout and shows the diff", async () => {
    files.writeProjectFile(uuid, "ugly.py", "x=[1,2,\n 3]\ndef f( a ):\n  return a\n");
    const r = await run("format_code", { path: "ugly.py" });
    expect(r.ok).toBe(true);
    expect(read("ugly.py")).toBe("x = [1, 2, 3]\n\n\ndef f(a):\n    return a\n");
    expect((await run("format_code", { path: "ugly.py" })).summary).toBe("Code already tidy");
  });

  it("refuses a file that doesn't parse, saying where", async () => {
    files.writeProjectFile(uuid, "bad.py", "def f(:\n");
    const r = await run("format_code", { path: "bad.py" });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/bad\.py doesn't parse \(line 1/);
    rmSync(path.join(files.projectDir(uuid), "bad.py"));
  });
});

describe("add_package's requirements.txt", () => {
  it("replaces the package's old line (pip's name rules) or adds it at the end", () => {
    expect(dev.setRequirement("", "aiohttp", "aiohttp>=3.9.5")).toBe("aiohttp>=3.9.5\n");
    expect(dev.setRequirement("highrise-bot-sdk==25.1.0\nDiscord.py==2.0\n", "discord.py", "discord.py>=2.6.4")).toBe("highrise-bot-sdk==25.1.0\ndiscord.py>=2.6.4\n");
    expect(dev.setRequirement("# python_dateutil\npython_dateutil\n", "python-dateutil", "python-dateutil>=2.9.0")).toBe("# python_dateutil\npython-dateutil>=2.9.0\n");
  });

  it("refuses names and versions that aren't", async () => {
    expect((await run("add_package", { name: "aiohttp; rm -rf /" })).ok).toBe(false);
    expect((await run("add_package", { name: "aiohttp", version: ">=1 --index-url x" })).ok).toBe(false);
  });
});

describe("the new tools and automatic fixes", () => {
  it("are owner-only, and edit_lines gets the injected-code check like edit_file", async () => {
    const { automaticTools, automaticRefusal, AUTOMATIC_RUN_LOCKED } = await import("../../../apps/runner/src/agent/autoFix.js");
    for (const t of ["rename_symbol", "add_package", "restore_file", "format_code", "run_unit_tests"]) {
      expect(AUTOMATIC_RUN_LOCKED[t], t).toBeTruthy();
      expect(automaticRefusal("crash", t, {}, () => "")).toMatch(/Not allowed in an automatic fix/);
    }
    const names = automaticTools(tools.TOOL_SPECS).map((t) => t.function.name);
    for (const t of ["rename_symbol", "add_package", "run_unit_tests"]) expect(names).not.toContain(t);
    const current = () => "a = 1\nb = 2\n";
    expect(automaticRefusal("crash", "edit_lines", { path: "bot.py", start_line: 1, end_line: 1, new_text: "import requests\na = 1" }, current)).toMatch(/internet access/);
    expect(automaticRefusal("crash", "edit_lines", { path: "data/x.json", start_line: 1, end_line: 1, new_text: "{}" }, current)).toMatch(/saved data/);
    expect(automaticRefusal("crash", "edit_lines", { path: "bot.py", start_line: 1, end_line: 1, new_text: "a = 3" }, current)).toBeNull();
  });

  it("Kojy is told about them", async () => {
    const { BOT_CHAT_TOOLS, systemPrompt } = await import("../../../apps/runner/src/agent/prompt.js");
    for (const t of ["edit_lines", "rename_symbol", "trace_error", "run_unit_tests", "add_package", "restore_file", "format_code"]) expect(BOT_CHAT_TOOLS).toContain(t);
    expect(systemPrompt({ projectName: "x", entrypoint: "", status: "stopped", secrets: [], memories: [], fileCount: 1 })).toMatch(/trace_error first/);
  });
});
