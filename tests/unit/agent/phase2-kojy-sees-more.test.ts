/**
 * Phase 2: Kojy can read the bot's data (read-only, one SELECT, in a worker
 * with a time limit) and the fake room can play whispers, tips, emotes,
 * leaves and several users.
 */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readQueryProblem } from "../../../packages/shared/src/projects/data.js";
import { formatRows, queryInWorker } from "../../../apps/runner/src/agent/dataTools.js";
import { chatToEvents, eventMessage, normalizeEvents } from "../../../apps/runner/src/agent/mockRoom.js";

describe("readQueryProblem", () => {
  it("allows one SELECT or WITH query", () => {
    expect(readQueryProblem("SELECT name, coins FROM players ORDER BY coins DESC LIMIT 10")).toBeNull();
    expect(readQueryProblem("with t as (select 1 as x) select * from t;")).toBeNull();
    expect(readQueryProblem("SELECT * FROM chat WHERE msg = 'drop table; please'")).toBeNull(); // quoted text is fine
  });
  it("refuses changes, a second statement, ATTACH and PRAGMA", () => {
    expect(readQueryProblem("DELETE FROM players")).toMatch(/Only SELECT/);
    expect(readQueryProblem("SELECT 1; DROP TABLE players")).toMatch(/one statement/);
    expect(readQueryProblem("SELECT * FROM players WHERE 1 AND (SELECT load_extension('x'))")).toMatch(/Only reading/);
    expect(readQueryProblem("WITH x AS (SELECT 1) DELETE FROM players")).toMatch(/Only reading/);
    expect(readQueryProblem("")).toMatch(/Empty/);
  });
});

describe("queryInWorker", () => {
  let dir: string;
  let file: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "kojy-data-"));
    file = path.join(dir, "bot.db");
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE players (name TEXT, coins INTEGER); INSERT INTO players VALUES ('amy', 50), ('bob', 120), ('cat', 7);");
    db.close();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads rows", async () => {
    const r = await queryInWorker(file, "SELECT name, coins FROM players ORDER BY coins DESC");
    expect(r).not.toBe("timeout");
    expect((r as { rows: unknown[] }).rows).toEqual([{ name: "bob", coins: 120 }, { name: "amy", coins: 50 }, { name: "cat", coins: 7 }]);
    expect(formatRows((r as { rows: Record<string, unknown>[] }).rows)).toBe("name\tcoins\nbob\t120\namy\t50\ncat\t7");
  });

  it("can't change the data even if a write slips past the text check", async () => {
    const r = await queryInWorker(file, "UPDATE players SET coins = 0");
    expect((r as { error?: string }).error).toMatch(/readonly|read-only|query_only/i);
    const after = await queryInWorker(file, "SELECT sum(coins) AS total FROM players");
    expect((after as { rows: unknown[] }).rows).toEqual([{ total: 177 }]);
  });

  it("stops a query that runs too long without blocking the main thread", async () => {
    const started = Date.now();
    const r = await queryInWorker(file, "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT count(*) FROM n");
    expect(r).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(8000);
  }, 15_000);
});

describe("fake room events", () => {
  it("cleans what the AI asks for", () => {
    const ev = normalizeEvents([
      { type: "tip", user: "amy", amount: 99999 },
      { type: "explode" },
      { type: "whisper", user: "bad name with spaces", message: "hi" },
      { type: "wait", seconds: 999 },
    ]);
    expect(ev).toEqual([
      { type: "tip", user: "amy", amount: 10000 },
      { type: "whisper", user: "tester", message: "hi" },
      { type: "wait", user: "tester", seconds: 15 },
    ]);
  });

  it("speaks the SDK's event formats", () => {
    expect(eventMessage({ type: "whisper", user: "bob", message: "!bal" })).toEqual({ _type: "ChatEvent", user: { id: "u-bob", username: "bob" }, message: "!bal", whisper: true });
    expect(eventMessage({ type: "tip", user: "amy", amount: 50 })).toMatchObject({ _type: "TipReactionEvent", sender: { username: "amy" }, item: { type: "gold", amount: 50 } });
    expect(eventMessage({ type: "leave", user: "amy" })).toEqual({ _type: "UserLeftEvent", user: { id: "u-amy", username: "amy" } });
    expect(eventMessage({ type: "wait" })).toBeNull();
  });

  it("keeps the old chat + join form working", () => {
    expect(chatToEvents(["!help"], true)).toEqual([{ type: "join", user: "tester" }, { type: "chat", user: "tester", message: "!help" }]);
  });
});
