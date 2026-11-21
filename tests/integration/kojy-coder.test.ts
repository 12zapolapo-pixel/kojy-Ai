/**
 * Integration — Kojy's real agent loop against real Postgres and a fake
 * OpenAI-compatible model, on the path that broke in the "Crii" chat: a
 * model whose answers stop at max_tokens. Skips without DATABASE_URL.
 *   - A write too long for one answer is never run cut off: Kojy is told to
 *     write in parts, does, and the whole file is there.
 *   - A false "I don't have the tools" is held back (never shown or kept)
 *     and Kojy is told what it has.
 *   - "continue" after an automatic crash fix gets the owner's instructions
 *     and every tool, not the crash fix's limits.
 */
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { createDb, runMigrations, type Database } from "../../packages/db/src/index.js";
import * as schema from "../../packages/db/src/schema.js";

const DB_URL = process.env.DATABASE_URL ?? "";
const test = DB_URL ? it : it.skip;

type Msg = { role: string; content: string | null; tool_calls?: { function: { name: string } }[] };
interface Seen { system: string; tools: string[]; last: Msg; maxTokens: number }
const seen: Seen[] = [];
const PART = "def cmd():\n    return 1\n".repeat(20); // ~500 characters

/** The fake model: what it answers depends on the request it was given. */
function answer(body: { messages: Msg[]; tools?: { function: { name: string } }[]; max_tokens: number }) {
  const msgs = body.messages;
  const task = msgs.find((m) => m.role === "user" && /WRITE_BIG|DENY|CONTINUE_CHECK/.test(m.content ?? ""))?.content ?? msgs[0]!.content ?? "";
  const last = msgs[msgs.length - 1]!;
  seen.push({ system: msgs[0]!.content ?? "", tools: (body.tools ?? []).map((t) => t.function.name), last, maxTokens: body.max_tokens });
  const results = msgs.filter((m) => m.role === "tool").map((m) => m.content ?? "");
  const call = (name: string, args: object, cut = false) => {
    const json = JSON.stringify(args);
    const room = body.max_tokens * 4;
    const cutOff = cut || json.length > room;
    return { finish_reason: cutOff ? "length" : "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: `c${seen.length}`, type: "function", function: { name, arguments: cutOff ? json.slice(0, room) : json } }] } };
  };
  const say = (content: string) => ({ finish_reason: "stop", message: { role: "assistant", content } });
  if (/WRITE_BIG/.test(task)) {
    if (!results.length) return call("write_file", { path: "main.py", content: PART.repeat(40) }); // ~20,000 characters
    if (results.length === 1 && /cut off/.test(results[0]!)) return call("write_file", { path: "main.py", content: PART });
    if (results.length < 4) return call("append_file", { path: "main.py", content: PART });
    return say("Done: main.py is written.");
  }
  if (/DENY/.test(task)) {
    if (!results.length && !/Your last reply said you can't/.test(last.content ?? "")) return say("Sorry, I don't have the tools to create files right now. You'll need to paste this into main.py yourself.");
    if (!results.length) return call("write_file", { path: "deny.py", content: "x = 1\n" });
    return say("Created deny.py.");
  }
  return say("Picked up where the fix left off.");
}

let server: http.Server;
let db: Database;
let pool: pg.Pool;
let end: () => Promise<void> = async () => undefined;
let Agent: typeof import("../../apps/runner/src/agent/agent.js").Agent;
const root = mkdtempSync(path.join(tmpdir(), "kojy-coder-it-"));

beforeAll(async () => {
  if (!DB_URL) return;
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [answer(JSON.parse(body))], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  Object.assign(process.env, {
    PROJECTS_DIR: path.join(root, "projects"), VENVS_DIR: path.join(root, "venvs"), RUNNER_SANDBOX: "off",
    // A model that can only answer ~2,000 tokens at a time (like the old setting).
    LITELLM_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, LITELLM_API_KEY: "sk-test", LITELLM_MODELS: "small-model", LITELLM_MAX_OUTPUT_TOKENS: "2000",
  });
  for (const k of ["GROQ_API_KEY", "MISTRAL_API_KEY", "AGENT_API_KEY", "AGENT_API_KEYS"]) delete process.env[k];
  vi.resetModules();
  ({ Agent } = await import("../../apps/runner/src/agent/agent.js"));
  const made = await createDb({ url: DB_URL, max: 3, log: { info: () => undefined, warn: () => undefined } });
  db = made.db;
  pool = made.pool;
  await runMigrations(db, path.resolve("packages/db/migrations"));
  end = () => made.pool.end();
});
afterAll(async () => {
  if (!DB_URL) return;
  await end();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

async function project(messages: { role: string; kind: string; content: string }[]) {
  const uuid = randomUUID();
  const [p] = await db.insert(schema.botProjects).values({ uuid, orgId: 990_001, ownerId: 1, name: "Crii", entrypoint: "run: python main.py" }).returning();
  for (const m of messages) await db.insert(schema.projectMessages).values({ thread: `project:${p!.id}`, projectId: p!.id, ...m });
  const supervisor = { isRunning: () => false, hostNote: () => null, handle: async () => undefined, secrets: async () => ({}), ensureVenv: async () => "python3", botEnv: async () => ({ ...process.env }) };
  const agent = new Agent(db as never, supervisor as never, null);
  const rows = async () => (await pool.query<{ role: string; kind: string; content: string; data: unknown }>("SELECT role, kind, content, data FROM project_messages WHERE project_id = $1 ORDER BY id", [p!.id])).rows;
  return { uuid, id: p!.id, agent, rows, file: (rel: string) => readFileSync(path.join(root, "projects", uuid, rel), "utf8") };
}

describe("Kojy on a model that can only answer so much", () => {
  test("a cut-off write isn't run; Kojy is told to write in parts and the whole file gets written", async () => {
    const p = await project([{ role: "user", kind: "text", content: "WRITE_BIG: write my Discord bot Crii in main.py" }]);
    await p.agent.run(p.uuid);
    const tools = (await p.rows()).filter((r) => r.role === "tool");
    const first = tools[0]!;
    expect((first.data as { summary: string }).summary).toMatch(/write_file was cut off .* nothing was run/);
    expect(first.content).toMatch(/write_file with the first part .* append_file/s);
    expect(tools.slice(1).every((t) => (t.data as { ok: boolean }).ok)).toBe(true);
    expect(p.file("main.py")).toBe(PART.repeat(3)); // written in three parts
    const last = (await p.rows()).at(-1)!;
    expect(last.content).toBe("Done: main.py is written.");
  });

  test("a false \"I don't have the tools\" is held back and Kojy is told what it has", async () => {
    const p = await project([{ role: "user", kind: "text", content: "DENY: create deny.py" }]);
    await p.agent.run(p.uuid);
    const all = await p.rows();
    expect(all.some((r) => /don't have the tools/.test(r.content))).toBe(false); // never shown or kept
    expect(p.file("deny.py")).toBe("x = 1\n");
    expect(seen.some((s) => /Your last reply said you can't do this/.test(s.last.content ?? ""))).toBe(true);
  });

  test("\"continue\" after a crash fix gets the owner's instructions and every tool", async () => {
    const p = await project([
      { role: "user", kind: "crash", content: "CONTINUE_CHECK The bot crashed. Fix it now." },
      { role: "assistant", kind: "text", content: "I looked at it." },
      { role: "user", kind: "text", content: "continue" },
    ]);
    seen.length = 0;
    await p.agent.run(p.uuid);
    const req = seen[0]!;
    expect(req.system).toMatch(/Your tools work/);
    expect(req.system).not.toMatch(/KojyAI started you to fix a problem/);
    expect(req.tools).toEqual(expect.arrayContaining(["run_command", "run_python", "git", "fetch_url"]));
    expect(req.system).toMatch(/CONTINUE_CHECK/); // the crash is still the task being worked on
  });
});
