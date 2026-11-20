/**
 * Integration Tests — the incident ledger (bot_incidents) against real Postgres:
 * the same problem is one row counted up, an automatic fix's state survives
 * new occurrences, a fixed problem that comes back is open again, and old
 * finished ones are pruned. Skips without DATABASE_URL.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Database } from "../../packages/db/src/index.js";
import pg from "pg";
import { IncidentLedger, classifyExit, describeIncidents } from "../../apps/runner/src/incidents.js";

const DB_URL = process.env.DATABASE_URL ?? "";
const test = DB_URL ? it : it.skip;

let db: Database;
let sqlc: pg.Client;
let end: () => Promise<void> = async () => undefined;
const project = 900_000_000 + Math.floor(Math.random() * 1_000_000);
const other = project + 1;

const crash = (user: string) => classifyExit({
  tail: [
    "Traceback (most recent call last):",
    '  File "/app/projects/u/highrise_bot/bot.py", line 302, in on_chat',
    "    coins = self.coins[user.username]",
    `KeyError: '${user}'`,
  ],
  how: "code 1",
  ranForMs: 5000,
});

beforeAll(async () => {
  if (!DB_URL) return;
  const made = await createDb({ url: DB_URL, max: 2, log: { info: () => undefined, warn: () => undefined } });
  db = made.db;
  sqlc = new pg.Client({ connectionString: DB_URL });
  await sqlc.connect();
  end = async () => { await sqlc.end(); await made.pool.end(); };
});
afterAll(async () => {
  if (!DB_URL) return;
  await sqlc.query("DELETE FROM bot_incidents WHERE project_id = ANY($1)", [[project, other]]);
  await end();
});

describe("incident ledger", () => {
  test("the same bug hit by different visitors is one incident, counted up", async () => {
    const ledger = new IncidentLedger(db);
    const a = await ledger.record(project, crash("amy"), "code 1");
    const b = await ledger.record(project, crash("bob"), "code 1");
    expect(a?.id).toBe(b?.id);
    expect(b).toMatchObject({ count: 2, category: "code", state: "open", summary: "KeyError: '…' in on_chat (highrise_bot/bot.py)", example: "KeyError: 'bob'" });
    expect(b?.data?.timeline?.[0]?.what).toBe("First seen");
  });

  test("an automatic fix working on it keeps its state when it happens again; a fixed one that comes back is open again", async () => {
    const ledger = new IncidentLedger(db);
    const first = (await ledger.record(project, crash("amy"), "code 1"))!;
    await ledger.update(first.id, { state: "fixing", attempt: true, note: "Kojy is fixing it." }, "Automatic fix started");
    const during = (await ledger.record(project, crash("cat"), "code 1"))!;
    expect(during).toMatchObject({ state: "fixing", note: "Kojy is fixing it.", attempts: 1 });
    expect(during.lastAttemptAt).toBeInstanceOf(Date);

    await ledger.update(first.id, { state: "fixed", note: "Fixed by Kojy — the fix held." }, "The fix held");
    const back = (await ledger.record(project, crash("dan"), "code 1"))!;
    expect(back.state).toBe("open");
    expect(back.data?.timeline?.map((t) => t.what)).toEqual(expect.arrayContaining(["Automatic fix started", "The fix held", "Came back after it was fixed"]));
    expect(await ledger.workingOn(project)).toEqual(new Set());
  });

  test("not-a-bug exits start out ignored or waiting for the owner, with a note saying why", async () => {
    const ledger = new IncidentLedger(db);
    const net = await ledger.record(other, classifyExit({ tail: ["Traceback (most recent call last):", "aiohttp.client_exceptions.ClientConnectorError: Cannot connect to host highrise.game:443"], how: "code 1", ranForMs: 1000 }), "code 1");
    expect(net).toMatchObject({ category: "network", state: "ignored" });
    const secret = await ledger.record(other, classifyExit({ tail: ["[kojy] Add HIGHRISE_ROOM_ID and HIGHRISE_BOT_TOKEN in the project's Secrets."], how: "code 2", ranForMs: 300 }), "code 2");
    expect(secret).toMatchObject({ category: "missing_secret", state: "needs_owner" });
    expect(secret?.note).toMatch(/only you have these values/);
  });

  test("what an automatic fix needs to pick up after a restart is kept on it, and old finished incidents are pruned", async () => {
    const ledger = new IncidentLedger(db);
    const row = (await ledger.record(other, crash("amy"), "code 1"))!;
    await ledger.update(row.id, { state: "waiting_for_ai", retryAt: new Date(Date.now() + 60_000), fix: { signature: row.signature, tail: ["Traceback (most recent call last):", "KeyError: 'amy'"], streak: 1, requestId: 42, snapshotId: "123" } });
    const waiting = (await ledger.inProgress()).find((r) => r.id === row.id);
    expect(waiting?.data?.fix).toMatchObject({ requestId: 42, snapshotId: "123", streak: 1 });
    await ledger.update(row.id, { state: "fixed", fix: null });
    expect((await ledger.inProgress()).some((r) => r.id === row.id)).toBe(false);

    await sqlc.query("UPDATE bot_incidents SET last_seen_at = now() - interval '40 days' WHERE id = $1", [row.id]);
    await ledger.prune();
    expect((await sqlc.query("SELECT id FROM bot_incidents WHERE id = $1", [row.id])).rows).toEqual([]);
  });

  test("Kojy's get_logs lists them newest first, without the ignored ones", async () => {
    const ledger = new IncidentLedger(db);
    const text = describeIncidents(await ledger.list(project), Date.now());
    expect(text).toMatch(/^- \[open\] ×\d+ KeyError: '…' in on_chat \(highrise_bot\/bot\.py\)/);
    const others = describeIncidents(await ledger.list(other), Date.now());
    expect(others).not.toContain("network");
    expect(others).toContain("[needs_owner]");
  });
});
