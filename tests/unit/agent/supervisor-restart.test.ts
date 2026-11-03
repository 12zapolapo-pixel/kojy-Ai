/**
 * Supervisor, around restarts: a bot whose start fails before it runs
 * (pip or the network down right after a deploy) is retried with backoff
 * instead of staying offline until someone presses Start; a stop cancels
 * the retry.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const root = mkdtempSync(path.join(tmpdir(), "kojy-supervisor-"));
let desiredState = "running";
const statuses: string[] = [];

const db = {
  select: () => {
    const q = {
      from() { return q; }, where() { return q; },
      limit: async () => [{ id: 1, uuid: "u1", orgId: 1, ownerId: 1, name: "Bot", entrypoint: "a:B", desiredState, restartCount: 0 }],
    };
    return q;
  },
  update: () => ({ set: (v: { status?: string; statusMessage?: string | null }) => ({ where: async () => { if (v.status) statuses.push(`${v.status}|${v.statusMessage ?? ""}`); } }) }),
  insert: () => ({ values: async () => undefined }),
};

let Supervisor: typeof import("../../../apps/runner/src/supervisor.js").Supervisor;

beforeAll(async () => {
  process.env.PROJECTS_DIR = path.join(root, "projects");
  process.env.VENVS_DIR = path.join(root, "venvs");
  process.env.PYTHON_BIN = path.join(root, "no-such-python"); // creating the venv fails
  process.env.RUNNER_SANDBOX = "off";
  mkdirSync(path.join(root, "projects", "u1"), { recursive: true });
  ({ Supervisor } = await import("../../../apps/runner/src/supervisor.js"));
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });
afterEach(() => { vi.useRealTimers(); });

const consoleLines = () => readFileSync(path.join(root, "projects", ".logs", "u1.log"), "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { line: string }).line);
const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setImmediate(r)); };

describe("a start that fails before the bot runs", () => {
  it("is tried again with backoff while the owner wants the bot running, and a stop cancels it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sup = new Supervisor(db as never);
    await sup.handle("u1", "start");
    await until(() => consoleLines().some((l) => l.includes("trying again in 30s")));
    const errors = consoleLines().filter((l) => l.startsWith("✖"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/— trying again in 30s$/);
    expect(statuses.at(-1)).toMatch(/^error\|.*trying again in 30s/);

    await vi.advanceTimersByTimeAsync(30_000);
    await until(() => consoleLines().some((l) => l.includes("trying again in 120s")));
    expect(consoleLines().filter((l) => l.includes("trying again"))).toHaveLength(2);

    await sup.handle("u1", "stop");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(consoleLines().filter((l) => l.includes("trying again"))).toHaveLength(2); // no third try after the stop
  });

  it("isn't retried when the owner has stopped the bot meanwhile", async () => {
    desiredState = "stopped";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sup = new Supervisor(db as never);
    const before = consoleLines().length;
    await sup.handle("u1", "start");
    await until(() => consoleLines().length > before + 1);
    const last = consoleLines().at(-1)!;
    expect(last.startsWith("✖")).toBe(true);
    expect(last).not.toContain("trying again");
    desiredState = "running";
  });
});
