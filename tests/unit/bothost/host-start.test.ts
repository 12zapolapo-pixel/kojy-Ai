/**
 * What runs on the bot host, for real (python3): the starter loads the
 * bot's settings from .kojy/env.json into the environment and starts
 * KojyAI's launcher; without settings, or when installing packages fails, it
 * says so and stops. The launcher reports room activity as marked console
 * lines when there's no fd 3 (KOJY_ACTIVITY=stdout).
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOSTSTART, LAUNCHER } from "../../../apps/runner/src/supervisor.js";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const test = hasPython ? it : it.skip;
const root = mkdtempSync(path.join(tmpdir(), "kojy-hoststart-"));

function run(cwd: string, file: string, env: Record<string, string> = {}, waitMs = 10_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("python3", [file], { cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONUNBUFFERED: "1", HOME: cwd, ...env } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), waitMs);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

/** A server's folder as KojyAI uploads it, with a stand-in launcher. */
function server(name: string, settings: Record<string, string> | null, requirements?: string): string {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, ".kojy"), { recursive: true });
  copyFileSync(HOSTSTART, path.join(dir, "kojy_start.py"));
  writeFileSync(path.join(dir, "kojy_launcher.py"), [
    "import os, sys",
    "print('entry=' + os.environ['KOJY_ENTRY'], 'secret=' + os.environ['HIGHRISE_BOT_TOKEN'], 'cwd=' + os.getcwd(), 'first=' + sys.path[0], flush=True)",
  ].join("\n"));
  if (settings) writeFileSync(path.join(dir, ".kojy", "env.json"), JSON.stringify(settings));
  if (requirements !== undefined) writeFileSync(path.join(dir, ".kojy", "requirements.txt"), requirements);
  return dir;
}

beforeAll(() => {
  // Just enough of the Highrise SDK for the launcher: connect, then one chat message.
  const sdk = path.join(root, "sdk", "highrise");
  mkdirSync(sdk, { recursive: true });
  writeFileSync(path.join(sdk, "__init__.py"), `
class BaseBot:
    async def on_start(self, session_metadata):
        pass
    async def on_chat(self, user, message):
        pass
class Highrise:
    async def chat(self, message):
        pass
    async def send_whisper(self, user_id, message):
        pass
`);
  writeFileSync(path.join(sdk, "__main__.py"), `
import asyncio
from highrise import Highrise
class BotDefinition:
    def __init__(self, bot, room_id, api_token):
        self.bot = bot
class User:
    id = "u1"
    username = "Kojy_"
class Meta:
    connection_id = "c1"
    user_id = "bot-1"
async def main(definitions):
    bot = definitions[0].bot
    bot.highrise = Highrise()
    await bot.on_start(Meta())
    await bot.on_chat(User(), "hi")
`);
  writeFileSync(path.join(root, "sdk", "chatbot.py"), `
from highrise import BaseBot
class ChatBot(BaseBot):
    async def on_chat(self, user, message):
        await self.highrise.chat("hello " + user.username)
`);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the starter on the bot host", () => {
  test("loads the bot's settings into the environment and runs the launcher from the server's folder", async () => {
    const dir = server("ok", { KOJY_ENTRY: "bot:MyBot", HIGHRISE_BOT_TOKEN: "abc123" });
    const r = await run(dir, "kojy_start.py");
    expect(r.code).toBe(0);
    expect(r.out).toContain("entry=bot:MyBot secret=abc123");
    expect(r.out).toContain(`cwd=${dir}`);
    expect(r.out).toContain(`first=${path.join(dir, ".kojy", "packages")}`);
  });

  test("without its settings it says to start the bot from KojyAI and stops", async () => {
    const r = await run(server("no-settings", null), "kojy_start.py");
    expect(r.code).toBe(2);
    expect(r.out).toContain("[kojy] The bot's settings are missing here. Start the bot from KojyAI so it uploads them.");
  });

  test("a failed package install stops the start with a clear line", async () => {
    const dir = server("bad-packages", { KOJY_ENTRY: "bot:MyBot", HIGHRISE_BOT_TOKEN: "x" }, "./no-such-package-folder\n");
    const r = await run(dir, "kojy_start.py", {}, 60_000);
    expect(r.code).toBe(2);
    expect(r.out).toContain("[kojy] Installing packages (first run or requirements.txt changed)…");
    expect(r.out).toMatch(/\[kojy\] Installing packages failed \(pip exit \d+\)\./);
  }, 70_000);
});

describe("the launcher on a bot host", () => {
  test("reports room activity as marked console lines (no fd 3 there)", async () => {
    const r = await run(path.join(root, "sdk"), LAUNCHER, {
      PYTHONPATH: path.join(root, "sdk"), KOJY_ENTRY: "chatbot:ChatBot", HIGHRISE_ROOM_ID: "r", HIGHRISE_BOT_TOKEN: "t",
      KOJY_ACTIVITY: "stdout", KOJY_WATCHDOG: "off",
    });
    const activity = r.out.split("\n").filter((l) => l.startsWith("[kojy:activity] ")).map((l) => JSON.parse(l.slice(16)) as { k: string; n: string | null });
    expect(activity).toEqual([{ k: "chat", id: "u1", n: "Kojy_" }, { k: "reply", id: null, n: null }]);
  });
});
