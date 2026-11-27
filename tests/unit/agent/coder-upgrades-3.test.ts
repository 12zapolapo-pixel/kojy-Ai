/**
 * Kojy round 3, run for real on a project folder (no sandbox): outline_file,
 * find_symbol, inspect_package, show_changes (this request / since it last ran
 * fine), replace_in_files, search_code with context, read_file with several
 * paths, and the web_search result parser. Plus: automatic fixes get only the
 * read-only ones.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const root = mkdtempSync(path.join(tmpdir(), "kojy-r3-"));
const uuid = "88888888-8888-4888-8888-888888888888";

let tools: typeof import("../../../apps/runner/src/agent/tools.js");
let codeTools: typeof import("../../../apps/runner/src/agent/codeTools.js");
let files: typeof import("../../../packages/shared/src/projects/files.js");
let ctx: import("../../../apps/runner/src/agent/tools.js").ToolContext;

const BOT = `import json
from highrise import BaseBot

PRICE = 10


class ShopBot(BaseBot):
    """Sells things."""

    async def on_chat(self, user, message: str) -> None:
        if message.startswith("!buy"):
            await self.give_coins(user, PRICE)

    async def give_coins(self, user, amount: int = 1) -> None:
        """Adds coins."""
        print(json.dumps({"user": user, "amount": amount}))
`;
const HELPERS = "from bot import PRICE\n\n\ndef total(n):\n    return n * PRICE\n";

beforeAll(async () => {
  process.env.PROJECTS_DIR = path.join(root, "projects");
  process.env.VENVS_DIR = path.join(root, "venvs");
  process.env.RUNNER_SANDBOX = "off";
  vi.resetModules();
  tools = await import("../../../apps/runner/src/agent/tools.js");
  codeTools = await import("../../../apps/runner/src/agent/codeTools.js");
  files = await import("../../../packages/shared/src/projects/files.js");
  files.ensureProjectDir(uuid);
  files.writeProjectFile(uuid, "bot.py", BOT);
  files.writeProjectFile(uuid, "helpers.py", HELPERS);
  files.writeProjectFile(uuid, "data/prices.json", '{"PRICE": 10}');
  const supervisor = {
    ensureVenv: async () => "python3",
    botEnv: async () => ({ PATH: process.env.PATH, HOME: root }),
    secrets: async () => ({}),
  };
  ctx = { db: {} as never, supervisor: supervisor as never, project: { id: 1, uuid, orgId: 1, entrypoint: "bot:ShopBot" } as never, snapshotted: false, changedFiles: new Set() };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const run = (name: string, args: Record<string, unknown>) => tools.runTool(name, args, ctx);
const read = (rel: string) => readFileSync(path.join(files.projectDir(uuid), rel), "utf8");

describe("understanding code", () => {
  it("outline_file lists classes and methods with line ranges and signatures", async () => {
    const r = await run("outline_file", { path: "bot.py" });
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/^bot\.py \(\d+ lines\)/);
    expect(r.output).toContain("imports: json | highrise: BaseBot");
    expect(r.output).toMatch(/7-16 class ShopBot\(BaseBot\)\s+# Sells things\./);
    expect(r.output).toMatch(/10-12 async def on_chat\(self, user, message: str\) -> None/);
    expect(r.output).toMatch(/14-16 async def give_coins\(self, user, amount: int=1\) -> None\s+# Adds coins\./);
    expect(r.output).toContain("4 PRICE = ...");
  });

  it("outline_file refuses files that aren't Python", async () => {
    expect((await run("outline_file", { path: "data/prices.json" })).ok).toBe(false);
  });

  it("find_symbol finds the definition and every use, imports included", async () => {
    const r = await run("find_symbol", { name: "PRICE" });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("bot.py:4: assigned: PRICE = 10");
    expect(r.output).toContain("bot.py:12:");
    expect(r.output).toContain("helpers.py:1: imported: from bot import PRICE");
    expect(r.output).toContain("helpers.py:5:");
    expect(r.summary).toMatch(/Found PRICE: 1 definition, \d+ uses/);
    const m = await run("find_symbol", { name: "give_coins" });
    expect(m.output).toMatch(/bot\.py:14-16: async def give_coins\(.*\) -> None \(in class ShopBot\)/);
    expect((await run("find_symbol", { name: "not a name" })).ok).toBe(false);
  });

  it("inspect_package shows a library's real API, and says so when something doesn't exist", async () => {
    const fn = await run("inspect_package", { target: "json.dumps" });
    expect(fn.ok).toBe(true);
    expect(fn.output).toMatch(/def dumps\(obj, \*, skipkeys=False/);
    const cls = await run("inspect_package", { target: "collections.Counter" });
    expect(cls.output).toMatch(/most_common/);
    const missing = await run("inspect_package", { target: "json.dumpz" });
    expect(missing.ok).toBe(false);
    expect(missing.output).toMatch(/has no attribute 'dumpz'/);
    expect(missing.output).toMatch(/Names in json like it: .*dump/);
    const nope = await run("inspect_package", { target: "no_such_lib_kojy" });
    expect(nope.ok).toBe(false);
    expect(nope.output).toMatch(/No installed module named no_such_lib_kojy/);
    expect((await run("inspect_package", { target: "os; rm -rf /" })).ok).toBe(false);
  });

  it("inspect_package reads the bot's own modules too, and names a missing dependency rather than the module", async () => {
    files.writeProjectFile(uuid, "util.py", "def double(n: int) -> int:\n    return n * 2\n");
    const r = await run("inspect_package", { target: "util.double" });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("def double(n: int) -> int");
    // helpers imports bot, which imports highrise (not installed on this machine).
    const dep = await run("inspect_package", { target: "helpers.total" });
    expect(dep.ok).toBe(false);
    expect(dep.output).toMatch(/Importing helpers(\.total)? failed: it needs "highrise"/);
  });
});

describe("searching and reading", () => {
  it("search_code shows lines around each match with context", async () => {
    const r = await run("search_code", { pattern: "give_coins", literal: true, context: 1 });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("bot.py:11- ");
    expect(r.output).toContain("bot.py:12: ");
    expect(r.output).toContain("bot.py:13- ");
  });

  it("read_file with paths reads several files in one call", async () => {
    const r = await run("read_file", { paths: ["bot.py", "helpers.py"] });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("bot.py — lines 1-");
    expect(r.output).toContain("helpers.py — lines 1-");
    expect(r.summary).toMatch(/Read 2 files/);
  });
});

describe("changing many files and seeing what changed", () => {
  it("replace_in_files renames everywhere (whole words only), leaves data alone, and shows the diff", async () => {
    ctx.snapshotted = false; ctx.snapshotId = undefined; ctx.changedFiles.clear();
    const r = await run("replace_in_files", { find: "PRICE", replace: "COIN_PRICE", whole_word: true });
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/Replaced 4 times in 2 files/);
    expect(read("bot.py")).toContain("COIN_PRICE = 10");
    expect(read("helpers.py")).toContain("from bot import COIN_PRICE");
    expect(read("data/prices.json")).toBe('{"PRICE": 10}');
    expect(r.diff).toContain("+COIN_PRICE = 10");
    expect(ctx.snapshotted).toBe(true);
    expect((await run("replace_in_files", { find: "NOT_THERE_X", replace: "y" })).ok).toBe(false);
  });

  it("show_changes shows this request's diff", async () => {
    const r = await run("show_changes", {});
    expect(r.ok).toBe(true);
    expect(r.output).toContain("--- bot.py (changed)");
    expect(r.output).toContain("--- helpers.py (changed)");
    expect(r.output).toMatch(/\+.*COIN_PRICE/);
  });

  it("show_changes since=last_working compares with the version that last ran fine", async () => {
    expect((await run("show_changes", { since: "last_working" })).output).toMatch(/No version that ran fine/);
    files.saveKnownGood(uuid);
    expect((await run("show_changes", { since: "last_working" })).output).toMatch(/same as the last version that ran fine/);
    files.writeProjectFile(uuid, "helpers.py", "def total(n):\n    return n * 2\n");
    const r = await run("show_changes", { since: "last_working" });
    expect(r.output).toContain("--- helpers.py (changed)");
    expect(r.output).toContain("+    return n * 2");
  });
});

describe("web_search", () => {
  const PAGE = `<html><body>
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdiscordpy.readthedocs.io%2Fen%2Fstable%2Finteractions%2Fapi.html&amp;rut=abc">Interactions API &amp; <b>autocomplete</b></a></h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Use <b>app_commands.autocomplete</b> to suggest choices.</a>
  </div>
</div>
<div class="result result--ad results_links">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_provider=x">An ad</a></h2>
</div>
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://stackoverflow.com/q/123">Autocomplete example</a></h2>
  <a class="result__snippet" href="https://stackoverflow.com/q/123">A short answer.</a>
</div>
</body></html>`;

  it("reads titles, real addresses and snippets, and skips ads", () => {
    const r = codeTools.parseSearchResults(PAGE);
    expect(r).toEqual([
      { title: "Interactions API & autocomplete", url: "https://discordpy.readthedocs.io/en/stable/interactions/api.html", snippet: "Use app_commands.autocomplete to suggest choices." },
      { title: "Autocomplete example", url: "https://stackoverflow.com/q/123", snippet: "A short answer." },
    ]);
  });

  it("an empty query isn't sent", async () => {
    expect((await run("web_search", { query: "  " })).ok).toBe(false);
  });
});

describe("the new tools and automatic fixes", () => {
  it("automatic fixes get the read-only code tools, never web_search or replace_in_files", async () => {
    const { automaticTools, automaticRefusal, AUTOMATIC_RUN_LOCKED } = await import("../../../apps/runner/src/agent/autoFix.js");
    const names = automaticTools(tools.TOOL_SPECS).map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(["find_symbol", "inspect_package"]));
    expect(names).not.toContain("web_search");
    expect(names).not.toContain("replace_in_files");
    for (const t of ["web_search", "replace_in_files"]) {
      expect(AUTOMATIC_RUN_LOCKED[t], t).toBeTruthy();
      expect(automaticRefusal("crash", t, {}, () => "")).toMatch(/Not allowed in an automatic fix/);
    }
  });

  it("Kojy is told about them", async () => {
    const { systemPrompt, BOT_CHAT_TOOLS } = await import("../../../apps/runner/src/agent/prompt.js");
    for (const t of ["outline_file", "find_symbol", "inspect_package", "show_changes", "replace_in_files", "web_search"]) expect(BOT_CHAT_TOOLS).toContain(t);
    const p = systemPrompt({ projectName: "x", entrypoint: "", status: "stopped", secrets: [], memories: [], fileCount: 1 });
    expect(p).toMatch(/Never guess a library's API/);
    expect(p).toMatch(/show_changes since=last_working/);
  });
});
