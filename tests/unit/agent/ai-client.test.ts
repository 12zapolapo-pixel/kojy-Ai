import http from "node:http";
import type { AddressInfo } from "node:net";
import { chat, currentEndpoint, endpoints, requestBody, resetAiState, type ChatMessage } from "../../../apps/runner/src/agent/groq.js";
import { testSettings } from "../../../apps/runner/src/agent/tools.js";

const KEYS = [
  "AGENT_API_KEY", "AGENT_BASE_URL", "AGENT_MODEL", "AGENT_TOKENS_PER_MINUTE", "AGENT_HISTORY_TOKENS", "AGENT_MAX_OUTPUT_TOKENS",
  "AGENT_REASONING_EFFORT", "AGENT_FALLBACK_MODEL", "GROQ_API_KEY", "GROQ_BASE_URL", "GROQ_MODEL_SMART", "GROQ_MODEL_FAST",
];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  resetAiState();
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  resetAiState();
});

describe("coder AI endpoints", () => {
  it("uses Groq alone on its free-plan budgets, with AGENT_* as Groq's settings", () => {
    const list = endpoints({ GROQ_API_KEY: "gsk_x", AGENT_HISTORY_TOKENS: "5000" });
    expect(list.map((e) => e.id)).toEqual(["groq:openai/gpt-oss-120b", "groq:openai/gpt-oss-20b"]);
    expect(list[0]).toMatchObject({ baseUrl: "https://api.groq.com/openai/v1", historyTokens: 5000, maxOutputTokens: 1200, tokensPerMinute: 7500 });
  });

  it("puts Gemini first when AGENT_API_KEY is set, with Groq as the backup on Groq's budgets", () => {
    const list = endpoints({ AGENT_API_KEY: "g", GROQ_API_KEY: "gsk_x", AGENT_HISTORY_TOKENS: "40000" });
    expect(list.map((e) => e.id)).toEqual(["agent", "groq:openai/gpt-oss-120b", "groq:openai/gpt-oss-20b"]);
    expect(list[0]).toMatchObject({
      kind: "gemini", model: "gemini-3.8-flash", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", historyTokens: 40000, maxOutputTokens: 8000,
    });
    expect(list[1]).toMatchObject({ historyTokens: 3000, maxOutputTokens: 1200, tokensPerMinute: 7500 });
  });

  it("has no AI without keys (a placeholder key doesn't count)", () => {
    expect(endpoints({})).toEqual([]);
    expect(endpoints({ GROQ_API_KEY: "gsk_ci_placeholder" })).toEqual([]);
  });
});

describe("coder AI requests", () => {
  const gemini = endpoints({ AGENT_API_KEY: "g" })[0]!;
  const groq = endpoints({ GROQ_API_KEY: "gsk_x" })[0]!;
  const history: ChatMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "check_code", arguments: "{}" }, extra_content: { google: { thought_signature: "sig" } } }] },
    { role: "tool", tool_call_id: "c1", content: "ok" },
  ];
  const tools = [
    { type: "function" as const, function: { name: "check_code", description: "d", parameters: { type: "object", properties: {}, required: [] } } },
    { type: "function" as const, function: { name: "read_file", description: "d", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  ];

  it("gives Gemini its thought signatures back, its default temperature and no empty schemas", () => {
    const body = requestBody(gemini, history, tools, 100) as any;
    expect(body.messages[1].tool_calls[0].extra_content).toEqual({ google: { thought_signature: "sig" } });
    expect(body).not.toHaveProperty("temperature");
    expect(body.tools[0].function).not.toHaveProperty("parameters");
    expect(body.tools[1].function.parameters.required).toEqual(["path"]);
    expect(body.reasoning_effort).toBe("medium");
    expect(body.max_tokens).toBe(8100);
  });

  it("sends other AIs standard tool calls only", () => {
    const body = requestBody(groq, history, tools, 100) as any;
    expect(body.messages[1].tool_calls[0]).toEqual({ id: "c1", type: "function", function: { name: "check_code", arguments: "{}" } });
    expect(body.temperature).toBe(0.2);
    expect(body.tools).toBe(tools);
    expect(body.max_tokens).toBe(900);
  });
});

describe("coder AI fallback", () => {
  let server: http.Server;
  let base = "";
  const seen: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as { model?: string };
        seen.push(req.url ?? "");
        if (req.url?.startsWith("/gemini")) {
          // Gemini's OpenAI-compatible API answers a used-up daily quota like this.
          res.writeHead(429, { "content-type": "application/json" });
          res.end(JSON.stringify([{ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for quota id GenerateRequestsPerDayPerProjectPerModel-FreeTier" } }]));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `from ${body.model}` } }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("moves to Groq when Gemini's daily limit is used up, and stays there", async () => {
    Object.assign(process.env, { AGENT_API_KEY: "g", AGENT_BASE_URL: `${base}/gemini`, GROQ_API_KEY: "gsk_x", GROQ_BASE_URL: `${base}/groq` });
    const r = await chat({ messages: [{ role: "user", content: "hi" }], tools: [] });
    expect(r).toMatchObject({ model: "openai/gpt-oss-120b", message: { content: "from openai/gpt-oss-120b" } });
    expect(seen).toEqual(["/gemini/chat/completions", "/groq/chat/completions"]);
    expect(currentEndpoint()?.id).toBe("groq:openai/gpt-oss-120b");
  });

  it("says why when every AI is used up", async () => {
    Object.assign(process.env, { AGENT_API_KEY: "g", AGENT_BASE_URL: `${base}/gemini` });
    await expect(chat({ messages: [{ role: "user", content: "hi" }], tools: [] })).rejects.toThrow(/daily limits are used up/);
  });
});

describe("test room settings", () => {
  it("keeps NAME=value settings but never the room, token or Python ones", () => {
    expect(testSettings(["ANNOUNCE_SECONDS=5", "HIGHRISE_BOT_TOKEN=x", "HR_BOTAPI_URL=ws://real", "PYTHONPATH=/x", "bad", "lower=1"]))
      .toEqual({ ANNOUNCE_SECONDS: "5" });
    expect(testSettings("ANNOUNCE_SECONDS=5")).toEqual({});
  });
});
