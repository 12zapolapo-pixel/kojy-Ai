/**
 * The coder AI's tools. Each returns plain text for the model plus a one-line
 * summary for the chat. File paths go through the same project-folder guard
 * as the website's editor (@kojyai/shared/projects).
 * OWNERSHIP: apps/runner/src/agent
 */

import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync, mkdtempSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import WebSocket from "ws";
import type { Database } from "@kojyai/db";
import { botProjects, projectSecrets, agentMemories, roomTests } from "@kojyai/db/schema";
import { decryptApiKey } from "@kojyai/shared/crypto";
import {
  listFiles, resolveInside, cleanRelPath, projectDir, snapshotProject, readLogs, ProjectFileError, MAX_EDIT_BYTES, EMOTE_CATALOG,
  pickMemories, normalizeNote, lineDiff,
} from "@kojyai/shared/projects";
import type { Supervisor } from "../supervisor.js";
import { BOTCHECK, LAUNCHER } from "../supervisor.js";
import { runRoomTest, normalizeEvents, chatToEvents, ROOM_EVENT_TYPES, type RoomEvent } from "./mockRoom.js";
import { grantDir, sandboxUid, spawnAs } from "../sandbox.js";
import type { ToolSpec } from "./groq.js";
import { connectionReport, duration, formatConsole, stamp } from "./botHealth.js";
import { queryData, roomActivity } from "./dataTools.js";
import type { GitService } from "../git.js";
import { VENVS_DIR } from "../supervisor.js";
import { entrypointProblem, isStartCommand } from "@kojyai/shared/projects";

export type Project = typeof botProjects.$inferSelect;

export interface ToolContext {
  db: Database;
  supervisor: Supervisor;
  project: Project;
  /** Set once the AI has snapshotted the code in this run (for "undo"). */
  snapshotted: boolean;
  changedFiles: Set<string>;
  /** What this run is for, as the undo label ("Before Kojy: add a !dance command"). */
  label?: string;
  /** The Git panel's operations (run as the bot's sandbox user). */
  git?: GitService | undefined;
}

export interface ToolResult {
  /** What the model sees. */
  output: string;
  /** One line for the chat, e.g. "Read highrise_bot/bot.py (lines 1-120)". */
  summary: string;
  ok: boolean;
  /** Extra data for the chat card (secret requests, panel/bot buttons). */
  card?: Record<string, unknown>;
  /** Message kind for the card; default "secret_request" when card is set. */
  cardKind?: string;
  /** Stop the run after this tool (waiting on the owner). */
  pause?: boolean;
  /** For file changes: the diff shown in the chat (never sent to the model). */
  diff?: string;
}

const fn = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): ToolSpec => ({
  type: "function", function: { name, description, parameters: { type: "object", properties, required } },
});
const str = (description: string) => ({ type: "string", description });

export const TOOL_SPECS: ToolSpec[] = [
  fn("list_files", "List the project's files (path and size). Optionally only under a folder.", { folder: str("e.g. highrise_bot") }),
  fn("read_file", "Read a text file with line numbers. Read big files in parts (max 200 lines per call).",
    { path: str("file path"), start_line: { type: "integer" }, end_line: { type: "integer" } }, ["path"]),
  fn("search_code", "Search all text files for a regular expression; returns file:line matches.", { pattern: str("regex, e.g. def on_chat|os.environ") , folder: str("optional folder") }, ["pattern"]),
  fn("edit_file", "Replace an exact piece of text in a file (must match exactly once, including indentation). Best way to change code.",
    { path: str("file path"), old_text: str("exact current text"), new_text: str("replacement") }, ["path", "old_text", "new_text"]),
  fn("write_file", "Create a file or replace a whole file. Use edit_file for small changes to existing files.",
    { path: str("file path"), content: str("full file content") }, ["path", "content"]),
  fn("delete_file", "Delete a file.", { path: str("file path") }, ["path"]),
  fn("check_code", "Compile every .py file and import the bot's entrypoint in the bot's Python environment (installs requirements.txt changes first). Shows errors with tracebacks."),
  fn("test_in_room", "Run a copy of the bot for a few seconds in a fake Highrise room (real room and data are untouched) and return what the bot did and any errors. Use `chat` for simple tests (user 'tester' says the lines); use `events` to test whispers, tips, emotes, joins, leaves or several users. Set moderator=false to check how the bot behaves without moderator rights.",
    {
      chat: { type: "array", items: { type: "string" }, description: "lines 'tester' says, e.g. [\"!help\", \"hi bot\"]" },
      join: { type: "boolean", description: "with chat: 'tester' joins first" },
      events: {
        type: "array", description: "what happens, in order (up to 12), e.g. [{type:'join',user:'amy'},{type:'tip',user:'amy',amount:50},{type:'whisper',user:'bob',message:'!balance'}]",
        items: { type: "object", properties: {
          type: { type: "string", enum: [...ROOM_EVENT_TYPES] }, user: str("username, default tester"), message: str("chat/whisper text"),
          amount: { type: "integer", description: "tip gold" }, emote: str("emote id"), seconds: { type: "number", description: "wait length" },
        }, required: ["type"] },
      },
      moderator: { type: "boolean", description: "is the bot a moderator in the test room (default true)" },
      expect: { type: "array", items: { type: "string" }, description: "texts the bot's replies/actions must contain, e.g. [\"Welcome\", \"emote-wave\"]; the test fails if one is missing" },
      seconds: { type: "integer" },
    }),
  fn("save_test", "Keep a test that passed so it can be run again after later changes (regression test). Same events/chat/moderator as test_in_room, plus expect (texts the bot must say or do) and a short name. Saving under an existing name replaces it.",
    {
      name: str("short name, e.g. 'greets new people'"),
      chat: { type: "array", items: { type: "string" } }, join: { type: "boolean" },
      events: { type: "array", items: { type: "object" }, description: "as in test_in_room" },
      expect: { type: "array", items: { type: "string" }, description: "texts the bot's actions must contain" },
      moderator: { type: "boolean" },
    }, ["name", "expect"]),
  fn("run_saved_tests", "Run every saved test of this bot in the fake room and report which pass. Do this after changing code, so a feature that worked before still works."),
  fn("find_env_vars", "Find the environment variables (secrets/settings) the code reads, and which are already set."),
  fn("request_secrets", "Show the owner a form in the chat to add missing secrets. Ask for all missing ones at once, then stop and wait.",
    { secrets: { type: "array", items: { type: "object", properties: { name: str("ENV_NAME"), description: str("what it is and where to get it") }, required: ["name", "description"] } } }, ["secrets"]),
  fn("test_secrets", "Check that secrets work: Highrise room+token (connects to Highrise), DISCORD_TOKEN (asks Discord), GUILD_ID (is the bot in that server), TELEGRAM_BOT_TOKEN, GROQ_API_KEY, OPENAI_API_KEY; others are only checked for being set — that's normal, continue the task after testing.", { names: { type: "array", items: { type: "string" } } }),
  fn("set_entrypoint", "Set what starts the bot. A Highrise bot: module.path:ClassName (a class based on BaseBot). Any other long-running program (a Discord or Telegram bot, a web server, a scheduler): run: <command>, e.g. run: python main.py. Both get Run/Stop, the console, crash restarts and the secrets as environment variables.", { entrypoint: str("e.g. bot:MyBot or run: python main.py") }, ["entrypoint"]),
  fn("run_command", "Run a shell command (bash) in the bot's folder, as the bot's own sandboxed user, with its Python environment and secrets, and return the output. For things the other tools can't do: pip install/list, python -c checks, running a script once, unzipping, moving many files, inspecting the environment. It stops after timeout_seconds (default 60, at most 180). Not for starting the bot or anything that keeps running: use bot_control. Don't print secret values.",
    { command: str("e.g. pip list | grep highrise"), timeout_seconds: { type: "integer" } }, ["command"]),
  fn("git", "The bot's GitHub repository (only once the owner linked one in the Git panel): status (branch, changed files, recent commits), commit (all changes, needs message), push, commit_and_push, pull (GitHub's latest; a snapshot is kept to undo). Push only when the owner asked for it or agreed.",
    { action: { type: "string", enum: ["status", "commit", "push", "commit_and_push", "pull"] }, message: str("commit message, for commit/commit_and_push") }, ["action"]),
  fn("bot_control", "Start, stop or restart the real bot (restart makes code changes live).", { action: { type: "string", enum: ["start", "stop", "restart"] } }, ["action"]),
  fn("get_logs", "Whether the real bot is in the room right now, what happened to its connection in the last day (KojyAI restarts, Highrise reconnects, the bot exiting), and its newest console lines (errors, tracebacks). Call it first when the owner says the bot disconnected, left or isn't answering.", { lines: { type: "integer", description: "console lines to show, newest last (default 40)" } }),
  fn("propose_plan", "Before a bigger change (a new feature, several files, a rewrite), show the owner a short plan with Approve/Change buttons, then stop and wait. Not for small fixes or questions.",
    { title: str("what you'll build, a few words"), steps: { type: "array", items: { type: "string" }, description: "3-7 short steps in plain words" } }, ["title", "steps"]),
  fn("find_emotes", "Search the list of emote ids that work in Highrise (checked in a real room) by name or id, e.g. 'dance', 'wave'. Use these ids in code; never guess emote ids.",
    { query: str("word to search, or empty for a sample") }),
  fn("open_panel", "Show the owner a panel next to the chat: console (logs), code, shell (a terminal), git (GitHub), data (the bot's database), secrets or settings.",
    { panel: { type: "string", enum: ["console", "code", "shell", "git", "data", "secrets", "settings"] } }, ["panel"]),
  fn("query_data", "Read the bot's own saved data (its SQLite database, read-only). Without sql: lists the databases, tables, columns and row counts (and any JSON data files). With sql: runs ONE SELECT and returns up to 50 rows. Use it to answer questions about players, coins, scores, warnings, or to check a data bug.",
    { sql: str("one SELECT, e.g. SELECT name, coins FROM players ORDER BY coins DESC LIMIT 10"), db: str("database path if the bot has several, e.g. data/bot.db") }),
  fn("room_activity", "This bot's room activity: chats, whispers, replies, joins, different visitors, tips (and gold), emotes, crashes, most used commands, top tippers.",
    { days: { type: "integer", description: "1-90, default 7" } }),
  fn("remember", "Save one short lesson for the future (a fix that worked, how this bot is built). scope 'all' = useful for every bot.",
    { note: str("one sentence"), scope: { type: "string", enum: ["project", "all"] } }, ["note"]),
];

const TEXT_EXT = /\.(py|txt|md|json|ya?ml|toml|ini|cfg|env|example|js|ts|html|css|sh)$|(^|\/)(Dockerfile|Procfile|requirements[^/]*)$/i;
/**
 * botcheck.py's "HIDDEN name|placeholder class|real class" lines, explained:
 * an empty \`...\` method earlier in the class bases replaces the real one.
 */
export function hiddenMethods(out: string): string[] {
  return out.split("\n").filter((l) => l.startsWith("HIDDEN ")).map((l) => {
    const [name, placeholder, real] = l.slice(7).trim().split("|");
    return `- ${name}: the empty placeholder in ${placeholder} is used instead of the real ${name} in ${real}. ` +
      `Remove the placeholder, or list ${placeholder} after ${real} in the bot class's bases.`;
  });
}

const clip = (s: string, max = 6000) => (s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters)` : s);

function runCapture(uid: number, cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let started: ReturnType<typeof spawnAs>;
    try { started = spawnAs(uid, cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { resolve({ code: -1, out: (e as Error).message }); return; }
    const { child, kill } = started;
    let out = "";
    const add = (d: Buffer) => { if (out.length < 20_000) out += d.toString("utf8"); };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    const timer = setTimeout(() => kill("SIGKILL"), timeoutMs);
    child.once("error", (e) => { clearTimeout(timer); resolve({ code: -1, out: e.message }); });
    child.once("exit", (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

/**
 * SECURITY FIX (V-04): search_code compiles a regex the AI chose (and the AI
 * can be steered by file contents) and ran it over up to 5,000 files on the
 * runner's main thread — a backtracking pattern froze every bot's
 * supervisor. It now runs in a worker thread that is killed after a few
 * seconds; the main thread stays free.
 */
const SEARCH_TIMEOUT_MS = 4000;
const MAX_SEARCH_PATTERN = 300;
const SEARCH_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { readFileSync } = require("node:fs");
const re = new RegExp(workerData.pattern, "i");
const hits = [];
for (const f of workerData.files) {
  let text;
  try { text = readFileSync(f.abs, "utf8"); } catch { continue; }
  const lines = text.split("\\n");
  for (let i = 0; i < lines.length && hits.length < 50; i++) {
    if (re.test(lines[i])) hits.push(f.rel + ":" + (i + 1) + ": " + lines[i].trim().slice(0, 160));
  }
  if (hits.length >= 50) break;
}
parentPort.postMessage(hits);`;

export function searchInWorker(pattern: string, files: { rel: string; abs: string }[]): Promise<string[] | "timeout"> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(SEARCH_WORKER, { eval: true, workerData: { pattern, files }, resourceLimits: { maxOldGenerationSizeMb: 128 } });
    const timer = setTimeout(() => { void worker.terminate(); resolve("timeout"); }, SEARCH_TIMEOUT_MS);
    worker.once("message", (hits: string[]) => { clearTimeout(timer); void worker.terminate(); resolve(hits); });
    worker.once("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

function ensureSnapshot(ctx: ToolContext): void {
  if (ctx.snapshotted) return;
  const label = ctx.label?.replace(/\s+/g, " ").trim();
  snapshotProject(ctx.project.uuid, label ? `Before Kojy: ${label.length > 100 ? `${label.slice(0, 100)}…` : label}` : "Before the coder AI's changes");
  ctx.snapshotted = true;
}

/** The chat's diff for a file change ("" when nothing to show). */
function changeDiff(before: string, after: string): string {
  return lineDiff(before, after, 2, 4000)?.text ?? "";
}

async function secretsMap(ctx: ToolContext): Promise<Map<string, string>> {
  const rows = await ctx.db.select().from(projectSecrets).where(eq(projectSecrets.projectId, ctx.project.id));
  const map = new Map<string, string>();
  for (const r of rows) { try { map.set(r.key, decryptApiKey(r.valueVault)); } catch { /* reported by test_secrets */ } }
  return map;
}

// ── secret checks ────────────────────────────────────────────────────────────

function checkHighrise(token: string, roomId: string): Promise<string> {
  if (process.env.HIGHRISE_VALIDATION_MODE === "relaxed") return Promise.resolve("not checked (validation is relaxed on this server)");
  const url = process.env.HR_BOTAPI_URL ?? "wss://highrise.game/web/botapi";
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { "room-id": roomId, "api-token": token, "user-agent": "kojyai-secret-check" } });
    const done = (msg: string) => { clearTimeout(timer); ws.removeAllListeners(); ws.terminate(); resolve(msg); };
    const timer = setTimeout(() => done("no answer from Highrise within 15s (check the room ID)"), 15_000);
    ws.on("message", (raw) => {
      try {
        const m = JSON.parse(String(raw)) as { _type?: string; message?: string };
        done(m._type === "SessionMetadata" ? "OK — Highrise accepted the token and room" : `rejected by Highrise: ${m.message ?? m._type}`);
      } catch { done("unexpected answer from Highrise"); }
    });
    ws.on("unexpected-response", (_req, res) => done(`rejected by Highrise (HTTP ${res.statusCode}) — the token or room ID is wrong`));
    ws.on("error", (e) => done(`couldn't connect to Highrise: ${e.message}`));
  });
}

async function checkBearer(url: string, key: string): Promise<string> {
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
    return res.ok ? "OK — key accepted" : res.status === 401 || res.status === 403 ? "rejected — the key is wrong or revoked" : `unexpected answer (HTTP ${res.status})`;
  } catch (e) { return `couldn't check: ${(e as Error).message}`; }
}

/** A Discord bot token: asks Discord who the bot is. */
export async function checkDiscordToken(token: string): Promise<string> {
  try {
    const res = await fetch("https://discord.com/api/v10/users/@me", { headers: { authorization: `Bot ${token.replace(/^Bot\s+/i, "")}` }, signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const me = await res.json() as { username?: string; bot?: boolean };
      return me.bot === false ? "rejected — that's a user account token, not a bot token (use the token from the Developer Portal → Bot)" : `OK — Discord accepted it (bot "${me.username ?? "?"}")`;
    }
    return res.status === 401 ? "rejected — Discord says the token is wrong or was reset (Developer Portal → Bot → Reset Token, then save the new one)"
      : `unexpected answer from Discord (HTTP ${res.status})`;
  } catch (e) { return `couldn't check: ${(e as Error).message}`; }
}

/** A Discord server id: the right shape, and (with a working token) whether the bot is in that server. */
export async function checkDiscordGuild(id: string, token: string | undefined): Promise<string> {
  if (!/^\d{17,20}$/.test(id.trim())) return "rejected — a server ID is a 17–20 digit number (Discord: Developer Mode on, right-click the server → Copy Server ID)";
  if (!token) return "looks like a server ID (can't check membership without DISCORD_TOKEN)";
  try {
    const res = await fetch(`https://discord.com/api/v10/guilds/${id.trim()}`, { headers: { authorization: `Bot ${token.replace(/^Bot\s+/i, "")}` }, signal: AbortSignal.timeout(10_000) });
    if (res.ok) { const g = await res.json() as { name?: string }; return `OK — the bot is in the server "${g.name ?? "?"}"`; }
    return res.status === 403 || res.status === 404 ? "rejected — the bot isn't in that server yet (invite it with the install link) or the ID is wrong"
      : res.status === 401 ? "couldn't check: DISCORD_TOKEN is rejected" : `unexpected answer from Discord (HTTP ${res.status})`;
  } catch (e) { return `couldn't check: ${(e as Error).message}`; }
}

/** A Telegram bot token (from @BotFather). */
async function checkTelegramToken(token: string): Promise<string> {
  if (!/^\d+:[\w-]{30,}$/.test(token)) return "rejected — a Telegram bot token looks like 123456789:ABC… (from @BotFather)";
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) { const b = await res.json() as { result?: { username?: string } }; return `OK — Telegram accepted it (@${b.result?.username ?? "?"})`; }
    return res.status === 401 || res.status === 404 ? "rejected — Telegram says the token is wrong or revoked" : `unexpected answer from Telegram (HTTP ${res.status})`;
  } catch (e) { return `couldn't check: ${(e as Error).message}`; }
}

// ── fake-room tests ──────────────────────────────────────────────────────────

const MAX_SAVED_TESTS = 20;

/** Up to 8 short texts the bot's actions must contain. */
function cleanExpect(raw: unknown): string[] {
  return (Array.isArray(raw) ? raw : []).map((x) => String(x).trim().slice(0, 120)).filter(Boolean).slice(0, 8);
}

/** Expectations no bot action contains (case-insensitive). Lines in brackets are the room's, not the bot's. */
export function missingExpectations(actions: string[], expect: string[]): string[] {
  const said = actions.filter((a) => !a.startsWith("(")).map((a) => a.toLowerCase());
  return expect.filter((e) => !said.some((a) => a.includes(e.toLowerCase())));
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  return out;
}

/** Runs one scenario in the fake room and judges it: connected, no crash, no errors, every expectation met. */
async function roomTest(ctx: ToolContext, t: { events: RoomEvent[]; expect: string[]; moderator: boolean; seconds?: number }): Promise<ToolResult> {
  if (!ctx.project.entrypoint) return { ok: false, output: "Set the entrypoint first (set_entrypoint).", summary: "Can't test: no entrypoint" };
  if (!t.events.length) return { ok: false, output: "Give chat lines or events to test with.", summary: "Can't test: nothing happens in the room" };
  const uuid = ctx.project.uuid;
  const dir = projectDir(uuid);
  const python = await ctx.supervisor.ensureVenv(uuid, dir, ctx.project.id);
  const env = await ctx.supervisor.botEnv(ctx.project, python, dir);
  const r = await runRoomTest({
    uid: sandboxUid(ctx.project.id), projectDir: dir, python, launcher: LAUNCHER, entrypoint: ctx.project.entrypoint, env,
    events: t.events, moderator: t.moderator, ...(t.seconds !== undefined ? { seconds: t.seconds } : {}),
  });
  const missing = missingExpectations(r.actions, t.expect);
  const verdict = !r.connected ? "The bot never connected to the test room."
    : r.exitedEarly ? `The bot crashed during the test (exit code ${r.exitCode}).`
    : r.errors.length ? "The bot ran, but errors were printed."
    : missing.length ? "The bot ran without errors, but didn't do everything expected." : "The bot ran without errors.";
  const output = [
    verdict,
    `What happened:\n${r.actions.join("\n") || "(nothing)"}`,
    missing.length ? `Expected but not seen in what the bot did:\n${missing.map((m) => `- ${m}`).join("\n")}` : "",
    r.errors.length ? `Errors:\n${r.errors.join("\n")}` : "",
    `Console (last lines):\n${r.output.slice(-40).join("\n")}`,
  ].filter(Boolean).join("\n\n");
  const replies = r.actions.filter((a) => !a.startsWith("(")).length;
  const ok = r.connected && !r.exitedEarly && r.errors.length === 0 && missing.length === 0;
  const state = ok ? "no errors" : r.exitedEarly ? "crashed" : !r.connected ? "didn't connect" : r.errors.length ? "errors" : `${missing.length} expectation${missing.length > 1 ? "s" : ""} not met`;
  return { ok, output: clip(output, 8000), summary: `Tested in a fake room: ${state}, ${replies} bot actions` };
}

// ── tools ────────────────────────────────────────────────────────────────────

type Args = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : "");

export async function runTool(name: string, args: Args, ctx: ToolContext): Promise<ToolResult> {
  const uuid = ctx.project.uuid;
  const dir = projectDir(uuid);
  try {
    switch (name) {
      case "list_files": {
        const folder = s(args.folder) ? cleanRelPath(s(args.folder)) + "/" : "";
        const all = listFiles(uuid).filter((f) => !folder || f.path.startsWith(folder));
        const lines = all.slice(0, 300).map((f) => (f.isDir ? `${f.path}/` : `${f.path} (${f.size < 1024 ? `${f.size} B` : `${Math.round(f.size / 1024)} KB`})`));
        return { ok: true, output: lines.join("\n") + (all.length > 300 ? `\n… ${all.length - 300} more` : "") || "(empty project)", summary: `Listed ${folder || "the project's"} files (${all.length})` };
      }

      case "read_file": {
        const rel = cleanRelPath(s(args.path));
        const file = resolveInside(uuid, rel);
        if (!existsSync(file)) return { ok: false, output: `No such file: ${rel}`, summary: `Couldn't find ${rel}` };
        if (statSync(file).size > MAX_EDIT_BYTES) return { ok: false, output: "File is over 1 MB; search it instead.", summary: `${rel} is too big to read` };
        const lines = readFileSync(file, "utf8").split("\n");
        const start = Math.max(1, Number(args.start_line) || 1);
        const end = Math.min(lines.length, Number(args.end_line) || start + 199, start + 199);
        const body = lines.slice(start - 1, end).map((l, i) => `${start + i}| ${l}`).join("\n");
        return { ok: true, output: clip(`${rel} — lines ${start}-${end} of ${lines.length}\n${body}`, 12_000), summary: `Read ${rel} (lines ${start}-${end})` };
      }

      case "search_code": {
        const pattern = s(args.pattern);
        if (pattern.length > MAX_SEARCH_PATTERN) return { ok: false, output: `Pattern is too long (${MAX_SEARCH_PATTERN} characters max).`, summary: "Search failed" };
        try { new RegExp(pattern, "i"); } catch { return { ok: false, output: "Invalid regular expression", summary: "Search failed" }; }
        const folder = s(args.folder) ? cleanRelPath(s(args.folder)) + "/" : "";
        const targets = listFiles(uuid)
          .filter((f) => !f.isDir && TEXT_EXT.test(f.path) && f.size <= MAX_EDIT_BYTES && (!folder || f.path.startsWith(folder)))
          .map((f) => ({ rel: f.path, abs: path.join(dir, f.path) }));
        const hits = await searchInWorker(pattern, targets);
        if (hits === "timeout") return { ok: false, output: `The search took over ${SEARCH_TIMEOUT_MS / 1000}s and was stopped. Use a simpler pattern (avoid nested repeats like (a+)+).`, summary: "Search stopped (too slow)" };
        return { ok: true, output: hits.join("\n") || "No matches.", summary: `Searched for “${pattern.slice(0, 40)}” (${hits.length} matches)` };
      }

      case "edit_file": {
        const rel = cleanRelPath(s(args.path));
        const file = resolveInside(uuid, rel);
        if (!existsSync(file)) return { ok: false, output: `No such file: ${rel}`, summary: `Couldn't find ${rel}` };
        const text = readFileSync(file, "utf8");
        const oldText = s(args.old_text);
        const count = oldText ? text.split(oldText).length - 1 : 0;
        if (count !== 1) {
          return { ok: false, output: count === 0 ? "old_text was not found. Read the file again and copy the exact text (indentation matters)." : `old_text matches ${count} places; include more surrounding lines so it is unique.`, summary: `Edit to ${rel} didn't apply` };
        }
        ensureSnapshot(ctx);
        const edited = text.replace(oldText, () => s(args.new_text));
        writeFileSync(file, edited);
        ctx.changedFiles.add(rel);
        const delta = s(args.new_text).split("\n").length - oldText.split("\n").length;
        return { ok: true, output: "Edited.", summary: `Edited ${rel}${delta ? ` (${delta > 0 ? "+" : ""}${delta} lines)` : ""}`, diff: changeDiff(text, edited) };
      }

      case "write_file": {
        const rel = cleanRelPath(s(args.path));
        const file = resolveInside(uuid, rel);
        const content = s(args.content);
        if (content.length > MAX_EDIT_BYTES) return { ok: false, output: "Content is over 1 MB.", summary: `${rel} too big` };
        const existed = existsSync(file);
        const before = existed && statSync(file).size <= MAX_EDIT_BYTES ? readFileSync(file, "utf8") : "";
        ensureSnapshot(ctx);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, content);
        ctx.changedFiles.add(rel);
        return { ok: true, output: existed ? "File replaced." : "File created.", summary: `${existed ? "Rewrote" : "Created"} ${rel} (${content.split("\n").length} lines)`, diff: changeDiff(before, content) };
      }

      case "delete_file": {
        const rel = cleanRelPath(s(args.path));
        if (rel === "data" || rel.startsWith("data/")) return { ok: false, output: "The bot's data/ folder can't be deleted by the AI.", summary: `Refused to delete ${rel}` };
        ensureSnapshot(ctx);
        rmSync(resolveInside(uuid, rel), { force: true });
        ctx.changedFiles.add(rel);
        return { ok: true, output: "Deleted.", summary: `Deleted ${rel}` };
      }

      case "check_code": {
        const python = await ctx.supervisor.ensureVenv(uuid, dir, ctx.project.id);
        const env = await ctx.supervisor.botEnv(ctx.project, python, dir);
        const uid = sandboxUid(ctx.project.id);
        const work = mkdtempSync(path.join(tmpdir(), "kojy-check-"));
        try {
          cpSync(dir, work, { recursive: true, filter: (src) => !/[/\\](\.git|node_modules|__pycache__|data)$/.test(src) });
          grantDir(work, uid);
          const compile = await runCapture(uid, python, ["-m", "compileall", "-q", "-x", "(^|/)(\\.|venv|node_modules)", "."], work, env, 60_000);
          if (compile.code !== 0) return { ok: false, output: clip(`Syntax errors:\n${compile.out}`), summary: "Code check: syntax errors" };
          const entry = ctx.project.entrypoint;
          if (!entry) return { ok: true, output: "All files compile. No entrypoint set yet (use set_entrypoint).", summary: "Code check: compiles (no entrypoint yet)" };
          if (isStartCommand(entry)) return { ok: true, output: `All files compile. The bot starts with a command (${entry}), so there's no Highrise class to load; run it once with run_command to test it.`, summary: "Code check: compiles" };
          const imp = await runCapture(uid, python, [BOTCHECK, entry], work, env, 60_000);
          if (!imp.out.includes("IMPORT_OK")) return { ok: false, output: clip(`Importing ${entry} failed:\n${imp.out}`), summary: "Code check: the bot fails to load" };
          const hidden = hiddenMethods(imp.out);
          if (hidden.length) {
            return {
              ok: false,
              output: clip(`All files compile and ${entry} loads, but these methods do nothing when the bot runs:\n${hidden.join("\n")}`),
              summary: `Code check: ${hidden.length} placeholder method(s) hide real ones`,
            };
          }
          return { ok: true, output: `All files compile and ${entry} loads.`, summary: "Code check passed" };
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
      }

      case "test_in_room": {
        if (isStartCommand(ctx.project.entrypoint)) return { ok: false, output: "This bot isn't a Highrise bot (it starts with a command), so the fake Highrise room can't run it. Test it with run_command instead.", summary: "Not a Highrise bot" };
        const chat = (Array.isArray(args.chat) ? args.chat : []).map(String).slice(0, 8);
        const events = normalizeEvents(args.events);
        const scenario = events.length ? events : chatToEvents(chat, args.join === true);
        const t = await roomTest(ctx, { events: scenario, expect: cleanExpect(args.expect), moderator: args.moderator !== false, ...(typeof args.seconds === "number" ? { seconds: args.seconds } : {}) });
        return t;
      }

      case "save_test": {
        const name = s(args.name).trim().slice(0, 80);
        if (!name) return { ok: false, output: "Give the test a short name.", summary: "Test not saved" };
        const chat = (Array.isArray(args.chat) ? args.chat : []).map(String).slice(0, 8);
        const events = normalizeEvents(args.events);
        const scenario = events.length ? events : chatToEvents(chat, args.join === true);
        if (!scenario.length) return { ok: false, output: "A saved test needs chat lines or events.", summary: "Test not saved" };
        const expect = cleanExpect(args.expect);
        const existing = await ctx.db.select({ name: roomTests.name }).from(roomTests).where(eq(roomTests.projectId, ctx.project.id));
        if (existing.length >= MAX_SAVED_TESTS && !existing.some((x) => x.name === name)) {
          return { ok: false, output: `This bot already has ${MAX_SAVED_TESTS} saved tests. Replace one by saving under its name.`, summary: "Test not saved (too many)" };
        }
        const moderator = args.moderator !== false;
        await ctx.db.insert(roomTests).values({ projectId: ctx.project.id, name, events: scenario as unknown as Record<string, unknown>[], expect, moderator })
          .onConflictDoUpdate({ target: [roomTests.projectId, roomTests.name], set: { events: scenario as unknown as Record<string, unknown>[], expect, moderator, updatedAt: new Date() } });
        return { ok: true, output: `Saved "${name}". run_saved_tests runs it again with the others after later changes.`, summary: `Saved the test “${name}”` };
      }

      case "run_saved_tests": {
        const tests = await ctx.db.select().from(roomTests).where(eq(roomTests.projectId, ctx.project.id)).orderBy(asc(roomTests.id));
        if (!tests.length) return { ok: true, output: "This bot has no saved tests yet. After a feature works, save its test with save_test.", summary: "No saved tests yet" };
        const results = await inBatches(tests, 3, async (t) => {
          const r = await roomTest(ctx, { events: normalizeEvents(t.events), expect: t.expect, moderator: t.moderator });
          await ctx.db.update(roomTests).set({ lastResult: r.ok ? "passed" : "failed", lastRunAt: new Date() }).where(eq(roomTests.id, t.id));
          return { name: t.name, r };
        });
        const failed = results.filter((x) => !x.r.ok);
        const lines = results.map((x) => `${x.r.ok ? "PASS" : "FAIL"} ${x.name}: ${x.r.summary}`);
        const details = failed.map((x) => `── ${x.name} ──\n${x.r.output}`).join("\n\n");
        return {
          ok: failed.length === 0,
          output: clip(`${lines.join("\n")}${details ? `\n\nWhat went wrong:\n${details}` : ""}`, 10_000),
          summary: failed.length ? `Saved tests: ${failed.length} of ${results.length} failed` : `Saved tests: all ${results.length} passed`,
        };
      }

      case "find_env_vars": {
        // name → where it's read, and its default if the code gives one
        const vars = new Map<string, { where: string; fallback: string | null }>();
        const note = (name: string, where: string, fallback: string | null) => {
          const prev = vars.get(name);
          // Required anywhere = required.
          if (!prev) vars.set(name, { where, fallback });
          else if (fallback === null) prev.fallback = null;
        };
        const required = /os\.environ\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g;
        const optional = /(?:os\.environ\.get|os\.getenv|environ\.get|getenv)\(\s*["']([A-Z][A-Z0-9_]*)["']\s*(?:,\s*([^)\n]{1,80}))?\)/g;
        for (const f of listFiles(uuid)) {
          if (f.isDir || f.size > MAX_EDIT_BYTES) continue;
          const isExample = /(^|\/)\.env(\.\w+)?$|\.env\.example$/i.test(f.path);
          if (!f.path.endsWith(".py") && !isExample) continue;
          if (/^(tests?|tools|scripts)\//.test(f.path)) continue;
          const text = readFileSync(path.join(dir, f.path), "utf8");
          if (isExample) {
            for (const m of text.matchAll(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/gm)) if (!vars.has(m[1]!)) vars.set(m[1]!, { where: f.path, fallback: m[2]!.trim() || null });
            continue;
          }
          for (const m of text.matchAll(required)) note(m[1]!, f.path, null);
          for (const m of text.matchAll(optional)) {
            const d = m[2]?.trim();
            // No default, or None / "", means the bot can't do without it.
            const empty = !d || /^(None|""|'')$/.test(d);
            // An empty default on a credential still means "required"; on anything
            // else (a webhook URL, a feature flag) it means "off unless set".
            note(m[1]!, f.path, !empty ? d : /TOKEN|KEY|SECRET|PASSWORD|ROOM_ID/.test(m[1]!) || !d ? null : "empty, feature off");
          }
        }
        for (const k of [...vars.keys()]) if (["PATH", "HOME", "HR_BOTAPI_URL"].includes(k) || k.startsWith("KOJY_") || k.startsWith("PYTHON")) vars.delete(k);
        const set = await secretsMap(ctx);
        const lines = [...vars].map(([n, v]) => `${n}: ${set.has(n) ? "set" : v.fallback !== null ? `optional, has a default (${v.fallback.slice(0, 60)})` : "MISSING"} (used in ${v.where})`);
        const missing = [...vars].filter(([n, v]) => !set.has(n) && v.fallback === null).length;
        return {
          ok: true,
          output: (lines.join("\n") || "The code doesn't read any environment variables.") + (missing ? "\nAsk only for the MISSING ones; optional ones work without a value." : ""),
          summary: `Found ${vars.size} settings the bot reads${missing ? `, ${missing} needed` : ", none missing"}`,
        };
      }

      case "request_secrets": {
        const items = (Array.isArray(args.secrets) ? args.secrets : [])
          .map((x) => ({ name: s((x as Args).name).trim(), description: s((x as Args).description).slice(0, 300) }))
          .filter((x) => /^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(x.name)).slice(0, 12);
        if (!items.length) return { ok: false, output: "No valid secret names.", summary: "Secret request was empty" };
        const set = await secretsMap(ctx);
        const card = { secrets: items.map((i) => ({ ...i, alreadySet: set.has(i.name) })), resolved: false };
        return { ok: true, output: "The owner now sees a form for these secrets. Stop and wait for them; you'll get a message when they're saved.", summary: `Asked for ${items.map((i) => i.name).join(", ")}`, card, pause: true };
      }

      case "test_secrets": {
        const set = await secretsMap(ctx);
        const wanted = Array.isArray(args.names) && args.names.length ? args.names.map(String) : [...set.keys()];
        const out: string[] = [];
        const done = new Set<string>();
        if ((wanted.includes("HIGHRISE_BOT_TOKEN") || wanted.includes("HIGHRISE_ROOM_ID"))) {
          const token = set.get("HIGHRISE_BOT_TOKEN"), room = set.get("HIGHRISE_ROOM_ID");
          if (!token || !room) out.push(`Highrise: missing ${!token ? "HIGHRISE_BOT_TOKEN" : "HIGHRISE_ROOM_ID"}`);
          else if (ctx.supervisor.isRunning(uuid)) out.push("Highrise: not re-checked because the bot is running — see get_logs for whether it connected");
          else out.push(`Highrise token + room: ${await checkHighrise(token, room)}`);
          done.add("HIGHRISE_BOT_TOKEN"); done.add("HIGHRISE_ROOM_ID");
        }
        for (const n of wanted) {
          if (done.has(n)) continue;
          const v = set.get(n);
          if (v === undefined) { out.push(`${n}: not set`); continue; }
          if (n === "GROQ_API_KEY") out.push(`${n}: ${await checkBearer("https://api.groq.com/openai/v1/models", v)}`);
          else if (n === "OPENAI_API_KEY") out.push(`${n}: ${await checkBearer("https://api.openai.com/v1/models", v)}`);
          else if (/^DISCORD(_BOT)?_TOKEN$/.test(n)) out.push(`${n}: ${await checkDiscordToken(v)}`);
          else if (/^(DISCORD_)?(GUILD|SERVER)_ID$/.test(n)) out.push(`${n}: ${await checkDiscordGuild(v, set.get("DISCORD_TOKEN") ?? set.get("DISCORD_BOT_TOKEN"))}`);
          else if (/^TELEGRAM(_BOT)?_TOKEN$/.test(n)) out.push(`${n}: ${await checkTelegramToken(v)}`);
          else out.push(`${n}: set (${v.length} characters). There's no automatic check for this one; that's fine — carry on, and the bot's logs will show if it's wrong.`);
        }
        const bad = out.filter((l) => /rejected|missing|not set|couldn't|no answer/i.test(l)).length;
        const next = bad ? "\nTell the owner which one is wrong and how to fix it." : "\nNow continue the task (e.g. start the bot with bot_control and confirm with get_logs) — don't stop here.";
        return { ok: bad === 0, output: (out.join("\n") || "No secrets to test.") + next, summary: bad ? `Tested secrets: ${bad} problem${bad > 1 ? "s" : ""}` : "Tested secrets: all good" };
      }

      case "run_command": {
        const command = s(args.command).trim();
        if (!command || command.length > 4000) return { ok: false, output: "Give one command (up to 4000 characters).", summary: "Invalid command" };
        const seconds = Math.min(Math.max(Number(args.timeout_seconds) || 60, 1), 180);
        // A command can change any file: keep the code as it was, for "undo".
        ensureSnapshot(ctx);
        const uid = sandboxUid(ctx.project.id);
        const venv = path.join(VENVS_DIR, uuid);
        const python = path.join(venv, "bin", "python");
        const env = await ctx.supervisor.botEnv(ctx.project, existsSync(python) ? python : "/usr/bin/python3", dir);
        delete env.KOJY_ENTRY;
        Object.assign(env, { PIP_CACHE_DIR: path.join(venv, ".pip-cache"), LESSHISTFILE: "-", PAGER: "cat", GIT_PAGER: "cat", TERM: "dumb",
          GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: dir });
        grantDir(dir, uid);
        // timeout(1) ends the whole command (and what it started in the foreground).
        const r = await runCapture(uid, "timeout", ["-k", "5", String(seconds), "/bin/bash", "-c", command], dir, env, (seconds + 10) * 1000);
        const secrets = Object.values(await ctx.supervisor.secrets(ctx.project)).filter((v) => v.length >= 6);
        let out = r.out;
        for (const v of secrets) out = out.split(v).join("[secret]");
        const timedOut = r.code === 124 || r.code === 137;
        const short = command.length > 60 ? `${command.slice(0, 60)}…` : command;
        return {
          ok: r.code === 0,
          output: clip(`$ ${command}\n${out || "(no output)"}\n[exit ${timedOut ? `— stopped after ${seconds}s` : r.code}]`),
          summary: `Ran \`${short}\`${r.code === 0 ? "" : timedOut ? " (timed out)" : ` (exit ${r.code})`}`,
        };
      }

      case "git": {
        if (!ctx.git) return { ok: false, output: "Git isn't available here.", summary: "Git unavailable" };
        const action = s(args.action);
        const message = s(args.message).trim();
        const run = (op: "status" | "commit" | "push" | "pull", extra: { message?: string } = {}) => ctx.git!.execute(uuid, { op, ...extra });
        const show = (st: { repo: boolean; branch: string | null; remote: string | null; ahead: number; behind: number; changes: { path: string; status: string }[]; commits: { hash: string; subject: string }[] }) =>
          !st.repo || !st.remote ? "Not linked to a GitHub repository. The owner links one in the Git panel (open_panel git)."
          : `${st.remote.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "")} on ${st.branch ?? "(no branch)"}${st.ahead ? ` · ${st.ahead} to push` : ""}${st.behind ? ` · ${st.behind} to pull` : ""}\n` +
            `Changed: ${st.changes.length ? st.changes.slice(0, 30).map((c) => `${c.status} ${c.path}`).join(", ") : "nothing"}\n` +
            `Recent: ${st.commits.slice(0, 5).map((c) => `${c.hash.slice(0, 7)} ${c.subject}`).join(" | ") || "no commits"}`;
        if (action === "status") {
          const r = await run("status");
          return r.ok ? { ok: true, output: show(r.status), summary: "Checked the git status" } : { ok: false, output: r.message, summary: "Git status failed" };
        }
        if (action === "pull") {
          ensureSnapshot(ctx);
          const r = await run("pull");
          return r.ok ? { ok: true, output: `${r.message}\n${show(r.status)}\nRead files again before changing them.`, summary: "Pulled from GitHub" } : { ok: false, output: r.message, summary: "Pull failed" };
        }
        let committed = "";
        if (action === "commit" || action === "commit_and_push") {
          if (!message) return { ok: false, output: "Give a short commit message saying what changed.", summary: "No commit message" };
          const c = await run("commit", { message });
          if (!c.ok && !(action === "commit_and_push" && /Nothing to commit/i.test(c.message))) return { ok: false, output: c.message, summary: "Commit failed" };
          committed = c.ok ? c.message : "";
          if (action === "commit") return { ok: true, output: c.ok ? `${c.message}\n${show(c.status)}` : c.message, summary: `Committed: ${message.slice(0, 60)}` };
        }
        if (action === "push" || action === "commit_and_push") {
          const p = await run("push");
          return p.ok
            ? { ok: true, output: `${committed} ${p.message}`.trim(), summary: committed ? "Committed and pushed to GitHub" : "Pushed to GitHub" }
            : { ok: false, output: `${committed} ${p.message}`.trim(), summary: "Push failed" };
        }
        return { ok: false, output: "action must be status, commit, push, commit_and_push or pull", summary: "Invalid git action" };
      }

      case "set_entrypoint": {
        const entry = s(args.entrypoint).trim();
        const problem = entrypointProblem(entry);
        if (problem) return { ok: false, output: problem, summary: "Invalid entrypoint" };
        await ctx.db.update(botProjects).set({ entrypoint: entry }).where(eq(botProjects.id, ctx.project.id));
        ctx.project.entrypoint = entry;
        return { ok: true, output: `Entrypoint set to ${entry}.`, summary: `Set the entrypoint to ${entry}` };
      }

      case "bot_control": {
        const action = s(args.action);
        if (!["start", "stop", "restart"].includes(action)) return { ok: false, output: "action must be start, stop or restart", summary: "Invalid bot action" };
        if (action !== "stop" && !ctx.project.entrypoint) return { ok: false, output: "Set the entrypoint first.", summary: "Can't start: no entrypoint" };
        await ctx.db.update(botProjects).set({ desiredState: action === "stop" ? "stopped" : "running", ...(action !== "stop" ? { restartCount: 0 } : {}) })
          .where(eq(botProjects.id, ctx.project.id));
        await ctx.supervisor.handle(uuid, action);
        // Give it a moment to connect (or fail) so get_logs has something to show.
        if (action !== "stop") await new Promise((r) => setTimeout(r, 8000));
        const [p] = await ctx.db.select({ status: botProjects.status, statusMessage: botProjects.statusMessage }).from(botProjects).where(eq(botProjects.id, ctx.project.id));
        const label = { start: "Started", stop: "Stopped", restart: "Restarted" }[action];
        return { ok: true, output: `${label}. Status now: ${p?.status}${p?.statusMessage ? ` (${p.statusMessage})` : ""}. Check get_logs to confirm it connected.`, summary: `${label} the bot (${p?.status})` };
      }

      case "get_logs": {
        const n = Math.min(Math.max(Number(args.lines) || 40, 5), 120);
        // A day of output for the connection summary; only the newest lines are shown.
        const lines = readLogs(uuid, undefined, 512 * 1024).lines;
        const [p] = await ctx.db.select({ status: botProjects.status, statusMessage: botProjects.statusMessage, restartCount: botProjects.restartCount, lastStartedAt: botProjects.lastStartedAt })
          .from(botProjects).where(eq(botProjects.id, ctx.project.id));
        const now = Date.now();
        const up = p?.status === "running" && p.lastStartedAt ? `, up ${duration((now - p.lastStartedAt.getTime()) / 1000)} (process started ${stamp(p.lastStartedAt.getTime())})` : "";
        const host = ctx.supervisor.hostNote(uuid);
        const output = [
          `Now: ${stamp(now)} UTC. Status: ${p?.status}${p?.statusMessage ? ` (${p.statusMessage})` : ""}${up}. Restarts so far: ${p?.restartCount}.`,
          ...(host ? [host] : []),
          connectionReport(lines, now),
          "Console, newest line last (times in UTC):",
          lines.length ? formatConsole(lines.slice(-600), { maxLines: n, maxChars: 6000 }) : "(no output yet)",
        ].join("\n");
        return { ok: true, output, summary: `Read the bot's console and connection history (${Math.min(n, lines.length)} lines)` };
      }

      case "propose_plan": {
        const steps = (Array.isArray(args.steps) ? args.steps : []).map((x) => String(x).slice(0, 200)).filter(Boolean).slice(0, 8);
        if (!steps.length) return { ok: false, output: "A plan needs steps.", summary: "Empty plan" };
        const title = s(args.title).slice(0, 120) || "Plan";
        return {
          ok: true, output: "The owner sees the plan with Approve/Change buttons. Stop now and wait for their answer.",
          summary: `Plan: ${title}`, cardKind: "plan", card: { title, steps, resolved: false }, pause: true,
        };
      }

      case "find_emotes": {
        const q = s(args.query).trim().toLowerCase();
        const hits = EMOTE_CATALOG.filter(([id, name, rarity]) => rarity !== "legendary" && (!q || id.includes(q) || name.toLowerCase().includes(q))).slice(0, 40);
        return {
          ok: true,
          output: hits.map(([id, name, , secs]) => `${id} — ${name}${secs ? ` (${secs.toFixed(1)}s)` : ""}`).join("\n") || "No emotes match.",
          summary: `Looked up emotes${q ? ` for “${q}”` : ""} (${hits.length})`,
        };
      }

      case "open_panel": {
        const panel = s(args.panel);
        if (!["console", "code", "shell", "git", "data", "secrets", "settings"].includes(panel)) return { ok: false, output: "Unknown panel.", summary: "Unknown panel" };
        return { ok: true, output: `The ${panel} panel is open next to the chat.`, summary: `Opened ${panel}`, cardKind: "ui", card: { panel } };
      }

      case "query_data":
        return await queryData(uuid, args);

      case "room_activity":
        return await roomActivity(ctx.db, ctx.project.id, args);

      case "remember": {
        const note = s(args.note).trim().slice(0, 300);
        if (!note) return { ok: false, output: "Empty note.", summary: "Nothing to remember" };
        const existing = await ctx.db.select({ content: agentMemories.content }).from(agentMemories).where(eq(agentMemories.orgId, ctx.project.orgId));
        if (existing.some((m) => normalizeNote(m.content) === normalizeNote(note))) return { ok: true, output: "Already saved earlier.", summary: `Already knew: ${note}` };
        await ctx.db.insert(agentMemories).values({ orgId: ctx.project.orgId, projectId: args.scope === "all" ? null : ctx.project.id, content: note });
        return { ok: true, output: "Saved.", summary: `Remembered: ${note}` };
      }

      default:
        return { ok: false, output: `Unknown tool ${name}`, summary: `Unknown tool ${name}` };
    }
  } catch (err) {
    const message = err instanceof ProjectFileError ? err.message : `Tool error: ${(err as Error).message}`;
    return { ok: false, output: message, summary: `${name} failed: ${message.slice(0, 80)}` };
  }
}

export async function loadMemories(db: Database, project: { orgId: number; id: number }): Promise<string[]> {
  const rows = await db.select({ id: agentMemories.id, content: agentMemories.content, projectId: agentMemories.projectId, source: agentMemories.source, pinned: agentMemories.pinned })
    .from(agentMemories).where(eq(agentMemories.orgId, project.orgId)).orderBy(asc(agentMemories.id));
  return pickMemories(rows, project.id).map((r) => r.content);
}

