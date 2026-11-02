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

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const auth = String(req.headers.authorization ?? "").replace("Bearer ", "");
      const { model } = JSON.parse(body || "{}") as { model: string };
      seen.push({ auth, model });
      if (auth === KEY_OUT && mode === "quota-on-first") {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: 429, message: "You exceeded your current quota" } }));
        return;
      }
      if (model === "gone-model") { res.writeHead(404); res.end("not found"); return; }
      if (body.includes("TOO_BIG")) { res.writeHead(413); res.end("Request too large"); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `hello from ${model}` } }] }));
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

beforeEach(() => { seen = []; mode = "normal"; });

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
});
