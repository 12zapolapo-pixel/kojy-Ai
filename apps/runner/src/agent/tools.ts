/**
 * The coder AI's tools. Each returns plain text for the model plus a one-line
 * summary for the chat. File paths go through the same project-folder guard
 * as the website's editor (@kojyai/shared/projects).
 * OWNERSHIP: apps/runner/src/agent
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync, mkdtempSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import WebSocket from "ws";
import type { Database } from "@kojyai/db";
import { botProjects, projectSecrets, agentMemories } from "@kojyai/db/schema";
import { decryptApiKey } from "@kojyai/shared/crypto";
import {
  listFiles, resolveInside, cleanRelPath, projectDir, snapshotProject, readLogs, ProjectFileError, MAX_EDIT_BYTES, EMOTE_CATALOG,
} from "@kojyai/shared/projects";
import type { Supervisor } from "../supervisor.js";
import { LAUNCHER } from "../supervisor.js";
import { runRoomTest } from "./mockRoom.js";
import type { ToolSpec } from "./groq.js";

export type Project = typeof botProjects.$inferSelect;

export interface ToolContext {
  db: Database;
  supervisor: Supervisor;
  project: Project;
  /** Set once the AI has snapshotted the code in this run (for "undo"). */
  snapshotted: boolean;
  changedFiles: Set<string>;
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
  fn("test_in_room", "Run a copy of the bot for up to 60 seconds in a fake Highrise room (real room and data are untouched). User 'tester' joins (optional) and says the chat lines. Returns what the bot did and any errors. To test a timer, make its interval a setting and shorten it with env.",
    {
      chat: { type: "array", items: { type: "string" }, description: "lines 'tester' says, e.g. [\"!help\", \"hi bot\"]" }, join: { type: "boolean" }, seconds: { type: "integer" },
      env: { type: "array", items: { type: "string" }, description: "NAME=value settings for this test only, e.g. [\"ANNOUNCE_SECONDS=5\"]" },
    }, ["chat"]),
  fn("find_env_vars", "Find the environment variables (secrets/settings) the code reads, and which are already set."),
  fn("request_secrets", "Show the owner a form in the chat to add missing secrets. Ask for all missing ones at once, then stop and wait.",
    { secrets: { type: "array", items: { type: "object", properties: { name: str("ENV_NAME"), description: str("what it is and where to get it") }, required: ["name", "description"] } } }, ["secrets"]),
  fn("test_secrets", "Check that secrets work: Highrise room+token (connects to Highrise), GROQ_API_KEY, OPENAI_API_KEY; others are only checked for being set.", { names: { type: "array", items: { type: "string" } } }),
  fn("set_entrypoint", "Set which class starts the bot, as module.path:ClassName (a class based on BaseBot).", { entrypoint: str("e.g. bot:MyBot") }, ["entrypoint"]),
  fn("bot_control", "Start, stop or restart the real bot (restart makes code changes live).", { action: { type: "string", enum: ["start", "stop", "restart"] } }, ["action"]),
  fn("get_logs", "The real bot's latest console output (status, errors, tracebacks).", { lines: { type: "integer" } }),
  fn("propose_plan", "Before a bigger change (a new feature, several files, a rewrite), show the owner a short plan with Approve/Change buttons, then stop and wait. Not for small fixes or questions.",
    { title: str("what you'll build, a few words"), steps: { type: "array", items: { type: "string" }, description: "3-7 short steps in plain words" } }, ["title", "steps"]),
  fn("find_emotes", "Search the list of emote ids that work in Highrise (checked in a real room) by name or id, e.g. 'dance', 'wave'. Use these ids in code; never guess emote ids.",
    { query: str("word to search, or empty for a sample") }),
  fn("open_panel", "Show the owner a panel next to the chat: console (logs), code, data (the bot's database), secrets or settings.",
    { panel: { type: "string", enum: ["console", "code", "data", "secrets", "settings"] } }, ["panel"]),
  fn("remember", "Save one short lesson for the future (a fix that worked, how this bot is built). scope 'all' = useful for every bot.",
    { note: str("one sentence"), scope: { type: "string", enum: ["project", "all"] } }, ["note"]),
];

const TEXT_EXT = /\.(py|txt|md|json|ya?ml|toml|ini|cfg|env|example|js|ts|html|css|sh)$|(^|\/)(Dockerfile|Procfile|requirements[^/]*)$/i;
const clip = (s: string, max = 6000) => (s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters)` : s);

// Settings a test may not change: the fake room's address and the bot's identity,
// plus the ones that decide which Python and code run.
const FIXED_TEST_ENV = /^(HIGHRISE_|HR_|KOJY_|PYTHON|VIRTUAL_ENV$|PATH$|HOME$|LD_)/;

/** test_in_room's env: ["NAME=value", …] → settings for that test only (max 10). */
export function testSettings(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of (Array.isArray(raw) ? raw : []).slice(0, 10)) {
    const m = /^([A-Z][A-Z0-9_]{0,63})=(.{0,200})$/s.exec(String(item).trim());
    if (m && !FIXED_TEST_ENV.test(m[1]!)) out[m[1]!] = m[2]!;
  }
  return out;
}

function runCapture(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const add = (d: Buffer) => { if (out.length < 20_000) out += d.toString("utf8"); };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (e) => { clearTimeout(timer); resolve({ code: -1, out: e.message }); });
    child.once("exit", (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

function ensureSnapshot(ctx: ToolContext): void {
  if (ctx.snapshotted) return;
  snapshotProject(ctx.project.uuid, "Before the coder AI's changes");
  ctx.snapshotted = true;
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
        let re: RegExp;
        try { re = new RegExp(s(args.pattern), "i"); } catch { return { ok: false, output: "Invalid regular expression", summary: "Search failed" }; }
        const folder = s(args.folder) ? cleanRelPath(s(args.folder)) + "/" : "";
        const hits: string[] = [];
        for (const f of listFiles(uuid)) {
          if (f.isDir || !TEXT_EXT.test(f.path) || f.size > MAX_EDIT_BYTES || (folder && !f.path.startsWith(folder))) continue;
          readFileSync(path.join(dir, f.path), "utf8").split("\n").forEach((line, i) => {
            if (hits.length < 50 && re.test(line)) hits.push(`${f.path}:${i + 1}: ${line.trim().slice(0, 160)}`);
          });
          if (hits.length >= 50) break;
        }
        return { ok: true, output: hits.join("\n") || "No matches.", summary: `Searched for “${s(args.pattern).slice(0, 40)}” (${hits.length} matches)` };
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
        writeFileSync(file, text.replace(oldText, () => s(args.new_text)));
        ctx.changedFiles.add(rel);
        const delta = s(args.new_text).split("\n").length - oldText.split("\n").length;
        return { ok: true, output: "Edited.", summary: `Edited ${rel}${delta ? ` (${delta > 0 ? "+" : ""}${delta} lines)` : ""}` };
      }

      case "write_file": {
        const rel = cleanRelPath(s(args.path));
        const file = resolveInside(uuid, rel);
        const content = s(args.content);
        if (content.length > MAX_EDIT_BYTES) return { ok: false, output: "Content is over 1 MB.", summary: `${rel} too big` };
        const existed = existsSync(file);
        ensureSnapshot(ctx);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, content);
        ctx.changedFiles.add(rel);
        return { ok: true, output: existed ? "File replaced." : "File created.", summary: `${existed ? "Rewrote" : "Created"} ${rel} (${content.split("\n").length} lines)` };
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
        const python = await ctx.supervisor.ensureVenv(uuid, dir);
        const env = await ctx.supervisor.botEnv(ctx.project, python, dir);
        const work = mkdtempSync(path.join(tmpdir(), "kojy-check-"));
        try {
          cpSync(dir, work, { recursive: true, filter: (src) => !/[/\\](\.git|node_modules|__pycache__|data)$/.test(src) });
          const compile = await runCapture(python, ["-m", "compileall", "-q", "-x", "(^|/)(\\.|venv|node_modules)", "."], work, env, 60_000);
          if (compile.code !== 0) return { ok: false, output: clip(`Syntax errors:\n${compile.out}`), summary: "Code check: syntax errors" };
          const entry = ctx.project.entrypoint;
          if (!entry) return { ok: true, output: "All files compile. No entrypoint set yet (use set_entrypoint).", summary: "Code check: compiles (no entrypoint yet)" };
          const [mod, cls] = entry.split(":");
          const probe = `import sys; sys.path.insert(0, "."); import importlib; m = importlib.import_module(${JSON.stringify(mod)}); c = getattr(m, ${JSON.stringify(cls)}); from highrise import BaseBot; assert issubclass(c, BaseBot), "${cls} is not a BaseBot"; c(); print("IMPORT_OK")`;
          const imp = await runCapture(python, ["-c", probe], work, env, 60_000);
          const ok = imp.out.includes("IMPORT_OK");
          return { ok, output: clip(ok ? `All files compile and ${entry} loads.` : `Importing ${entry} failed:\n${imp.out}`), summary: ok ? "Code check passed" : "Code check: the bot fails to load" };
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
      }

      case "test_in_room": {
        if (!ctx.project.entrypoint) return { ok: false, output: "Set the entrypoint first (set_entrypoint).", summary: "Can't test: no entrypoint" };
        const chat = (Array.isArray(args.chat) ? args.chat : []).map(String).slice(0, 8);
        const extraEnv = testSettings(args.env);
        const python = await ctx.supervisor.ensureVenv(uuid, dir);
        const env = await ctx.supervisor.botEnv(ctx.project, python, dir);
        const r = await runRoomTest({
          projectDir: dir, python, launcher: LAUNCHER, entrypoint: ctx.project.entrypoint, env, chat, extraEnv,
          join: args.join === true, ...(typeof args.seconds === "number" ? { seconds: args.seconds } : {}),
        });
        const verdict = !r.connected ? "The bot never connected to the test room."
          : r.exitedEarly ? `The bot crashed during the test (exit code ${r.exitCode}).`
          : r.errors.length ? "The bot ran, but errors were printed." : "The bot ran without errors.";
        const settings = Object.entries(extraEnv).map(([k, v]) => `${k}=${v}`);
        const output = [
          verdict,
          settings.length ? `Test-only settings: ${settings.join(", ")}` : "",
          `What happened:\n${r.actions.join("\n") || "(nothing)"}`,
          r.errors.length ? `Errors:\n${r.errors.join("\n")}` : "",
          `Console (last lines):\n${r.output.slice(-40).join("\n")}`,
        ].filter(Boolean).join("\n\n");
        const replies = r.actions.filter((a) => !a.startsWith("(")).length;
        const ok = r.connected && !r.exitedEarly && r.errors.length === 0;
        return { ok, output: clip(output, 8000), summary: `Tested in a fake room: ${ok ? "no errors" : r.exitedEarly ? "crashed" : r.connected ? "errors" : "didn't connect"}, ${replies} bot actions` };
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
            note(m[1]!, f.path, !empty ? d! : /TOKEN|KEY|SECRET|PASSWORD|ROOM_ID/.test(m[1]!) || !d ? null : "empty, feature off");
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
          else out.push(`${n}: set (${v.length} characters; no automatic check for this one)`);
        }
        const bad = out.filter((l) => /rejected|missing|not set|couldn't|no answer/i.test(l)).length;
        return { ok: bad === 0, output: out.join("\n") || "No secrets to test.", summary: bad ? `Tested secrets: ${bad} problem${bad > 1 ? "s" : ""}` : "Tested secrets: all good" };
      }

      case "set_entrypoint": {
        const entry = s(args.entrypoint).trim();
        if (!/^[A-Za-z_][\w.]*:[A-Za-z_]\w*$/.test(entry)) return { ok: false, output: "Use module.path:ClassName", summary: "Invalid entrypoint" };
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
        const lines = readLogs(uuid, undefined, 48 * 1024).lines.slice(-n).map((l) => `${l.stream === "stderr" ? "! " : l.stream === "system" ? "# " : ""}${l.line}`);
        const [p] = await ctx.db.select({ status: botProjects.status, statusMessage: botProjects.statusMessage, restartCount: botProjects.restartCount }).from(botProjects).where(eq(botProjects.id, ctx.project.id));
        return { ok: true, output: clip(`Status: ${p?.status}${p?.statusMessage ? ` (${p.statusMessage})` : ""}, restarts: ${p?.restartCount}\n${lines.join("\n") || "(no output yet)"}`), summary: `Read the bot's console (${lines.length} lines)` };
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
        if (!["console", "code", "data", "secrets", "settings"].includes(panel)) return { ok: false, output: "Unknown panel.", summary: "Unknown panel" };
        return { ok: true, output: `The ${panel} panel is open next to the chat.`, summary: `Opened ${panel}`, cardKind: "ui", card: { panel } };
      }

      case "remember": {
        const note = s(args.note).trim().slice(0, 300);
        if (!note) return { ok: false, output: "Empty note.", summary: "Nothing to remember" };
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
  const rows = await db.select({ content: agentMemories.content, projectId: agentMemories.projectId }).from(agentMemories)
    .where(eq(agentMemories.orgId, project.orgId)).orderBy(asc(agentMemories.id));
  return rows.filter((r) => r.projectId === null || r.projectId === project.id).slice(-15).map((r) => r.content);
}

