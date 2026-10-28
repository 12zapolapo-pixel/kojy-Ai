/** L-35 reconnect cap, L-36 plan normalization, L-37 embedding timeout, L-38 docker re-check. */
import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import { WebSocketServer } from "../../packages/engine/node_modules/ws";
import { HighriseClient } from "../../packages/engine/src/runtime/HighriseClient";
import { normalizeTaskPlan, MAX_SCRIPT_NAME_LENGTH } from "../../packages/engine/src/delegation/AgentPlanner";
import { embed } from "../../packages/engine/src/runtime/EmbeddingProvider";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const plan = (o: Record<string, unknown> = {}) => ({ scriptName: "Emote commands", description: "d", requiredEvents: ["ChatEvent"], needsEmoteCatalog: false, ...o } as any);

describe("L-36 normalizeTaskPlan", () => {
  it("accepts a normal plan and fills defaults", () => { const p = normalizeTaskPlan(plan())!; expect(p.scriptName).toBe("Emote commands"); expect(p.complexity).toBe("moderate"); expect(p.testCases).toEqual([]); });
  it("caps absurd lengths", () => { expect(normalizeTaskPlan(plan({ scriptName: "A".repeat(5000) }))!.scriptName.length).toBeLessThanOrEqual(MAX_SCRIPT_NAME_LENGTH); });
  it("strips markup/control/newline characters, keeps unicode letters", () => {
    expect(normalizeTaskPlan(plan({ scriptName: "<img src=x onerror=1>\n\tWelcome\u0000 bot" }))!.scriptName).toBe("img src x onerror 1 Welcome bot");
    expect(normalizeTaskPlan(plan({ scriptName: "مرحبا بوت" }))!.scriptName).toBe("مرحبا بوت");
  });
  it("rejects unusable plans (so the caller retries)", () => {
    for (const bad of [plan({ scriptName: "" }), plan({ scriptName: "!!!***" }), plan({ scriptName: 42 }), plan({ description: null }), plan({ requiredEvents: "x" }), null, "str"]) expect(normalizeTaskPlan(bad as any)).toBeNull();
  });
  it("filters junk out of requiredEvents", () => { expect(normalizeTaskPlan(plan({ requiredEvents: ["ChatEvent", 5, "", "x".repeat(500), null] }))!.requiredEvents).toEqual(["ChatEvent"]); });
});

describe("L-37 embed() timeout", () => {
  const servers: http.Server[] = []; afterEach(() => { servers.splice(0).forEach((s) => { s.closeAllConnections?.(); s.close(); }); });
  const serve = async (h: http.RequestListener) => { const s = http.createServer(h); servers.push(s); await new Promise<void>((r) => s.listen(0, "127.0.0.1", r)); return `http://127.0.0.1:${(s.address() as any).port}`; };
  const cfg = (baseUrl: string, name: "openai" | "ollama" = "ollama") => ({ name, baseUrl, apiKey: "k", model: "m" });

  it("a server that never answers returns null at the timeout instead of hanging", async () => {
    const url = await serve(() => { /* never respond */ });
    const t0 = Date.now(); expect(await embed(cfg(url), "hi", { timeoutMs: 300 })).toBeNull(); const dt = Date.now() - t0;
    expect(dt).toBeGreaterThanOrEqual(250); expect(dt).toBeLessThan(2000);
  });
  it("headers sent but body stalls: still aborted (timer covers the body read)", async () => {
    const url = await serve((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write('{"embedding":['); /* never finishes */ });
    const t0 = Date.now(); expect(await embed(cfg(url, "ollama"), "hi", { timeoutMs: 300 })).toBeNull(); expect(Date.now() - t0).toBeLessThan(2000);
  });
  it("healthy providers still work (ollama + openai shapes), and wrong dimensions degrade to null", async () => {
    const vec = Array.from({ length: 384 }, (_, i) => i / 384);
    const ok = await serve((q, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(q.url!.includes("/embeddings") && !q.url!.includes("/api/") ? { data: [{ embedding: vec }] } : { embedding: vec })); });
    expect(await embed(cfg(ok, "ollama"), "x")).toHaveLength(384);
    expect(await embed(cfg(ok, "openai"), "x")).toHaveLength(384);
    const short = await serve((_q, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ embedding: [1, 2, 3] })); });
    expect(await embed(cfg(short), "x")).toBeNull();
  });
});

describe("L-35 HighriseClient reconnect cap", () => {
  it("stops after N consecutive failures, reports error + close, and makes no further attempts", async () => {
    let conns = 0; const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" }); await new Promise((r) => wss.on("listening", r));
    wss.on("connection", (ws: any) => { conns++; ws.close(1011, "nope"); });
    const port = (wss.address() as any).port;
    const client = new HighriseClient({ apiKey: "k", roomId: "r", baseUrl: `ws://127.0.0.1:${port}`, maxBackoffMs: 5, maxReconnectAttempts: 3 });
    const statuses: string[] = []; let closed = false; let errMsg = "";
    client.on("status", (s: any) => statuses.push(typeof s === "string" ? s : s.status));
    client.on("error", (e: any) => { errMsg = e.message; });
    client.on("close", () => { closed = true; });
    await client.connect().catch(() => undefined);
    await sleep(600);
    const atStop = conns; await sleep(400);
    expect(closed).toBe(true); expect(errMsg).toMatch(/Gave up reconnecting.*3 consecutive/);
    expect(statuses).toContain("error"); expect(statuses[statuses.length - 1]).toBe("stopped");
    expect(atStop).toBeGreaterThanOrEqual(3); expect(atStop).toBeLessThanOrEqual(5);
    expect(conns).toBe(atStop); // nothing more after giving up
    wss.close();
  }, 10000);
  it("maxReconnectAttempts: 0 keeps the old retry-forever behaviour", async () => {
    let conns = 0; const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" }); await new Promise((r) => wss.on("listening", r));
    wss.on("connection", (ws: any) => { conns++; ws.close(1011, "nope"); });
    const client = new HighriseClient({ apiKey: "k", roomId: "r", baseUrl: `ws://127.0.0.1:${(wss.address() as any).port}`, maxBackoffMs: 5, maxReconnectAttempts: 0 });
    client.on("error", () => {}); await client.connect().catch(() => undefined); await sleep(700);
    expect(conns).toBeGreaterThan(8); client.stop(); wss.close();
  }, 10000);
});

describe("L-38 docker availability re-check", () => {
  it("a failed probe is retried after its TTL (not cached forever), and a run failure invalidates the cache", async () => {
    vi.resetModules(); vi.useFakeTimers({ toFake: ["Date"] });
    let dockerUp = false; const calls: string[][] = [];
    vi.doMock("node:child_process", async (orig) => {
      const real: any = await (orig as any)();
      const execFile: any = (cmd: string, args: string[], opts: any, cb: any) => {
        const callback = typeof opts === "function" ? opts : cb; calls.push([cmd, ...args]);
        if (cmd === "docker" && args[0] === "version") return dockerUp ? callback(null, { stdout: "27.0", stderr: "" }) : callback(Object.assign(new Error("Cannot connect to the Docker daemon"), { code: 1 }));
        if (cmd === "docker" && args[0] === "run") return callback(new Error("Cannot connect to the Docker daemon at unix:///var/run/docker.sock"));
        return real.execFile(cmd, args, opts, cb);
      };
      execFile[Symbol.for("nodejs.util.promisify.custom")] = (cmd: string, args: string[], opts: any) => new Promise((res, rej) => execFile(cmd, args, opts ?? {}, (e: any, so: any) => (e ? rej(e) : res(so))));
      return { ...real, execFile, default: { ...real, execFile } };
    });
    const sb = await import("../../packages/engine/src/highrise/sandbox/PythonSandbox");
    const probes = () => calls.filter((c) => c[1] === "version").length;
    expect(await sb.runPythonBotHandler("x=1", "h", {})).toBeNull(); expect(probes()).toBe(1);   // docker down
    expect(await sb.runPythonBotHandler("x=1", "h", {})).toBeNull(); expect(probes()).toBe(1);   // cached within TTL
    dockerUp = true; vi.setSystemTime(Date.now() + 16_000);                                         // past the 15s "down" TTL
    const r = await sb.runPythonBotHandler("x=1", "h", {});                                         // probe now succeeds -> tries to run -> daemon error
    expect(probes()).toBe(2); expect(r).toBeNull();                                                 // infra failure => null (fall back), not {ok:false}
    await sb.runPythonBotHandler("x=1", "h", {}); expect(probes()).toBe(3);                         // failure invalidated the cache -> re-probed immediately
    vi.useRealTimers(); vi.doUnmock("node:child_process");
  });
});
