/**
 * A crash starts Kojy on the fix right away (the first crash, no approval
 * step), freezes too; network errors, exits without a traceback and a second
 * crash moments later don't. Uses a tiny in-memory stand-in for the queries.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Table = object;
const tableName = (t: Table) => (t as Record<symbol, string>)[Symbol.for("drizzle:Name")] ?? "";

let rows: Record<string, Record<string, unknown>[]>;
const db = {
  select: () => {
    let table = "";
    const q = {
      from(t: Table) { table = tableName(t); return q; },
      where() { return q; }, orderBy() { return q; }, limit() { return q; },
      then(ok: (v: unknown[]) => unknown, fail: (e: unknown) => unknown) { return Promise.resolve(rows[table] ?? []).then(ok, fail); },
    };
    return q;
  },
  update: () => ({ set: () => ({ where: async () => undefined }) }),
  insert: (t: Table) => ({
    values: (values: Record<string, unknown>) => {
      const row = { id: 100 + (rows[tableName(t)]?.length ?? 0), ...values };
      (rows[tableName(t)] ??= []).push(row);
      const done = Promise.resolve(undefined);
      return { returning: async () => [row], onConflictDoUpdate: async () => undefined, then: done.then.bind(done) };
    },
  }),
};

let Agent: typeof import("../../../apps/runner/src/agent/agent.js").Agent;
beforeAll(async () => {
  process.env.GROQ_API_KEY = "gsk_fake-test-key"; // an AI is configured
  vi.resetModules();
  ({ Agent } = await import("../../../apps/runner/src/agent/agent.js"));
});
afterAll(() => { delete process.env.GROQ_API_KEY; });

const crash = [
  "2026-11-03 15:00:00 INFO     highrise_bot.bot: visitor said hello",
  "Traceback (most recent call last):",
  '  File "/app/projects/u1/highrise_bot/bot.py", line 302, in on_user_join',
  "    self._join_times = [s for s in self._join_times if s <= window]",
  "TypeError: '<=' not supported between instances of 'float' and 'NoneType'",
];
const frozen = [
  "Traceback (most recent call last):",
  '  File "/app/projects/u1/highrise_bot/weather.py", line 40, in fetch',
  "    time.sleep(30)",
  "BotFrozenError: the bot's code didn't hand control back for 61s, so the bot couldn't answer anyone in the room.",
];
const network = [
  "Traceback (most recent call last):",
  "aiohttp.client_exceptions.ClientConnectorError: Cannot connect to host highrise.game:443 ssl:default [Temporary failure in name resolution]",
];

function setup(project: Record<string, unknown> = {}) {
  rows = { bot_projects: [{ id: 1, uuid: "u1", name: "Japalo", ownerId: 7, autoFix: true, desiredState: "running", ...project }], project_messages: [], agent_work_log: [] };
  const supervisor: { onCrash?: (uuid: string, streak: number, tail: string[]) => void } = {};
  const agent = new Agent(db as never, supervisor as never, null);
  const run = vi.spyOn(agent, "run").mockResolvedValue(undefined);
  const crashMessages = () => (rows.project_messages ?? []).filter((m) => m.kind === "crash").map((m) => String(m.content));
  const fire = async (tail: string[], streak = 1) => { supervisor.onCrash!("u1", streak, tail); await new Promise((r) => setTimeout(r, 20)); };
  return { run, crashMessages, fire };
}

beforeEach(() => { vi.clearAllMocks(); });

describe("automatic crash fix", () => {
  it("the first crash starts Kojy on a fix right away, without asking the owner", async () => {
    const { run, crashMessages, fire } = setup();
    await fire(crash);
    const [msg] = crashMessages();
    expect(msg).toMatch(/^The bot crashed\. /);
    expect(msg).toContain("<untrusted_bot_output>");
    expect(msg).toContain("line 302, in on_user_join");
    expect(msg).not.toContain("visitor said hello"); // log lines stay out
    expect(msg).toMatch(/Fix it now — the owner wants crashes fixed without waiting for them/);
    expect(msg).toMatch(/restart the bot with bot_control and confirm with get_logs/);
    expect(msg).not.toMatch(/propose_plan/);
    expect(run).toHaveBeenCalledWith("u1");
    expect(rows.notifications?.[0]).toMatchObject({ userId: 7, title: "Kojy looked into a crash in Japalo" });
  });

  it("a freeze caught by the watchdog is fixed the same way, with a hint about blocking code", async () => {
    const { run, crashMessages, fire } = setup();
    await fire(frozen);
    expect(crashMessages()[0]).toMatch(/^The bot froze\. /);
    expect(crashMessages()[0]).toMatch(/await asyncio\.sleep instead of time\.sleep/);
    expect(run).toHaveBeenCalledOnce();
  });

  it("leaves network errors and exits without a traceback alone", async () => {
    const { run, crashMessages, fire } = setup();
    await fire(network);
    await fire(["ERROR: Error(message='timeout', do_not_reconnect=False, rid=None)"]);
    expect(crashMessages()).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("doesn't start a second fix for a crash moments after the last one", async () => {
    const { run, crashMessages, fire } = setup();
    await fire(crash);
    await fire(crash, 2);
    expect(crashMessages()).toHaveLength(1);
    expect(run).toHaveBeenCalledOnce();
  });

  it("does nothing when auto-fix is switched off for the bot", async () => {
    const { run, fire } = setup({ autoFix: false });
    await fire(crash);
    expect(run).not.toHaveBeenCalled();
  });
});
