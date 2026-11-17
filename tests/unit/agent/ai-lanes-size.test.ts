/**
 * Kojy's AI client, the parts that broke on 2026-11-03:
 *  - Mistral's reasoning models answer with chunks (thinking + text); only
 *    the text may reach the chat (it was stored as raw JSON before).
 *  - A request bigger than Groq's free per-minute size never goes to Groq;
 *    it waits for a bigger model that's briefly busy, and only asks for a
 *    shorter history when nothing that can take it comes back soon.
 * Uses a local fake of the OpenAI-compatible endpoints.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type MistralMode = "ok" | "chunks" | "thinking-only-with-tools" | "thinking-only" | "quota" | "busy-1s" | "busy-always" | "too-big";
let mistralMode: MistralMode = "ok";
let seen: string[] = [];
/** The last request body each model got. */
let bodies: Record<string, Record<string, unknown>> = {};
let server: http.Server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { model } = JSON.parse(body || "{}") as { model: string };
      seen.push(model);
      bodies[model] = JSON.parse(body || "{}") as Record<string, unknown>;
      const json = (status: number, data: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(data));
      };
      const answer = (message: Record<string, unknown>) => json(200, { choices: [{ message: { role: "assistant", ...message } }], usage: { prompt_tokens: 5, completion_tokens: 3 } });
      if (model.startsWith("reject-")) {
        // What Gemini answered on 2026-11-03 to a history that opened with a tool call.
        return json(400, [{ error: { code: 400, message: "Please ensure that function call turn comes immediately after a user turn or after a function response turn.", status: "INVALID_ARGUMENT" } }]);
      }
      if (model.startsWith("mistral")) {
        if (mistralMode === "quota") return json(429, { message: "Monthly quota exceeded for this plan" });
        if (mistralMode === "busy-always") return json(429, { message: "Rate limit exceeded" }, { "retry-after": "1" });
        if (mistralMode === "busy-1s") { mistralMode = "ok"; return json(429, { message: "Rate limit exceeded" }, { "retry-after": "1" }); }
        if (mistralMode === "too-big") return json(400, { message: "Prompt contains 300000 tokens, too large for model with 131072 maximum context length" });
        if (mistralMode === "chunks") {
          return answer({ content: [{ type: "thinking", thinking: [{ type: "text", text: "secret thoughts" }], closed: true }, { type: "text", text: "Hello owner" }] });
        }
        if (mistralMode === "thinking-only-with-tools") {
          return answer({
            content: [{ type: "thinking", thinking: [{ type: "text", text: "I should read the logs" }] }],
            tool_calls: [{ id: "c1", type: "function", function: { name: "get_logs", arguments: "{}" } }],
          });
        }
        if (mistralMode === "thinking-only") return answer({ content: [{ type: "thinking", thinking: [{ type: "text", text: "hmm" }] }] });
        return answer({ content: `hello from ${model}` });
      }
      return answer({ content: `hello from ${model}` });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.MISTRAL_BASE_URL = base;
  process.env.GROQ_BASE_URL = base;
  process.env.GEMINI_BASE_URL = base;
  process.env.MISTRAL_API_KEY = "mstrl_fake-test-key";
  process.env.MISTRAL_MODELS = "mistral-large-4";
  process.env.MISTRAL_MIN_INTERVAL_MS = "0";
  process.env.GROQ_API_KEY = "gsk_fake-test-key";
  process.env.AGENT_MODEL = "groq-small";
  process.env.AGENT_FALLBACK_MODEL = "groq-small";
  process.env.AGENT_TOKENS_PER_MINUTE = "600";
  delete process.env.AGENT_API_KEY;
  delete process.env.AGENT_API_KEYS;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const k of ["GROQ_API_KEY", "GROQ_BASE_URL", "AGENT_MODEL", "AGENT_FALLBACK_MODEL", "AGENT_TOKENS_PER_MINUTE", "MISTRAL_API_KEY"]) delete process.env[k];
});

/** Loads the client with `env` set while it reads its configuration. */
async function load(env: Record<string, string> = {}) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  vi.resetModules();
  const ai = await import("../../../apps/runner/src/agent/groq.js");
  ai._resetAiStateForTests();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return ai;
}

/** ~tokens of history: the estimate is 4 characters per token. */
const ask = (ai: Awaited<ReturnType<typeof load>>, tokens: number) =>
  ai.chat({ messages: [{ role: "user", content: "x".repeat(tokens * 4) }], tools: [], maxTokens: 10 });

beforeEach(() => { seen = []; bodies = {}; mistralMode = "ok"; });

describe("Mistral's chunked answers", () => {
  it("keeps only the reply's text, never the thinking", async () => {
    mistralMode = "chunks";
    const ai = await load();
    const out = await ask(ai, 10);
    expect(out.message.content).toBe("Hello owner");
    expect(JSON.stringify(out.message)).not.toContain("secret thoughts");
  });

  it("thinking plus a tool call: the call is kept, no text", async () => {
    mistralMode = "thinking-only-with-tools";
    const ai = await load();
    const out = await ask(ai, 10);
    expect(out.message.content).toBeNull();
    expect(out.message.tool_calls?.[0]?.function.name).toBe("get_logs");
  });

  it("an answer with nothing in it goes to the next AI", async () => {
    mistralMode = "thinking-only";
    const ai = await load();
    const out = await ask(ai, 10);
    expect(out.message.content).toBe("hello from groq-small");
  });

  it("contentText handles every shape", async () => {
    const ai = await load();
    expect(ai.contentText("plain")).toBe("plain");
    expect(ai.contentText("<think>Let me look at the file.</think>\nThe bug is on line 3.")).toBe("The bug is on line 3.");
    expect(ai.contentText("<think>only thinking, cut off")).toBeNull();
    expect(ai.contentText(null)).toBeNull();
    expect(ai.contentText([{ type: "text", text: "a" }, { type: "thinking", thinking: [] }, { type: "text", text: "b" }])).toBe("ab");
    expect(ai.contentText([{ type: "thinking", thinking: [{ type: "text", text: "x" }] }])).toBeNull();
  });
});

describe("requests too big for Groq's free plan", () => {
  it("a long chat is never sent to Groq; with the big AIs out for long, the chat is told to shorten", async () => {
    mistralMode = "quota";
    const ai = await load();
    const err = await ask(ai, 2000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ai.RequestTooLargeError);
    expect(String((err as Error).message)).toMatch(/busy for about \d+ min/);
    expect(seen).toEqual(["mistral-large-4"]); // Groq was never called with it
    // The shortened retry fits Groq and gets an answer.
    const out = await ask(ai, 100);
    expect(out.message.content).toBe("hello from groq-small");
  });

  it("waits for a big AI that's busy for a moment instead of cutting the history", async () => {
    mistralMode = "busy-1s";
    const ai = await load();
    const started = Date.now();
    const out = await ask(ai, 2000);
    expect(out.message.content).toBe("hello from mistral-large-4");
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(seen).not.toContain("groq-small");
  }, 10_000);

  it("a model whose context is too small for the request is skipped, not fatal", async () => {
    mistralMode = "too-big";
    const ai = await load();
    const out = await ask(ai, 100);
    expect(out.message.content).toBe("hello from groq-small");
    expect(seen).toEqual(["mistral-large-4", "groq-small"]);
  });

  it("the same request too big for every model asks for a shorter one", async () => {
    mistralMode = "too-big";
    const ai = await load();
    await expect(ask(ai, 2000)).rejects.toThrow(/too big for the AI/);
  });
});

describe("2026-11-03: \"The AI is busy right now\" while an AI was free", () => {
  const twelveRejecting = { AGENT_API_KEYS: "AQ.k1,AQ.k2", GEMINI_MODELS: "reject-1,reject-2,reject-3,reject-4,reject-5,reject-6" };

  it("Mistral rate limited and 12 Gemini lanes rejecting: it still gets to Groq instead of giving up after 12 tries", async () => {
    mistralMode = "busy-always";
    const ai = await load(twelveRejecting);
    const out = await ask(ai, 100);
    expect(out.message.content).toBe("hello from groq-small");
    expect(seen.filter((m) => m.startsWith("reject-"))).toHaveLength(12);
  });

  it("a chat too long for Groq waits once for Mistral, then asks for a shorter request instead of 'busy'", async () => {
    mistralMode = "busy-always";
    const ai = await load(twelveRejecting);
    const err = await ask(ai, 2000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ai.RequestTooLargeError);
    expect(seen.filter((m) => m === "mistral-large-4")).toHaveLength(2); // tried, waited once, tried again
    expect(seen).not.toContain("groq-small");
  }, 10_000);

  it("Mistral's 20,000 tokens a minute: once its minute is used up, the next request goes to Gemini at once", async () => {
    const ai = await load({ AGENT_API_KEYS: "AQ.k1", GEMINI_MODELS: "gem-ok", MISTRAL_TOKENS_PER_MINUTE: "3000" });
    expect((await ask(ai, 2000)).message.content).toBe("hello from mistral-large-4");
    const started = Date.now();
    expect((await ask(ai, 2000)).message.content).toBe("hello from gem-ok");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(seen.filter((m) => m === "mistral-large-4")).toHaveLength(1); // not hit again only to be refused
  });
});

describe("more models: LiteLLM and free providers", () => {
  const base = () => process.env.MISTRAL_BASE_URL!; // the fake server

  it("a LiteLLM proxy and a free provider become lanes after Gemini and before Groq", async () => {
    const ai = await load({
      AGENT_API_KEYS: "AQ.k1", GEMINI_MODELS: "gem-a",
      LITELLM_BASE_URL: `${base()}/`, LITELLM_API_KEY: "sk-litellm-test", LITELLM_MODELS: "router-model",
      CEREBRAS_BASE_URL: base(), CEREBRAS_API_KEY: "csk-test", CEREBRAS_MODELS: "fast-model, big-model",
    });
    expect(ai.configuredLanes()).toEqual([
      "Mistral mistral-large-4", "Gemini gem-a (key 1)",
      "LiteLLM router-model", "Cerebras fast-model", "Cerebras big-model",
      "Groq groq-small",
    ]);
  });

  it("LiteLLM is left out without its address, and a provider without models is left out", async () => {
    const ai = await load({ LITELLM_API_KEY: "sk-litellm-test", LITELLM_MODELS: "router-model", OPENROUTER_API_KEY: "sk-or-test" });
    expect(ai.configuredLanes().some((l) => l.startsWith("LiteLLM") || l.startsWith("OpenRouter"))).toBe(false);
  });

  it("when Mistral is out of quota the LiteLLM model answers, in plain OpenAI format", async () => {
    mistralMode = "quota";
    const ai = await load({ LITELLM_BASE_URL: base(), LITELLM_API_KEY: "sk-litellm-test", LITELLM_MODELS: "router-model" });
    const out = await ai.chat({
      messages: [
        { role: "user", content: "read bot.py" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" }, extra_content: { google: { thought_signature: "x" } } }] },
        { role: "tool", tool_call_id: "c1", content: "print(1)" },
        { role: "user", content: "x".repeat(4000) }, // too long for Groq's 600-token test plan
      ],
      tools: [], maxTokens: 10,
    });
    expect(out.message.content).toBe("hello from router-model");
    const sent = JSON.stringify(bodies["router-model"]);
    expect(sent).not.toContain("extra_content");
    expect(sent).not.toContain("reasoning_effort");
  });

  it("a provider's per-minute budget from .env is respected", async () => {
    const ai = await load({ CEREBRAS_BASE_URL: base(), CEREBRAS_API_KEY: "csk-test", CEREBRAS_MODELS: "fast-model", CEREBRAS_TOKENS_PER_MINUTE: "500", MISTRAL_API_KEY: "" });
    expect(ai.configuredLanes()).toContain("Cerebras fast-model");
    // 1000 tokens can never fit a 500-a-minute plan (nor Groq's 600): the chat is asked to shorten.
    await expect(ask(ai, 1000)).rejects.toBeInstanceOf(ai.RequestTooLargeError);
    expect(seen).not.toContain("fast-model");
  });
});
