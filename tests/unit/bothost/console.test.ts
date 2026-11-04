/**
 * A bot host's live console against a stand-in node (a real websocket):
 * authenticating with the panel's Origin, lines without colour codes, the
 * power state and stats, renewing the token on the same socket, reconnecting
 * after a drop, giving up for good on a suspended server or a refused key,
 * and which lines of the host's recent history are new after a gap.
 */
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { HostApiError, HostConsole, unseenLines, type PowerState } from "../../../packages/shared/src/bothost/index.js";

let wss: WebSocketServer;
let url = "";
let onAuth: (socket: WebSocket, token: string, n: number) => void = () => undefined;
let connections = 0;
const origins: string[] = [];

beforeAll(async () => {
  wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/api/servers/abcd/ws`;
  wss.on("connection", (socket, req) => {
    const n = ++connections;
    origins.push(String(req.headers.origin));
    socket.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { event: string; args?: string[] };
      if (msg.event === "auth") onAuth(socket, msg.args?.[0] ?? "", n);
    });
  });
});
afterAll(() => new Promise<void>((r) => wss.close(() => r())));
beforeEach(() => { connections = 0; origins.length = 0; });

const send = (socket: WebSocket, event: string, args?: string[]) => socket.send(JSON.stringify(args ? { event, args } : { event }));
const until = async (check: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); };

function collect() {
  const seen = { lines: [] as string[], states: [] as PowerState[], ready: [] as boolean[], ended: [] as string[], memory: 0, tokens: [] as string[] };
  return seen;
}

describe("live console", () => {
  it("authenticates with the panel's Origin and passes on lines, the power state and stats", async () => {
    const seen = collect();
    onAuth = (socket, token) => {
      seen.tokens.push(token);
      send(socket, "auth success");
      send(socket, "status", ["running"]);
      send(socket, "console output", ["\u001b[33m\u001b[1mhello\u001b[0m room\r"]);
      send(socket, "console output", ["two\nlines"]);
      send(socket, "stats", [JSON.stringify({ memory_bytes: 50 * 1048576, memory_limit_bytes: 256 * 1048576, cpu_absolute: 1.5, disk_bytes: 10, uptime: 5000, state: "running" })]);
    };
    const c = new HostConsole({
      credentials: async () => ({ token: "token-1", socket: url }), origin: "https://panel.test", minCredentialGapMs: 0,
      events: { line: (l) => seen.lines.push(l), status: (s) => seen.states.push(s), ready: (a) => seen.ready.push(a), stats: (s) => { seen.memory = s.memoryBytes; } },
    });
    c.start();
    await until(() => seen.memory > 0);
    c.close();
    expect(origins).toEqual(["https://panel.test"]);
    expect(seen.tokens).toEqual(["token-1"]);
    expect(seen.ready).toEqual([false]);
    expect(seen.states).toEqual(["running"]);
    expect(seen.lines).toEqual(["hello room", "two", "lines"]);
    expect(seen.memory).toBe(50 * 1048576);
  });

  it("renews the token on the same socket when the node says it's expiring", async () => {
    const seen = collect();
    let issued = 0;
    onAuth = (socket, token) => {
      seen.tokens.push(token);
      if (token === "token-1") { send(socket, "auth success"); send(socket, "token expiring"); }
    };
    const c = new HostConsole({
      credentials: async () => ({ token: `token-${++issued}`, socket: url }), origin: "https://panel.test", minCredentialGapMs: 0,
      events: { line: () => undefined, status: () => undefined },
    });
    c.start();
    await until(() => seen.tokens.length >= 2);
    c.close();
    expect(seen.tokens).toEqual(["token-1", "token-2"]);
    expect(connections).toBe(1);
  });

  it("reconnects after the socket drops, and says the second time is a reconnect", async () => {
    const seen = collect();
    onAuth = (socket, _token, n) => {
      send(socket, "auth success");
      if (n === 1) setTimeout(() => socket.close(1011), 20);
    };
    const c = new HostConsole({
      credentials: async () => ({ token: "t", socket: url }), origin: "https://panel.test", minCredentialGapMs: 0, delaysMs: [10],
      events: { line: () => undefined, status: () => undefined, ready: (a) => seen.ready.push(a) },
    });
    c.start();
    await until(() => seen.ready.length >= 2);
    c.close();
    expect(seen.ready).toEqual([false, true]);
    expect(connections).toBe(2);
  });

  it("stops for good on a suspended server (4409) or a refused key", async () => {
    const seen = collect();
    onAuth = (socket) => { send(socket, "auth success"); setTimeout(() => socket.close(4409), 10); };
    const c = new HostConsole({
      credentials: async () => ({ token: "t", socket: url }), origin: "https://panel.test", minCredentialGapMs: 0, delaysMs: [10],
      events: { line: () => undefined, status: () => undefined, ended: (why) => seen.ended.push(why) },
    });
    c.start();
    await until(() => seen.ended.length > 0);
    await new Promise((r) => setTimeout(r, 150));
    expect(seen.ended).toEqual(["The host suspended this server."]);
    expect(connections).toBe(1);

    const refused = collect();
    const k = new HostConsole({
      credentials: async () => { throw new HostApiError(401, "Test Host refused the API key."); }, origin: "https://panel.test", minCredentialGapMs: 0, delaysMs: [10],
      events: { line: () => undefined, status: () => undefined, ended: (why) => refused.ended.push(why) },
    });
    k.start();
    await until(() => refused.ended.length > 0);
    expect(refused.ended).toEqual(["Test Host refused the API key."]);
    expect(connections).toBe(1);
  });
});

describe("filling a gap from the host's recent history", () => {
  it("keeps only what comes after the last lines already saved", () => {
    expect(unseenLines(["a", "b", "c", "d", "e"], ["x", "a", "b", "c"])).toEqual(["d", "e"]);
    // Repeated lines: the last place the saved lines appear counts.
    expect(unseenLines(["p", "p", "p", "q", "p", "p", "p", "r"], ["q", "p", "p", "p"])).toEqual(["r"]);
    expect(unseenLines(["new 1", "new 2"], ["old 1", "old 2", "old 3"])).toEqual(["new 1", "new 2"]);
    expect(unseenLines(["a", "b"], [])).toEqual(["a", "b"]);
    expect(unseenLines(["a", "b", "c"], ["b"])).toEqual(["c"]);
    expect(unseenLines(["a", "b", "c"], ["a", "b", "c"])).toEqual([]);
  });
});
