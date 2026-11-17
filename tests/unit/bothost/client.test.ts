/**
 * The bot-host panel client against a stand-in panel: the API key and JSON
 * headers, the panel's own error messages, waiting on 429 and retrying a busy
 * read (but never a busy create), raw file writes, which startup variable is
 * the Python file, and the checks on addresses the panel hands out.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BotHostClient, HostApiError, onDomains, pythonFileVariable, type BotHostProvider } from "../../../packages/shared/src/bothost/index.js";

interface Hit { method: string; url: string; auth: string; accept: string; type: string; body: string }
interface Reply { status: number; body?: unknown; headers?: Record<string, string> }

let server: http.Server;
let base = "";
let hits: Hit[] = [];
let replies: Reply[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method ?? "", url: req.url ?? "", auth: String(req.headers.authorization ?? ""), accept: String(req.headers.accept ?? ""), type: String(req.headers["content-type"] ?? ""), body });
      const r = replies.shift() ?? { status: 204 };
      res.writeHead(r.status, { "content-type": "application/json", ...r.headers });
      res.end(r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/panel/api/client`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { hits = []; replies = []; });

const provider = (): BotHostProvider => ({
  id: "test", label: "Test Host", apiUrl: base, origin: "https://panel.test", nodeDomains: ["nodes.test"], freeServers: true, keyHelp: "", keyPattern: /.*/,
});
const sleeps: number[] = [];
const client = () => new BotHostClient({ provider: provider(), apiKey: "sdevc_testkey123", sleep: async (ms) => { sleeps.push(ms); } });
const serverAttrs = {
  identifier: "abcd1234", uuid: "abcd1234-0000", name: "Japalo", node: "London 3", limits: { memory: 256, disk: 512, cpu: 25 },
  docker_image: "ghcr.io/pterodactyl/yolks:python_3.12", invocation: "python /home/container/bot.py", is_installing: false, is_suspended: false, is_transferring: false,
};

describe("talking to the panel", () => {
  it("sends the key as a bearer token and reads a server", async () => {
    replies.push({ status: 200, body: { object: "server", attributes: serverAttrs } });
    const s = await client().getServer("abcd1234");
    expect(s).toMatchObject({ id: "abcd1234", name: "Japalo", node: "London 3", memoryMb: 256, diskMb: 512, dockerImage: "ghcr.io/pterodactyl/yolks:python_3.12", installing: false });
    expect(hits[0]).toMatchObject({ method: "GET", url: "/panel/api/client/servers/abcd1234", auth: "Bearer sdevc_testkey123", accept: "application/json" });
  });

  it("passes on the panel's own message, and doesn't retry a refused create", async () => {
    replies.push({ status: 503, body: { errors: [{ code: "ServiceUnavailableHttpException", status: "503", detail: "Free servers are full right now." }] } });
    const err = await client().createFreeServer({ name: "Japalo", description: "x", runtime: "python" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostApiError);
    expect(err).toMatchObject({ status: 503, message: "Free servers are full right now." });
    expect(hits).toHaveLength(1);
    expect(JSON.parse(hits[0]!.body)).toEqual({ name: "Japalo", description: "x", runtime: "python" });

    replies.push({ status: 401, body: "" });
    await expect(client().account()).rejects.toThrow(/refused the API key/);
  });

  it("waits out a 429 (its Retry-After) and retries a busy read once", async () => {
    sleeps.length = 0;
    replies.push({ status: 429, headers: { "retry-after": "7" } }, { status: 204 });
    await client().power("abcd1234", "restart");
    expect(hits.map((h) => h.method)).toEqual(["POST", "POST"]);
    expect(JSON.parse(hits[1]!.body)).toEqual({ signal: "restart" });
    expect(sleeps).toEqual([7000]);

    hits = [];
    replies.push({ status: 502 }, { status: 200, body: { object: "stats", attributes: { current_state: "running", resources: { memory_bytes: 1048576, disk_bytes: 5, uptime: 9000 } } } });
    expect(await client().resources("abcd1234")).toEqual({ state: "running", memoryBytes: 1048576, diskBytes: 5, uptimeMs: 9000 });
    expect(hits).toHaveLength(2);
  });

  it("writes a file's raw contents (text or binary) to the path in the query", async () => {
    await client().writeFile("abcd1234", "cogs/fun.py", "print('hi')\n");
    expect(hits[0]).toMatchObject({ method: "POST", url: "/panel/api/client/servers/abcd1234/files/write?file=cogs%2Ffun.py", type: "text/plain", body: "print('hi')\n" });
    await client().writeFile("abcd1234", "data/x.db", new Uint8Array([1, 2, 3]));
    expect(hits[1]!.type).toBe("application/octet-stream");
    await client().deleteFiles("abcd1234", ["old.py", ".kojy"]);
    expect(JSON.parse(hits[2]!.body)).toEqual({ root: "/", files: ["old.py", ".kojy"] });
  });

  it("reads the free-server allowance, and the startup settings", async () => {
    replies.push({ status: 200, body: { object: "server_creation", attributes: { limit: 2, servers_owned: 0, can_create: true, free_full: true, runtimes: [{ key: "nodejs" }, { key: "python" }] } } });
    expect(await client().freeServerOptions()).toEqual({ limit: 2, owned: 0, canCreate: true, full: true, runtimes: ["nodejs", "python"] });
    replies.push({ status: 404, body: { errors: [{ detail: "Not found" }] } });
    expect(await client().freeServerOptions()).toBeNull();

    replies.push({ status: 200, body: {
      data: [{ attributes: { name: "Bot file", env_variable: "BOT_PY_FILE", server_value: "bot.py", default_value: "bot.py", is_editable: true } }],
      meta: { raw_startup_command: "python /home/container/{{BOT_PY_FILE}}", docker_images: { "Python 3.12": "ghcr.io/pterodactyl/yolks:python_3.12" } },
    } });
    const startup = await client().startup("abcd1234");
    expect(startup.variables).toEqual([{ name: "Bot file", env: "BOT_PY_FILE", value: "bot.py", defaultValue: "bot.py", editable: true }]);
    expect(pythonFileVariable(startup)).toBe("BOT_PY_FILE");
  });
});

describe("which startup variable is the Python file", () => {
  it("is the one the command uses whose value is a .py file", () => {
    // Pterodactyl's generic Python egg.
    expect(pythonFileVariable({
      rawCommand: "if [[ -f /home/container/${REQUIREMENTS_FILE} ]]; then pip install -r ${REQUIREMENTS_FILE}; fi; /usr/local/bin/python /home/container/{{PY_FILE}}",
      variables: [
        { name: "Requirements", env: "REQUIREMENTS_FILE", value: "requirements.txt", defaultValue: "requirements.txt", editable: true },
        { name: "App py file", env: "PY_FILE", value: "app.py", defaultValue: "app.py", editable: true },
      ],
      dockerImages: {},
    })).toBe("PY_FILE");
    expect(pythonFileVariable({ rawCommand: "node {{MAIN_FILE}}", variables: [{ name: "Main", env: "MAIN_FILE", value: "index.js", defaultValue: "index.js", editable: false }], dockerImages: {} })).toBeNull();
  });
});

describe("addresses from the panel", () => {
  it("must be on the host's own domains", async () => {
    replies.push({ status: 200, body: { data: { token: "jwt", socket: "wss://169.254.169.254/latest/meta-data" } } });
    await expect(client().consoleCredentials("abcd1234")).rejects.toThrow(/outside its own servers/);
    replies.push({ status: 200, body: { data: { token: "jwt", socket: "wss://lon3.nodes.test:8080/api/servers/abcd/ws" } } });
    expect(await client().consoleCredentials("abcd1234")).toEqual({ token: "jwt", socket: "wss://lon3.nodes.test:8080/api/servers/abcd/ws" });

    expect(onDomains("wss://nodes.test.evil.com/ws", ["nodes.test"], ["wss:"])).toBe(false);
    expect(onDomains("ws://lon3.nodes.test/ws", ["nodes.test"], ["wss:"])).toBe(false);
    expect(onDomains("https://user:pw@lon3.nodes.test/x", ["nodes.test"], ["https:"])).toBe(false);
    expect(onDomains("https://evilnodes.test/x", ["nodes.test"], ["https:"])).toBe(false);
  });

  it("refuses a server identifier that could change the path", async () => {
    await expect(client().getServer("../account")).rejects.toThrow(/Not a server identifier/);
    expect(hits).toHaveLength(0);
  });
});
