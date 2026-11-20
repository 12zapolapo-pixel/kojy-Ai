/**
 * A crash starts Kojy on the fix right away (no approval step, no daily
 * limit), freezes too; network errors and exits without a traceback don't.
 * A crash while Kojy is busy waits its turn, and a fix no AI could take is
 * picked up again by itself. Uses a tiny in-memory stand-in for the queries.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

const root = mkdtempSync(path.join(tmpdir(), "kojy-autofix-"));
let Agent: typeof import("../../../apps/runner/src/agent/agent.js").Agent;
let files: typeof import("../../../packages/shared/src/projects/files.js");
beforeAll(async () => {
  process.env.PROJECTS_DIR = root;
  process.env.GROQ_API_KEY = "gsk_fake-test-key"; // an AI is configured
  vi.resetModules();
  ({ Agent } = await import("../../../apps/runner/src/agent/agent.js"));
  files = await import("../../../packages/shared/src/projects/files.js");
});
afterAll(() => { delete process.env.GROQ_API_KEY; rmSync(root, { recursive: true, force: true }); });

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
const otherBug = [
  "Traceback (most recent call last):",
  '  File "/app/projects/u1/highrise_bot/shop.py", line 40, in buy',
  "    price = PRICES[item]",
  "KeyError: 'sword'",
];
const network = [
  "Traceback (most recent call last):",
  "aiohttp.client_exceptions.ClientConnectorError: Cannot connect to host highrise.game:443 ssl:default [Temporary failure in name resolution]",
];

type RunResult = import("../../../apps/runner/src/agent/agent.js").RunResult;
const finished: RunResult = { outcome: "done", ended: null, aiUnavailable: false };

function setup(project: Record<string, unknown> = {}) {
  rows = { bot_projects: [{ id: 1, uuid: "u1", name: "Japalo", ownerId: 7, autoFix: true, desiredState: "running", ...project }], project_messages: [], agent_work_log: [] };
  const supervisor: {
    onCrash?: (uuid: string, streak: number, tail: string[], incident: unknown) => void;
    onBotError?: (uuid: string, tail: string[], incident: unknown, report: { event?: { handler?: string; command?: string } }) => void;
    isRunning?: () => boolean;
  } = { isRunning: () => true };
  const agent = new Agent(db as never, supervisor as never, null);
  const active = (agent as unknown as { active: Map<string, AbortController> }).active;
  /** Each run stays "working" until release() is called (or finishes at once when not held). */
  let hold = false;
  const waiting: (() => void)[] = [];
  let result: RunResult = finished;
  const run = vi.spyOn(agent, "run").mockImplementation(async (uuid: string) => {
    active.set(uuid, new AbortController());
    if (hold) await new Promise<void>((r) => waiting.push(r));
    active.delete(uuid);
    return result;
  });
  const crashMessages = () => (rows.project_messages ?? []).filter((m) => m.kind === "crash").map((m) => String(m.content));
  const events = () => (rows.project_messages ?? []).filter((m) => m.kind === "event").map((m) => String(m.content));
  const fire = async (tail: string[], streak = 1, incident: { id: number; category: string } | null = null) => {
    supervisor.onCrash!("u1", streak, tail, incident);
    await new Promise((r) => setTimeout(r, 20));
  };
  const survive = async (tail: string[], event: { handler?: string; command?: string }) => {
    supervisor.onBotError!("u1", tail, { id: 4, category: "code" }, { event });
    await new Promise((r) => setTimeout(r, 20));
  };
  return {
    run, crashMessages, events, fire, survive,
    holdRuns: () => { hold = true; },
    release: async () => { hold = false; for (const r of waiting.splice(0)) r(); await new Promise((r) => setTimeout(r, 30)); },
    nextResult: (r: RunResult) => { result = r; },
  };
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
    expect(run).toHaveBeenCalledWith("u1", { snapshotted: true, automatic: true });
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

  it("has no daily limit: every crash after the last fix starts another fix", async () => {
    const { run, crashMessages, fire } = setup();
    for (let i = 1; i <= 5; i++) await fire(crash, i);
    expect(crashMessages()).toHaveLength(5);
    expect(run).toHaveBeenCalledTimes(5);
  });

  it("while a fix runs, the same bug crashing again is left to it; a different crash waits its turn and is fixed next", async () => {
    const { run, crashMessages, fire, holdRuns, release } = setup();
    holdRuns();
    await fire(crash);
    await fire(crash, 2); // the bot restarted with the old code and crashed the same way
    await fire(otherBug, 3);
    expect(run).toHaveBeenCalledTimes(1);
    await release();
    expect(run).toHaveBeenCalledTimes(2);
    expect(crashMessages()).toHaveLength(2);
    expect(crashMessages()[1]).toContain("in buy");
  });

  it("takes one undo point before the fix and removes it again when nothing was changed", async () => {
    const { fire } = setup();
    files.ensureProjectDir("u1");
    files.writeProjectFile("u1", "bot.py", "print('hi')\n");
    const before = files.listSnapshots("u1").length;
    await fire(crash);
    expect(files.listSnapshots("u1")).toHaveLength(before); // taken, then removed: the fix changed nothing
  });

  it("when every AI is at its limit, says when it will try again and picks the fix up by itself", async () => {
    const { run, events, fire, nextResult } = setup();
    const ai = await import("../../../apps/runner/src/agent/groq.js");
    ai._resetAiStateForTests();
    nextResult({ outcome: "done", ended: "error", aiUnavailable: true });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const fired = fire(crash);
      await vi.advanceTimersByTimeAsync(50);
      await fired;
      expect(run).toHaveBeenCalledTimes(1);
      expect(events().some((e) => /Every AI is at its limit right now, so I'll pick up a crash again by myself at about \d\d:\d\d UTC/.test(e))).toBe(true);
      nextResult(finished);
      await vi.advanceTimersByTimeAsync(31_000); // the AI is free again: the shortest wait is 30s
      expect(run).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenLastCalledWith("u1", { snapshotted: true, automatic: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("only bugs in the code go to Kojy: what the supervisor recorded as the network or a missing secret doesn't", async () => {
    const { run, fire } = setup();
    await fire(crash, 1, { id: 9, category: "network" });
    await fire(crash, 1, { id: 9, category: "missing_secret" });
    await fire(crash, 1, { id: 9, category: "not_in_room" });
    expect(run).not.toHaveBeenCalled();
    await fire(crash, 1, { id: 9, category: "code" });
    expect(run).toHaveBeenCalledOnce();
  });

  it("an error the bot survived (it kept running) is fixed right away too, and the bot restarted so the fix runs", async () => {
    const { run, crashMessages, survive } = setup();
    await survive(crash, { handler: "on_user_join" });
    await survive(crash, { handler: "on_chat", command: "!coins" }); // same bug again while the fix runs: left to it
    expect(run).toHaveBeenCalledTimes(2); // the first fix had finished: no limit, so it's looked at again
    const [msg] = crashMessages();
    expect(msg).toMatch(/^The bot hit an error in on_user_join — it kept running, but that part of it failed\. /);
    expect(msg).toMatch(/the owner wants every error fixed without waiting for them/);
    expect(msg).toMatch(/restart the bot with bot_control so the fixed code runs/);
    expect(crashMessages()[1]).toMatch(/^The bot hit an error in on_chat \(the !coins command\) — it kept running, but that command failed\. /);
    expect(rows.notifications?.[0]).toMatchObject({ title: "Kojy looked into an error in Japalo" });
  });

  it("does nothing when auto-fix is switched off for the bot", async () => {
    const { run, fire } = setup({ autoFix: false });
    await fire(crash);
    expect(run).not.toHaveBeenCalled();
  });
});
