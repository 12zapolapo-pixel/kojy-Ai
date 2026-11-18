/**
 * Discord bots: KojyAI works out what's wrong with a bot's Discord setup
 * from Discord itself and the code (agent/discord.ts), so Kojy fixes the
 * right thing and the owner gets the exact steps only they can do.
 * The main example is a real case: a slash-command bot that asked for the
 * message content and members intents, and wasn't in any server yet.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const root = mkdtempSync(path.join(tmpdir(), "kojy-discord-"));
process.env.PROJECTS_DIR = path.join(root, "projects");
process.env.VENVS_DIR = path.join(root, "venvs");
process.env.RUNNER_SANDBOX = "off";
process.env.ENCRYPTION_KEY ??= "c".repeat(64);

let discord: typeof import("../../../apps/runner/src/agent/discord.js");
beforeAll(async () => { discord = await import("../../../apps/runner/src/agent/discord.js"); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

const APP_ID = "1572597432980865044";
const GUILD = "1572597001105707069";

/** The bot as it was when it kept crashing. */
const SLASH_BOT = [
  {
    path: "main.py",
    text: [
      "import discord", "from discord.ext import commands", "",
      "class CriiBot(commands.Bot):",
      "    def __init__(self):",
      "        intents = discord.Intents.default()",
      "        intents.message_content = True",
      "        intents.guilds = True",
      "        intents.members = True",
      "        super().__init__(command_prefix='!', intents=intents)",
      "",
      "bot = CriiBot()",
      "",
      "@bot.tree.error",
      "async def on_app_command_error(interaction, error):",
      "    pass",
    ].join("\n"),
  },
  {
    path: "cogs/config.py",
    text: [
      "import discord", "from discord import app_commands", "from discord.ext import commands",
      "class Config(commands.Cog):",
      "    config_group = app_commands.Group(name='config', description='Manage server settings')",
      "    @config_group.command(name='set', description='Change a setting')",
      "    async def set(self, interaction, setting: str): ...",
    ].join("\n"),
  },
  {
    path: "cogs/utility.py",
    text: [
      "from discord import app_commands",
      "class Utility:",
      "    @app_commands.command(name='serverinfo')",
      "    async def serverinfo(self, interaction):",
      "        await interaction.response.send_message(f'{interaction.guild.member_count} members')",
      "    @app_commands.command(name='userinfo')",
      "    async def userinfo(self, interaction, member: discord.Member): ...",
    ].join("\n"),
  },
];

/** Discord's API, answering per path. */
function fakeDiscord(routes: Record<string, { status?: number; body: unknown }>) {
  return vi.fn(async (url: string | URL) => {
    const p = String(url).replace("https://discord.com/api/v10", "");
    const r = routes[p];
    return new Response(JSON.stringify(r?.body ?? { message: "404" }), { status: r ? r.status ?? 200 : 404 });
  });
}
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const ME = { status: 200, body: { id: APP_ID, username: "Crii", discriminator: "5771", bot: true } };
const MEMBERS_ON = (1 << 15); // GATEWAY_GUILD_MEMBERS_LIMITED: what the owner switched on
const MESSAGE_CONTENT_ON = (1 << 19);

describe("reading the code", () => {
  it("finds the privileged intents a bot asks for, with file and line", () => {
    const asked = discord.requestedIntents(SLASH_BOT);
    expect(asked.get("message_content")).toEqual(["main.py:7"]);
    expect(asked.get("members")).toEqual(["main.py:9"]);
    expect(asked.has("presences")).toBe(false);
    expect(discord.requestedIntents([{ path: "a.py", text: "intents = discord.Intents.all()" }]).size).toBe(3);
    expect(discord.requestedIntents([{ path: "a.py", text: "i = discord.Intents(guilds=True, members=True)" }]).get("members")).toEqual(["a.py:1"]);
    expect(discord.requestedIntents([{ path: "a.py", text: "# intents.members = True" }]).size).toBe(0);
  });

  it("knows slash commands (including app_commands groups) don't need message content or members", () => {
    expect(discord.usedIntents(SLASH_BOT).size).toBe(0);
  });

  it("sees when the code really uses them", () => {
    const used = discord.usedIntents([{
      path: "bot.py",
      text: [
        "bot = commands.Bot(command_prefix='!', intents=intents)",
        "@bot.command()", "async def hello(ctx): ...",
        "@bot.event", "async def on_member_join(member): ...",
        "async def on_presence_update(before, after): ...",
      ].join("\n"),
    }]);
    expect(used.get("message_content")).toEqual(["bot.py:2"]);
    expect(used.get("members")).toEqual(["bot.py:5"]);
    expect(used.get("presences")).toEqual(["bot.py:6"]);
    expect(discord.usedIntents([{ path: "x.py", text: "@commands.command()\nasync def ping(ctx): ..." }]).has("message_content")).toBe(true);
    expect(discord.usedIntents([{ path: "x.py", text: "@bot.tree.command(name='ping')\nasync def ping(i): ..." }]).size).toBe(0);
  });

  it("asks for the permissions the code needs in the invite link", () => {
    const base = BigInt(discord.neededPermissions(SLASH_BOT));
    expect(base & (1n << 11n)).toBe(1n << 11n); // Send Messages
    expect(base & (1n << 28n)).toBe(0n);
    const roles = BigInt(discord.neededPermissions([{ path: "a.py", text: "await member.add_roles(role)" }]));
    expect(roles & (1n << 28n)).toBe(1n << 28n); // Manage Roles
    expect(discord.inviteUrl(APP_ID, "8", GUILD)).toBe(`https://discord.com/oauth2/authorize?client_id=${APP_ID}&scope=bot+applications.commands&permissions=8&guild_id=${GUILD}`);
  });
});

describe("diagnoseDiscord", () => {
  it("the real case: removes the unused intent in code, and gives the owner the invite link", async () => {
    globalThis.fetch = fakeDiscord({
      "/users/@me": ME,
      "/applications/@me": { body: { id: APP_ID, flags: MEMBERS_ON } },
      "/users/@me/guilds": { body: [] },
    }) as never;
    const d = await discord.diagnoseDiscord({ token: "SECRET-token-value-9f3a", guildId: GUILD, files: SLASH_BOT });
    expect(d.ok).toBe(false);
    expect(d.botName).toBe("Crii#5771");
    // Message content: asked for, not switched on, not used -> Kojy removes it.
    expect(d.codeFixes).toEqual([expect.stringContaining("Remove the message_content intent from the code (main.py:7)")]);
    expect(d.report).toMatch(/Message Content Intent: .*switched on in the portal: NO · used by the code: no → PROBLEM .*FIX IT YOURSELF/);
    // Members: switched on by the owner, so it's fine (even though unused).
    expect(d.report).toMatch(/Server Members Intent: .*switched on in the portal: yes .*→ fine/);
    // Not in any server: the owner gets the invite link, pre-set to GUILD_ID.
    expect(d.report).toContain("isn't in ANY server yet");
    expect(d.ownerSteps).toHaveLength(1);
    expect(d.ownerSteps[0]).toContain(`https://discord.com/oauth2/authorize?client_id=${APP_ID}&scope=bot+applications.commands`);
    expect(d.ownerSteps[0]).toContain(`guild_id=${GUILD}`);
    expect(d.report).toMatch(/What to do:\n1\. YOU \(Kojy\): Remove .*\n2\. OWNER: Add the bot to your server/);
    expect(d.report + d.ownerSteps.join(" ")).not.toContain("SECRET-token-value-9f3a");
  });

  it("an intent the code really uses: the owner must switch it on (exact switch and link), never removed", async () => {
    globalThis.fetch = fakeDiscord({
      "/users/@me": ME,
      "/applications/@me": { body: { id: APP_ID, flags: 0 } },
      "/users/@me/guilds": { body: [{ id: GUILD, name: "Cool\nServer" }] },
    }) as never;
    const files = [{ path: "bot.py", text: "intents.members = True\n@bot.event\nasync def on_member_join(m): ...\ndef on_member_join(m): ..." }];
    const d = await discord.diagnoseDiscord({ token: "tok", guildId: GUILD, files });
    expect(d.codeFixes).toEqual([]);
    expect(d.ownerSteps).toEqual([expect.stringContaining(`Switch on "Server Members Intent" for your bot: https://discord.com/developers/applications/${APP_ID}/bot`)]);
    expect(d.report).toContain('Servers (1): "Cool Server"'); // a name from Discord: one line, quoted
  });

  it("everything in place", async () => {
    globalThis.fetch = fakeDiscord({
      "/users/@me": ME,
      "/applications/@me": { body: { id: APP_ID, flags: MESSAGE_CONTENT_ON | MEMBERS_ON } },
      "/users/@me/guilds": { body: [{ id: GUILD, name: "Home" }] },
    }) as never;
    const d = await discord.diagnoseDiscord({ token: "tok", guildId: GUILD, files: SLASH_BOT });
    expect(d.ok).toBe(true);
    expect(d.report).toContain("Everything Discord needs is in place.");
  });

  it("in some servers but not GUILD_ID; and a GUILD_ID that isn't an id", async () => {
    globalThis.fetch = fakeDiscord({
      "/users/@me": ME,
      "/applications/@me": { body: { id: APP_ID, flags: MESSAGE_CONTENT_ON | MEMBERS_ON } },
      "/users/@me/guilds": { body: [{ id: "111111111111111111", name: "Other" }] },
    }) as never;
    const d = await discord.diagnoseDiscord({ token: "tok", guildId: GUILD, files: SLASH_BOT });
    expect(d.report).toContain(`GUILD_ID ${GUILD}: the bot is NOT in that server`);
    expect(d.ownerSteps[0]).toMatch(/Add the bot to the server in GUILD_ID/);
    const bad = await discord.diagnoseDiscord({ token: "tok", guildId: "my server", files: SLASH_BOT });
    expect(bad.ownerSteps.join(" ")).toMatch(/isn't a server ID/);
  });

  it("a wrong or reset token, a user token, and Discord being unreachable", async () => {
    globalThis.fetch = fakeDiscord({ "/users/@me": { status: 401, body: { message: "401: Unauthorized" } } }) as never;
    const d = await discord.diagnoseDiscord({ token: "tok", files: SLASH_BOT });
    expect(d.ownerSteps[0]).toMatch(/wrong or was reset.*Reset Token/);
    globalThis.fetch = fakeDiscord({ "/users/@me": { body: { username: "me", bot: false } } }) as never;
    expect((await discord.diagnoseDiscord({ token: "tok", files: [] })).ownerSteps[0]).toMatch(/user account's token/);
    globalThis.fetch = vi.fn(async () => { throw new Error("getaddrinfo ENOTFOUND"); }) as never;
    const off = await discord.diagnoseDiscord({ token: "tok", files: [] });
    expect(off.ok).toBe(false);
    expect(off.ownerSteps).toEqual([]);
    expect(off.report).toMatch(/Couldn't reach Discord/);
  });
});

describe("noticing Discord problems in the console", () => {
  it("knows the crash lines and the 'connected' line discord.py prints", () => {
    expect(discord.isDiscordSetupError("discord.errors.PrivilegedIntentsRequired: Shard ID None is requesting privileged intents")).toBe(true);
    expect(discord.isDiscordSetupError("discord.errors.LoginFailure: Improper token has been passed.")).toBe(true);
    expect(discord.isDiscordSetupError("KeyError: 'amy'")).toBe(false);
    expect(discord.DISCORD_CONNECTED.test("\u001b[30;1m2026-11-18 13:58:36\u001b[0m \u001b[34;1mINFO    \u001b[0m \u001b[35mdiscord.gateway\u001b[0m Shard ID None has connected to Gateway (Session ID: 484d).")).toBe(true);
    expect(discord.DISCORD_CONNECTED.test("[kojy] Connected to Highrise (connection 5d6b)")).toBe(false);
  });

  it("the supervisor reports a Discord connection once per start", async () => {
    const { Supervisor } = await import("../../../apps/runner/src/supervisor.js");
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }), update: () => ({ set: () => ({ where: async () => undefined }) }), insert: () => ({ values: async () => undefined }) };
    const sup = new Supervisor(db as never);
    const seen: string[] = [];
    sup.onDiscordConnected = (uuid) => seen.push(uuid);
    const U = "33333333-4444-4555-8666-777777777777";
    const line = "2026-11-18 13:58:36 INFO     discord.gateway Shard ID None has connected to Gateway (Session ID: x).";
    sup.console(U, "stderr", line);
    sup.console(U, "stderr", line); // a reconnect: not again
    expect(seen).toEqual([U]);
    sup.console(U, "system", "▶ Starting run: python main.py");
    sup.console(U, "stderr", line);
    expect(seen).toEqual([U, U]);
  });
});
