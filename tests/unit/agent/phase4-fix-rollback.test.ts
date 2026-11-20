/**
 * Phase 4: an automatic fix is watched. If the bot crashes again soon after,
 * the code goes back to how it was before the fix (all of it, and the fixed
 * version stays in Undo), the owner is told, and a new fix starts that knows
 * why the last one was undone. Code changed after the fix is never overwritten.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

const root = mkdtempSync(path.join(tmpdir(), "kojy-rollback-"));
const uuid = "33333333-3333-4333-8333-333333333333";
let Agent: typeof import("../../../apps/runner/src/agent/agent.js").Agent;
let files: typeof import("../../../packages/shared/src/projects/files.js");

beforeAll(async () => {
  process.env.PROJECTS_DIR = root;
  process.env.GROQ_API_KEY = "gsk_fake-test-key";
  vi.resetModules();
  ({ Agent } = await import("../../../apps/runner/src/agent/agent.js"));
  files = await import("../../../packages/shared/src/projects/files.js");
});
afterAll(() => { delete process.env.GROQ_API_KEY; rmSync(root, { recursive: true, force: true }); });

const crash = (user: string) => [
  "Traceback (most recent call last):",
  `  File "/app/projects/${uuid}/bot.py", line 3, in on_chat`,
  "    x = self.coins[user.username]",
  `KeyError: '${user}'`,
];

function setup() {
  rows = { bot_projects: [{ id: 1, uuid, name: "Japalo", ownerId: 7, autoFix: true, desiredState: "running" }], project_messages: [], agent_work_log: [] };
  const supervisor: { onCrash?: (u: string, s: number, t: string[]) => void; isRunning: () => boolean } = { isRunning: () => true };
  const agent = new Agent(db as never, supervisor as never, null);
  const run = vi.spyOn(agent, "run").mockResolvedValue({ outcome: "done", ended: null, aiUnavailable: false });
  const fire = async (tail: string[]) => { supervisor.onCrash!(uuid, 1, tail); await new Promise((r) => setTimeout(r, 40)); };
  /** As if an automatic fix for `tail` had just finished, with the undo point taken before it. */
  const watch = async (snapshotId: string, tail: string[]) => {
    const { crashSignature } = await import("../../../apps/runner/src/agent/autoFix.js");
    (agent as unknown as { watchFix(u: string, p: unknown, fix: unknown): void })
      .watchFix(uuid, rows.bot_projects![0], { signature: crashSignature(tail), tail, snapshotId, requestId: 1, what: "a crash" });
  };
  const read = (rel: string) => readFileSync(path.join(root, uuid, rel), "utf8");
  return { run, fire, watch, read };
}

describe("an automatic fix that didn't hold", () => {
  it("is undone when the same crash comes back, and a new fix starts that knows why", async () => {
    const { run, fire, watch, read } = setup();
    files.ensureProjectDir(uuid);
    files.writeProjectFile(uuid, "bot.py", "before the fix\n");
    const snap = files.snapshotProject(uuid, "Before Kojy: automatic crash fix");
    files.writeProjectFile(uuid, "bot.py", "after the fix\n");
    await watch(snap.id, crash("amy"));

    await fire(crash("bob")); // same bug, another visitor
    expect(read("bot.py")).toBe("before the fix\n");
    const note = rows.project_messages!.find((m) => String(m.content).startsWith("↶"));
    expect(String(note?.content)).toMatch(/didn't hold \(the same error came back\)/);
    expect(String(note?.content)).toMatch(/starting a new fix/);
    expect(rows.notifications?.[0]).toMatchObject({ userId: 7, title: "Kojy undid its fix for Japalo" });
    // The fixed code is kept as an undo point.
    expect(files.listSnapshots(uuid).some((x) => x.reason === "Before undoing an automatic fix that didn't hold")).toBe(true);
    // …and Kojy starts over on the original crash, told why.
    expect(run).toHaveBeenCalledOnce();
    const request = rows.project_messages!.find((m) => m.kind === "crash");
    expect(String(request?.content)).toMatch(/An earlier automatic fix for this crash was undone because the same error came back after it/);
    expect(String(request?.content)).toContain("KeyError: 'amy'"); // the crash the fix was for
  });

  it("puts back everything the fix changed — the undo point from before the fix, not a newer one", async () => {
    const { fire, watch, read } = setup();
    files.writeProjectFile(uuid, "a.py", "a before\n");
    files.writeProjectFile(uuid, "b.py", "b before\n");
    const before = files.snapshotProject(uuid, "Before Kojy: automatic crash fix");
    files.writeProjectFile(uuid, "a.py", "a fixed\n");
    files.snapshotProject(uuid, "Before Kojy: automatic crash fix"); // as a later part of a long run used to take
    files.writeProjectFile(uuid, "b.py", "b fixed\n");
    await watch(before.id, crash("amy"));

    await fire(crash("amy"));
    expect(read("a.py")).toBe("a before\n");
    expect(read("b.py")).toBe("b before\n");
  });

  it("never overwrites code changed after the fix: the owner's edit stays and the crash is fixed as it is now", async () => {
    const { run, fire, watch, read } = setup();
    files.writeProjectFile(uuid, "bot.py", "before the fix\n");
    const snap = files.snapshotProject(uuid, "Before Kojy: automatic crash fix");
    files.writeProjectFile(uuid, "bot.py", "after the fix\n");
    await watch(snap.id, crash("amy"));
    files.writeProjectFile(uuid, "bot.py", "the owner's own edit\n");

    await fire(crash("amy"));
    expect(read("bot.py")).toBe("the owner's own edit\n");
    expect(rows.project_messages!.some((m) => /its code was changed since \(bot\.py\), so I'm not undoing anything/.test(String(m.content)))).toBe(true);
    expect(rows.project_messages!.some((m) => String(m.content).startsWith("↶"))).toBe(false);
    expect(run).toHaveBeenCalledOnce(); // a normal fix of the crash as it is now
  });

  it("a crash with nothing being watched goes the normal way (a new automatic fix)", async () => {
    const { run, fire } = setup();
    await fire(crash("amy"));
    expect(run).toHaveBeenCalledWith(uuid, { snapshotted: true, automatic: true });
  });
});
