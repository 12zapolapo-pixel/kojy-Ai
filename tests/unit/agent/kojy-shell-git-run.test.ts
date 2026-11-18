/**
 * Kojy's run_command and git tools, start commands (programs that aren't
 * Highrise bots), and the locks on both in automatic runs.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = mkdtempSync(path.join(tmpdir(), "kojy-run-"));
const UUID = "22222222-3333-4444-8555-666666666666";
process.env.PROJECTS_DIR = path.join(root, "projects");
process.env.VENVS_DIR = path.join(root, "venvs");
process.env.RUNNER_SANDBOX = "off";
process.env.ENCRYPTION_KEY ??= "c".repeat(64);
const dir = path.join(root, "projects", UUID);

const project = { id: 3, uuid: UUID, orgId: 1, ownerId: 1, name: "Disco", entrypoint: "run: python3 main.py", desiredState: "running", restartCount: 0, status: "stopped" };
let isProjects: (t: unknown) => boolean;
const statuses: string[] = [];
const db = {
  select: () => {
    let table: unknown;
    const q = { from(t: unknown) { table = t; return q; }, where() { return q; }, limit: async () => (isProjects(table) ? [project] : []), then: (r: (v: unknown[]) => void) => r([]) };
    return q;
  },
  update: () => ({ set: (v: { status?: string; statusMessage?: string | null }) => ({ where: async () => { if (v.status) statuses.push(`${v.status}|${v.statusMessage ?? ""}`); } }) }),
  insert: () => ({ values: async () => undefined }),
};
const supervisorStub = {
  botEnv: async (_p: unknown, python: string, d: string) => ({ PATH: `${path.dirname(python)}:${process.env.PATH}`, HOME: d, DISCORD_TOKEN: "super-secret-token-123", KOJY_ENTRY: "x" }),
  secrets: async () => ({ DISCORD_TOKEN: "super-secret-token-123" }),
};

let tools: typeof import("../../../apps/runner/src/agent/tools.js");
let autoFix: typeof import("../../../apps/runner/src/agent/autoFix.js");
let git: typeof import("../../../apps/runner/src/git.js");
let shared: typeof import("../../../packages/shared/src/projects/index.js");

beforeAll(async () => {
  mkdirSync(dir, { recursive: true });
  const schema = await import("../../../packages/db/src/schema.js");
  isProjects = (t) => t === schema.botProjects;
  tools = await import("../../../apps/runner/src/agent/tools.js");
  autoFix = await import("../../../apps/runner/src/agent/autoFix.js");
  git = await import("../../../apps/runner/src/git.js");
  shared = await import("../../../packages/shared/src/projects/index.js");
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

const ctx = (extra: Record<string, unknown> = {}) =>
  ({ db, supervisor: supervisorStub, project: { ...project }, snapshotted: false, changedFiles: new Set<string>(), ...extra }) as never;

describe("start commands", () => {
  it("are told apart from Highrise bot classes and checked", () => {
    const { entrypointProblem, isStartCommand, startCommand } = shared;
    expect(isStartCommand("run: python main.py")).toBe(true);
    expect(isStartCommand("bot:MyBot")).toBe(false);
    expect(startCommand("run:   node index.js ")).toBe("node index.js");
    expect(entrypointProblem("bot:MyBot")).toBeNull();
    expect(entrypointProblem("run: python main.py")).toBeNull();
    expect(entrypointProblem("run:")).toMatch(/after run:/);
    expect(entrypointProblem("run: a\nb")).toMatch(/one line/);
    expect(entrypointProblem("python main.py")).toMatch(/run: <command>/);
  });

  it("run as the bot: the supervisor starts the program, logs its output and marks it running", async () => {
    writeFileSync(path.join(dir, "main.py"), "import os, time\nprint('discord bot up', 'token set' if os.environ.get('HIGHRISE_X') is None else '')\ntime.sleep(30)\n");
    // A ready venv (the requirements marker matches), so nothing is installed.
    const venv = path.join(root, "venvs", UUID);
    mkdirSync(path.join(venv, "bin"), { recursive: true });
    symlinkSync("/usr/bin/python3", path.join(venv, "bin", "python"));
    writeFileSync(path.join(venv, ".kojy-requirements"), createHash("sha256").update("highrise-bot-sdk==25.1.0\nsetuptools<82\n").digest("hex"));
    const { Supervisor } = await import("../../../apps/runner/src/supervisor.js");
    const sup = new Supervisor(db as never);
    await sup.handle(UUID, "start");
    const log = () => (existsSync(path.join(root, "projects", ".logs", `${UUID}.log`)) ? readFileSync(path.join(root, "projects", ".logs", `${UUID}.log`), "utf8") : "");
    for (let i = 0; i < 100 && !log().includes("discord bot up"); i++) await new Promise((r) => setTimeout(r, 100));
    expect(log()).toContain("▶ Starting run: python3 main.py");
    expect(log()).toContain("discord bot up");
    expect(statuses).toContain("running|");
    expect(sup.isRunning(UUID)).toBe(true);
    await sup.handle(UUID, "stop");
    expect(sup.isRunning(UUID)).toBe(false);
  }, 30_000);
});

describe("Kojy's run_command", () => {
  it("runs in the bot's folder with its environment, hides secret values, and keeps a snapshot to undo", async () => {
    const c = ctx();
    const r = await tools.runTool("run_command", { command: "pwd; echo token=$DISCORD_TOKEN; echo entry=${KOJY_ENTRY:-none}; touch made-by-kojy.txt" }, c);
    expect(r.ok).toBe(true);
    expect(r.output).toContain(dir);
    expect(r.output).toContain("token=[secret]");
    expect(r.output).not.toContain("super-secret-token-123");
    expect(r.output).toContain("entry=none");
    expect(existsSync(path.join(dir, "made-by-kojy.txt"))).toBe(true);
    expect((c as { snapshotted: boolean }).snapshotted).toBe(true);
    expect(r.summary).toMatch(/^Ran `pwd;/);
  });

  it("reports failures and stops commands that run too long", async () => {
    const fail = await tools.runTool("run_command", { command: "exit 3" }, ctx());
    expect(fail).toMatchObject({ ok: false, summary: expect.stringMatching(/exit 3/) });
    const t0 = Date.now();
    const slow = await tools.runTool("run_command", { command: "sleep 30", timeout_seconds: 1 }, ctx());
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(slow).toMatchObject({ ok: false, summary: expect.stringMatching(/timed out/) });
  }, 20_000);

  it("is locked in automatic runs: needs the owner after a check-up, never in a crash fix", () => {
    expect(autoFix.automaticRefusal("checkup", "run_command", { command: "ls" }, () => "")).toMatch(/owner/);
    expect(autoFix.automaticRefusal("crash", "run_command", { command: "ls" }, () => "")).toMatch(/running shell commands/);
    expect(autoFix.automaticRefusal("crash", "git", { action: "push" }, () => "")).toMatch(/using git/);
    expect(autoFix.automaticRefusal("checkup", "git", { action: "push" }, () => "")).toMatch(/owner/);
  });
});

describe("Kojy's git tool", () => {
  it("says how to link a repo when there is none, then commits; push needs a GitHub account", async () => {
    const svc = new git.GitService(db as never, { publish: async () => 1 } as never);
    const st = await tools.runTool("git", { action: "status" }, ctx({ git: svc }));
    expect(st.output).toMatch(/Not linked to a GitHub repository/);

    expect((await svc.execute(UUID, { op: "connect", url: "me/disco" })).ok).toBe(true);
    const noMsg = await tools.runTool("git", { action: "commit" }, ctx({ git: svc }));
    expect(noMsg).toMatchObject({ ok: false, summary: "No commit message" });
    const c = await tools.runTool("git", { action: "commit", message: "Discord bot" }, ctx({ git: svc }));
    expect(c).toMatchObject({ ok: true, summary: "Committed: Discord bot" });
    expect(c.output).toMatch(/me\/disco on main/);

    const p = await tools.runTool("git", { action: "commit_and_push", message: "more" }, ctx({ git: svc }));
    expect(p.ok).toBe(false);
    expect(p.output).toMatch(/Connect your GitHub account/);
  });

  it("won't run without the git service", async () => {
    expect(await tools.runTool("git", { action: "status" }, ctx())).toMatchObject({ ok: false, summary: "Git unavailable" });
  });

  it("refuses the fake Highrise room for a program that isn't a Highrise bot", async () => {
    const r = await tools.runTool("test_in_room", { chat: ["hi"] }, ctx());
    expect(r).toMatchObject({ ok: false, summary: "Not a Highrise bot" });
  });
});
