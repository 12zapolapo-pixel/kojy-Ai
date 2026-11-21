/**
 * The second round of Kojy upgrades: a fake Discord to test Discord bots, a
 * project map in its instructions, ruff in check_code, more history for AIs
 * without a per-minute limit, and longer tasks.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { describeFile } from "../../../apps/runner/src/agent/projectMap.js";
import { judgeDiscord, pythonTarget } from "../../../apps/runner/src/agent/tools.js";
import { systemPrompt } from "../../../apps/runner/src/agent/prompt.js";

const SCRATCH_PY = process.env.KOJY_TEST_DISCORD_PYTHON ?? "";
/** A python with discord.py (the runner installs it from a bot's requirements.txt); the fake-Discord run is skipped without one. */
const discordPython = [SCRATCH_PY, "python3"].filter(Boolean).find((p) => spawnSync(p, ["-c", "import discord"]).status === 0);
const ruff = [process.env.KOJY_RUFF ?? "", "ruff"].filter(Boolean).find((p) => spawnSync(p, ["--version"]).status === 0);

describe("the project map", () => {
  it("names classes, handlers, slash commands (groups too), prefix and Highrise chat commands", () => {
    const discordFile = [
      "import discord", "from discord import app_commands",
      "class Config(commands.Cog):",
      "    config_group = app_commands.Group(name='config', description='x')",
      "    @config_group.command(name='set', description='Change a setting')",
      "    async def set(self, interaction, setting: str): ...",
      "@bot.tree.command(name='ping')", "async def ping(interaction): ...",
      "@bot.command()", "async def hello(ctx): ...",
      "async def on_member_join(member): ...",
      "def helper(): ...",
    ].join("\n");
    const line = describeFile(discordFile);
    expect(line).toContain("classes Config");
    expect(line).toContain("handlers on_member_join");
    expect(line).toMatch(/slash \/config set, \/ping/);
    expect(line).toContain("prefix commands hello");
    expect(line).toContain("functions set, ping, hello, helper");
    const highrise = describeFile('class Bot(BaseBot):\n    async def on_chat(self, user, message):\n        if message.startswith("!coins"):\n            pass\n        elif message in ("!help", "!h"):\n            pass\n');
    expect(highrise).toContain("chat commands !coins, !help, !h");
    expect(highrise).toContain("handlers on_chat");
  });

  it("goes into the instructions", () => {
    const text = systemPrompt({ projectName: "Crii", entrypoint: "run: python main.py", status: "running", secrets: [], memories: [], fileCount: 2, map: "- main.py (20 lines): slash /ping" });
    expect(text).toContain("Project map (from the code; read the file before changing it):\n- main.py (20 lines): slash /ping");
  });
});

describe("test_discord", () => {
  it("knows what starts a Python program", () => {
    expect(pythonTarget("run: python main.py")).toEqual(["main.py"]);
    expect(pythonTarget("run: python3 -u bot/main.py --debug")).toEqual(["bot/main.py", "--debug"]);
    expect(pythonTarget("run: python -m crii")).toEqual(["-m", "crii"]);
    expect(pythonTarget("bot:MyBot")).toBeNull();
    expect(pythonTarget("run: node index.js")).toBeNull();
  });

  it("turns the fake Discord's events into a report with a verdict", () => {
    const steps = [{ slash: "ping", user: "amy" }, { command: "!hello", user: "bob" }];
    const ok = judgeDiscord(steps, [
      { kind: "ready", slash: ["ping"], prefix: ["hello"] },
      { kind: "sent", step: 0, where: "reply", content: "Pong!", ephemeral: true },
      { kind: "sent", step: 1, where: "channel", embeds: ["Hi — welcome"] },
    ], "", ["pong", "welcome"]);
    expect(ok.ok).toBe(true);
    expect(ok.output).toContain("/ping (as amy):\n  replied (only they see it): Pong!");
    expect(ok.output).toContain("[embed] Hi — welcome");
    const bad = judgeDiscord(steps, [{ kind: "ready", slash: ["ping"], prefix: [] }, { kind: "error", step: 1, error: "KeyError: 'x'" }], "", ["pong"]);
    expect(bad.ok).toBe(false);
    expect(bad.summary).toMatch(/1 error/);
    expect(bad.output).toContain("ERROR: KeyError: 'x'");
    expect(judgeDiscord(steps, [], "Traceback…\nImportError: x", []).output).toMatch(/never got as far as its commands[\s\S]*ImportError/);
  });
});

describe("running in a fake Discord and checking with ruff", () => {
  const root = mkdtempSync(path.join(tmpdir(), "kojy-upg2-"));
  const uuid = "88888888-8888-4888-8888-888888888888";
  let tools: typeof import("../../../apps/runner/src/agent/tools.js");
  let files: typeof import("../../../packages/shared/src/projects/files.js");
  let ctx: import("../../../apps/runner/src/agent/tools.js").ToolContext;
  beforeAll(async () => {
    process.env.PROJECTS_DIR = path.join(root, "projects");
    process.env.VENVS_DIR = path.join(root, "venvs");
    process.env.RUNNER_SANDBOX = "off";
    if (ruff) process.env.KOJY_RUFF = ruff;
    vi.resetModules();
    tools = await import("../../../apps/runner/src/agent/tools.js");
    files = await import("../../../packages/shared/src/projects/files.js");
    files.ensureProjectDir(uuid);
    const python = discordPython ?? "python3";
    ctx = {
      db: {} as never, project: { id: 1, uuid, orgId: 1, entrypoint: "run: python main.py" } as never, snapshotted: false, changedFiles: new Set(),
      supervisor: { ensureVenv: async () => python, botEnv: async () => ({ PATH: `${path.dirname(python)}:${process.env.PATH}`, HOME: root, DISCORD_TOKEN: "REAL-TOKEN-never-used" }), secrets: async () => ({}) } as never,
    };
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it.skipIf(!discordPython)("calls slash commands (in cogs and groups) and prefix commands, never with the real token", async () => {
    files.writeProjectFile(uuid, "main.py", [
      "import os, discord", "from discord.ext import commands",
      "class Crii(commands.Bot):",
      "    def __init__(self):", "        super().__init__(command_prefix='!', intents=discord.Intents.default())",
      "    async def setup_hook(self):", "        await self.load_extension('cogs.config')", "        await self.tree.sync()",
      "bot = Crii()",
      "@bot.tree.command(name='add')", "async def add(interaction: discord.Interaction, a: int, b: int):",
      "    await interaction.response.send_message(embed=discord.Embed(title='Sum', description=str(a + b)))",
      "@bot.tree.command(name='token')", "async def token(interaction: discord.Interaction):",
      "    await interaction.response.send_message(os.environ['DISCORD_TOKEN'][:4])",
      "@bot.tree.command(name='broken')", "async def broken(interaction: discord.Interaction):", "    return {}['nope']",
      "@bot.command()", "async def hello(ctx, *, who: str = 'you'):", "    await ctx.send(f'Hello {who}')",
      "bot.run(os.environ['DISCORD_TOKEN'])",
    ].join("\n") + "\n");
    files.writeProjectFile(uuid, "cogs/config.py", [
      "import discord", "from discord import app_commands", "from discord.ext import commands",
      "class Config(commands.Cog):",
      "    group = app_commands.Group(name='config', description='Settings')",
      "    @group.command(name='set', description='x')",
      "    async def set(self, interaction: discord.Interaction, setting: str):",
      "        await interaction.response.send_message(f'Set {setting}', ephemeral=True)",
      "async def setup(bot):", "    await bot.add_cog(Config(bot))",
    ].join("\n") + "\n");
    const r = await tools.runTool("test_discord", {
      steps: [{ slash: "/add", args: { a: "2", b: "3" } }, { slash: "config set", args: { setting: "lang" }, user: "amy" }, { slash: "token" }, { command: "!hello big world" }],
      expect: ["Sum", "Set lang", "Hello big world"],
    }, ctx);
    expect(r.output).toContain("[embed] Sum — 5");
    expect(r.output).toContain("replied (only they see it): Set lang");
    expect(r.output).toContain("replied: koj"); // the fake token, never the real one
    expect(r.ok).toBe(true);
    const broken = await tools.runTool("test_discord", { steps: [{ slash: "broken" }] }, ctx);
    expect(broken.ok).toBe(false);
    expect(broken.output).toMatch(/main\.py", line 18, in broken[\s\S]*KeyError: 'nope'/);
  }, 60_000);

  it.skipIf(!ruff)("check_code: ruff finds sure bugs (failing) and blocking calls (a warning); fix tidies unused imports", async () => {
    files.writeProjectFile(uuid, "main.py", "import os\nimport time\nimport json\n\nasync def tick():\n    time.sleep(5)\n\ndef f():\n    return undefined_thing\n");
    const r = await tools.runTool("check_code", {}, ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/main\.py:9: Undefined name `undefined_thing` \(F821\)/);
    expect(r.output).toMatch(/Warnings[\s\S]*main\.py:6: .*time\.sleep.* \(ASYNC\d+\)/);
    files.writeProjectFile(uuid, "main.py", "import os\nimport json\n\nprint(os.getcwd())\n");
    const fixed = await tools.runTool("check_code", { fix: true }, ctx);
    expect(fixed.ok).toBe(true);
    expect(fixed.output).toMatch(/^ruff tidied 1 thing/);
    expect(files.readProjectFile(uuid, "main.py").content).toBe("import os\n\nprint(os.getcwd())\n");
  }, 60_000);
});

describe("history and task length", () => {
  async function client(env: Record<string, string>) {
    const keys = ["AGENT_API_KEY", "AGENT_API_KEYS", "GEMINI_MODELS", "MISTRAL_API_KEY", "MISTRAL_MODELS", "GROQ_API_KEY", "AGENT_LANE_ORDER"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    Object.assign(process.env, env);
    vi.resetModules();
    const ai = await import("../../../apps/runner/src/agent/groq.js");
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return ai;
  }
  it("an AI without a per-minute limit first gets the long history; Mistral's free plan the short one", async () => {
    expect((await client({ AGENT_API_KEY: "k", GEMINI_MODELS: "g" })).historyBudget(8000, 24_000)).toBe(24_000);
    expect((await client({ AGENT_API_KEY: "k", GEMINI_MODELS: "g", MISTRAL_API_KEY: "m", MISTRAL_MODELS: "mm" })).historyBudget(8000, 24_000)).toBe(8000);
    expect((await client({ AGENT_API_KEY: "k", GEMINI_MODELS: "g", MISTRAL_API_KEY: "m", MISTRAL_MODELS: "mm", AGENT_LANE_ORDER: "gemini" })).historyBudget(8000, 24_000)).toBe(24_000);
  });
});
