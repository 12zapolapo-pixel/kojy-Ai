/**
 * How the launcher reports what went wrong, run for real (python3) against a
 * stand-in for the Highrise SDK that, like the real one, runs every event
 * handler as a task in a task group inside another task group (so an error in
 * a handler would end the whole bot with nested exception groups).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LAUNCHER } from "../../../apps/runner/src/supervisor.js";

const hasPython = spawnSync("python3", ["-c", "import asyncio; asyncio.TaskGroup"]).status === 0;
const test = hasPython ? it : it.skip;
const dir = mkdtempSync(path.join(tmpdir(), "kojy-crash-reports-"));

beforeAll(() => {
  mkdirSync(path.join(dir, "highrise"));
  writeFileSync(path.join(dir, "highrise", "__init__.py"), `
class BaseBot:
    async def on_start(self, session_metadata):
        pass
    async def on_chat(self, user, message):
        pass
    async def on_whisper(self, user, message):
        pass
    async def on_user_join(self, user, position):
        pass
    async def on_user_leave(self, user):
        pass
    async def on_tip(self, sender, receiver, tip):
        pass
    async def on_emote(self, user, emote_id, receiver):
        pass
class Highrise:
    async def chat(self, message):
        print(f"(bot says) {message}", flush=True)
    async def send_whisper(self, user_id, message):
        print(f"(bot whispers) {message}", flush=True)
class User:
    def __init__(self, name):
        self.id = "u-" + name
        self.username = name
`);
  // SCRIPT: one event per line, "chat <user> <message>", "join <user>", "wait <seconds>".
  // SDK_MODE=refused: Highrise refuses the session (the real SDK prints ERROR and returns).
  writeFileSync(path.join(dir, "highrise", "__main__.py"), `
import asyncio, os
from highrise import Highrise, User
class BotDefinition:
    def __init__(self, bot, room_id, api_token):
        self.bot = bot
class Socket:
    closed = False
class Answer:
    content = []
class Chat(Highrise):
    ws = Socket()
    async def get_room_users(self):
        return Answer()
    async def get_room_privilege(self, user_id):
        class Rights:
            moderator = True
        return Rights()
class Meta:
    connection_id = "test-connection"
    user_id = "bot-1"
async def bot_runner(bot):
    async with asyncio.TaskGroup() as tg:
        if os.environ.get("SDK_MODE") == "refused":
            print("ERROR: Invalid room id or api token closing connection with ID: test-connection")
            return
        bot.highrise = Chat()
        tg.create_task(bot.on_start(Meta()))
        for line in os.environ.get("SCRIPT", "").splitlines():
            parts = line.split(" ", 2)
            if parts[0] == "wait":
                await asyncio.sleep(float(parts[1]))
            elif parts[0] == "chat":
                tg.create_task(bot.on_chat(User(parts[1]), parts[2]))
            elif parts[0] == "join":
                tg.create_task(bot.on_user_join(User(parts[1]), None))
        await asyncio.sleep(3600)
async def main(definitions):
    async with asyncio.TaskGroup() as tg:
        tg.create_task(bot_runner(definitions[0].bot))
`);
  writeFileSync(path.join(dir, "brokenimport.py"), `
from highrise import BaseBot
from helpers import does_not_exist
class Bot(BaseBot):
    pass
`);
  writeFileSync(path.join(dir, "helpers.py"), "def something():\n    return 1\n");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function launch(entry: string, env: Record<string, string>, waitMs: number): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn("python3", [LAUNCHER], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONPATH: dir, PYTHONUNBUFFERED: "1", KOJY_ENTRY: entry, HIGHRISE_ROOM_ID: "r", HIGHRISE_BOT_TOKEN: "t", KOJY_ROOM_CHECK_SECONDS: "600", ...env },
    });
    let out = ""; let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), waitMs);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

describe("the bot fails to load", () => {
  test("a wrong import prints a real traceback ending at the bot's own line, so Kojy can fix it", async () => {
    const r = await launch("brokenimport:Bot", {}, 15_000);
    expect(r.code).toBe(2);
    expect(r.err).toContain("Traceback (most recent call last):");
    expect(r.err).toMatch(/brokenimport\.py", line 3, in <module>\n\s+from helpers import does_not_exist/);
    expect(r.err).toMatch(/ImportError: cannot import name 'does_not_exist' from 'helpers'/);
    expect(r.err).toContain("[kojy] Can't load brokenimport:Bot");
  }, 20_000);
});
