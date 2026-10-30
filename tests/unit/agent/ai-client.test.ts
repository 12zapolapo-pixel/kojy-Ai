import http from "node:http";
import type { AddressInfo } from "node:net";
import { chat, currentEndpoint, endpoints, requestBody, resetAiState, retrySeconds, unsignedStepsAsText, type ChatMessage } from "../../../apps/runner/src/agent/groq.js";
import { testSettings } from "../../../apps/runner/src/agent/tools.js";

const KEYS = [
  "AGENT_API_KEY", "AGENT_BASE_URL", "AGENT_MODEL", "AGENT_TOKENS_PER_MINUTE", "AGENT_HISTORY_TOKENS", "AGENT_MAX_OUTPUT_TOKENS",
  "AGENT_REASONING_EFFORT", "AGENT_TIMEOUT_SECONDS", "AGENT_FALLBACK_MODEL", "GROQ_API_KEY", "GROQ_BASE_URL", "GROQ_MODEL_SMART", "GROQ_MODEL_FAST",
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

  it("puts several free Gemini models first when AGENT_API_KEY is set, with Groq as the backup on Groq's budgets", () => {
    const list = endpoints({ AGENT_API_KEY: "g", GROQ_API_KEY: "gsk_x", AGENT_HISTORY_TOKENS: "40000" });
    expect(list.map((e) => e.id)).toEqual([
      "agent:gemini-3.6-flash", "agent:gemini-3-flash-preview", "agent:gemini-3.5-flash-lite", "agent:gemini-3.1-flash-lite",
      "groq:openai/gpt-oss-120b", "groq:openai/gpt-oss-20b",
    ]);
    expect(list[0]).toMatchObject({
      group: "agent", kind: "gemini", model: "gemini-3.6-flash", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", historyTokens: 40000, maxOutputTokens: 8000,
    });
    expect(list[4]).toMatchObject({ group: "groq", historyTokens: 3000, maxOutputTokens: 1200, tokensPerMinute: 7500 });
  });

  it("takes AGENT_MODEL as one model or a list; another service needs it", () => {
    expect(endpoints({ AGENT_API_KEY: "g", AGENT_MODEL: "gemini-3.8-flash, gemini-3.6-flash" }).map((e) => e.model)).toEqual(["gemini-3.8-flash", "gemini-3.6-flash"]);
    expect(endpoints({ AGENT_API_KEY: "k", AGENT_BASE_URL: "https://integrate.api.nvidia.com/v1" })).toEqual([]);
    expect(endpoints({ AGENT_API_KEY: "k", AGENT_BASE_URL: "https://integrate.api.nvidia.com/v1", AGENT_MODEL: "x/y" })[0]).toMatchObject({ kind: "openai", model: "x/y" });
  });

  it("reads Gemini's and Groq's retry times", () => {
    const none = new Headers();
    expect(retrySeconds(none, "Please retry in 20.5s.")).toBe(21);
    expect(retrySeconds(none, "Please retry in 5h38m24.137368371s.")).toBe(20305);
    expect(retrySeconds(none, `"retryDelay": "33s"`)).toBe(33);
    expect(retrySeconds(new Headers({ "retry-after": "7" }), "")).toBe(7);
    expect(retrySeconds(none, "Rate limit reached, slow down")).toBeNull();
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

describe("steps without a thought signature (made by Groq) for Gemini", () => {
  const step = (id: string, signed = false): ChatMessage => ({
    role: "assistant", content: null,
    tool_calls: [{ id, type: "function", function: { name: "list_files", arguments: "{}" }, ...(signed ? { extra_content: { google: { thought_signature: "s" } } } : {}) }],
  });
  const result = (id: string, content = "bot.py"): ChatMessage => ({ role: "tool", tool_call_id: id, content });

  it("become plain text, with the results as app messages so a request never ends on Gemini's turn", () => {
    const out = unsignedStepsAsText([{ role: "user", content: "hi" }, step("g1"), result("g1"), step("g2"), result("g2", "ok"), { role: "assistant", content: "Done." }]);
    expect(out).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "I ran list_files({})." },
      { role: "user", content: "[app] Result of list_files: bot.py" },
      { role: "assistant", content: "I ran list_files({})." },
      { role: "user", content: "[app] Result of list_files: ok" },
      { role: "assistant", content: "Done." },
    ]);
  });

  it("put the results of one step with several calls in one app message", () => {
    const two: ChatMessage = { role: "assistant", content: "Looking.", tool_calls: [step("a").tool_calls![0]!, { ...step("b").tool_calls![0]!, function: { name: "get_logs", arguments: "{\"lines\":20}" } }] };
    expect(unsignedStepsAsText([{ role: "user", content: "hi" }, two, result("a"), result("b", "started")])).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Looking.\nI ran list_files({}).\nI ran get_logs({\"lines\":20})." },
      { role: "user", content: "[app] Result of list_files: bot.py\n[app] Result of get_logs: started" },
    ]);
  });

  it("keep Gemini's own steps as real tool calls, including parallel calls signed on the first only", () => {
    const parallel: ChatMessage = { role: "assistant", content: null, tool_calls: [step("a", true).tool_calls![0]!, step("b").tool_calls![0]!] };
    const msgs = [{ role: "user", content: "hi" } as ChatMessage, step("s1", true), result("s1"), parallel, result("a"), result("b")];
    expect(unsignedStepsAsText(msgs)).toEqual(msgs);
  });

  it("only applies to Gemini", () => {
    const msgs = [{ role: "user", content: "hi" } as ChatMessage, step("g1"), result("g1")];
    const [gemini] = endpoints({ AGENT_API_KEY: "g" });
    const [groq] = endpoints({ GROQ_API_KEY: "gsk_x" });
    expect((requestBody(gemini!, msgs, [], 10) as any).messages.map((m: ChatMessage) => m.role)).toEqual(["user", "assistant", "user"]);
    expect((requestBody(groq!, msgs, [], 10) as any).messages.map((m: ChatMessage) => m.role)).toEqual(["user", "assistant", "tool"]);
  });
});

describe("coder AI fallback", () => {
  let server: http.Server;
  let base = "";
  const seen: string[] = [];
  const calls = new Map<string, number>(); // model → requests so far, for /mix

  // Gemini's OpenAI-compatible API answers used-up quotas like these.
  const quota = (res: http.ServerResponse, message: string) => {
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify([{ error: { code: 429, status: "RESOURCE_EXHAUSTED", message } }]));
  };
  const PER_DAY = "Quota exceeded for metric: generate_content_free_tier_requests, limit: 20, description: Generate content requests per day limit exceeded on Free Tier.\nPlease retry in 5h38m24.1s.";
  const PER_MINUTE = "Quota exceeded for metric: generate_content_free_tier_requests, limit: 5, description: Generate content requests per minute limit exceeded on Free Tier.\nPlease retry in 1s.";

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as { model?: string };
        seen.push(`${req.url ?? ""} ${body.model}`);
        const answer = () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `from ${body.model}` } }] }));
        };
        const n = (calls.get(body.model ?? "") ?? 0) + 1;
        calls.set(body.model ?? "", n);
        if (req.url?.startsWith("/gemini")) {
          quota(res, "Quota exceeded for quota id GenerateRequestsPerDayPerProjectPerModel-FreeTier");
        } else if (req.url?.startsWith("/rpm")) {
          // m1 is at its per-minute limit; m2 answers.
          if (body.model === "m1") quota(res, PER_MINUTE); else answer();
        } else if (req.url?.startsWith("/mix")) {
          // m1: per-minute limit once, then answers. m2: used up for the day.
          if (body.model === "m2") quota(res, PER_DAY); else if (n === 1) quota(res, PER_MINUTE); else answer();
        } else if (req.url?.startsWith("/refuse")) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify([{ error: { code: 400, message: "Function call is missing a thought_signature in functionCall parts." } }]));
        } else if (req.url?.startsWith("/slow")) {
          setTimeout(answer, 1500);
        } else {
          answer();
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  beforeEach(() => { seen.length = 0; calls.clear(); });
  const groq = () => ({ GROQ_API_KEY: "gsk_x", GROQ_BASE_URL: `${base}/groq` });
  const hi: ChatMessage[] = [{ role: "user", content: "hi" }];

  it("moves to Groq when Gemini's daily limit is used up, and stays there", async () => {
    Object.assign(process.env, { AGENT_API_KEY: "g", AGENT_BASE_URL: `${base}/gemini`, AGENT_MODEL: "m1", ...groq() });
    const r = await chat({ messages: hi, tools: [] });
    expect(r).toMatchObject({ model: "openai/gpt-oss-120b", message: { content: "from openai/gpt-oss-120b" } });
    expect(seen).toEqual(["/gemini/chat/completions m1", "/groq/chat/completions openai/gpt-oss-120b"]);
    expect(currentEndpoint()?.id).toBe("groq:openai/gpt-oss-120b");
  });

  it("says why when every AI is used up", async () => {
    Object.assign(process.env, { AGENT_API_KEY: "g", AGENT_BASE_URL: `${base}/gemini`, AGENT_MODEL: "m1" });
    await expect(chat({ messages: hi, tools: [] })).rejects.toThrow(/daily limits are used up/);
  });

  it("hands a step to the next Gemini model at once when one hits its per-minute limit", async () => {
    Object.assign(process.env, { AGENT_API_KEY: "g", AGENT_BASE_URL: `${base}/rpm`, AGENT_MODEL: "m1,m2", ...groq() });
    const waits: number[] = [];
    const started = Date.now();
    const r = await chat({ messages: hi, tools: [], onWait: (s) => waits.push(s) });
    expect(r.model).toBe("m2");
    expect(waits).toEqual([]);
    expect(Date.now() - started).toBeLessThan(800);
    expect(currentEndpoint()?.id).toBe("agent:m2"); // m1 rests until its minute is over
  });

  it("waits a moment for a resting Gemini model rather than handing the step to Groq", async () => {
    // m1 hits its per-minute limit, m2 is used up for the day: m1 is back in a second.
    Object.assign(process.env, { AGENT_API_KEY: "g", AGENT_BASE_URL: `${base}/mix`, AGENT_MODEL: "m1,m2", ...groq() });
    const waits: string[] = [];
    const r = await chat({ messages: hi, tools: [], onWait: (_s, why) => waits.push(why) });
    expect(r.model).toBe("m1");
    expect(waits).toEqual(["AI rate limit"]);
    expect(seen.some((s) => s.startsWith("/groq"))).toBe(false);
  }, 10_000);

  it("gives a request to Groq when the main AI is too slow, even with the owner's Stop signal passed", async () => {
    Object.assign(process.env, { AGENT_API_KEY: "g", AGENT_BASE_URL: `${base}/slow`, AGENT_MODEL: "m1", AGENT_TIMEOUT_SECONDS: "0.3", ...groq() });
    const r = await chat({ messages: hi, tools: [], signal: new AbortController().signal });
    expect(r.model).toBe("openai/gpt-oss-120b");
    expect(currentEndpoint()?.id).toBe("groq:openai/gpt-oss-120b");
  });

  it("stops at the time limit when there's no other AI", async () => {
    Object.assign(process.env, { AGENT_API_KEY: "g", AGENT_BASE_URL: `${base}/slow`, AGENT_MODEL: "m1", AGENT_TIMEOUT_SECONDS: "0.3" });
    await expect(chat({ messages: hi, tools: [] })).rejects.toThrow(/took longer than/);
  });

  it("gives a refused request to the next AI without skipping the main AI afterwards", async () => {
    Object.assign(process.env, { AGENT_API_KEY: "g", AGENT_BASE_URL: `${base}/refuse`, AGENT_MODEL: "m1", ...groq() });
    const r = await chat({ messages: hi, tools: [] });
    expect(r.model).toBe("openai/gpt-oss-120b");
    expect(seen).toEqual(["/refuse/chat/completions m1", "/groq/chat/completions openai/gpt-oss-120b"]);
    expect(currentEndpoint()?.id).toBe("agent:m1");
  });
});

describe("test room settings", () => {
  it("keeps NAME=value settings but never the room, token or Python ones", () => {
    expect(testSettings(["ANNOUNCE_SECONDS=5", "HIGHRISE_BOT_TOKEN=x", "HR_BOTAPI_URL=ws://real", "PYTHONPATH=/x", "bad", "lower=1"]))
      .toEqual({ ANNOUNCE_SECONDS: "5" });
    expect(testSettings("ANNOUNCE_SECONDS=5")).toEqual({});
  });
});
