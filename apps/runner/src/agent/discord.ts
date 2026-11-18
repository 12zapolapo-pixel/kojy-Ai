/**
 * Discord bots: the setup problems a new one runs into, found out from
 * Discord itself and from the bot's code, each with the exact fix.
 *
 *  - Privileged intents the code asks for that aren't switched on in the
 *    Developer Portal: Discord refuses the connection
 *    (discord.errors.PrivilegedIntentsRequired). An intent the code doesn't
 *    use can simply be removed from the code; one it uses must be switched
 *    on by the owner. Adding intents never fixes this error.
 *  - The bot isn't in any server yet, or not in GUILD_ID: slash commands
 *    can't sync (403 Missing Access) and nobody can use the bot.
 *  - A wrong or reset token (LoginFailure, 401).
 *
 * Only the runner reads the token; what comes back to Kojy and the owner is
 * the bot's name, its application id, server names and the fixes.
 * OWNERSHIP: apps/runner/src/agent
 */

export type Intent = "message_content" | "members" | "presences";
export const INTENTS: Intent[] = ["message_content", "members", "presences"];

/** The switch's name in the Developer Portal (Bot → Privileged Gateway Intents). */
export const INTENT_LABEL: Record<Intent, string> = {
  message_content: "Message Content Intent",
  members: "Server Members Intent",
  presences: "Presence Intent",
};

/** What each intent is for, in plain words. */
const INTENT_FOR: Record<Intent, string> = {
  message_content: "reading what people write (\"!\" text commands, on_message)",
  members: "member join/leave events and the full member list",
  presences: "people's online status and activities",
};

/**
 * Application flags (GET /applications/@me) meaning an intent is switched on.
 * The *_LIMITED flag is what unverified bots (under 100 servers) get.
 */
const INTENT_FLAGS: Record<Intent, number> = {
  presences: (1 << 12) | (1 << 13),
  members: (1 << 14) | (1 << 15),
  message_content: (1 << 18) | (1 << 19),
};

export interface CodeFile { path: string; text: string }

/** Lines of code without comments, numbered from 1. */
function codeLines(f: CodeFile): { where: string; code: string }[] {
  return f.text.split("\n").map((line, i) => ({ where: `${f.path}:${i + 1}`, code: line.replace(/(^|\s)#.*$/, "") }));
}

function addTo(map: Map<Intent, string[]>, intent: Intent, where: string): void {
  const list = map.get(intent) ?? [];
  if (!list.includes(where)) list.push(where);
  map.set(intent, list);
}

/** Where the code asks Discord for each privileged intent ("main.py:12"). */
export function requestedIntents(files: CodeFile[]): Map<Intent, string[]> {
  const out = new Map<Intent, string[]>();
  for (const f of files) {
    for (const { where, code } of codeLines(f)) {
      if (/\bIntents\.all\s*\(\s*\)/.test(code)) for (const i of INTENTS) addTo(out, i, where);
      for (const i of INTENTS) {
        // intents.members = True · Intents(members=True) · intents.update(members=True)
        if (new RegExp(`(?:\\.${i}\\s*=\\s*True\\b|[(,]\\s*${i}\\s*=\\s*True\\b)`).test(code)) addTo(out, i, where);
      }
    }
  }
  return out;
}

/**
 * Where the code relies on each privileged intent. A heuristic over the
 * code: it errs towards "used" for members and presences (keeping an intent
 * that isn't needed is harmless once it's switched on), and recognises slash
 * commands (app_commands, tree.command, app_commands.Group) as NOT needing
 * message content.
 */
export function usedIntents(files: CodeFile[]): Map<Intent, string[]> {
  const out = new Map<Intent, string[]>();
  const all = files.map((f) => f.text).join("\n");
  // Names of the commands.Bot instances: `bot = commands.Bot(...)`, or an instance of a subclass.
  const botClasses = [...all.matchAll(/class\s+(\w+)\s*\(\s*(?:commands\.)?(?:AutoSharded)?Bot\s*\)/g)].map((m) => m[1]!);
  const botCtor = new RegExp(`=\\s*(?:commands\\.(?:AutoSharded)?Bot${botClasses.map((c) => `|${c}`).join("")})\\s*\\(`);
  const botVars = new Set<string>();
  for (const line of all.split("\n")) {
    const m = new RegExp(`^\\s*(\\w+)\\s*${botCtor.source}`).exec(line);
    if (m) botVars.add(m[1]!);
  }
  const prefixDecorator = botVars.size
    ? new RegExp(`^\\s*@(?:commands\\.(?:command|group)|(?:${[...botVars].join("|")})\\.(?:command|group))\\s*\\(`)
    : /^\s*@commands\.(?:command|group)\s*\(/;

  for (const f of files) {
    for (const { where, code } of codeLines(f)) {
      if (prefixDecorator.test(code) || /\bdef\s+on_message\s*\(|\bwait_for\s*\(\s*['"]message['"]/.test(code)) addTo(out, "message_content", where);
      // `.members` but not `intents.members = True` (asking for it isn't using it).
      if (/\bdef\s+on_(?:raw_)?member_(?:join|remove|update)\s*\(|\.members\b(?!\s*=(?!=))|\bfetch_members\s*\(|\.chunk\s*\(|\bget_member\s*\(|\brequest_members\s*\(/.test(code)) addTo(out, "members", where);
      if (/\bdef\s+on_presence_update\s*\(|\.activities\b|\.raw_status\b|\.(?:desktop|mobile|web)_status\b|\b(?:member|m|user|u|target)\.(?:status|activity)\b/.test(code)) addTo(out, "presences", where);
    }
  }
  return out;
}

// ── invite link ──────────────────────────────────────────────────────────────

const P = (bit: number) => 1n << BigInt(bit);
/** See channels, send messages and embeds, attach files, read history, add reactions. */
const BASE_PERMISSIONS = P(6) | P(10) | P(11) | P(14) | P(15) | P(16);
const EXTRA_PERMISSIONS: { re: RegExp; bits: bigint }[] = [
  { re: /\b(?:add_roles|remove_roles)\s*\(/, bits: P(28) },               // Manage Roles
  { re: /\.kick\s*\(/, bits: P(1) },                                         // Kick Members
  { re: /\.(?:ban|unban)\s*\(/, bits: P(2) },                                // Ban Members
  { re: /\.purge\s*\(|\bdelete_messages\s*\(|\bmessage\.delete\s*\(/, bits: P(13) }, // Manage Messages
  { re: /\.timeout\s*\(|\btimed_out_until\b/, bits: P(40) },                 // Moderate Members
  { re: /\bcreate_(?:text|voice)_channel\s*\(|\bcreate_category\s*\(|\bset_permissions\s*\(/, bits: P(4) }, // Manage Channels
  { re: /\.edit\s*\([^)]*\bnick\s*=/, bits: P(27) },                         // Manage Nicknames
  { re: /\bcreate_thread\s*\(/, bits: P(35) | P(38) },                       // Create Public Threads, Send in Threads
];

/** The permissions the bot's code needs, as Discord's permission integer. */
export function neededPermissions(files: CodeFile[]): string {
  const all = files.map((f) => f.text).join("\n");
  let bits = BASE_PERMISSIONS;
  for (const e of EXTRA_PERMISSIONS) if (e.re.test(all)) bits |= e.bits;
  return bits.toString();
}

export function inviteUrl(appId: string, permissions: string, guildId?: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot+applications.commands&permissions=${permissions}` +
    (guildId && /^\d{17,20}$/.test(guildId) ? `&guild_id=${guildId}` : "");
}

// ── asking Discord ───────────────────────────────────────────────────────────

type Answer = { status: number; body: unknown } | { error: string };

async function discordGet(path: string, token: string): Promise<Answer> {
  try {
    const res = await fetch(`https://discord.com/api/v10${path}`, {
      headers: { authorization: `Bot ${token.replace(/^Bot\s+/i, "")}` },
      signal: AbortSignal.timeout(10_000),
    });
    let body: unknown = null;
    try { body = await res.json(); } catch { /* no body */ }
    return { status: res.status, body };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** A name set by people (a server's name): quoted, one line, short. */
const q = (s: string | undefined) => JSON.stringify((s ?? "?").replace(/\s+/g, " ").slice(0, 60));

export interface DiscordDiagnosis {
  /** Nothing to fix. */
  ok: boolean;
  /** The full report, for Kojy. */
  report: string;
  /** Short plain steps for the owner (notifications); empty when Kojy can fix everything itself. */
  ownerSteps: string[];
  /** Things Kojy can fix in the code itself. */
  codeFixes: string[];
  inviteUrl?: string;
  botName?: string;
  /** Servers the bot is in (undefined when Discord couldn't be asked). */
  servers?: { id: string; name: string }[];
}

/** Checks a Discord bot end to end: token, intents (code vs portal), servers. */
export async function diagnoseDiscord(p: { token: string; guildId?: string | undefined; files: CodeFile[] }): Promise<DiscordDiagnosis> {
  const lines: string[] = [];
  const ownerSteps: string[] = [];
  const codeFixes: string[] = [];

  const me = await discordGet("/users/@me", p.token);
  if ("error" in me) {
    return { ok: false, ownerSteps, codeFixes, report: `Couldn't reach Discord (${me.error}). Try again in a minute.` };
  }
  if (me.status === 401) {
    const step = "Your Discord bot token is wrong or was reset. In the Discord Developer Portal open your app → Bot → Reset Token, copy the new token and save it in the bot's Secrets as DISCORD_TOKEN. Then restart the bot.";
    return { ok: false, ownerSteps: [step], codeFixes, report: `Token: rejected by Discord (401).\nOWNER must fix: ${step}` };
  }
  if (me.status !== 200) {
    return { ok: false, ownerSteps, codeFixes, report: `Unexpected answer from Discord (HTTP ${me.status}). Try again in a minute.` };
  }
  const user = (me.body ?? {}) as { id?: string; username?: string; discriminator?: string; bot?: boolean };
  if (user.bot === false) {
    const step = "DISCORD_TOKEN is a user account's token, not a bot's. Use the token from the Discord Developer Portal → your app → Bot → Reset Token, and save it in Secrets.";
    return { ok: false, ownerSteps: [step], codeFixes, report: `Token: a user account token, not a bot token.\nOWNER must fix: ${step}` };
  }
  const botName = `${user.username ?? "?"}${user.discriminator && user.discriminator !== "0" ? `#${user.discriminator}` : ""}`;

  const app = await discordGet("/applications/@me", p.token);
  const appBody = ("status" in app && app.status === 200 ? app.body : null) as { id?: string; flags?: number } | null;
  const appId = String(appBody?.id ?? user.id ?? "");
  const flags = typeof appBody?.flags === "number" ? appBody.flags : undefined;
  lines.push(`Bot: ${q(botName)} (application id ${appId || "?"}) — the token works.`);

  // Intents: asked for in the code, switched on in the portal, used by the code.
  const requested = requestedIntents(p.files);
  const used = usedIntents(p.files);
  const portal = appId ? `https://discord.com/developers/applications/${appId}/bot` : "the Discord Developer Portal → your app → Bot";
  const intentLines: string[] = [];
  for (const i of INTENTS) {
    const asked = requested.get(i);
    const uses = used.get(i);
    const on = flags === undefined ? undefined : (flags & INTENT_FLAGS[i]) !== 0;
    if (!asked && !uses) continue;
    const state = `asked for in the code: ${asked ? asked.join(", ") : "no"} · switched on in the portal: ${on === undefined ? "unknown" : on ? "yes" : "NO"} · used by the code: ${uses ? `yes (${uses.slice(0, 3).join(", ")})` : "no"}`;
    let verdict = "fine";
    if (asked && on === false && !uses) {
      verdict = `PROBLEM — Discord refuses the connection (PrivilegedIntentsRequired). FIX IT YOURSELF: remove the line(s) asking for it (${asked.join(", ")}); the bot doesn't use ${INTENT_FOR[i]}. Don't switch anything else on.`;
      codeFixes.push(`Remove the ${i} intent from the code (${asked.join(", ")}): the bot doesn't use it and it isn't switched on in the Developer Portal.`);
    } else if (asked && on === false && uses) {
      verdict = `PROBLEM — Discord refuses the connection (PrivilegedIntentsRequired), and the code really uses it. OWNER must switch on "${INTENT_LABEL[i]}": ${portal} → Privileged Gateway Intents → ${INTENT_LABEL[i]} → Save Changes. Then restart the bot.`;
      ownerSteps.push(`Switch on "${INTENT_LABEL[i]}" for your bot: ${portal} → Privileged Gateway Intents → turn on ${INTENT_LABEL[i]} → Save Changes. Then tell Kojy (or press Restart).`);
    } else if (!asked && uses) {
      verdict = `NOTE — the code uses ${INTENT_FOR[i]} but doesn't ask for this intent, so that part silently won't work. To make it work: add it to the intents in the code AND have the owner switch on "${INTENT_LABEL[i]}" in the portal (${portal}) — both, or the bot can't connect.`;
    } else if (asked && on === undefined) {
      verdict = "couldn't read the portal setting; if the bot crashes with PrivilegedIntentsRequired, this is the cause";
    }
    intentLines.push(`  · ${INTENT_LABEL[i]}: ${state} → ${verdict}`);
  }
  lines.push(intentLines.length ? `Privileged intents:\n${intentLines.join("\n")}` : "Privileged intents: none asked for or used (fine — slash commands don't need them).");

  // Servers.
  const guildsAnswer = await discordGet("/users/@me/guilds", p.token);
  const servers = "status" in guildsAnswer && guildsAnswer.status === 200 && Array.isArray(guildsAnswer.body)
    ? (guildsAnswer.body as { id?: unknown; name?: unknown }[]).map((g) => ({ id: typeof g.id === "string" ? g.id : "", name: typeof g.name === "string" ? g.name : "?" }))
    : undefined;
  const guildId = p.guildId?.trim();
  const invite = appId ? inviteUrl(appId, neededPermissions(p.files), guildId) : undefined;
  if (guildId && !/^\d{17,20}$/.test(guildId)) {
    lines.push(`GUILD_ID: ${q(guildId)} isn't a server ID (17–20 digits).`);
    ownerSteps.push("GUILD_ID in Secrets isn't a server ID. In Discord: Settings → Advanced → Developer Mode on, then right-click your server → Copy Server ID, and save that as GUILD_ID.");
  }
  if (!servers) {
    lines.push("Servers: couldn't ask Discord which servers the bot is in.");
  } else if (!servers.length) {
    lines.push("Servers: the bot isn't in ANY server yet — nobody can use it, and slash commands can't sync (\"403 Missing Access\" / \"Missing permissions (application.commands scope)\").");
    if (invite) ownerSteps.push(`Add the bot to your server: open ${invite} , pick the server and press Authorize. Then tell Kojy (or press Restart) so the slash commands sync.`);
  } else {
    lines.push(`Servers (${servers.length}): ${servers.slice(0, 10).map((g) => `${q(g.name)} (${g.id})`).join(", ")}${servers.length > 10 ? ", …" : ""}`);
    if (guildId && /^\d{17,20}$/.test(guildId) && !servers.some((g) => g.id === guildId)) {
      lines.push(`GUILD_ID ${guildId}: the bot is NOT in that server, so slash commands can't sync there.`);
      if (invite) ownerSteps.push(`Add the bot to the server in GUILD_ID: open ${invite} and press Authorize (or, if GUILD_ID is the wrong server, change it in Secrets). Then tell Kojy (or press Restart).`);
    }
  }
  if (invite) lines.push(`Invite link (bot + slash commands, with the permissions this code needs): ${invite}`);

  const ok = !ownerSteps.length && !codeFixes.length;
  const todo: string[] = [];
  if (codeFixes.length) todo.push(...codeFixes.map((c) => `YOU (Kojy): ${c} Then restart the bot with bot_control and confirm with get_logs.`));
  if (ownerSteps.length) todo.push(...ownerSteps.map((s) => `OWNER: ${s}`));
  lines.push(ok
    ? "Everything Discord needs is in place."
    : `What to do:\n${todo.map((t, n) => `${n + 1}. ${t}`).join("\n")}\nGive the owner the OWNER steps word for word (with the links). When they say they've done it, restart the bot with bot_control — slash commands only sync when it starts — and check get_logs and discord_check again.`);
  return { ok, report: lines.join("\n"), ownerSteps, codeFixes, ...(invite ? { inviteUrl: invite } : {}), botName, ...(servers ? { servers } : {}) };
}

/** A crash that diagnoseDiscord can explain. */
export function isDiscordSetupError(exceptionLine: string): boolean {
  return /PrivilegedIntentsRequired|LoginFailure|Improper token|discord\.errors\.Forbidden.*(?:50001|Missing Access)/.test(exceptionLine);
}

/** discord.py logged that the bot connected (each start, and after reconnects). */
export const DISCORD_CONNECTED = /\bdiscord\.gateway\b.*\bhas connected to Gateway\b|\bShard ID \S+ has connected to Gateway\b/;
