/**
 * Phase 4: an automatic fix is watched. If the bot crashes again soon after,
 * the code goes back to how it was before the fix (the fixed version stays
 * in Undo), the owner is told, and no new automatic fix starts for it.
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
  const run = vi.spyOn(agent, "run").mockResolvedValue(undefined);
  const fire = async (tail: string[]) => { supervisor.onCrash!(uuid, 1, tail); await new Promise((r) => setTimeout(r, 30)); };
  return { agent, run, fire };
}

describe("an automatic fix that didn't hold", () => {
  it("is undone when the same crash comes back, and no second fix starts", async () => {
    const { agent, run, fire } = setup();
    files.ensureProjectDir(uuid);
    files.writeProjectFile(uuid, "bot.py", "before the fix\n");
    const startedAt = Date.now();
    files.snapshotProject(uuid, "Before Kojy: automatic crash fix");
    files.writeProjectFile(uuid, "bot.py", "after the fix\n");
    (agent as unknown as { watchFix(u: string, p: unknown, sig: string, at: number): void })
      .watchFix(uuid, rows.bot_projects![0], (await import("../../../apps/runner/src/agent/autoFix.js")).crashSignature(crash("amy")), startedAt);

    await fire(crash("bob")); // same bug, another visitor
    expect(readFileSync(path.join(root, uuid, "bot.py"), "utf8")).toBe("before the fix\n");
    expect(run).not.toHaveBeenCalled();
    const note = rows.project_messages!.find((m) => String(m.content).startsWith("↶"));
    expect(String(note?.content)).toMatch(/didn't hold \(the same error came back\)/);
    expect(rows.notifications?.[0]).toMatchObject({ userId: 7, title: "Kojy undid its fix for Japalo" });
    // The fixed code is kept as an undo point.
    expect(files.listSnapshots(uuid)[0]!.reason).toBe("Before undoing an automatic fix that didn't hold");
  });

  it("a crash with nothing being watched goes the normal way (a new automatic fix)", async () => {
    const { run, fire } = setup();
    await fire(crash("amy"));
    expect(run).toHaveBeenCalledWith(uuid);
  });
});
