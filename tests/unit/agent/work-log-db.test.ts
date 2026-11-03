/**
 * Work log against a real Postgres (WORKLOG_TEST_DATABASE_URL). Creates only
 * the two tables it needs; skipped when no database is given.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Database } from "../../../packages/db/src/index.js";
import { projectMessages } from "../../../packages/db/src/schema.js";
import { recordWork, recentWork, runMemoryTool } from "../../../apps/runner/src/agent/workLog.js";

const URL = process.env.WORKLOG_TEST_DATABASE_URL ?? "";
const test = URL ? it : it.skip;
let db: Database;
let pool: { end(): Promise<void> };
const thread = `project:${Date.now() % 100000}`;

beforeAll(async () => {
  if (!URL) return;
  ({ db, pool } = await createDb({ url: URL, max: 2, log: { info: () => undefined, warn: () => undefined } }));
  const raw = pool as unknown as { query(sql: string): Promise<unknown> };
  await raw.query(`CREATE TABLE IF NOT EXISTS project_messages (
    id serial PRIMARY KEY, thread varchar(64) DEFAULT '' NOT NULL, project_id integer NOT NULL,
    role varchar(16) NOT NULL, kind varchar(32) DEFAULT 'text' NOT NULL, content text DEFAULT '' NOT NULL,
    data jsonb, created_at timestamptz DEFAULT now() NOT NULL)`);
  const migration = readFileSync(path.resolve(__dirname, "../../../packages/db/migrations/0006_agent_work_log.sql"), "utf8");
  for (const stmt of migration.split("--> statement-breakpoint")) if (stmt.trim()) await raw.query(stmt);
});
afterAll(async () => { await pool?.end(); });

const add = (role: string, content: string, data: Record<string, unknown> | null = null, kind = "text") =>
  db.insert(projectMessages).values({ thread, projectId: 1, role, kind, content, data });

describe("work log in Postgres", () => {
  test("one row per request, updated as the request goes on", async () => {
    await add("user", "Add !tp for moderators");
    await add("assistant", "", { toolCalls: [{ id: "a", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "tp.py" }) } }] });
    await add("tool", "ok", { toolCallId: "a", name: "write_file", summary: "Wrote tp.py", ok: true }, "tool");
    await recordWork(db, thread, 1, "paused");
    await add("user", "continue");
    await add("assistant", "Done: !tp works and the test passes.");
    await recordWork(db, thread, 1, "done");
    const rows = await recentWork(db, thread);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ request: "Add !tp for moderators", status: "done", summary: "Done: !tp works and the test passes." });
    expect(rows[0]!.files).toEqual([{ path: "tp.py", change: "wrote" }]);
  });

  test("work_log finds requests by word and by file name", async () => {
    const byWord = await runMemoryTool("work_log", { query: "moderators" }, { db, thread });
    expect(byWord.output).toContain("Add !tp for moderators");
    const byFile = await runMemoryTool("work_log", { query: "tp.py" }, { db, thread });
    expect(byFile.output).toContain("wrote tp.py");
    const none = await runMemoryTool("work_log", { query: "dance" }, { db, thread });
    expect(none.output).toMatch(/No earlier requests mention/);
  });

  test("search_chat finds earlier messages, and % or _ are matched literally", async () => {
    await add("user", "Make the welcome say 100% fun");
    const hit = await runMemoryTool("search_chat", { query: "100%" }, { db, thread });
    expect(hit.output).toContain("100% fun");
    const literal = await runMemoryTool("search_chat", { query: "%" + "_" }, { db, thread });
    expect(literal.output).toMatch(/Nothing in this chat mentions/);
  });

  test("other chats' logs are never returned", async () => {
    const other = await runMemoryTool("work_log", {}, { db, thread: "project:999999" });
    expect(other.output).toMatch(/No earlier requests/);
  });
});
