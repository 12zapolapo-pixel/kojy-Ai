/**
 * The launcher checks the bot is really in its room, not just running, run
 * for real (python3) against a stand-in for the Highrise SDK (and for aiohttp,
 * which the SDK connects with): every check is reported as "presence" with
 * the room's name; a bot Highrise stops listing among the room's users is
 * restarted — but only once Highrise is known to list it, never on a guess;
 * a bot whose code hangs before it ever connects is caught, with where it
 * hangs; Highrise refusing the connection ends the bot at once with Highrise's
 * answer instead of retrying for minutes.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LAUNCHER } from "../../../apps/runner/src/supervisor.js";

const hasPython = spawnSync("python3", ["-c", "import asyncio; asyncio.TaskGroup"]).status === 0;
const test = hasPython ? it : it.skip;
const dir = mkdtempSync(path.join(tmpdir(), "kojy-presence-"));

beforeAll(() => {
  mkdirSync(path.join(dir, "highrise"));
  mkdirSync(path.join(dir, "aiohttp"));
  // Just the part of aiohttp the launcher watches: every connection attempt goes through _ws_connect.
  writeFileSync(path.join(dir, "aiohttp", "__init__.py"), `
import os
class WSServerHandshakeError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message
class ClientSession:
    async def _ws_connect(self, url):
        mode = os.environ.get("SDK_MODE", "")
        if mode == "refusing":
            raise WSServerHandshakeError(403, "Invalid response status")
        if mode == "network-down":
            raise OSError("Name or service not known")
        return "socket"
`);
  writeFileSync(path.join(dir, "highrise", "__init__.py"), `
class BaseBot:
    async def on_start(self, session_metadata):
        pass
class Highrise:
    pass
`);
  // ROOM: "listed" (the room's users include the bot), "unlisted" (only someone else), "listed-then-gone".
  writeFileSync(path.join(dir, "highrise", "__main__.py"), `
import asyncio, os, time
import aiohttp
from highrise import Highrise
class BotDefinition:
    def __init__(self, bot, room_id, api_token):
        self.bot = bot
class User:
    def __init__(self, id):
        self.id = id
        self.username = id
class Answer:
    def __init__(self, content):
        self.content = content
class Socket:
    closed = False
class Room:
    room_name = "Japalo's Lounge"
    owner_id = "owner-1"
class Meta:
    connection_id = "c1"
    user_id = "bot-1"
    room_info = Room()
STARTED = time.monotonic()
class Chat(Highrise):
    ws = Socket()
    async def get_room_users(self):
        mode = os.environ.get("ROOM", "listed")
        bot_there = mode == "listed" or (mode == "listed-then-gone" and time.monotonic() - STARTED < 2.5)
        return Answer([(User("visitor"), None)] + ([(User("bot-1"), None)] if bot_there else []))
    async def get_room_privilege(self, user_id):
        class Rights:
            moderator = True
        return Rights()
async def main(definitions):
    bot = definitions[0].bot
    mode = os.environ.get("SDK_MODE", "")
    if mode in ("refusing", "network-down"):
        while True:  # like the real SDK: try again, a few times a second
            try:
                await aiohttp.ClientSession()._ws_connect("wss://highrise.game/web/botapi")
            except Exception:
                print("ERROR: reconnecting...", flush=True)
            await asyncio.sleep(0.05)
    bot.highrise = Chat()
    await bot.on_start(Meta())
    await asyncio.sleep(3600)
`);
  writeFileSync(path.join(dir, "presencebot.py"), `
import time
from highrise import BaseBot
class Fine(BaseBot):
    pass
class HangsAtStart(BaseBot):
    def __init__(self):
        self.load_shop()
    def load_shop(self):
        time.sleep(3600)  # a blocking call before the bot ever connects
`);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Event { k: string; in_room?: boolean; why?: string; room?: string; owner?: string; listed?: boolean; type?: string; line?: string; frames?: { file: string; func: string }[]; connect_error?: string }

function launch(entry: string, env: Record<string, string>, waitMs: number): Promise<{ code: number | null; out: string; err: string; events: Event[] }> {
  return new Promise((resolve) => {
    const child = spawn("python3", [LAUNCHER], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONPATH: dir, PYTHONUNBUFFERED: "1", KOJY_ENTRY: entry, HIGHRISE_ROOM_ID: "r", HIGHRISE_BOT_TOKEN: "t", KOJY_ROOM_CHECK_SECONDS: "1", ...env },
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    let out = ""; let err = ""; let side = "";
    child.stdout!.on("data", (d) => (out += d));
    child.stderr!.on("data", (d) => (err += d));
    (child.stdio[3] as NodeJS.ReadableStream).on("data", (d) => (side += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), waitMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, events: side.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Event).filter((e) => e.k === "presence" || e.k === "crash") });
    });
  });
}

describe("presence", () => {
  test("every check says the bot is in its room, with the room's name, and the connected line names the room", async () => {
    const r = await launch("presencebot:Fine", { ROOM: "listed" }, 4500);
    expect(r.code).toBeNull();
    expect(r.out).toContain('[kojy] Connected to Highrise (connection c1) — room "Japalo\'s Lounge"');
    const presence = r.events.filter((e) => e.k === "presence");
    expect(presence[0]).toMatchObject({ in_room: true, room: "Japalo's Lounge", owner: "owner-1", why: "connected" });
    expect(presence.filter((e) => e.listed === true).length).toBeGreaterThanOrEqual(2);
  }, 10_000);

  test("a bot that Highrise stops listing among the room's users is restarted (it was listed before, so that's known)", async () => {
    const r = await launch("presencebot:Fine", { ROOM: "listed-then-gone" }, 15_000);
    expect(r.code).toBe(4);
    expect(r.out).toContain("[kojy] Watchdog: Highrise didn't list the bot among the room's users 3 checks in a row, so it isn't really in the room — restarting the bot.");
    expect(r.events.filter((e) => e.k === "presence" && e.listed === false).length).toBe(3);
    expect(r.events.at(-1)).toMatchObject({ k: "crash", type: "NotInRoom" });
  }, 20_000);

  test("never restarted on a guess: never listed, and not known that Highrise lists bots — reported, but left running", async () => {
    const r = await launch("presencebot:Fine", { ROOM: "unlisted" }, 5000);
    expect(r.code).toBeNull();
    expect(r.out).not.toContain("Watchdog:");
    expect(r.events.filter((e) => e.k === "presence" && e.listed === false).every((e) => e.in_room === true)).toBe(true);
  }, 10_000);

  test("once KojyAI knows Highrise lists this bot (an earlier run), never being listed counts", async () => {
    const r = await launch("presencebot:Fine", { ROOM: "unlisted", KOJY_EXPECT_LISTED: "1" }, 15_000);
    expect(r.code).toBe(4);
    expect(r.out).toContain("Highrise didn't list the bot among the room's users 3 checks in a row");
  }, 20_000);
});

describe("before the bot ever gets into its room", () => {
  test("code that hangs before connecting is caught, with the line it hangs at (it goes to Kojy as a freeze)", async () => {
    const r = await launch("presencebot:HangsAtStart", { KOJY_CONNECT_SECONDS: "3" }, 15_000);
    expect(r.code).toBe(4);
    expect(r.err).toMatch(/presencebot\.py", line \d+, in load_shop\n\s+time\.sleep\(3600\)/);
    expect(r.err).toMatch(/BotFrozenError: the bot didn't get into its room within \d+s of starting; its code was stuck at the line above before it ever connected\./);
    expect(r.out).toMatch(/\[kojy\] Watchdog: the bot didn't get into its room within \d+s of starting — restarting the bot\./);
    expect(r.events.some((e) => e.k === "presence" && e.in_room === false)).toBe(true); // it was still reporting while stuck
    const crash = r.events.find((e) => e.k === "crash")!;
    expect(crash).toMatchObject({ type: "NeverConnected" });
    expect(crash.frames!.map((f) => f.func)).toContain("load_shop");
  }, 20_000);

  test("Highrise refusing the connection ends the bot at once, with Highrise's answer — no minutes of retrying", async () => {
    const started = Date.now();
    const r = await launch("presencebot:Fine", { SDK_MODE: "refusing" }, 15_000);
    expect(r.code).toBe(5);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(r.err).toMatch(/\[kojy\] Highrise refused the connection \d+ times in a row \(Highrise answered HTTP 403 \(Invalid response status\)\) — stopping instead of retrying\. Check HIGHRISE_BOT_TOKEN and HIGHRISE_ROOM_ID\./);
    expect(r.events.at(-1)).toMatchObject({ k: "crash", type: "ConnectRefused", line: "Highrise answered HTTP 403 (Invalid response status)" });
  }, 20_000);

  test("the network being down isn't a refusal: it keeps trying until the deadline, and says why it couldn't get in", async () => {
    const r = await launch("presencebot:Fine", { SDK_MODE: "network-down", KOJY_CONNECT_SECONDS: "3" }, 15_000);
    expect(r.code).toBe(4);
    expect(r.out).toMatch(/the bot didn't get into its room within \d+s of starting \(couldn't reach Highrise: OSError: Name or service not known\)/);
    const crash = r.events.find((e) => e.k === "crash")!;
    expect(crash).toMatchObject({ type: "NeverConnected", connect_error: "couldn't reach Highrise: OSError: Name or service not known", frames: [] });
  }, 20_000);
});
