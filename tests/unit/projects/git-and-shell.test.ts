/**
 * Shell + Git panel (runner side): URL/branch checks, git's environment (the
 * token only as a github.com header, https only), the git operations against
 * a real repository, and a shell session through Terminals end to end.
 *
 * KOJY_NET_TESTS=1 also imports a real public GitHub repository.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isSafeBranch, normalizeGitHubUrl, type GitReply, type TermOut } from "@kojyai/shared/projects";
import { signBotControlMessage } from "@kojyai/shared/crypto";

const root = mkdtempSync(path.join(tmpdir(), "kojy-git-shell-"));
const UUID = "11111111-2222-4333-8444-555555555555";
process.env.PROJECTS_DIR = path.join(root, "projects");
process.env.VENVS_DIR = path.join(root, "venvs");
process.env.RUNNER_SANDBOX = "off";
process.env.ENCRYPTION_KEY ??= "a".repeat(64);
const projectDir = path.join(root, "projects", UUID);

const project = { id: 7, uuid: UUID, orgId: 1, ownerId: 1, name: "Japalo", entrypoint: "", desiredState: "stopped" };
// select().from(table).where().limit(): the project for bot_projects, no GitHub connection.
const db = {
  select: () => {
    let table: unknown;
    const q = { from(t: unknown) { table = t; return q; }, where() { return q; }, limit: async () => (isProjects(table) ? [project] : []) };
    return q;
  },
};
let isProjects: (t: unknown) => boolean;

/** Collects what the runner publishes. */
function fakeRedis() {
  const sent: { channel: string; message: string }[] = [];
  return { sent, publish: async (channel: string, message: string) => { sent.push({ channel, message }); return 1; } };
}

let git: typeof import("../../../apps/runner/src/git.js");
let terminal: typeof import("../../../apps/runner/src/terminal.js");

beforeAll(async () => {
  mkdirSync(projectDir, { recursive: true });
  const schema = await import("../../../packages/db/src/schema.js");
  isProjects = (t) => t === schema.botProjects;
  git = await import("../../../apps/runner/src/git.js");
  terminal = await import("../../../apps/runner/src/terminal.js");
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe("GitHub addresses and branch names", () => {
  it("accepts GitHub repositories in the usual forms, as their https clone URL", () => {
    expect(normalizeGitHubUrl("https://github.com/me/my-bot")).toBe("https://github.com/me/my-bot.git");
    expect(normalizeGitHubUrl("https://github.com/me/my-bot.git")).toBe("https://github.com/me/my-bot.git");
    expect(normalizeGitHubUrl("http://www.github.com/me/my.bot/")).toBe("https://github.com/me/my.bot.git");
    expect(normalizeGitHubUrl("me/my_bot")).toBe("https://github.com/me/my_bot.git");
  });

  it("refuses anything that isn't a GitHub https repository", () => {
    for (const bad of [
      "https://gitlab.com/me/bot", "git@github.com:me/bot.git", "ssh://github.com/me/bot", "file:///etc",
      "https://github.com/me", "https://github.com/me/bot/tree/main", "https://user:pw@github.com/me/bot",
      "https://github.com.evil.com/me/bot", "ext::sh -c touch% /tmp/pwned", "https://github.com/me/..", "-u/x",
    ]) expect(normalizeGitHubUrl(bad), bad).toBeNull();
  });

  it("allows ordinary branch names only", () => {
    for (const ok of ["main", "master", "feature/dance", "v1.2", "fix_bug-3"]) expect(isSafeBranch(ok), ok).toBe(true);
    for (const bad of ["", "-f", "--upload-pack=x", "a..b", "a b", "HEAD", "x.lock", "/a", "a/", "a//b", "a~1", "a^", "a:b"]) {
      expect(isSafeBranch(bad), bad).toBe(false);
    }
  });
});

describe("git's environment", () => {
  const vars = (env: NodeJS.ProcessEnv) => {
    const out: Record<string, string> = {};
    for (let i = 0; i < Number(env.GIT_CONFIG_COUNT); i++) out[env[`GIT_CONFIG_KEY_${i}`]!] = env[`GIT_CONFIG_VALUE_${i}`]!;
    return out;
  };

  it("sends the token only as a header for github.com, and only allows https", () => {
    const env = git.gitEnv("/p", { name: "Jay", email: "1+jay@users.noreply.github.com" }, "ghp_secret123");
    const cfg = vars(env);
    expect(cfg["http.https://github.com/.extraHeader"]).toBe(`Authorization: Basic ${Buffer.from("x-access-token:ghp_secret123").toString("base64")}`);
    expect(Object.keys(cfg).filter((k) => k.toLowerCase().includes("extraheader"))).toEqual(["http.https://github.com/.extraHeader"]);
    expect(cfg["protocol.allow"]).toBe("never");
    expect(cfg["protocol.https.allow"]).toBe("always");
    expect(cfg["safe.directory"]).toBe("/p");
    expect(cfg["user.email"]).toBe("1+jay@users.noreply.github.com");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    // Nothing of the runner's own environment (its secrets) comes along.
    expect(env.ENCRYPTION_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("has no auth header without a token", () => {
    expect(Object.values(vars(git.gitEnv("/p", null, null))).some((v) => v.includes("Authorization"))).toBe(false);
  });

  it("reads git's branch line", () => {
    expect(git.parseBranchLine("main...origin/main [ahead 2, behind 1]")).toEqual({ branch: "main", tracking: true, ahead: 2, behind: 1 });
    expect(git.parseBranchLine("main...origin/main")).toEqual({ branch: "main", tracking: true, ahead: 0, behind: 0 });
    expect(git.parseBranchLine("main")).toEqual({ branch: "main", tracking: false, ahead: 0, behind: 0 });
    expect(git.parseBranchLine("No commits yet on main")).toEqual({ branch: "main", tracking: false, ahead: 0, behind: 0 });
    expect(git.parseBranchLine("dev...origin/dev [gone]")).toMatchObject({ branch: "dev", tracking: false });
  });
});

describe("Git panel operations", () => {
  const call = async (payload: Record<string, unknown>): Promise<GitReply> => {
    const redis = fakeRedis();
    const svc = new git.GitService(db as never, redis as never);
    const requestId = crypto.randomUUID();
    await svc.handle(UUID, { requestId, ...payload });
    expect(redis.sent).toHaveLength(1);
    expect(redis.sent[0]!.channel).toBe(`runner_reply:${requestId}`);
    return JSON.parse(redis.sent[0]!.message) as GitReply;
  };

  it("reports no repository before one is connected", async () => {
    const r = await call({ op: "status" });
    expect(r).toMatchObject({ ok: true, status: { repo: false, changes: [], commits: [] } });
  });

  it("refuses a remote that isn't GitHub", async () => {
    const r = await call({ op: "connect", url: "file:///etc" });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/GitHub repository address/);
    expect(existsSync(path.join(projectDir, ".git"))).toBe(false);
  });

  it("connects a repository: git init, the remote, and a .gitignore that keeps the bot's data out", async () => {
    writeFileSync(path.join(projectDir, "main.py"), "print('hi')\n");
    mkdirSync(path.join(projectDir, "data"), { recursive: true });
    writeFileSync(path.join(projectDir, "data", "coins.json"), "{}");
    writeFileSync(path.join(projectDir, "bot.db"), "x");
    const r = await call({ op: "connect", url: "https://github.com/me/japalo", branch: "main" });
    expect(r).toMatchObject({ ok: true, message: "Connected to me/japalo." });
    if (!r.ok) return;
    expect(r.status).toMatchObject({ repo: true, branch: "main", remote: "https://github.com/me/japalo.git", tracking: false });
    expect(r.status.changes.map((c) => c.path).sort()).toEqual([".gitignore", "main.py"]);
    expect(readFileSync(path.join(projectDir, ".gitignore"), "utf8")).toContain("*.db");
  });

  it("commits everything, and says so when there's nothing to commit", async () => {
    expect(await call({ op: "commit", message: "  " })).toMatchObject({ ok: false, message: expect.stringMatching(/short message/) });
    const r = await call({ op: "commit", message: "First version" });
    expect(r).toMatchObject({ ok: true, message: "Committed (2 files)." });
    if (r.ok) {
      expect(r.status.changes).toEqual([]);
      expect(r.status.commits).toHaveLength(1);
      expect(r.status.commits[0]).toMatchObject({ subject: "First version", author: "KojyAI" });
    }
    expect(await call({ op: "commit", message: "again" })).toMatchObject({ ok: false, message: "Nothing to commit — no files changed." });

    writeFileSync(path.join(projectDir, "main.py"), "print('hello')\n");
    const st = await call({ op: "status" });
    expect(st.ok && st.status.changes).toEqual([{ path: "main.py", status: "modified" }]);
  });

  it("won't push without a connected GitHub account", async () => {
    const r = await call({ op: "push" });
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/Connect your GitHub account/) });
  });

  it("won't pull over changes that aren't committed", async () => {
    // (Fails at the fetch first when offline; either way nothing is changed.)
    const r = await call({ op: "pull", branch: "main" });
    expect(r.ok).toBe(false);
    expect(readFileSync(path.join(projectDir, "main.py"), "utf8")).toBe("print('hello')\n");
  });

  it("ignores requests without a valid request id", async () => {
    const redis = fakeRedis();
    await new git.GitService(db as never, redis as never).handle(UUID, { requestId: "nope", op: "status" });
    expect(redis.sent).toEqual([]);
  });

  it.skipIf(!process.env.KOJY_NET_TESTS)("imports a public GitHub repository into an empty bot", async () => {
    rmSync(projectDir, { recursive: true, force: true });
    mkdirSync(projectDir, { recursive: true });
    const r = await call({ op: "import", url: "https://github.com/octocat/Hello-World" });
    expect(r).toMatchObject({ ok: true, message: "Got master from GitHub.", changedFiles: true });
    expect(existsSync(path.join(projectDir, "README"))).toBe(true);
    if (r.ok) expect(r.status).toMatchObject({ branch: "master", tracking: true, ahead: 0, behind: 0 });
    const again = await call({ op: "pull" });
    expect(again).toMatchObject({ ok: true, message: "Already up to date." });
  }, 60_000);
});

describe("shell", () => {
  const supervisor = {
    botEnv: async (_p: unknown, python: string, dir: string) => ({
      PATH: `${path.dirname(python)}:${process.env.PATH}`, HOME: dir, LANG: "C.UTF-8", HIGHRISE_ROOM_ID: "room-123", KOJY_ENTRY: "a:B",
    }),
  };
  const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const outputs = (redis: ReturnType<typeof fakeRedis>, sid = SID) =>
    redis.sent.filter((m) => m.channel === `term_out:${sid}`).map((m) => JSON.parse(m.message) as TermOut);
  const text = (redis: ReturnType<typeof fakeRedis>) =>
    outputs(redis).filter((m): m is Extract<TermOut, { t: "o" }> => m.t === "o").map((m) => Buffer.from(m.d, "base64").toString("utf8")).join("");
  const waitFor = async (check: () => boolean, ms = 15_000) => {
    const end = Date.now() + ms;
    while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    return check();
  };

  it("is refused when the sandbox isn't working (it would run as the runner's own user)", async () => {
    delete process.env.RUNNER_TERMINAL_UNSANDBOXED;
    const redis = fakeRedis();
    const t = new terminal.Terminals(db as never, supervisor as never, redis as never);
    await t.open(UUID, { sid: SID, cols: 80, rows: 24 });
    expect(outputs(redis)).toEqual([{ t: "err", m: expect.stringMatching(/needs the bot sandbox/) }]);
    expect(t.count()).toBe(0);
    t.closeAll();
  });

  it("runs commands in the bot's folder with its secrets, takes signed input only, and closes cleanly", async () => {
    process.env.RUNNER_TERMINAL_UNSANDBOXED = "true";
    const redis = fakeRedis();
    const t = new terminal.Terminals(db as never, supervisor as never, redis as never);
    await t.open(UUID, { sid: SID, cols: 100, rows: 30 });
    expect(await waitFor(() => outputs(redis).some((m) => m.t === "ready"))).toBe(true);
    expect(await waitFor(() => text(redis).includes("Japalo"))).toBe(true);

    // Unsigned or wrongly-signed input is dropped.
    t.input(SID, JSON.stringify({ action: "in", payload: { d: "echo UNSIGNED\r" }, ts: Date.now(), sig: "00" }));
    t.input(SID, signBotControlMessage("some-other-sid", "in", { d: "echo WRONGSID\r" }));
    t.input(SID, signBotControlMessage(SID, "resize", { cols: 120, rows: 40 }));
    t.input(SID, signBotControlMessage(SID, "in", { d: "pwd; echo room=$HIGHRISE_ROOM_ID entry=${KOJY_ENTRY:-none}; stty size; echo DONE-$((6*7))\r" }));
    expect(await waitFor(() => text(redis).includes("DONE-42"))).toBe(true);
    const out = text(redis);
    expect(out).toContain(projectDir);
    expect(out).toContain("room=room-123 entry=none");
    expect(out).toContain("40 120");
    expect(out).not.toContain("UNSIGNED\r\n");
    expect(out).not.toContain("WRONGSID");
    expect(existsSync(path.join(root, "venvs", UUID, "bin", "python"))).toBe(true);

    t.input(SID, signBotControlMessage(SID, "close"));
    expect(await waitFor(() => outputs(redis).some((m) => m.t === "exit"))).toBe(true);
    expect(t.count()).toBe(0);
    t.closeAll();
  }, 60_000);

  it("allows at most 3 shells per bot", async () => {
    process.env.RUNNER_TERMINAL_UNSANDBOXED = "true";
    const redis = fakeRedis();
    const t = new terminal.Terminals(db as never, supervisor as never, redis as never);
    const sids = [1, 2, 3, 4].map((n) => `aaaaaaaa-bbbb-4ccc-8ddd-00000000000${n}`);
    for (const sid of sids) await t.open(UUID, { sid, cols: 80, rows: 24 });
    expect(t.count()).toBe(3);
    expect(outputs(redis, sids[3])).toEqual([{ t: "err", m: expect.stringMatching(/up to 3 shells/) }]);
    t.closeProject(UUID);
    expect(await waitFor(() => t.count() === 0)).toBe(true);
    t.closeAll();
  }, 60_000);
});
