/**
 * The coder AI tries every (key, model) lane: a key that's out of quota is
 * skipped straight away, keys are never logged, and a healthy lane answers.
 * Uses a local fake of Google's OpenAI-compatible endpoint.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const KEY_OUT = "AQ.fake-key-out-of-quota";
const KEY_OK = "AQ.fake-key-healthy";
let server: http.Server;
let seen: { auth: string; model: string }[] = [];
let mode: "normal" | "quota-on-first" = "normal";
let rejectModels = new Set<string>();
let times: number[] = [];
let bodies: Record<string, unknown>[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const auth = String(req.headers.authorization ?? "").replace("Bearer ", "");
      const { model } = JSON.parse(body || "{}") as { model: string };
      seen.push({ auth, model });
      times.push(Date.now());
      bodies.push(JSON.parse(body || "{}"));
      if (rejectModels.has(model)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: 400, message: "Function call is missing a thought_signature" } }));
        return;
      }
      if (auth === KEY_OUT && mode === "quota-on-first") {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: 429, message: "You exceeded your current quota" } }));
        return;
      }
      if (model === "gone-model") { res.writeHead(404); res.end("not found"); return; }
      if (body.includes("TOO_BIG")) { res.writeHead(413); res.end("Request too large"); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `hello from ${model}` } }], usage: { prompt_tokens: 11, completion_tokens: 7 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.AGENT_API_KEYS = `${KEY_OUT},${KEY_OK}`;
  process.env.AGENT_API_KEY = KEY_OUT; // also listed in AGENT_API_KEYS: must be de-duplicated
  process.env.GEMINI_MODELS = "model-a,model-b";
  delete process.env.GROQ_API_KEY;
  process.env.MISTRAL_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.MISTRAL_MODELS = "mistral-large-4,mistral-large-2512";
  process.env.MISTRAL_MIN_INTERVAL_MS = "250";
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function load(withMistral = false) {
  vi.resetModules();
  if (withMistral) process.env.MISTRAL_API_KEY = "mstrl_fake-test-key";
  else delete process.env.MISTRAL_API_KEY;
  const ai = await import("../../../apps/runner/src/agent/groq.js");
  ai._resetAiStateForTests();
  return ai;
}

const ask = (ai: typeof import("../../../apps/runner/src/agent/groq.js")) =>
  ai.chat({ messages: [{ role: "user", content: "hi" }], tools: [] });

beforeEach(() => { seen = []; times = []; bodies = []; mode = "normal"; rejectModels = new Set(); });

describe("coder AI lanes", () => {
  it("tries Mistral first, then Gemini, one lane per key and model", async () => {
    const ai = await load(true);
    expect(ai.configuredLanes()).toEqual([
      "Mistral mistral-large-4", "Mistral mistral-large-2512",
      "Gemini model-a (key 1)", "Gemini model-a (key 2)", "Gemini model-b (key 1)", "Gemini model-b (key 2)",
    ]);
  });

  it("with no Mistral key, Gemini is used", async () => {
    const ai = await load(false);
    expect(ai.configuredLanes()[0]).toBe("Gemini model-a (key 1)");
  });

  it("answers from the first healthy lane (Mistral when it's set)", async () => {
    const ai = await load(true);
    const out = await ask(ai);
    expect(out.message.content).toBe("hello from mistral-large-4");
    expect(seen[0]?.model).toBe("mistral-large-4");
  });

  it("skips a key that is out of quota and moves on at once", async () => {
    mode = "quota-on-first";
    const ai = await load(false);
    const out = await ask(ai);
    expect(out.message.content).toBe("hello from model-a");
    expect(seen.map((s) => s.auth)).toEqual([KEY_OUT, KEY_OK]); // the exhausted key was tried once, then skipped
    await ask(ai);
    expect(seen.slice(2).every((s) => s.auth === KEY_OK)).toBe(true); // and stays skipped
  });

  it("a model that doesn't exist is skipped, not fatal", async () => {
    process.env.GEMINI_MODELS = "gone-model,model-b";
    const ai = await load(false);
    const out = await ask(ai);
    expect(out.message.content).toBe("hello from model-b");
    process.env.GEMINI_MODELS = "model-a,model-b";
  });

  it("a request that's too big is reported so the chat can shorten it", async () => {
    const ai = await load();
    await expect(ai.chat({ messages: [{ role: "user", content: "TOO_BIG" }], tools: [] })).rejects.toBeInstanceOf(ai.RequestTooLargeError);
  });

  it("never puts a key in an error message", async () => {
    const ai = await load();
    try { await ai.chat({ messages: [{ role: "user", content: "TOO_BIG" }], tools: [] }); }
    catch (err) { expect(String((err as Error).message)).not.toContain("AQ.fake"); }
  });

  it("a 400 skips that lane for this request only, without a long cooldown", async () => {
    rejectModels = new Set(["model-a"]);
    const ai = await load(false);
    const first = await ask(ai);
    expect(first.message.content).toBe("hello from model-b");
    await ask(ai);
    // model-a is tried again on the second request: it was not taken out for everyone.
    expect(seen.filter((x) => x.model === "model-a").length).toBeGreaterThanOrEqual(2);
  });

  it("when every lane rejects the request, the error says so instead of 'busy'", async () => {
    rejectModels = new Set(["model-a", "model-b"]);
    const ai = await load(false);
    await expect(ask(ai)).rejects.toThrow(/rejected this request.*thought_signature/);
  });

  it("paces Mistral requests so the free plan's per-second limit isn't hit", async () => {
    const ai = await load(true);
    await ask(ai);
    await ask(ai);
    const mistral = seen.map((x, i) => ({ ...x, at: times[i]! })).filter((x) => x.model.startsWith("mistral"));
    expect(mistral.length).toBe(2);
    // Pacing is 250 ms here; times are when the fake server finished reading each
    // request, which a busy test machine can delay a little. Unpaced, the gap is ~0.
    expect(mistral[1]!.at - mistral[0]!.at).toBeGreaterThanOrEqual(200);
  });
});

describe("prepareMessages (history written by another model)", () => {
  const history = [
    { role: "user", content: "hi" },
    { role: "assistant", content: null, tool_calls: [
      { id: "call_1", type: "function", function: { name: "list_files", arguments: "{}" } },
      { id: "call_2", type: "function", function: { name: "read_file", arguments: "{}" }, extra_content: { google: { thought_signature: "REAL" } } },
    ] },
    { role: "tool", tool_call_id: "call_1", content: "ok" },
  ] as import("../../../apps/runner/src/agent/groq.js").ChatMessage[];

  it("Gemini gets a placeholder signature where one is missing and keeps real ones", async () => {
    const ai = await load(false);
    const out = ai.prepareMessages("gemini", history);
    const calls = out[1]!.tool_calls!;
    expect(calls[0]!.extra_content?.google?.thought_signature).toBe("skip_thought_signature_validator");
    expect(calls[1]!.extra_content?.google?.thought_signature).toBe("REAL");
    expect(history[1]!.tool_calls![0]!.extra_content).toBeUndefined(); // the saved history isn't modified
  });

  it("Mistral and Groq never see Gemini-only fields", async () => {
    const ai = await load(false);
    for (const provider of ["mistral", "groq"] as const) {
      const calls = ai.prepareMessages(provider, history)[1]!.tool_calls!;
      expect(calls.every((c) => !("extra_content" in c))).toBe(true);
    }
  });
});

describe("usage recorded for the chat's AI models circle", () => {
  function fakeSink() {
    const hashes = new Map<string, Map<string, string>>();
    const h = (k: string) => { let m = hashes.get(k); if (!m) { m = new Map(); hashes.set(k, m); } return m; };
    return {
      hashes,
      hincrby: async (k: string, f: string, by: number) => { h(k).set(f, String(Number(h(k).get(f) ?? 0) + by)); },
      hset: async (k: string, f: string, v: string) => { h(k).set(f, v); },
      expire: async () => undefined,
    };
  }
  const flush = () => new Promise((r) => setTimeout(r, 20));

  it("publishes every configured model, with no keys in it", async () => {
    const ai = await load(true);
    const sink = fakeSink();
    ai.setUsageSink(sink);
    await flush();
    const lanes = sink.hashes.get("ai_lanes")!;
    expect(lanes.size).toBe(ai.configuredLanes().length);
    for (const v of lanes.values()) expect(v).not.toMatch(/AQ\.fake|mstrl_fake/);
  });

  it("models taken out of .env leave the list when the runner starts", async () => {
    const ai = await load(true);
    const sink = {
      ...fakeSink(),
      hkeys: async (k: string) => [...(sink.hashes.get(k)?.keys() ?? [])],
      hdel: async (k: string, ...fields: string[]) => { for (const f of fields) sink.hashes.get(k)?.delete(f); },
    };
    // Left over from an earlier configuration.
    await sink.hset("ai_lanes", "mistral:mistral-large-2512", "{}");
    await sink.hset("ai_lanes", "openrouter:xingchen-agi/xing4.0-29b-a4b:free", "{}");
    ai.setUsageSink(sink);
    await flush();
    const ids = [...sink.hashes.get("ai_lanes")!.keys()];
    expect(ids).not.toContain("openrouter:xingchen-agi/xing4.0-29b-a4b:free");
    expect(ids).toHaveLength(ai.configuredLanes().length);
  });

  it("counts requests and tokens for the model that answered", async () => {
    const ai = await load(true);
    const sink = fakeSink();
    ai.setUsageSink(sink);
    await ask(ai);
    await ask(ai);
    await flush();
    const today = [...sink.hashes.keys()].find((k) => k.startsWith("ai_usage:"))!;
    const day = sink.hashes.get(today)!;
    expect(day.get("mistral:mistral-large-4|req")).toBe("2");
    expect(day.get("mistral:mistral-large-4|in")).toBe("22");
    expect(day.get("mistral:mistral-large-4|out")).toBe("14");
  });

  it("records an out-of-quota model as such, with when it comes back", async () => {
    mode = "quota-on-first";
    const ai = await load(false);
    const sink = fakeSink();
    ai.setUsageSink(sink);
    await ask(ai);
    await flush();
    const state = JSON.parse(sink.hashes.get("ai_lanes")!.get("gemini:model-a:0")!) as { kind: string; coolUntil: number };
    expect(state.kind).toBe("out_of_quota");
    expect(state.coolUntil).toBeGreaterThan(Date.now() + 30 * 60_000);
    const today = [...sink.hashes.keys()].find((k) => k.startsWith("ai_usage:"))!;
    expect(sink.hashes.get(today)!.get("gemini:model-a:0|fail")).toBe("1");
  });
});
