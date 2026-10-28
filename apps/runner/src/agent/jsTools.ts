/**
 * JavaScript bot tools — Kojy in a JS bot's own chat (thread "bot:<id>").
 * OWNERSHIP: apps/runner/src/agent
 *
 * A JS bot is a set of small scripts (bot_scripts) the API's runtime calls
 * for every room event: handler(event, ctx) → actions[]. Kojy can read,
 * write and test them, reload them into the running bot, or turn the whole
 * bot into a Python bot (convert_to_python), which can do far more.
 *
 * test_script runs a script in a separate Node process with an empty
 * environment and a time limit (like Python bots' tests), never inside the
 * runner itself.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import type { Database } from "@kojyai/db";
import { bots, botScripts, botProjects, projectMessages } from "@kojyai/db/schema";
import { signBotControlMessage } from "@kojyai/shared/crypto";
import { ensureProjectDir } from "@kojyai/shared/projects";
import type { ToolSpec } from "./groq.js";
import type { ToolResult } from "./tools.js";

export type JsBot = typeof bots.$inferSelect;

export interface JsContext {
  db: Database;
  redis: Redis | null;
  bot: JsBot;
  startBotChat: (uuid: string) => void;
}

const fn = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): ToolSpec => ({
  type: "function", function: { name, description, parameters: { type: "object", properties, required } },
});
const str = (description: string) => ({ type: "string", description });

export const JS_TOOL_SPECS: ToolSpec[] = [
  fn("list_scripts", "The bot's active scripts (name, version, size)."),
  fn("read_script", "Read one script's code.", { name: str("script name") }, ["name"]),
  fn("write_script", "Create or replace a script (a new version; the old one is kept inactive). Contract: `export default function handler(event, ctx) { return [actions] }`; event._type is ChatEvent/UserJoinedEvent/UserLeftEvent/TipReactionEvent/EmoteEvent; actions like { kind: \"chat\", reason: \"…\", request: { _type: \"ChatRequest\", message: \"…\", whisper_target_id: null } }, { kind: \"emote\", request: { _type: \"EmoteRequest\", emote_id, target_user_id } }, { kind: \"reaction\", request: { _type: \"ReactionRequest\", reaction: \"clap\"|\"heart\"|\"thumbs\"|\"wave\"|\"wink\", target_user_id } }. No timers, network or saved files; ctx.userState (Map) and ctx.scriptState (object) persist while the bot runs. Test it, then reload_scripts.",
    { name: str("script name"), code: str("full script code"), description: str("what it does") }, ["name", "code"]),
  fn("delete_script", "Turn a script off.", { name: str("script name") }, ["name"]),
  fn("test_script", "Run a script against fake room events (tester chats the lines; optional join) and show the actions it returns.",
    { name: str("script name"), chat: { type: "array", items: { type: "string" } }, join: { type: "boolean" } }, ["name", "chat"]),
  fn("reload_scripts", "Load the current scripts into the running bot (after writing or deleting)."),
  fn("bot_control", "Start, stop or restart this JS bot.", { action: { type: "string", enum: ["start", "stop", "restart"] } }, ["action"]),
  fn("convert_to_python", "Make a new Python bot that does what this JS bot does (and can grow far beyond it). Kojy rebuilds it there; this JS bot keeps running until the owner stops it."),
];

const clip = (s: string, max = 6000) => (s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters)` : s);

async function activeScripts(ctx: JsContext) {
  return ctx.db.select().from(botScripts)
    .where(and(eq(botScripts.botId, ctx.bot.id), eq(botScripts.isActive, true))).orderBy(asc(botScripts.name));
}

async function publishControl(ctx: JsContext, action: string): Promise<void> {
  if (!ctx.redis) throw new Error("Redis isn't connected");
  await ctx.redis.publish(`bot_control:${ctx.bot.uuid}`, signBotControlMessage(ctx.bot.uuid, action));
}

/** Child-process harness: strip types, wrap like the live runtime, feed events. */
const HARNESS = `
const { stripTypeScriptTypes } = require("node:module");
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const { code, events } = JSON.parse(input);
  let js = code;
  try { if (stripTypeScriptTypes) js = stripTypeScriptTypes(code, { mode: "strip" }); } catch (e) { console.log(JSON.stringify({ error: "Type syntax error: " + e.message })); return; }
  js = js.replace(/^\\s*import\\s+type\\b.*$/gm, "")
    .replace(/^(\\s*)export\\s+default\\s+(async\\s+)?function\\s*\\(/m, "$1$2function handler(")
    .replace(/^(\\s*)export\\s+default\\s+(?=(async\\s+)?\\(|(async\\s+)?\\w+\\s*=>)/m, "$1const handler = ")
    .replace(/^(\\s*)export\\s+default\\s+function\\b/m, "$1function")
    .replace(/^\\s*export\\s+default\\s+\\w+\\s*;\\s*$/m, "")
    .replace(/^(\\s*)export\\s+(const|let|var|function)\\b/gm, "$1$2");
  let fn;
  try { fn = new Function(js + "\\n;return typeof handler === 'function' ? handler : null;")(); }
  catch (e) { console.log(JSON.stringify({ error: "Syntax error: " + e.message })); return; }
  if (typeof fn !== "function") { console.log(JSON.stringify({ error: "No handler function found (use: export default function handler(event, ctx) { … })" })); return; }
  const ctx = { botUserId: "bot-test", userState: new Map(), scriptState: {}, emotes: null };
  const out = [];
  for (const ev of events) {
    try {
      const actions = fn(ev, ctx);
      out.push({ event: ev._type === "ChatEvent" ? "tester says: " + ev.message : ev._type, actions: Array.isArray(actions) ? actions : [] });
    } catch (e) { out.push({ event: ev._type, error: String(e && e.stack || e).slice(0, 500) }); }
  }
  console.log(JSON.stringify({ results: out }));
});`;

export function runHarness(code: string, events: unknown[]): Promise<{ error?: string; results?: { event: string; actions?: unknown[]; error?: string }[] }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--no-warnings", "-e", HARNESS], { env: {}, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => { if (out.length < 200_000) out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { if (out.length < 200_000) out += d.toString(); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      const line = out.trim().split("\n").reverse().find((l) => l.startsWith("{"));
      try { resolve(line ? JSON.parse(line) : { error: code === null ? "Timed out (does the script loop forever?)" : out.slice(0, 1000) || "No output" }); }
      catch { resolve({ error: out.slice(0, 1000) }); }
    });
    child.stdin.end(JSON.stringify({ code, events }));
  });
}

function describeAction(a: unknown): string {
  const x = a as { kind?: string; request?: Record<string, unknown> };
  const r = x.request ?? {};
  switch (x.kind) {
    case "chat": return r.whisper_target_id ? `whisper: ${r.message}` : `say: ${r.message}`;
    case "emote": return `emote ${r.emote_id}`;
    case "reaction": return `react ${r.reaction}`;
    case "moderate": return `${r.moderation_action} user`;
    default: return String(x.kind ?? "unknown action");
  }
}

export async function runJsTool(name: string, args: Record<string, unknown>, ctx: JsContext): Promise<ToolResult> {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  try {
    switch (name) {
      case "list_scripts": {
        const list = await activeScripts(ctx);
        return { ok: true, output: list.map((x) => `${x.name} (v${x.version}, ${x.code.split("\n").length} lines)${x.description ? ` — ${x.description}` : ""}`).join("\n") || "No scripts yet.", summary: `Listed scripts (${list.length})` };
      }
      case "read_script": {
        const [row] = (await activeScripts(ctx)).filter((x) => x.name.toLowerCase() === s(args.name).toLowerCase());
        if (!row) return { ok: false, output: `No active script called "${s(args.name)}".`, summary: `No script "${s(args.name)}"` };
        return { ok: true, output: clip(row.code, 12_000), summary: `Read ${row.name}` };
      }
      case "write_script": {
        const scriptName = s(args.name).trim().slice(0, 300);
        const code = s(args.code);
        if (!scriptName || !code.trim()) return { ok: false, output: "A script needs a name and code.", summary: "Missing name or code" };
        if (code.length > 100_000) return { ok: false, output: "Script is too big (100 KB max).", summary: "Script too big" };
        const [prev] = await ctx.db.select().from(botScripts)
          .where(and(eq(botScripts.botId, ctx.bot.id), eq(botScripts.name, scriptName))).orderBy(desc(botScripts.version)).limit(1);
        await ctx.db.update(botScripts).set({ isActive: false }).where(and(eq(botScripts.botId, ctx.bot.id), eq(botScripts.name, scriptName)));
        await ctx.db.insert(botScripts).values({
          uuid: randomUUID(), botId: ctx.bot.id, orgId: ctx.bot.orgId, name: scriptName, code,
          description: s(args.description).slice(0, 500) || prev?.description || null, version: (prev?.version ?? 0) + 1,
        });
        return { ok: true, output: `Saved ${scriptName} v${(prev?.version ?? 0) + 1}. Test it, then reload_scripts.`, summary: `${prev ? "Updated" : "Created"} script ${scriptName}` };
      }
      case "delete_script": {
        const scriptName = s(args.name);
        await ctx.db.update(botScripts).set({ isActive: false }).where(and(eq(botScripts.botId, ctx.bot.id), eq(botScripts.name, scriptName)));
        return { ok: true, output: `${scriptName} is off. Call reload_scripts to apply.`, summary: `Turned off ${scriptName}` };
      }
      case "test_script": {
        const [row] = (await activeScripts(ctx)).filter((x) => x.name.toLowerCase() === s(args.name).toLowerCase());
        if (!row) return { ok: false, output: `No active script called "${s(args.name)}".`, summary: `No script "${s(args.name)}"` };
        const tester = { id: "u-tester", username: "tester" };
        const events: unknown[] = [];
        if (args.join === true) events.push({ _type: "UserJoinedEvent", user: tester, position: { x: 1, y: 0, z: 1, facing: "FrontRight" } });
        for (const line of (Array.isArray(args.chat) ? args.chat : []).slice(0, 8)) events.push({ _type: "ChatEvent", user: tester, message: String(line), whisper: false });
        const r = await runHarness(row.code, events);
        if (r.error) {
          await ctx.db.update(botScripts).set({ lastTestStatus: "failed", lastTestOutput: r.error.slice(0, 2000), lastTestedAt: new Date() }).where(eq(botScripts.id, row.id));
          return { ok: false, output: r.error, summary: `Test of ${row.name}: failed` };
        }
        const lines = (r.results ?? []).map((x) => `${x.event} → ${x.error ? `ERROR ${x.error}` : (x.actions ?? []).map(describeAction).join("; ") || "(nothing)"}`);
        const failed = (r.results ?? []).some((x) => x.error);
        await ctx.db.update(botScripts).set({ lastTestStatus: failed ? "failed" : "passed", lastTestOutput: lines.join("\n").slice(0, 2000), lastTestedAt: new Date() }).where(eq(botScripts.id, row.id));
        return { ok: !failed, output: lines.join("\n") || "No events.", summary: `Tested ${row.name}: ${failed ? "errors" : "ok"}` };
      }
      case "reload_scripts": {
        await publishControl(ctx, "reload_scripts");
        return { ok: true, output: "The running bot reloads its scripts now (if it's running).", summary: "Reloaded scripts" };
      }
      case "bot_control": {
        const action = s(args.action);
        if (!["start", "stop", "restart"].includes(action)) return { ok: false, output: "action must be start, stop or restart", summary: "Invalid action" };
        await publishControl(ctx, action);
        return { ok: true, output: `${action} sent to the bot.`, summary: `${action[0]!.toUpperCase()}${action.slice(1)} sent` };
      }
      case "convert_to_python": {
        const scripts = await activeScripts(ctx);
        const uuid = randomUUID();
        const name = `${ctx.bot.name} (Python)`.slice(0, 150);
        const [row] = await ctx.db.insert(botProjects).values({ uuid, orgId: ctx.bot.orgId, ownerId: ctx.bot.ownerId, name }).returning();
        ensureProjectDir(uuid);
        const listing = scripts.map((x) => `--- ${x.name}${x.description ? ` (${x.description})` : ""} ---\n${x.code}`).join("\n\n").slice(0, 12_000);
        await ctx.db.insert(projectMessages).values({
          thread: `project:${row!.id}`, projectId: row!.id, role: "user", kind: "text",
          content: `Rebuild my JavaScript bot "${ctx.bot.name}" as a Python bot (highrise-bot-sdk) that does the same things${scripts.length ? "" : " (it has no scripts yet, so make a friendly starter)"}. Its scripts:\n\n${listing || "(none)"}\n\nWrite it in Python, set the entrypoint, check and test it in the fake room, then ask me for the secrets. Don't start it until I say — the JS bot is still running with the same token.`,
        });
        ctx.startBotChat(uuid);
        return { ok: true, output: `Created ${name}; Kojy is rebuilding it there. Tell the owner to stop this JS bot before starting the Python one (one token can't run twice).`,
          summary: `Started converting to Python`, cardKind: "ui", card: { openBot: { kind: "python", id: uuid, name } } };
      }
      default:
        return { ok: false, output: `Unknown tool ${name}`, summary: `Unknown tool ${name}` };
    }
  } catch (err) {
    return { ok: false, output: `Tool error: ${(err as Error).message}`, summary: `${name} failed` };
  }
}
