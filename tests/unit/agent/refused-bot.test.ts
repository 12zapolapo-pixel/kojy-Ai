/**
 * A Python bot whose token or room Highrise refuses: the SDK prints the error
 * and stops reconnecting, the launcher exits with SDK_ENDED_EXIT, and the
 * runner stops the bot instead of restarting it every minute for ever.
 * Long crash streaks restart more slowly.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LAUNCHER, SDK_ENDED_EXIT, highriseRefusal, restartDelayS } from "../../../apps/runner/src/supervisor.js";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const test = hasPython ? it : it.skip;
const dir = mkdtempSync(path.join(tmpdir(), "kojy-refused-"));

beforeAll(() => {
  mkdirSync(path.join(dir, "highrise"));
  writeFileSync(path.join(dir, "highrise", "__init__.py"), "class BaseBot:\n    async def on_start(self, session_metadata):\n        pass\nclass Highrise:\n    pass\n");
  // What the real SDK does when Highrise answers the connection with an Error.
  writeFileSync(path.join(dir, "highrise", "__main__.py"), `
class BotDefinition:
    def __init__(self, bot, room_id, api_token):
        self.bot = bot
async def main(definitions):
    print("ERROR: Error(message='Invalid room id or api token', do_not_reconnect=True, rid=None)", flush=True)
`);
  writeFileSync(path.join(dir, "testbot.py"), "from highrise import BaseBot\nclass Bot(BaseBot):\n    pass\n");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("a bot Highrise refuses", () => {
  test("the launcher exits with SDK_ENDED_EXIT and the refusal is in its output", async () => {
    const { code, out } = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn("python3", [LAUNCHER], {
        cwd: dir, env: { PATH: process.env.PATH ?? "", KOJY_ENTRY: "testbot:Bot", HIGHRISE_ROOM_ID: "r", HIGHRISE_BOT_TOKEN: "t", KOJY_WATCHDOG: "off" },
      });
      let out = "";
      child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
      child.once("exit", (c) => resolve({ code: c, out }));
    });
    expect(code).toBe(SDK_ENDED_EXIT);
    expect(highriseRefusal(code, out.trim().split("\n"))).toBe("Invalid room id or api token");
  });

  it("only that exit code with an ERROR line counts as a refusal", () => {
    const tail = ["[kojy] Starting", "ERROR: Error(message='Invalid room id or api token', do_not_reconnect=True, rid=None)"];
    expect(highriseRefusal(1, tail)).toBeNull(); // a crash
    expect(highriseRefusal(SDK_ENDED_EXIT, ["Websocket error, exiting."])).toBeNull(); // worth a restart
    expect(highriseRefusal(SDK_ENDED_EXIT, tail)).toBe("Invalid room id or api token");
  });
});

describe("restart backoff", () => {
  it("5s, 15s, 30s, then a minute, slowing down on long streaks", () => {
    expect([1, 2, 3, 4, 5, 9].map(restartDelayS)).toEqual([5, 15, 30, 60, 60, 60]);
    expect(restartDelayS(10)).toBe(300);
    expect(restartDelayS(19)).toBe(300);
    expect(restartDelayS(20)).toBe(900);
    expect(restartDelayS(500)).toBe(900);
  });
});
