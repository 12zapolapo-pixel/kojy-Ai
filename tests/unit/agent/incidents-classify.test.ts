/**
 * What kind of problem an exit was (classifyExit): bugs in the bot's code are
 * told apart from the network, the watchdog, missing secrets and packages,
 * memory and Highrise refusing the bot — each with a stable signature, so the
 * same problem is one incident however often it happens.
 */
import { describe, expect, it } from "vitest";
import { classifyExit, FIXABLE } from "../../../apps/runner/src/incidents.js";

const exit = (tail: string[], how = "code 1", ranForMs = 5000) => classifyExit({ tail, how, ranForMs });

describe("classifyExit", () => {
  it("a traceback in the bot's code is a code bug; the same bug for another visitor has the same signature", () => {
    const tb = (user: string, line: number) => [
      "Traceback (most recent call last):",
      `  File "/app/projects/u1/highrise_bot/bot.py", line ${line}, in on_chat`,
      "    coins = self.coins[user.username]",
      `KeyError: '${user}'`,
    ];
    const a = exit(tb("amy", 302));
    expect(a).toMatchObject({ category: "code", phase: "startup", state: "open", summary: "KeyError: '…' in on_chat (highrise_bot/bot.py)", example: "KeyError: 'amy'" });
    expect(exit(tb("bob", 310)).signature).toBe(a.signature); // another visitor, and a fix moved the line
    expect(FIXABLE.has(a.category)).toBe(true);
  });

  it("knows the bot was in the room: from the launcher's connected line, or from running for minutes", () => {
    const tb = ["Traceback (most recent call last):", '  File "/app/projects/u1/bot.py", line 3, in on_tip', "    x = 1 / 0", "ZeroDivisionError: division by zero"];
    expect(exit(["[kojy] Connected to Highrise (connection c1)", ...tb]).phase).toBe("in_room");
    expect(exit(tb, "code 1", 10 * 60_000).phase).toBe("in_room");
  });

  it("a freeze caught by the watchdog is a bug Kojy fixes too", () => {
    const c = exit(["Traceback (most recent call last):", '  File "/app/projects/u1/weather.py", line 40, in fetch', "    time.sleep(30)", "BotFrozenError: the bot's code didn't hand control back for 61s"], "code 3");
    expect(c.category).toBe("frozen");
    expect(FIXABLE.has(c.category)).toBe(true);
  });

  it("the network or Highrise being away isn't a bug: ignored, one signature per kind of error", () => {
    const c = exit(["Traceback (most recent call last):", "aiohttp.client_exceptions.ClientConnectorError: Cannot connect to host highrise.game:443 ssl:default"]);
    expect(c).toMatchObject({ category: "network", state: "ignored", signature: "network:aiohttp.client_exceptions.ClientConnectorError" });
    expect(FIXABLE.has(c.category)).toBe(false);
  });

  it("a wrong import in the bot's own code is a code bug found while loading", () => {
    const c = exit([
      "Traceback (most recent call last):",
      '  File "/app/projects/u1/main.py", line 2, in <module>',
      "    from helpers import does_not_exist",
      "ImportError: cannot import name 'does_not_exist' from 'helpers' (/app/projects/u1/helpers.py)",
      "[kojy] Can't load main:Bot: cannot import name 'does_not_exist' from 'helpers'",
    ], "code 2", 400);
    expect(c).toMatchObject({ category: "code", phase: "import" });
  });

  it("a package that isn't installed is its own kind, named after the module", () => {
    const c = exit([
      "Traceback (most recent call last):",
      '  File "/app/projects/u1/main.py", line 1, in <module>',
      "    import requests",
      "ModuleNotFoundError: No module named 'requests'",
      "[kojy] Can't load main:Bot: No module named 'requests'",
    ], "code 2", 400);
    expect(c).toMatchObject({ category: "missing_package", signature: "package:requests", phase: "import" });
  });

  it("a secret the bot reads but doesn't have is the owner's to add (only they have the value)", () => {
    const c = exit(["Traceback (most recent call last):", '  File "/app/projects/u1/ai.py", line 5, in <module>', '    KEY = os.environ["OPENAI_API_KEY"]', "KeyError: 'OPENAI_API_KEY'"]);
    expect(c).toMatchObject({ category: "missing_secret", signature: "secret:OPENAI_API_KEY", state: "needs_owner" });
    expect(c.note).toMatch(/add it there \(only you have the value\)/);
    // An ordinary KeyError on a dict isn't a secret.
    expect(exit(["Traceback (most recent call last):", '  File "/app/projects/u1/bot.py", line 5, in f', "    x = PRICES[item]", "KeyError: 'SWORD'"]).category).toBe("code");
  });

  it("the launcher missing the room or token is the owner's to add", () => {
    expect(exit(["[kojy] Add HIGHRISE_ROOM_ID and HIGHRISE_BOT_TOKEN in the project's Secrets."], "code 2", 200)).toMatchObject({ category: "missing_secret", state: "needs_owner", signature: "config:room-and-token" });
  });

  it("the watchdog finding the bot wasn't in its room is a problem to see, never \"not a bug\" — one kind per reason", () => {
    const offline = exit(["[kojy] Watchdog: the bot hasn't been connected to Highrise for 301s — restarting the bot."], "code 4", 400_000);
    expect(offline).toMatchObject({ category: "not_in_room", state: "open", signature: "watchdog:offline" });
    expect(offline.note).toMatch(/^It wasn't in its room \(the bot hasn't been connected to Highrise for 301s\), so it was started again\.$/);
    expect(exit(["[kojy] Watchdog: Highrise didn't list the bot among the room's users 3 checks in a row, so it isn't really in the room — restarting the bot."], "code 4", 400_000).signature).toBe("watchdog:missing-from-list");
    expect(exit(["[kojy] Watchdog: Highrise didn't answer 3 room checks in a row, so the bot isn't really in the room — restarting the bot."], "code 4", 400_000).signature).toBe("watchdog:no-answer");
    expect(exit(["[kojy] Watchdog: the bot didn't get into its room within 300s of starting — restarting the bot."], "code 4", 300_000)).toMatchObject({ category: "cannot_connect", signature: "never-connected" });
  });

  it("Highrise refusing the connection at the HTTP level isn't settled yet (it can be the bot host's network): KojyAI finds out", () => {
    const c = classifyExit({ tail: [], how: "code 5", ranForMs: 1500, report: { k: "crash", fatal: true, type: "ConnectRefused", line: "Highrise answered HTTP 403 (Invalid response status)", frames: [], connected: false } });
    expect(c).toMatchObject({ category: "highrise_refused", state: "open" });
    expect(c.note).toMatch(/HTTP 403.*KojyAI is finding out why/);
  });

  it("never getting into the room: the network, a refusal, or the bot's own code hanging (a freeze Kojy fixes)", () => {
    const report = (extra: Record<string, unknown>) => ({ k: "crash" as const, fatal: true, type: "NeverConnected", line: "[kojy] Watchdog: the bot didn't get into its room within 300s of starting", frames: [], connected: false, uptime: 300, ...extra });
    expect(classifyExit({ tail: [], how: "code 4", ranForMs: 300_000, report: report({ connect_error: "couldn't reach Highrise: ClientConnectorError: Cannot connect" }) }))
      .toMatchObject({ category: "cannot_connect", state: "open", signature: "never-connected" });
    expect(classifyExit({ tail: [], how: "code 4", ranForMs: 300_000, report: report({ connect_error: "Highrise answered HTTP 401 (Unauthorized)" }) }))
      .toMatchObject({ category: "highrise_refused", state: "open" });
    const hang = classifyExit({ tail: [], how: "code 4", ranForMs: 300_000, report: report({
      line: "BotFrozenError: the bot didn't get into its room within 300s of starting", frames: [{ file: "bot.py", line: 9, func: "load_shop", code: "time.sleep(3600)" }],
    }) });
    expect(hang.category).toBe("frozen");
    expect(FIXABLE.has(hang.category)).toBe(true);
  });

  it("killed for memory (a host's note, or an unexpected SIGKILL here)", () => {
    expect(exit(["hello"], "code 137, out of memory (512 MB limit)").category).toBe("out_of_memory");
    expect(exit([], "SIGKILL").signature).toBe("exit:out_of_memory");
  });

  it("Highrise refusing the session in its own words: the token, the room or the bot's access are the owner's; busy is waited out", () => {
    // What Highrise really sends for a bad token (checked against the live API), as the SDK prints it.
    const token = exit(["ERROR: Error(message='API token not found', do_not_reconnect=False, rid=None)"], "code 0", 2000);
    expect(token).toMatchObject({ category: "highrise_refused", state: "needs_owner", summary: "Highrise refused the bot: API token not found" });
    expect(token.note).toMatch(/doesn't accept the bot's token \(Highrise said: “API token not found”\).*HIGHRISE_BOT_TOKEN/);
    const either = exit(["ERROR: Invalid room id or api token closing connection with ID: abc-123"], "code 0", 2000);
    expect(either).toMatchObject({ category: "highrise_refused", state: "needs_owner" });
    expect(either.note).toMatch(/HIGHRISE_BOT_TOKEN and HIGHRISE_ROOM_ID/);
    expect(exit(["ERROR: Error(message='Bot is banned from this room', do_not_reconnect=True, rid=None)"], "code 0").note).toMatch(/won't let the bot into that room/);
    expect(exit(["ERROR: Error(message='Rate limit exceeded, try again later', do_not_reconnect=False, rid=None)"], "code 0")).toMatchObject({ state: "open", note: expect.stringMatching(/asked the bot to wait/) });
    expect(exit(["ERROR: Error(message='Something new', do_not_reconnect=False, rid=None)"], "code 0")).toMatchObject({ state: "open", note: expect.stringMatching(/finding out why/) });
    // Reconnect noise from a bot that was in the room isn't a refusal.
    expect(exit(["[kojy] Connected to Highrise", "ERROR: reconnecting..."], "code 0").category).toBe("unknown");
  });

  it("an exit with nothing printed is unknown, one signature per exit code", () => {
    const c = exit(["just some output"], "code 1");
    expect(c).toMatchObject({ category: "unknown", signature: "exit:code N", state: "open" });
    expect(c.note).toMatch(/stopped without printing an error/);
  });
});
