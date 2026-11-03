/**
 * A KojyAI restart (a deploy) cuts off whatever Kojy was doing. On boot the
 * request picks up again by itself — once per request — instead of sitting
 * dead until the owner types "continue". Uses a tiny in-memory stand-in for
 * the few queries involved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../../../apps/runner/src/agent/agent.js";

type Table = object;
/** drizzle keeps a table's SQL name under this symbol. */
const getTableName = (t: Table) => (t as Record<symbol, string>)[Symbol.for("drizzle:Name")] ?? "";

interface Msg { id: number; role: string; kind: string; content: string; createdAt: Date; data: null }

function fakeDb(projects: { id: number; uuid: string }[], messages: Msg[]) {
  const inserted: { table: string; values: Record<string, unknown> }[] = [];
  const query = () => {
    let table = "";
    const q = {
      from(t: Table) { table = getTableName(t); return q; },
      where() { return q; }, orderBy() { return q; }, limit() { return q; },
      then(ok: (v: unknown[]) => unknown, fail: (e: unknown) => unknown) {
        // Newest first, as the code asks for.
        const rows = table === "bot_projects" ? projects : table === "project_messages" ? [...messages].reverse() : [];
        return Promise.resolve(rows).then(ok, fail);
      },
    };
    return q;
  };
  const db = {
    select: () => query(),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    insert: (t: Table) => ({
      values: (values: Record<string, unknown>) => {
        inserted.push({ table: getTableName(t), values });
        const done = Promise.resolve(undefined);
        return { returning: async () => [{ id: 1000 + inserted.length, ...values }], onConflictDoUpdate: async () => undefined, then: done.then.bind(done) };
      },
    }),
  };
  return { db, inserted };
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
const conversation = (lastActivityMinutesAgo: number): Msg[] => [
  { id: 1, role: "user", kind: "text", content: "The bot disconnected find out why and fix it", createdAt: minutesAgo(lastActivityMinutesAgo + 5), data: null },
  { id: 2, role: "assistant", kind: "text", content: "Let me check the logs.", createdAt: minutesAgo(lastActivityMinutesAgo + 4), data: null },
  { id: 3, role: "tool", kind: "tool", content: "Status: running", createdAt: minutesAgo(lastActivityMinutesAgo), data: null },
];

function setup(messages: Msg[], redisAnswer: "OK" | null) {
  const { db, inserted } = fakeDb([{ id: 1, uuid: "u1" }], messages);
  const redis = { set: vi.fn(async () => redisAnswer) };
  const agent = new Agent(db as never, {} as never, redis as never);
  const run = vi.spyOn(agent, "run").mockResolvedValue(undefined);
  const events = () => inserted.filter((i) => i.table === "project_messages").map((i) => String(i.values.content));
  return { agent, run, redis, events };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("a request cut off by a KojyAI restart", () => {
  it("picks up again by itself, after the bots are back", async () => {
    const { agent, run, redis, events } = setup(conversation(2), "OK");
    await agent.resetStates();
    expect(events()).toEqual(["KojyAI restarted while I was working on this — picking up where I left off."]);
    expect(redis.set).toHaveBeenCalledWith("agent_resumed:project:1:1", "1", "EX", 86_400, "NX");
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(run).toHaveBeenCalledWith("u1");
  });

  it("only once per request: cut off again, it asks the owner to continue", async () => {
    const { agent, run, events } = setup(conversation(2), null);
    await agent.resetStates();
    expect(events()).toEqual(["KojyAI restarted while I was working on this. Send “continue” and I'll pick up from my notes on this request."]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).not.toHaveBeenCalled();
  });

  it("leaves an old, stale request alone", async () => {
    const { agent, run, events } = setup(conversation(45), "OK");
    await agent.resetStates();
    expect(events()).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).not.toHaveBeenCalled();
  });
});
