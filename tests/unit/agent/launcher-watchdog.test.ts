/**
 * The bot launcher's watchdog, run for real (python3) against a stand-in for
 * the Highrise SDK: frozen code is caught with the line it's stuck on, a bot
 * that stops answering in the room or loses its connection is restarted, and
 * a healthy bot is left alone.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LAUNCHER } from "../../../apps/runner/src/supervisor.js";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const test = hasPython ? it : it.skip;
const dir = mkdtempSync(path.join(tmpdir(), "kojy-watchdog-"));

beforeAll(() => {
  mkdirSync(path.join(dir, "highrise"));
  // Just enough of the SDK: main() connects (sets bot.highrise) unless told not to, calls on_start, then runs.
  writeFileSync(path.join(dir, "highrise", "__init__.py"), `
class BaseBot:
    async def on_start(self, session_metadata):
        pass
class Highrise:
    pass
`);
  writeFileSync(path.join(dir, "highrise", "__main__.py"), `
import asyncio, os
class BotDefinition:
    def __init__(self, bot, room_id, api_token):
        self.bot = bot
class Answer:
    content = []
class Socket:
    closed = False
class Rights:
    def __init__(self, moderator):
        self.moderator = moderator
class Refused:
    message = "not allowed"
class Chat:
    ws = Socket()
    async def get_room_privilege(self, user_id):
        mode = os.environ.get("ROOM_RIGHTS", "mod")
        if mode == "error":
            return Refused()
        return Rights(mode == "mod" and user_id == "bot-1")
    async def get_room_users(self):
        mode = os.environ.get("ROOM_MODE", "ok")
        if mode == "silent":
            raise ConnectionResetError("Cannot write to closing transport")
        return Answer()
class Meta:
    connection_id = "test-connection"
    user_id = "bot-1"
async def main(definitions):
    bot = definitions[0].bot
    if os.environ.get("ROOM_MODE") != "never-connects":
        bot.highrise = Chat()
        await bot.on_start(Meta())
    await asyncio.sleep(3600)
`);
  writeFileSync(path.join(dir, "testbot.py"), `
import asyncio, time
from highrise import BaseBot
class FrozenBot(BaseBot):
    async def on_start(self, session_metadata):
        await asyncio.sleep(0.2)
        self.wait_for_api()
    def wait_for_api(self):
        time.sleep(1000)  # blocks the event loop: the freeze
class FineBot(BaseBot):
    async def on_start(self, session_metadata):
        print("hello room", flush=True)
`);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function launch(entry: string, env: Record<string, string>, waitMs: number): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn("python3", [LAUNCHER], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONPATH: dir, PYTHONUNBUFFERED: "1", KOJY_ENTRY: entry, HIGHRISE_ROOM_ID: "r", HIGHRISE_BOT_TOKEN: "t", ...env },
    });
    let out = ""; let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), waitMs);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

describe("bot watchdog", () => {
  test("frozen code: prints where it's stuck as a traceback and exits so the runner restarts it", async () => {
    const r = await launch("testbot:FrozenBot", { KOJY_FREEZE_SECONDS: "2" }, 15_000);
    expect(r.code).toBe(3);
    expect(r.err).toContain("Traceback (most recent call last):");
    expect(r.err).toMatch(/testbot\.py", line \d+, in wait_for_api\n\s+time\.sleep\(1000\)/);
    expect(r.err).toMatch(/BotFrozenError: the bot's code didn't hand control back for \d+s/);
    expect(r.out).toContain("[kojy] Connected to Highrise (connection test-connection)");
  }, 20_000);

  test("Highrise stops answering room checks: restarted after three misses", async () => {
    const r = await launch("testbot:FineBot", { ROOM_MODE: "silent", KOJY_ROOM_CHECK_SECONDS: "1" }, 15_000);
    expect(r.code).toBe(4);
    expect(r.out).toContain("[kojy] Watchdog: Highrise didn't answer 3 room checks in a row");
  }, 20_000);

  test("never connected for too long: restarted", async () => {
    const r = await launch("testbot:FineBot", { ROOM_MODE: "never-connects", KOJY_ROOM_CHECK_SECONDS: "1", KOJY_OFFLINE_SECONDS: "2" }, 15_000);
    expect(r.code).toBe(4);
    expect(r.out).toMatch(/\[kojy\] Watchdog: the bot hasn't been connected to Highrise for \d+s/);
  }, 20_000);

  test("a healthy bot is left alone", async () => {
    const r = await launch("testbot:FineBot", { KOJY_FREEZE_SECONDS: "2", KOJY_ROOM_CHECK_SECONDS: "1" }, 6_000);
    expect(r.code).toBeNull(); // still running when the test stopped it
    expect(r.out).toContain("hello room");
    expect(r.out).toContain("[kojy] Freeze and room checks on: the code is checked every 0.5s (restart when frozen for 2s), the room every 1s");
    expect(r.out).not.toContain("Watchdog");
    expect(r.err).not.toContain("BotFrozenError");
  }, 10_000);

  test("KOJY_WATCHDOG=off (the test room) disables it", async () => {
    const r = await launch("testbot:FrozenBot", { KOJY_WATCHDOG: "off", KOJY_FREEZE_SECONDS: "1" }, 4_000);
    expect(r.code).toBeNull();
    expect(r.out).not.toContain("Freeze and room checks on");
    expect(r.err).not.toContain("BotFrozenError");
  }, 8_000);

  test("after connecting it says whether the bot is a moderator in its room", async () => {
    const not = await launch("testbot:FineBot", { ROOM_RIGHTS: "not" }, 3_000);
    expect(not.out).toContain("[kojy] Room rights: the bot is NOT a moderator in this room — commands that move, kick, mute or ban people won't work");
    const mod = await launch("testbot:FineBot", { ROOM_RIGHTS: "mod" }, 3_000);
    expect(mod.out).toContain("[kojy] Room rights: the bot is a moderator here.");
    const err = await launch("testbot:FineBot", { ROOM_RIGHTS: "error" }, 3_000);
    expect(err.out).toContain("[kojy] Room rights: couldn't check (not allowed)");
    const testRoom = await launch("testbot:FineBot", { ROOM_RIGHTS: "not", KOJY_WATCHDOG: "off" }, 3_000);
    expect(testRoom.out).not.toContain("Room rights");
  }, 20_000);
});
