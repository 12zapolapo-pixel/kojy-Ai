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
  writeFileSync(path.join(dir, "keybot.py"), `
import asyncio
from highrise import BaseBot
class KeyBot(BaseBot):
    coins = {"cat": 5}
    async def on_chat(self, user, message):
        if message.startswith("!coins"):
            await self.highrise.chat(f"{user.username} has {self.lookup(user.username)} coins")
        else:
            await self.highrise.chat(f"hi {user.username}")
    def lookup(self, name):
        return self.coins[name]
class StartFails(BaseBot):
    async def on_start(self, session_metadata):
        raise RuntimeError("could not load the shop")
class Chained(BaseBot):
    async def on_chat(self, user, message):
        try:
            int(message)
        except ValueError:
            raise LookupError("no such item")
class Background(BaseBot):
    async def on_start(self, session_metadata):
        asyncio.get_running_loop().call_exception_handler({"message": "Task exception was never retrieved", "exception": ValueError("bad tick")})
        print("still here", flush=True)
`);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Report { k: string; fatal: boolean; phase: string; type: string; line: string; frames: { file: string; line: number; func: string; code: string }[];
  event?: { handler: string; command?: string }; cause?: { line: string }; lib?: { file: string; func: string }; connected: boolean; times?: number }

/** Runs the launcher as the runner does (side channel on fd 3) and collects what it reports there. */
function launch(entry: string, env: Record<string, string>, waitMs: number): Promise<{ code: number | null; out: string; err: string; reports: Report[] }> {
  return new Promise((resolve) => {
    const child = spawn("python3", [LAUNCHER], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONPATH: dir, PYTHONUNBUFFERED: "1", KOJY_ENTRY: entry, HIGHRISE_ROOM_ID: "r", HIGHRISE_BOT_TOKEN: "t", KOJY_ROOM_CHECK_SECONDS: "600", ...env },
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    let out = ""; let err = ""; let side = "";
    child.stdout!.on("data", (d) => (out += d));
    child.stderr!.on("data", (d) => (err += d));
    (child.stdio[3] as NodeJS.ReadableStream).on("data", (d) => (side += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), waitMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      const reports = side.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Report).filter((r) => r.k === "crash" || r.k === "error");
      resolve({ code, out, err, reports });
    });
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
    expect(r.reports).toEqual([expect.objectContaining({
      k: "crash", fatal: true, phase: "import", type: "ImportError",
      frames: [expect.objectContaining({ file: "brokenimport.py", line: 3, func: "<module>", code: "from helpers import does_not_exist" })],
    })]);
    expect(r.reports[0]!.line).toMatch(/^ImportError: cannot import name 'does_not_exist' from 'helpers'/);
  }, 20_000);
});

describe("an error in a handler", () => {
  test("doesn't take the bot out of the room: it's printed, reported with the handler and command, and the next event still works", async () => {
    const r = await launch("keybot:KeyBot", { SCRIPT: "chat amy !coins\nwait 0.2\nchat cat !coins\nchat bob hello" }, 3_000);
    expect(r.code).toBeNull(); // still running when the test stopped it
    expect(r.err).toContain("[kojy] Error in on_chat (the !coins command) — the bot keeps running:");
    expect(r.err).toMatch(/keybot\.py", line \d+, in lookup\n\s+return self\.coins\[name\]\n(?:\s*[~^]+\n)?KeyError: 'amy'/);
    expect(r.out).toContain("(bot says) cat has 5 coins");
    expect(r.out).toContain("(bot says) hi bob");
    expect(r.reports).toHaveLength(1);
    expect(r.reports[0]).toMatchObject({
      k: "error", fatal: false, phase: "in_room", type: "KeyError", line: "KeyError: 'amy'", connected: true,
      event: { handler: "on_chat", command: "!coins" },
    });
    expect(r.reports[0]!.frames.map((f) => f.func)).toEqual(["on_chat", "lookup"]);
  }, 10_000);

  test("repeats are folded after the third, and a flood of errors restarts the bot with a crash report", async () => {
    const script = Array.from({ length: 8 }, (_, i) => `chat user${i} !coins`).join("\n");
    const r = await launch("keybot:KeyBot", { SCRIPT: script, KOJY_ERROR_FLOOD_SAME: "5" }, 10_000);
    expect(r.code).toBe(6);
    expect(r.err.match(/\[kojy\] Error in on_chat/g)).toHaveLength(3);
    expect(r.err).toMatch(/\[kojy\] Errors keep flooding in \(5 in the last minute, the latest in on_chat \(the !coins command\)\), so the bot is restarted\./);
    expect(r.reports.filter((x) => x.k === "error")).toHaveLength(3);
    expect(r.reports.at(-1)).toMatchObject({ k: "crash", fatal: true, type: "KeyError", event: { handler: "on_chat" } });
  }, 15_000);

  test("with KOJY_KEEP_RUNNING=off it ends the bot as before, and the report still names the handler and the real error inside the task groups", async () => {
    const r = await launch("keybot:KeyBot", { SCRIPT: "chat amy !coins", KOJY_KEEP_RUNNING: "off" }, 10_000);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Exception Group Traceback");
    expect(r.reports).toEqual([expect.objectContaining({ k: "crash", fatal: true, phase: "in_room", type: "KeyError", line: "KeyError: 'amy'", event: { handler: "on_chat", command: "!coins" } })]);
  }, 15_000);

  test("an error in on_start still ends the bot (it may be half set up), reported as on_start", async () => {
    const r = await launch("keybot:StartFails", {}, 10_000);
    expect(r.code).toBe(1);
    expect(r.reports).toEqual([expect.objectContaining({ k: "crash", type: "RuntimeError", line: "RuntimeError: could not load the shop", event: { handler: "on_start" } })]);
  }, 15_000);

  test("the error that caused it is reported too", async () => {
    const r = await launch("keybot:Chained", { SCRIPT: "chat amy sword" }, 3_000);
    expect(r.reports[0]).toMatchObject({ type: "LookupError", cause: { line: "ValueError: invalid literal for int() with base 10: 'sword'" } });
  }, 10_000);

  test("a background task that died with an error is survived and reported", async () => {
    const r = await launch("keybot:Background", {}, 3_000);
    expect(r.code).toBeNull();
    expect(r.out).toContain("still here");
    expect(r.err).toContain("[kojy] Error in a background task — the bot keeps running:");
    expect(r.reports[0]).toMatchObject({ k: "error", type: "ValueError", line: "ValueError: bad tick", event: { handler: "a background task" } });
  }, 10_000);
});

describe("Highrise refuses the session", () => {
  test("the SDK returning by itself is exit 5 with Highrise's words, not a silent exit 0", async () => {
    const r = await launch("keybot:KeyBot", { SDK_MODE: "refused" }, 10_000);
    expect(r.code).toBe(5);
    expect(r.err).toContain("[kojy] Highrise ended the session: ERROR: Invalid room id or api token closing connection with ID: test-connection — the bot stopped.");
    expect(r.reports).toEqual([expect.objectContaining({ k: "crash", type: "SessionEnded", connected: false, line: "ERROR: Invalid room id or api token closing connection with ID: test-connection" })]);
  }, 15_000);
});
