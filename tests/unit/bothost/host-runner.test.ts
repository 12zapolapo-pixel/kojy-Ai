/**
 * A bot on a bot host, end to end through the supervisor, with a stand-in
 * host (its files, power and live console):
 * - the first start uploads the code, KojyAI's launcher and starter, the
 *   package list and the settings with the decrypted secrets; data files once
 * - the host's console goes into the bot's log; room activity and the host's
 *   own lines are handled apart
 * - a crash there is counted with the host's exit code, Kojy gets the
 *   traceback, and the bot is started again
 * - a later start sends only what changed and removes deleted files; a stop
 *   is no crash
 * - a KojyAI restart reattaches without touching the bot and fills the gap
 * - moving off the host copies its data back and removes its settings there
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ConsoleOptions, PowerState } from "../../../packages/shared/src/bothost/index.js";

const root = mkdtempSync(path.join(tmpdir(), "kojy-host-"));
const UUID = "11111111-2222-4333-8444-555555555555";
const projectDir = path.join(root, "projects", UUID);

type Row = Record<string, unknown> & { hostSync?: { server: string; files: Record<string, string>; dataUploaded: boolean } | null };
const project: Row = {};
let host: Row = {};
let secrets: Row[] = [];
let schema: typeof import("../../../packages/db/src/schema.js");

function rowsFor(table: unknown): Row[] {
  if (table === schema.botProjects) return [project];
  if (table === schema.botHosts) return [host];
  if (table === schema.projectSecrets) return secrets;
  return [];
}
const db = {
  select: () => {
    let table: unknown;
    const q = {
      from(t: unknown) { table = t; return q; },
      leftJoin() { return q; },
      where() { return q; },
      orderBy() { return q; },
      limit: async () => rowsFor(table),
      then(resolve: (v: Row[]) => unknown, reject?: (e: unknown) => unknown) { return Promise.resolve(rowsFor(table)).then(resolve, reject); },
    };
    return q;
  },
  update: (t: unknown) => ({ set: (v: Row) => ({ where: async () => { if (t === schema.botProjects) Object.assign(project, v); } }) }),
  insert: () => ({ values: async () => undefined }),
};

const consoles: FakeConsole[] = [];
class FakeConsole {
  logsAsked = 0;
  private open = false;
  constructor(readonly options: ConsoleOptions) {}
  start() { consoles.push(this); setImmediate(() => { this.open = true; this.options.events.ready?.(false); }); }
  close() { this.open = false; }
  get isReady() { return this.open; }
  requestLogs() { this.logsAsked++; }
  line(text: string) { this.options.events.line(text); }
  status(state: PowerState) { this.options.events.status(state); }
}

class FakeHost {
  provider = { id: "sillydev", label: "Silly Development" };
  files = new Map<string, Buffer>();
  calls: string[] = [];
  state: PowerState = "offline";
  startupValue = "bot.py";
  async getServer() {
    return { id: "abcd1234", uuid: "u", name: "Japalo", node: "London 3", memoryMb: 256, diskMb: 512, cpuPercent: 25, dockerImage: this.image, invocation: "", installing: false, suspended: false, transferring: false };
  }
  async resources() { return { state: this.state, memoryBytes: 0, diskBytes: 0, uptimeMs: 60_000 }; }
  requirementsValue = "requirements.txt";
  image = "ghcr.io/ptero-eggs/yolks:python_3.13";
  async startup() {
    return {
      variables: [
        { name: "Bot file", env: "BOT_PY_FILE", value: this.startupValue, defaultValue: "bot.py", editable: true },
        { name: "Requirements file", env: "REQUIREMENTS_FILE", value: this.requirementsValue, defaultValue: "requirements.txt", editable: true },
      ],
      rawCommand: "pip install -r ${REQUIREMENTS_FILE}; python /home/container/{{BOT_PY_FILE}}",
      dockerImages: { "Python 3.13": "ghcr.io/ptero-eggs/yolks:python_3.13", "Python 3.11": "ghcr.io/ptero-eggs/yolks:python_3.11" },
    };
  }
  async setDockerImage(_id: string, image: string) { this.image = image; this.calls.push(`image ${image}`); }
  async setStartupVariable(_id: string, key: string, value: string) {
    if (key === "BOT_PY_FILE") this.startupValue = value; else this.requirementsValue = value;
    this.calls.push(`startup ${key}=${value}`);
  }
  async writeFile(_id: string, file: string, content: string | Uint8Array) { this.files.set(file, Buffer.from(content)); this.calls.push(`write ${file}`); }
  async deleteFiles(_id: string, names: string[]) {
    for (const n of names) for (const k of [...this.files.keys()]) if (k === n || k.startsWith(`${n}/`)) this.files.delete(k);
    this.calls.push(`delete ${names.join(",")}`);
  }
  async power(_id: string, signal: string) {
    this.calls.push(`power ${signal}`);
    const c = consoles.at(-1);
    if (signal === "start") setImmediate(() => { c?.status("starting"); this.state = "running"; c?.status("running"); });
    if (signal === "stop" || signal === "kill") { this.state = "offline"; setImmediate(() => { c?.status("stopping"); c?.status("offline"); }); }
  }
  async command(_id: string, text: string) { this.calls.push(`command ${text}`); }
  async listDir(_id: string, dir: string) {
    const prefix = dir === "/" || dir === "" ? "" : `${dir}/`;
    const seen = new Map<string, { name: string; isFile: boolean; size: number }>();
    for (const [k, v] of this.files) {
      if (!k.startsWith(prefix)) continue;
      const [first, ...more] = k.slice(prefix.length).split("/");
      seen.set(first!, { name: first!, isFile: more.length === 0, size: more.length ? 0 : v.length });
    }
    return [...seen.values()];
  }
  async downloadFile(_id: string, file: string) { return new Uint8Array(this.files.get(file)!); }
}

const fake = new FakeHost();
const keysUsed: string[] = [];
const crashes: { streak: number; tail: string[] }[] = [];
let Supervisor: typeof import("../../../apps/runner/src/supervisor.js").Supervisor;
const testing = {
  makeClient: (_p: unknown, apiKey: string) => { keysUsed.push(apiKey); return fake as never; },
  makeConsole: (o: ConsoleOptions) => new FakeConsole(o) as never,
};

const logLines = () => readFileSync(path.join(root, "projects", ".logs", `${UUID}.log`), "utf8").trim().split("\n")
  .map((l) => JSON.parse(l) as { stream: string; line: string })
  .map(({ stream, line }) => ({ stream, line })); // without the time
const consoleLines = () => logLines().map((l) => l.line);
const until = async (check: () => boolean) => { for (let i = 0; i < 3000 && !check(); i++) await new Promise((r) => setImmediate(r)); };

beforeAll(async () => {
  process.env.PROJECTS_DIR = path.join(root, "projects");
  process.env.VENVS_DIR = path.join(root, "venvs");
  process.env.RUNNER_SANDBOX = "off";
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
  mkdirSync(path.join(projectDir, "data"), { recursive: true });
  writeFileSync(path.join(projectDir, "bot.py"), "class MyBot: pass\n");
  writeFileSync(path.join(projectDir, "requirements.txt"), "aiohttp\n");
  writeFileSync(path.join(projectDir, "data", "players.json"), '{"kojy_": 10}');
  writeFileSync(path.join(projectDir, "scores.db"), "SQLITE");
  ({ Supervisor } = await import("../../../apps/runner/src/supervisor.js"));
  schema = await import("../../../packages/db/src/schema.js");
  const { encryptApiKey } = await import("../../../packages/shared/src/crypto/index.js");
  Object.assign(project, {
    id: 5, uuid: UUID, orgId: 1, ownerId: 1, name: "Japalo", entrypoint: "bot:MyBot", desiredState: "running", status: "stopped",
    statusMessage: null, restartCount: 0, lastExitCode: null, hostId: 7, hostServer: "abcd1234", hostSync: null,
  });
  host = { id: 7, orgId: 1, provider: "sillydev", account: "kojyai", apiKeyVault: encryptApiKey("sdevc_fakefakefakefakefake1"), keyHint: "" };
  secrets = [
    { projectId: 5, key: "HIGHRISE_BOT_TOKEN", valueVault: encryptApiKey("hr-token-123") },
    { projectId: 5, key: "HIGHRISE_ROOM_ID", valueVault: encryptApiKey("room-1") },
  ];
}, 30_000); // loading the runner's modules takes a while when every test file runs at once
afterEach(() => { vi.useRealTimers(); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe("a bot on a bot host", () => {
  let sup: InstanceType<typeof Supervisor>;

  it("first start: uploads the bot, KojyAI's files and the settings, points the server at the starter and powers it on", async () => {
    sup = new Supervisor(db as never, testing);
    sup.onCrash = (_uuid, streak, tail) => crashes.push({ streak, tail });
    await sup.handle(UUID, "start");
    await until(() => project.status === "running");
    expect(project.status).toBe("running");
    expect(keysUsed[0]).toBe("sdevc_fakefakefakefakefake1");
    expect([...fake.files.keys()].sort()).toEqual([
      ".kojy/env.json", ".kojy/requirements.txt", "bot.py", "data/players.json", "kojy_launcher.py", "kojy_start.py", "requirements.txt", "scores.db",
    ]);
    expect(JSON.parse(fake.files.get(".kojy/env.json")!.toString())).toMatchObject({
      KOJY_ENTRY: "bot:MyBot", KOJY_ACTIVITY: "stdout", HIGHRISE_BOT_TOKEN: "hr-token-123", HIGHRISE_ROOM_ID: "room-1",
    });
    expect(fake.files.get(".kojy/requirements.txt")!.toString()).toBe("highrise-bot-sdk==25.1.0\nsetuptools<82\naiohttp\n");
    expect(fake.files.get("kojy_launcher.py")!.toString()).toContain("class Watchdog");
    expect(fake.files.get("kojy_start.py")!.toString()).toContain("def install_packages");
    expect(fake.startupValue).toBe("kojy_start.py");
    // Python 3.11 like the runner (the SDK doesn't install on 3.13), and the panel's own install off.
    expect(fake.image).toBe("ghcr.io/ptero-eggs/yolks:python_3.11");
    expect(fake.requirementsValue).toBe("kojy-no-requirements.txt");
    expect(consoleLines()).toContain("Switched Silly Development, server abcd1234 to Python 3.11, the version KojyAI runs bots on.");
    expect(fake.calls.at(-1)).toBe("power start");
    expect(project.hostSync).toMatchObject({ server: "abcd1234", dataUploaded: true });
    expect(Object.keys(project.hostSync!.files)).not.toContain("data/players.json");
    expect(consoleLines()).toContainEqual(expect.stringMatching(/^▶ Starting bot:MyBot on Silly Development, server abcd1234/));
    expect(sup.isRunning(UUID)).toBe(true);
    expect(sup.hostNote(UUID)).toMatch(/^Runs on Silly Development, server abcd1234 \(London 3\): 256 MB memory/);
  });

  it("the host's console goes into the bot's log; activity and the host's own lines are handled apart", async () => {
    const c = consoles.at(-1)!;
    c.line("hello room");
    c.line('[kojy:activity] {"k":"chat","id":"u1","n":"Kojy_"}');
    c.line("[kojy] Room rights: the bot is NOT a moderator in this room — commands that move, kick, mute or ban people won't work until the room owner makes it a moderator.");
    await until(() => String(project.statusMessage ?? "").startsWith("Not a moderator"));
    const lines = logLines();
    expect(lines).toContainEqual({ stream: "stdout", line: "hello room" });
    expect(lines.some((l) => l.line.includes("kojy:activity"))).toBe(false);
    expect(project.statusMessage).toMatch(/^Not a moderator in its room/);
  });

  it("a crash there is counted with the host's exit code, Kojy gets the traceback, and the bot starts again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const c = consoles.at(-1)!;
    const mark = fake.calls.length;
    c.line("Traceback (most recent call last):");
    c.line('  File "/home/container/bot.py", line 3, in on_chat');
    c.line("ZeroDivisionError: division by zero");
    c.line("[Pterodactyl Daemon]: Exit code: 1");
    fake.state = "offline";
    c.status("offline");
    await vi.advanceTimersByTimeAsync(1_600);
    await until(() => project.status === "crashed");
    expect(project.lastExitCode).toBe(1);
    expect(logLines()).toContainEqual({ stream: "system", line: "Host: Exit code: 1" });
    expect(consoleLines().some((l) => /^✖ Bot exited \(code 1\) after \d+s — restarting in 5s$/.test(l))).toBe(true);
    expect(crashes).toHaveLength(1);
    expect(crashes[0]!.tail).toContain("ZeroDivisionError: division by zero");

    await vi.advanceTimersByTimeAsync(5_000);
    await until(() => project.status === "running");
    vi.useRealTimers();
    // Nothing changed here, so only the settings go up again.
    expect(fake.calls.slice(mark)).toEqual(["write .kojy/env.json", "power start"]);
  });

  it("a later start sends only what changed and removes deleted files; a stop is no crash", async () => {
    writeFileSync(path.join(projectDir, "bot.py"), "class MyBot:\n    x = 1\n");
    rmSync(path.join(projectDir, "requirements.txt"));
    const mark = fake.calls.length;
    const crashLines = consoleLines().filter((l) => l.startsWith("✖ Bot exited")).length;
    await sup.handle(UUID, "restart");
    await until(() => project.status === "running");
    const calls = fake.calls.slice(mark);
    expect(calls[0]).toBe("power stop");
    expect(calls).toEqual(expect.arrayContaining(["write bot.py", "write .kojy/requirements.txt", "write .kojy/env.json", "delete requirements.txt", "power start"]));
    expect(calls).not.toContain("write kojy_launcher.py");
    expect(calls).not.toContain("write data/players.json");
    expect(fake.files.get(".kojy/requirements.txt")!.toString()).toBe("highrise-bot-sdk==25.1.0\nsetuptools<82\n");

    await sup.handle(UUID, "stop");
    expect(project.status).toBe("stopped");
    expect(consoleLines().filter((l) => l.startsWith("✖ Bot exited")).length).toBe(crashLines);
    expect(crashes).toHaveLength(1);
  });

  it("a KojyAI restart reattaches without touching the bot, and adds the output from the gap", async () => {
    await sup.handle(UUID, "start");
    await until(() => project.status === "running");
    consoles.at(-1)!.line("before the restart");
    await sup.shutdown();
    const savedBefore = consoleLines();

    const sup2 = new Supervisor(db as never, testing);
    const mark = fake.calls.length;
    await sup2.handle(UUID, "start"); // what restoreAll does on boot
    const c2 = consoles.at(-1)!;
    await until(() => c2.logsAsked > 0);
    // The host's recent output: the bot's last lines already saved here, then what it said during the restart.
    const saved = logLines().filter((l) => l.stream === "stdout").map((l) => l.line);
    for (const l of [...saved.slice(-5), "said during the restart", "hello room", "and this too"]) c2.line(l);
    await new Promise((r) => setTimeout(r, 2_300));
    expect(fake.calls.slice(mark)).toEqual([]);
    expect(project.status).toBe("running");
    // Only the new lines (a repeat of an old line after the gap is new too).
    expect(consoleLines().slice(savedBefore.length)).toEqual(["said during the restart", "hello room", "and this too"]);
    sup = sup2;
  });

  it("moving off the host copies its data back and removes the settings (with the secrets) there", async () => {
    fake.files.set("data/players.json", Buffer.from('{"kojy_": 99}')); // the bot saved this on the host
    Object.assign(project, { hostId: null, hostServer: null, hostSync: null, desiredState: "stopped" });
    await sup.handle(UUID, "rehost", { from: { hostId: 7, server: "abcd1234" } });
    expect(readFileSync(path.join(projectDir, "data", "players.json"), "utf8")).toBe('{"kojy_": 99}');
    expect(fake.files.has(".kojy/env.json")).toBe(false);
    expect(fake.files.has("kojy_start.py")).toBe(false);
    expect(fake.files.has("bot.py")).toBe(true);
    expect(consoleLines()).toContain("■ Moved off Silly Development, server abcd1234; copied 2 data file(s) back.");
    expect(project.status).toBe("stopped");
    await sup.shutdown();
  });
});
