/**
 * Integration Tests — Python bot projects, coder AI chat, analytics, status
 * OWNERSHIP: tests/integration
 *
 * Runs against the real API + Postgres + Redis (the runner isn't needed: these
 * check what the API stores and returns). Skips when the stack isn't up.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { Redis } from "ioredis";
import { zipSync, strToU8 } from "fflate";

const DB_URL = process.env.DATABASE_URL ?? "";
const REDIS_URL = process.env.REDIS_URL ?? "";
const test = !DB_URL || !REDIS_URL ? it.skip : it;

const EMAIL = `itest-projects-${Date.now()}@kojyai-test.com`;
const PASSWORD = "SecureTestPass!99";
let db: pg.Client;
let token = "";
let projectId = "";

async function call(procedure: string, input: unknown, kind: "mutation" | "query" = "mutation") {
  const base = process.env.API_TEST_URL ?? "http://localhost:3001";
  const headers = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const res = kind === "query"
    ? await fetch(`${base}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`, { headers })
    : await fetch(`${base}/trpc/${procedure}`, { method: "POST", headers, body: JSON.stringify({ json: input }) });
  const body = await res.json() as { result?: { data: { json: any } }; error?: { json: { message: string; data: { code: string } } } };
  if (body.error) return { error: { message: body.error.json.message, code: body.error.json.data.code }, data: undefined as any };
  return { data: body.result?.data.json, error: undefined };
}

beforeAll(async () => {
  if (!DB_URL || !REDIS_URL) return;
  db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  // The auth tests use up the per-IP sign-up/login limits; reset them.
  const redis = new Redis(REDIS_URL);
  for (const prefix of ["rl:auth:*", "rl:api:anon:*"]) {
    const keys = await redis.keys(prefix);
    if (keys.length) await redis.del(...keys);
  }
  await redis.quit();
  await call("auth.register", { email: "itest-owner@kojyai-test.com", username: "itestowner", password: PASSWORD });
  await call("auth.register", { email: EMAIL, username: `itestproj${Date.now() % 100000}`, password: PASSWORD });
  // Skip email verification for this test account and make it an admin.
  await db.query("update users set status = 'active', role = 'superadmin' where email = $1", [EMAIL]);
  const login = await call("auth.login", { email: EMAIL, password: PASSWORD });
  token = login.data?.sessionId ?? "";
});

afterAll(async () => {
  if (!db) return;
  if (projectId) await call("projects.delete", { id: projectId });
  const u = await db.query("select id from users where email = $1", [EMAIL]);
  if (u.rows[0]) {
    await db.query("delete from sessions where user_id = $1", [u.rows[0].id]).catch(() => undefined);
    await db.query("delete from org_members where user_id = $1", [u.rows[0].id]).catch(() => undefined);
    await db.query("delete from organizations where owner_id = $1", [u.rows[0].id]).catch(() => undefined);
    await db.query("delete from users where id = $1", [u.rows[0].id]).catch(() => undefined);
  }
  await db.end();
});

describe("Python bot projects", () => {
  test("logs in", () => { expect(token).not.toBe(""); });

  test("creates a project and uploads a zip", async () => {
    const created = await call("projects.create", { name: "ITest bot" });
    expect(created.error).toBeUndefined();
    projectId = created.data.id;

    const zip = zipSync({
      "mybot/bot.py": strToU8("import os\nfrom highrise import BaseBot\n\nclass ITestBot(BaseBot):\n    async def on_chat(self, user, message):\n        token = os.environ['HIGHRISE_BOT_TOKEN']\n"),
      "mybot/data/state.json": strToU8("{}"),
      "mybot/__pycache__/x.pyc": strToU8("x"),
    });
    const up = await call("projects.uploadZip", { id: projectId, zipBase64: Buffer.from(zip).toString("base64") });
    expect(up.error).toBeUndefined();
    expect(up.data.written).toBe(2);
    expect(up.data.entrypoint).toBe("bot:ITestBot");
  });

  test("lists and reads files, and refuses paths outside the project", async () => {
    const files = await call("projects.listFiles", { id: projectId }, "query");
    expect(files.data.map((f: { path: string }) => f.path)).toContain("bot.py");
    const read = await call("projects.readFile", { id: projectId, path: "bot.py" }, "query");
    expect(read.data.content).toContain("class ITestBot");
    const escape = await call("projects.readFile", { id: projectId, path: "../../etc/passwd" }, "query");
    expect(escape.error?.code).toBe("BAD_REQUEST");
  });

  test("stores secrets encrypted and only returns their names", async () => {
    expect((await call("projects.setSecret", { id: projectId, key: "HIGHRISE_BOT_TOKEN", value: "itest-secret-value" })).error).toBeUndefined();
    expect((await call("projects.setSecret", { id: projectId, key: "PATH", value: "x" })).error?.code).toBe("BAD_REQUEST");
    const got = await call("projects.get", { id: projectId }, "query");
    expect(got.data.secrets.map((s: { key: string }) => s.key)).toEqual(["HIGHRISE_BOT_TOKEN"]);
    expect(JSON.stringify(got.data)).not.toContain("itest-secret-value");
    const row = await db.query("select value_vault from project_secrets ps join bot_projects p on p.id = ps.project_id where p.uuid = $1", [projectId]);
    expect(row.rows[0].value_vault).not.toContain("itest-secret-value");
  });

  test("keeps the chat with the coder AI", async () => {
    expect((await call("projects.chatSend", { id: projectId, text: "hello Kojy" })).error).toBeUndefined();
    const list = await call("projects.chatList", { id: projectId }, "query");
    expect(list.data.messages.some((m: { content: string }) => m.content === "hello Kojy")).toBe(true);
    const bad = await call("projects.chatSubmitSecrets", { id: projectId, messageId: 999999999, values: { A: "b" } });
    expect(bad.error?.code).toBe("NOT_FOUND");
  });
});

describe("Analytics and server status", () => {
  test("counts real bot activity", async () => {
    const p = await db.query("select id, org_id from bot_projects where uuid = $1", [projectId]);
    const { id, org_id } = p.rows[0];
    await db.query(
      `insert into bot_activity (org_id, source, source_id, kind, actor_id, actor_name) values
       ($1,'project',$2,'chat','u1','alice'), ($1,'project',$2,'chat','u2','bob'), ($1,'project',$2,'reply',null,null), ($1,'project',$2,'join','u1','alice')`,
      [org_id, id]);
    const a = await call("analytics.activity", { days: 7, tzOffsetMin: 0 }, "query");
    expect(a.error).toBeUndefined();
    expect(a.data.totals.chat).toBeGreaterThanOrEqual(2);
    expect(a.data.visitors).toBeGreaterThanOrEqual(2);
    const bot = a.data.bots.find((b: { id: string }) => b.id === projectId);
    expect(bot).toMatchObject({ kind: "python", chats: 2, replies: 1, joins: 1, visitors: 2 });
    await db.query("delete from bot_activity where source = 'project' and source_id = $1", [id]);
  });

  test("reports database and Redis health", async () => {
    const s = await call("system.status", undefined, "query");
    expect(s.error).toBeUndefined();
    expect(s.data.database.ok).toBe(true);
    expect(s.data.redis.ok).toBe(true);
    expect(Array.isArray(s.data.queues)).toBe(true);
  });
});
