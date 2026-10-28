/**
 * Studio tools — what Kojy can do in the Studio chat, across all of the
 * owner's bots (the per-bot chat has the coding tools in tools.ts).
 * OWNERSHIP: apps/runner/src/agent
 */

import os from "node:os";
import { and, eq, gte, isNull, sql, count } from "drizzle-orm";
import type { Redis } from "ioredis";
import type { Database } from "@kojyai/db";
import { randomUUID } from "node:crypto";
import { botProjects, bots, botActivity, agentMemories, organizations, projectMessages } from "@kojyai/db/schema";
import { ensureProjectDir, writeProjectFile, BOT_TEMPLATES } from "@kojyai/shared/projects";
import { signBotControlMessage } from "@kojyai/shared/crypto";
import type { Supervisor } from "../supervisor.js";
import type { ToolSpec } from "./groq.js";
import type { ToolResult } from "./tools.js";

export interface StudioContext {
  db: Database;
  supervisor: Supervisor;
  redis: Redis | null;
  orgId: number;
  /** Starts Kojy in a bot's own chat (used after create_bot). */
  startBotChat: (uuid: string) => void;
}

const MAX_BOTS_PER_ORG = 20;

const fn = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): ToolSpec => ({
  type: "function", function: { name, description, parameters: { type: "object", properties, required } },
});
const str = (description: string) => ({ type: "string", description });

export const STUDIO_TOOL_SPECS: ToolSpec[] = [
  fn("list_bots", "All the owner's bots (Python and JavaScript): status, restarts, last activity."),
  fn("analytics", "Room activity numbers (messages, replies, visitors, joins, tips, crashes) per bot.",
    { days: { type: "integer", description: "1-90, default 7" }, bot: str("optional bot name") }),
  fn("server_status", "Server health: services, memory, disk, running bots, last backup."),
  fn("control_bot", "Start, stop or restart a bot by name (or 'all').",
    { bot: str("bot name, or 'all'"), action: { type: "string", enum: ["start", "stop", "restart"] } }, ["bot", "action"]),
  fn("open_bot", "Show the owner a button that opens a bot's own chat (for coding, fixing or setting it up).",
    { bot: str("bot name") }, ["bot"]),
  fn("create_bot", "Create a new Python bot and start building it in its own chat (Kojy writes, tests and starts it there). Use when the owner asks for a new bot. If a starter template fits, pass it: the bot then works right away and only the changes need coding.",
    { name: str("short bot name"), description: str("what the bot should do, in the owner's words plus useful detail"),
      template: { type: "string", enum: BOT_TEMPLATES.map((t) => t.id), description: BOT_TEMPLATES.map((t) => `${t.id}: ${t.description}`).join(" · ") } },
    ["name", "description"]),
  fn("remember", "Save one short lesson that applies to all bots.", { note: str("one sentence") }, ["note"]),
];

interface BotRow { kind: "python" | "javascript"; id: number; uuid: string; name: string; status: string; desired?: string; restarts?: number; entrypoint?: string }

async function allBots(ctx: StudioContext): Promise<BotRow[]> {
  const [py, js] = await Promise.all([
    ctx.db.select().from(botProjects).where(eq(botProjects.orgId, ctx.orgId)),
    ctx.db.select({ id: bots.id, uuid: bots.uuid, name: bots.name, status: bots.status }).from(bots)
      .where(and(eq(bots.orgId, ctx.orgId), isNull(bots.deletedAt))),
  ]);
  return [
    ...py.map((p) => ({ kind: "python" as const, id: p.id, uuid: p.uuid, name: p.name, status: p.status, desired: p.desiredState, restarts: p.restartCount, entrypoint: p.entrypoint })),
    ...js.map((b) => ({ kind: "javascript" as const, id: b.id, uuid: b.uuid, name: b.name, status: b.status })),
  ];
}

function findBots(list: BotRow[], name: string): BotRow[] {
  const n = name.trim().toLowerCase();
  if (n === "all") return list;
  const exact = list.filter((b) => b.name.toLowerCase() === n);
  return exact.length ? exact : list.filter((b) => b.name.toLowerCase().includes(n));
}

/** A short line about every bot, for the Studio chat's instructions. */
export async function studioSnapshot(ctx: StudioContext): Promise<string> {
  const list = await allBots(ctx);
  if (!list.length) return "The owner has no bots yet.";
  return list.map((b) => `${b.name} (${b.kind}, ${b.status})`).join(", ");
}

export async function runStudioTool(name: string, args: Record<string, unknown>, ctx: StudioContext): Promise<ToolResult> {
  try {
    switch (name) {
      case "list_bots": {
        const list = await allBots(ctx);
        const since = new Date(Date.now() - 86_400_000);
        const last = await ctx.db.select({ source: botActivity.source, sourceId: botActivity.sourceId, n: count(), last: sql<string>`max(${botActivity.createdAt})` })
          .from(botActivity).where(and(eq(botActivity.orgId, ctx.orgId), gte(botActivity.createdAt, since)))
          .groupBy(botActivity.source, botActivity.sourceId);
        const act = new Map(last.map((r) => [`${r.source}:${r.sourceId}`, r]));
        const lines = list.map((b) => {
          const a = act.get(`${b.kind === "python" ? "project" : "bot"}:${b.id}`);
          return `${b.name} — ${b.kind}, ${b.status}${b.restarts ? `, ${b.restarts} restarts` : ""}${a ? `, ${a.n} events in 24h (last ${new Date(a.last).toISOString().slice(11, 16)} UTC)` : ", no activity in 24h"}`;
        });
        return { ok: true, output: lines.join("\n") || "No bots yet.", summary: `Looked at your ${list.length} bots` };
      }

      case "analytics": {
        const days = Math.min(Math.max(Number(args.days) || 7, 1), 90);
        const since = new Date(Date.now() - days * 86_400_000);
        const rows = await ctx.db.select({ source: botActivity.source, sourceId: botActivity.sourceId, kind: botActivity.kind, n: count(),
          people: sql<number>`count(distinct ${botActivity.actorId})`.mapWith(Number) })
          .from(botActivity).where(and(eq(botActivity.orgId, ctx.orgId), gte(botActivity.createdAt, since)))
          .groupBy(botActivity.source, botActivity.sourceId, botActivity.kind);
        let list = await allBots(ctx);
        if (typeof args.bot === "string" && args.bot.trim()) list = findBots(list, args.bot);
        const lines = list.map((b) => {
          const mine = rows.filter((r) => r.source === (b.kind === "python" ? "project" : "bot") && r.sourceId === b.id);
          const k = (kind: string) => Number(mine.find((r) => r.kind === kind)?.n ?? 0);
          const people = Math.max(0, ...mine.filter((r) => ["chat", "join"].includes(r.kind)).map((r) => r.people));
          return `${b.name}: ${k("chat") + k("whisper")} messages, ${k("reply")} replies, ~${people} people, ${k("join")} joins, ${k("tip")} tips, ${k("crash")} crashes`;
        });
        return { ok: true, output: `Last ${days} days:\n${lines.join("\n") || "no bots"}`, summary: `Checked ${days}-day numbers`, cardKind: "ui", card: { panel: "analytics" } };
      }

      case "server_status": {
        const [worker, backup] = ctx.redis ? await ctx.redis.mget("worker:heartbeat", "backup:last").catch(() => [null, null]) : [null, null];
        const w = worker ? JSON.parse(worker) as { ts: number; rssMb: number } : null;
        const b = backup ? JSON.parse(backup) as { ok: boolean; at: number; error?: string } : null;
        const out = [
          `Python bots running: ${ctx.supervisor.runningCount()}`,
          `Memory: ${Math.round((os.totalmem() - os.freemem()) / 1048576)} of ${Math.round(os.totalmem() / 1048576)} MB used; CPU load ${os.loadavg().map((n) => n.toFixed(2)).join(" / ")} on ${os.cpus().length} cores`,
          `Background worker: ${w && Date.now() - w.ts < 45_000 ? "OK" : "NOT RESPONDING"}`,
          `Last backup: ${b ? (b.ok ? `OK, ${Math.round((Date.now() - b.at) / 3600_000)} h ago` : `FAILED — ${b.error}`) : "none yet"}`,
        ];
        return { ok: true, output: out.join("\n"), summary: "Checked the server", cardKind: "ui", card: { panel: "status" } };
      }

      case "control_bot": {
        const action = String(args.action ?? "");
        if (!["start", "stop", "restart"].includes(action)) return { ok: false, output: "action must be start, stop or restart", summary: "Invalid action" };
        const targets = findBots(await allBots(ctx), String(args.bot ?? ""));
        if (!targets.length) return { ok: false, output: `No bot called "${args.bot}".`, summary: `No bot "${args.bot}"` };
        const done: string[] = [];
        for (const t of targets) {
          if (t.kind === "python") {
            if (action !== "stop" && !t.entrypoint) { done.push(`${t.name}: skipped (no entrypoint yet)`); continue; }
            await ctx.db.update(botProjects).set({ desiredState: action === "stop" ? "stopped" : "running", ...(action !== "stop" ? { restartCount: 0 } : {}) })
              .where(eq(botProjects.id, t.id));
            void ctx.supervisor.handle(t.uuid, action);
          } else {
            // JS bots run in the API; same signed control channel the website uses.
            await ctx.redis?.publish(`bot_control:${t.uuid}`, signBotControlMessage(t.uuid, action));
          }
          done.push(`${t.name}: ${action} sent`);
        }
        return { ok: true, output: done.join("\n"), summary: `${action[0]!.toUpperCase()}${action.slice(1)}: ${targets.map((t) => t.name).join(", ")}` };
      }

      case "open_bot": {
        const [b] = findBots(await allBots(ctx), String(args.bot ?? ""));
        if (!b) return { ok: false, output: `No bot called "${args.bot}".`, summary: `No bot "${args.bot}"` };
        return { ok: true, output: `The owner now has a button to open ${b.name}'s chat.`, summary: `Open ${b.name}`, cardKind: "ui", card: { openBot: { kind: b.kind, id: b.uuid, name: b.name } } };
      }

      case "create_bot": {
        const name = String(args.name ?? "").trim().slice(0, 150);
        const description = String(args.description ?? "").trim().slice(0, 4000);
        if (!name || !description) return { ok: false, output: "A new bot needs a name and a description.", summary: "Missing name or description" };
        const [{ n } = { n: 0 }] = await ctx.db.select({ n: count() }).from(botProjects).where(eq(botProjects.orgId, ctx.orgId));
        if (Number(n) >= MAX_BOTS_PER_ORG) return { ok: false, output: `The limit is ${MAX_BOTS_PER_ORG} bots.`, summary: "Bot limit reached" };
        const [org] = await ctx.db.select({ ownerId: organizations.ownerId }).from(organizations).where(eq(organizations.id, ctx.orgId)).limit(1);
        if (!org) return { ok: false, output: "Organization not found.", summary: "No organization" };
        const template = BOT_TEMPLATES.find((t) => t.id === args.template);
        const uuid = randomUUID();
        const [row] = await ctx.db.insert(botProjects).values({ uuid, orgId: ctx.orgId, ownerId: org.ownerId, name, entrypoint: template?.entrypoint ?? "" }).returning();
        ensureProjectDir(uuid);
        if (template) for (const [file, content] of Object.entries(template.files)) writeProjectFile(uuid, file, content);
        await ctx.db.insert(projectMessages).values({
          thread: `project:${row!.id}`, projectId: row!.id, role: "user", kind: "text",
          content: template
            ? `This bot was created from the ${template.name} template. What I want: ${description}\n\nChange the template to match (plan first if it's a big change), test it in the fake room, then ask me for the secrets it needs.`
            : `Build a new Highrise bot called "${name}": ${description}\n\nStart small: write a working first version (Python, highrise-bot-sdk), set the entrypoint, check it and test it in the fake room. Then ask me for the secrets it needs (at least HIGHRISE_ROOM_ID and HIGHRISE_BOT_TOKEN).`,
        });
        ctx.startBotChat(uuid);
        return {
          ok: true, output: `Created ${name}. Kojy is building it now in its own chat; the owner has a button to open it.`,
          summary: `Created ${name}`, cardKind: "ui", card: { openBot: { kind: "python", id: uuid, name } },
        };
      }

      case "remember": {
        const note = String(args.note ?? "").trim().slice(0, 300);
        if (!note) return { ok: false, output: "Empty note.", summary: "Nothing to remember" };
        await ctx.db.insert(agentMemories).values({ orgId: ctx.orgId, projectId: null, content: note });
        return { ok: true, output: "Saved.", summary: `Remembered: ${note}` };
      }

      default:
        return { ok: false, output: `Unknown tool ${name}`, summary: `Unknown tool ${name}` };
    }
  } catch (err) {
    return { ok: false, output: `Tool error: ${(err as Error).message}`, summary: `${name} failed` };
  }
}
