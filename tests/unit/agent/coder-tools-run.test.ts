/**
 * Kojy's new and upgraded tools, run for real on a project folder (no
 * sandbox): append_file, multi_edit, edit_file's whitespace-tolerant match,
 * move_file, undo_changes, search_code literal, update_todo, run_python, and
 * check_code finding missing packages and undefined names before the bot runs.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const root = mkdtempSync(path.join(tmpdir(), "kojy-tools-"));
const uuid = "77777777-7777-4777-8777-777777777777";
/** A python3 with pyflakes, as in the runner image (python3-pyflakes), if this machine has one. */
const pyflakesPython = ["/usr/bin/python3", "python3"].find((p) => spawnSync(p, ["-m", "pyflakes", "--version"]).status === 0);

let tools: typeof import("../../../apps/runner/src/agent/tools.js");
let files: typeof import("../../../packages/shared/src/projects/files.js");
let ctx: import("../../../apps/runner/src/agent/tools.js").ToolContext;

beforeAll(async () => {
  process.env.PROJECTS_DIR = path.join(root, "projects");
  process.env.VENVS_DIR = path.join(root, "venvs");
  process.env.RUNNER_SANDBOX = "off";
  if (pyflakesPython) process.env.PYTHON_BIN = pyflakesPython;
  vi.resetModules();
  tools = await import("../../../apps/runner/src/agent/tools.js");
  files = await import("../../../packages/shared/src/projects/files.js");
  files.ensureProjectDir(uuid);
  const python = pyflakesPython ?? "python3";
  const supervisor = {
    ensureVenv: async () => python,
    botEnv: async () => ({ PATH: process.env.PATH, HOME: root, SECRET_TOKEN: "s3cr3t-value-123" }),
    secrets: async () => ({ SECRET_TOKEN: "s3cr3t-value-123" }),
  };
  ctx = { db: {} as never, supervisor: supervisor as never, project: { id: 1, uuid, orgId: 1, entrypoint: "run: python main.py" } as never, snapshotted: false, changedFiles: new Set() };
});
afterAll(() => { delete process.env.PYTHON_BIN; rmSync(root, { recursive: true, force: true }); });

const run = (name: string, args: Record<string, unknown>) => tools.runTool(name, args, ctx);
const read = (rel: string) => readFileSync(path.join(files.projectDir(uuid), rel), "utf8");

describe("writing a long file in parts", () => {
  it("write_file the first part, append_file the rest", async () => {
    expect((await run("write_file", { path: "main.py", content: "import os\n\ndef one():\n    return 1" })).ok).toBe(true);
    const r = await run("append_file", { path: "main.py", content: "def two():\n    return 2\n" });
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/main\.py has \d+ lines now/);
    expect(read("main.py")).toBe("import os\n\ndef one():\n    return 1\ndef two():\n    return 2\n"); // a part never glues onto the last line
  });

  it("the first change of a request leaves an undo point; undo_changes puts the code back", async () => {
    files.writeProjectFile(uuid, "keep.py", "x = 1\n");
    ctx.snapshotted = false;
    ctx.label = "add a feature";
    await run("write_file", { path: "keep.py", content: "x = 2\n" });
    await run("write_file", { path: "extra.py", content: "y = 3\n" });
    const r = await run("undo_changes", {});
    expect(r.ok).toBe(true);
    expect(read("keep.py")).toBe("x = 1\n");
    expect(existsSync(path.join(files.projectDir(uuid), "extra.py"))).toBe(false);
    expect(files.listSnapshots(uuid)[0]!.reason).toBe("Before Kojy undid its own changes"); // the undone code stays in Undo
  });
});

describe("changing code", () => {
  it("multi_edit makes several changes in one call", async () => {
    files.writeProjectFile(uuid, "shop.py", "PRICE = 5\nTAX = 1\n");
    const r = await run("multi_edit", { path: "shop.py", edits: [{ old_text: "PRICE = 5", new_text: "PRICE = 7" }, { old_text: "TAX = 1", new_text: "TAX = 2" }] });
    expect(r.ok).toBe(true);
    expect(read("shop.py")).toBe("PRICE = 7\nTAX = 2\n");
  });

  it("edit_file finds a copy that's off only in indentation, and says so", async () => {
    files.writeProjectFile(uuid, "bot.py", "class B:\n    def f(self):\n        return 1\n");
    const r = await run("edit_file", { path: "bot.py", old_text: "def f(self):\n    return 1", new_text: "def f(self):\n    return 2" });
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/differed from the file only in indentation/);
    expect(read("bot.py")).toBe("class B:\n    def f(self):\n        return 2\n");
  });

  it("move_file renames, and data files stay put", async () => {
    files.writeProjectFile(uuid, "old_name.py", "z = 1\n");
    expect((await run("move_file", { from: "old_name.py", to: "cogs/new_name.py" })).ok).toBe(true);
    expect(read("cogs/new_name.py")).toBe("z = 1\n");
    expect((await run("move_file", { from: "data/bot.db", to: "x.db" })).ok).toBe(false);
  });

  it("search_code literal finds text with regex characters in it", async () => {
    files.writeProjectFile(uuid, "q.py", "print(user.name)\n");
    const r = await run("search_code", { pattern: "print(user.name)", literal: true });
    expect(r.output).toContain("q.py:1");
  });
});

describe("running and checking code", () => {
  it("run_python runs a multi-line script in the bot's folder, with secrets hidden", async () => {
    files.writeProjectFile(uuid, "calc.py", "def add(a, b):\n    return a + b\n");
    const r = await run("run_python", { code: "import os\nimport calc\nprint('sum', calc.add(2, 3))\nprint(os.environ['SECRET_TOKEN'])" });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("sum 5");
    expect(r.output).toContain("[secret]");
    expect(r.output).not.toContain("s3cr3t-value-123");
  });

  it("check_code names an import nothing provides (with the package to add) and undefined names", async () => {
    files.removeProjectDir(uuid);
    files.ensureProjectDir(uuid);
    files.writeProjectFile(uuid, "main.py", [
      "import os", "import discord", "from helpers import greet",
      "try:", "    import ujson as json", "except ImportError:", "    import json",
      "def hello():", "    return greet(nmae)",
    ].join("\n") + "\n");
    files.writeProjectFile(uuid, "helpers.py", "def greet(n):\n    return 'hi ' + n\n");
    const r = await run("check_code", {});
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/main\.py:2: imports "discord", but no installed package provides it — add discord\.py to requirements\.txt/);
    expect(r.output).not.toMatch(/"helpers"|"ujson"|"os"/); // its own module, an optional import, the standard library
    if (pyflakesPython) expect(r.output).toMatch(/main\.py:9:\d+:? undefined name 'nmae'/);
  });

  it("check_code passes clean code", async () => {
    files.writeProjectFile(uuid, "main.py", "import os\nfrom helpers import greet\nprint(greet(os.getcwd()))\n");
    const r = await run("check_code", {});
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("Code check passed");
  });
});

describe("the checklist", () => {
  it("update_todo keeps the steps and shows them as a card", async () => {
    const r = await run("update_todo", { items: [{ step: "Write main.py", done: true }, { step: "Add /ping" }, "Test it"] });
    expect(r.ok).toBe(true);
    expect(r.cardKind).toBe("todo");
    expect(r.card).toEqual({ items: [{ step: "Write main.py", done: true }, { step: "Add /ping", done: false }, { step: "Test it", done: false }] });
    expect(r.summary).toBe("Checklist: 1 of 3 done");
  });
});
