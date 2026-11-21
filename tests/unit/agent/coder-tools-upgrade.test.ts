/**
 * Kojy "didn't have the tools" (the Crii chat, 2026-11): every bigger
 * write_file was cut off at a fixed ~2,000-token output limit, the cut-off
 * call ran with no arguments ("Invalid path: "), and Kojy told the owner it
 * couldn't write files — which then stayed in its history and work log.
 * These tests pin the fixes and the new tools.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyEdit, applyEdits } from "../../../apps/runner/src/agent/editing.js";
import { deniesCapability } from "../../../apps/runner/src/agent/taskMemory.js";
import { formatEntry } from "../../../apps/runner/src/agent/workLog.js";
import { automaticRefusal, automaticTools, AUTOMATIC_RUN_LOCKED } from "../../../apps/runner/src/agent/autoFix.js";
import { TOOL_SPECS } from "../../../apps/runner/src/agent/tools.js";
import { htmlToText, isPrivateAddress, urlProblem, summarizePypi, fetchPublic } from "../../../apps/runner/src/agent/webFetch.js";
import { badArguments, missingArguments, parseToolArguments } from "../../../apps/runner/src/agent/agent.js";
import { fixPrompt, systemPrompt } from "../../../apps/runner/src/agent/prompt.js";

// ── the AI client: output room, cut-off answers ─────────────────────────────

let server: http.Server;
let bodies: Record<string, unknown>[] = [];
/** Characters of tool-call arguments the fake model wants to write. */
let wantChars = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const r = JSON.parse(body) as { max_tokens: number };
      bodies.push(r as unknown as Record<string, unknown>);
      // Like real providers: the answer stops at max_tokens (~4 characters a token).
      const args = JSON.stringify({ path: "main.py", content: "x".repeat(wantChars) });
      const room = r.max_tokens * 4;
      const cut = args.length > room;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ finish_reason: cut ? "length" : "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: cut ? args.slice(0, room) : args } }] } }],
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { bodies = []; });

async function client(env: Record<string, string>) {
  const keys = ["AGENT_API_KEY", "AGENT_API_KEYS", "GEMINI_MODELS", "GEMINI_BASE_URL", "MISTRAL_API_KEY", "MISTRAL_BASE_URL", "MISTRAL_MODELS", "MISTRAL_TOKENS_PER_MINUTE", "MISTRAL_MIN_INTERVAL_MS", "GROQ_API_KEY", "AGENT_LANE_ORDER"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  vi.resetModules();
  const ai = await import("../../../apps/runner/src/agent/groq.js");
  ai._resetAiStateForTests();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return ai;
}
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const tool = { type: "function" as const, function: { name: "write_file", description: "w", parameters: { type: "object", properties: {} } } };

describe("output room for each AI", () => {
  it("asks for a whole file's worth by default (not the old ~2,000 tokens)", async () => {
    wantChars = 20_000; // ~5,000 tokens: the old limit cut this off
    const ai = await client({ AGENT_API_KEY: "k", GEMINI_MODELS: "gem", GEMINI_BASE_URL: base() });
    const out = await ai.chat({ messages: [{ role: "user", content: "write it" }], tools: [tool] });
    expect(out.truncated).toBe(false);
    expect(ai.argumentsParse(out.message.tool_calls![0]!.function.arguments)).toBe(true);
    expect(Number(bodies[0]!.max_tokens)).toBeGreaterThanOrEqual(8192);
  });

  it("an answer cut off at its limit is asked again with more room", async () => {
    wantChars = 60_000; // ~15,000 tokens: over the first try's room
    const ai = await client({ AGENT_API_KEY: "k", GEMINI_MODELS: "gem", GEMINI_BASE_URL: base() });
    const out = await ai.chat({ messages: [{ role: "user", content: "write it" }], tools: [tool] });
    expect(bodies).toHaveLength(2);
    expect(Number(bodies[1]!.max_tokens)).toBeGreaterThan(Number(bodies[0]!.max_tokens));
    expect(out.truncated).toBe(false);
    expect(ai.argumentsParse(out.message.tool_calls![0]!.function.arguments)).toBe(true);
  });

  it("when the plan has no more room, the answer comes back marked cut off (never silently broken)", async () => {
    wantChars = 60_000;
    const ai = await client({ MISTRAL_API_KEY: "m", MISTRAL_MODELS: "mis", MISTRAL_BASE_URL: base(), MISTRAL_TOKENS_PER_MINUTE: "9000", MISTRAL_MIN_INTERVAL_MS: "0" });
    const out = await ai.chat({ messages: [{ role: "user", content: "write it" }], tools: [tool] });
    expect(out.truncated).toBe(true);
    expect(ai.argumentsParse(out.message.tool_calls![0]!.function.arguments)).toBe(false);
    expect(out.outputLimit).toBeLessThanOrEqual(9000);
  });

  it("per-minute plans give what their budget leaves; others their cap; too little room = not used", async () => {
    const ai = await client({});
    expect(ai.outputFor({ maxRequestTokens: 20_000, maxOutput: 32_768, thinks: false }, 14_000, 8192)).toBe(6000);
    expect(ai.outputFor({ maxRequestTokens: Infinity, maxOutput: 8192, thinks: false }, 50_000, 8192)).toBe(8192);
    expect(ai.outputFor({ maxRequestTokens: Infinity, maxOutput: 32_768, thinks: true }, 1000, 8192)).toBe(8192 + 4096);
    expect(ai.outputFor({ maxRequestTokens: 7500, maxOutput: 32_768, thinks: false }, 7000, 8192)).toBe(0);
  });

  it("learns a model's output limit from its error message", async () => {
    const ai = await client({});
    expect(ai.maxTokensFromError("max_tokens is too large: 12288. This model supports at most 4096 completion tokens, whereas you provided 12288.", 12288)).toBe(4096);
    expect(ai.maxTokensFromError("Invalid max_tokens value, the valid range of max_tokens is [1, 8192]", 12288)).toBe(8192);
    expect(ai.maxTokensFromError("bad request", 12288)).toBeNull();
  });
});

describe("tool calls, whatever shape a provider sends", () => {
  it("arguments as an object, a missing id or the same id twice are made uniform", async () => {
    const ai = await client({});
    const calls = ai.normalizeToolCalls([
      { function: { name: "read_file", arguments: { path: "a.py" } } },
      { id: "x", function: { name: "read_file", arguments: "{}" } },
      { id: "x", function: { name: "list_files", arguments: "{}" } },
      { id: "y", function: { arguments: "{}" } },
    ]);
    expect(calls.map((c) => c.function.name)).toEqual(["read_file", "read_file", "list_files"]);
    expect(calls[0]!.function.arguments).toBe('{"path":"a.py"}');
    expect(new Set(calls.map((c) => c.id)).size).toBe(3);
  });

  it("calls a model wrote into its text are taken as calls (known tools only)", async () => {
    const ai = await client({});
    const names = new Set(["read_file", "write_file"]);
    const a = ai.textToolCalls('Let me look.\n<tool_call>{"name": "read_file", "arguments": {"path": "bot.py"}}</tool_call>', names);
    expect(a.calls[0]!.function).toEqual({ name: "read_file", arguments: '{"path":"bot.py"}' });
    expect(a.text).toBe("Let me look.");
    expect(ai.textToolCalls('<function=write_file>{"path": "a.py", "content": "x"}</function>', names).calls).toHaveLength(1);
    expect(ai.textToolCalls('[TOOL_CALLS][{"name": "read_file", "arguments": {"path": "x"}}]', names).calls).toHaveLength(1);
    expect(ai.textToolCalls('```json\n{"name": "read_file", "arguments": {"path": "x"}}\n```', names).calls).toHaveLength(1);
    expect(ai.textToolCalls('<tool_call>{"name": "rm_rf", "arguments": {}}</tool_call>', names).calls).toHaveLength(0);
    expect(ai.textToolCalls("Use read_file to see it", names).calls).toHaveLength(0);
  });

  it("Mistral gets 9-character ids (the same each time) and never a user turn straight after a tool result", async () => {
    const ai = await client({});
    const out = ai.prepareMessages("mistral", [
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [{ id: "function-call-123456789", type: "function", function: { name: "request_secrets", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "function-call-123456789", content: "form shown" },
      { role: "user", content: "[app] The owner saved these secrets" },
    ]);
    const id = out[1]!.tool_calls![0]!.id;
    expect(id).toMatch(/^[A-Za-z0-9]{9}$/);
    expect(out[2]!.tool_call_id).toBe(id);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
    expect(ai.mistralToolId("AbC123xyz")).toBe("AbC123xyz");
  });

  it("AGENT_LANE_ORDER puts the named providers first", async () => {
    const ai = await client({});
    const lanes = [{ provider: "mistral" }, { provider: "gemini" }, { provider: "openai" }, { provider: "groq" }];
    expect(ai.orderLanes(lanes, ["openai", "gemini"]).map((l) => l.provider)).toEqual(["openai", "gemini", "mistral", "groq"]);
    expect(ai.orderLanes(lanes, [])).toBe(lanes);
  });
});

// ── the agent: cut-off and broken calls are never run ───────────────────────

describe("a call whose arguments are unusable", () => {
  it("is parsed when it's valid (even fenced), else refused with how to do it instead", () => {
    expect(parseToolArguments('{"path":"a.py"}')).toEqual({ path: "a.py" });
    expect(parseToolArguments('```json\n{"path":"a.py"}\n```')).toEqual({ path: "a.py" });
    expect(parseToolArguments("")).toEqual({});
    expect(parseToolArguments('{"path":"main.py","content":"import disc')).toBeNull();
    expect(parseToolArguments("[1,2]")).toBeNull();
  });

  it("a cut-off write says it was cut off, that nothing changed, and to write in parts", () => {
    const r = badArguments("write_file", '{"path":"main.py","content":"import disc', true, 2000);
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/cut off .* nothing was run/);
    expect(r.output).toMatch(/Nothing was run and no file was changed/);
    expect(r.output).toMatch(/write_file with the first part .* append_file/);
    expect(badArguments("read_file", "{oops", false, 2000).output).toMatch(/weren't a valid JSON object/);
  });

  it("missing required arguments are named instead of a confusing 'Invalid path: '", () => {
    const spec = TOOL_SPECS.find((t) => t.function.name === "write_file")!;
    expect(missingArguments(spec, {})?.output).toMatch(/write_file needs path, content/);
    expect(missingArguments(spec, { path: " ", content: "x" })?.summary).toMatch(/missing path/);
    expect(missingArguments(spec, { path: "a/__init__.py", content: "" })).toBeNull(); // an empty file is fine
    const edit = TOOL_SPECS.find((t) => t.function.name === "edit_file")!;
    expect(missingArguments(edit, { path: "a.py", old_text: "x", new_text: "" })).toBeNull(); // deleting text is fine
  });
});

describe("a false \"I can't\"", () => {
  it("is recognised", () => {
    for (const t of [
      "Sorry, I don't have the tools to create files right now.",
      "I currently don't have the capability to test secrets or continue with your request",
      "I'm unable to write files directly, but here is the code:",
      "I can't edit the files myself. You'll need to paste this into main.py yourself.",
      "Unfortunately that's beyond my capabilities.",
      "I don't have access to the bot's files.",
    ]) expect(deniesCapability(t), t).toBe(true);
  });

  it("isn't confused with what only the owner can do, or with normal answers", () => {
    for (const t of [
      "I can't switch on the Message Content Intent for you — open the Developer Portal: https://discord.com/developers/applications/1/bot",
      "I don't have access to your Highrise account; make the bot a moderator in the room settings.",
      "Done! I added the !dance command and tested it in the fake room.",
      "The bot can't reach the room right now because Highrise is down.",
      "",
    ]) expect(deniesCapability(t), t).toBe(false);
  });

  it("isn't repeated as an earlier request's result in the work log", () => {
    const entry = { status: "done", request: "write Crii", summary: "Sorry, I don't have the tools to create files right now.", files: [], updatedAt: new Date() };
    expect(formatEntry(entry as never)).toMatch(/result: not done — Kojy wrongly said it couldn't/);
    expect(formatEntry({ ...entry, summary: "Added /ping." } as never)).toContain("result: Added /ping.");
  });
});

describe("the instructions", () => {
  const p = { projectName: "Crii", entrypoint: "run: python main.py", status: "running", secrets: ["DISCORD_TOKEN"], memories: [], fileCount: 4 };
  it("the owner's chat lists the tools up front and has no automatic-fix limits in it", () => {
    const text = systemPrompt(p);
    expect(text.indexOf("Your tools work")).toBeLessThan(text.indexOf("How to work"));
    expect(text).toMatch(/Never tell the owner you can't do something/);
    expect(text).not.toMatch(/add code that reaches the internet, reads secrets or the environment/);
    expect(fixPrompt(p)).toMatch(/can't delete files.*run commands or git, or add code that reaches the internet/s);
  });
});

// ── editing ──────────────────────────────────────────────────────────────────

describe("edit_file matching", () => {
  const file = "class Bot:\n    async def on_chat(self, user, msg):\n        if msg == '!hi':\n            await self.say('hi')\n";
  it("exact text, and every match with replace_all", () => {
    const r = applyEdit(file, "'hi'", "'hello'");
    expect(r.ok && r.text).toContain("await self.say('hello')");
    expect(applyEdit("a a a", "a", "b").ok).toBe(false);
    const all = applyEdit("a a a", "a", "b", true);
    expect(all.ok && all.text).toBe("b b b");
  });

  it("a copy off only in trailing spaces or line endings still matches", () => {
    const crlf = file.replace(/\n/g, "\r\n");
    const r = applyEdit(crlf, "        if msg == '!hi':   \n            await self.say('hi')", "        if msg == '!hey':\n            await self.say('hey')");
    expect(r.ok && r.how).toBe("whitespace");
    expect(r.ok && r.text).toContain("if msg == '!hey':\r\n            await self.say('hey')\r\n");
  });

  it("a block copied one level off is matched, and the new text is moved the same way", () => {
    const r = applyEdit(file, "if msg == '!hi':\n    await self.say('hi')", "if msg == '!hi':\n    await self.say('hi there')\n    await self.react()");
    expect(r.ok && r.how).toBe("indentation");
    expect(r.ok && r.text).toContain("        if msg == '!hi':\n            await self.say('hi there')\n            await self.react()\n");
  });

  it("no match: the closest lines are shown with their numbers", () => {
    const r = applyEdit(file, "        if message == '!hi':", "x");
    expect(!r.ok && r.error).toMatch(/closest lines in the file now:\n[\s\S]*3\|         if msg == '!hi':/);
  });

  it("multi_edit applies all or none", () => {
    expect(applyEdits("a\nb\n", [{ old_text: "a", new_text: "A" }, { old_text: "b", new_text: "B" }])).toMatchObject({ ok: true, text: "A\nB\n" });
    const r = applyEdits("a\nb\n", [{ old_text: "a", new_text: "A" }, { old_text: "zzz", new_text: "B" }]);
    expect(!r.ok && r.error).toMatch(/^Edit 2 of 2 didn't apply, so none were made/);
  });
});

// ── fetch_url ────────────────────────────────────────────────────────────────

describe("fetch_url only reads the public web", () => {
  it("private, local and odd addresses are refused before connecting", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.5", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:10.0.0.1"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "151.101.0.223", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
    expect(urlProblem("http://127.0.0.1/admin")).toMatch(/private network/);
    expect(urlProblem("http://api:3001/trpc")).not.toBeNull(); // the API on KojyAI's own network
    expect(urlProblem("http://api/trpc")).toMatch(/public/);
    expect(urlProblem("http://redis.internal/")).toMatch(/public/);
    expect(urlProblem("https://user:pw@example.com/")).toMatch(/user name/);
    expect(urlProblem("https://example.com:6379/")).toMatch(/ports/);
    expect(urlProblem("file:///etc/passwd")).toMatch(/http/);
    expect(urlProblem("https://discordpy.readthedocs.io/en/stable/")).toBeNull();
  });

  it("a host name that resolves to a private address is refused when connecting", async () => {
    await expect(fetchPublic("http://localtest.me/")).rejects.toThrow(/private network|ENOTFOUND|EAI_AGAIN/);
  });

  it("pages become readable text; PyPI's JSON becomes a short summary", () => {
    const text = htmlToText("<html><head><title>Docs</title><script>evil()</script></head><body><nav>menu</nav><h1>Intents</h1><p>Use <code>Intents.default()</code> &amp; slash commands.</p><ul><li>one</li></ul></body></html>");
    expect(text).toMatch(/^Docs\n\nIntents\nUse Intents.default\(\) & slash commands./);
    expect(text).not.toMatch(/evil|menu/);
    const pypi = summarizePypi(JSON.stringify({ info: { name: "discord.py", version: "2.6.4", summary: "A Python wrapper for the Discord API", requires_python: ">=3.8", requires_dist: ["aiohttp<4,>=3.7.4"] }, releases: { "2.6.3": [], "2.6.4": [] } }));
    expect(pypi).toMatch(/^discord\.py 2\.6\.4 — A Python wrapper/);
    expect(pypi).toContain("Needs: aiohttp<4,>=3.7.4");
  });
});

// ── automatic fixes keep their limits with the new tools ────────────────────

describe("automatic fixes and the new tools", () => {
  const none = () => "";
  it("running code, reading the web, moving files and undo stay owner-only", () => {
    for (const t of ["run_python", "fetch_url", "move_file", "undo_changes"]) {
      expect(AUTOMATIC_RUN_LOCKED[t], t).toBeTruthy();
      expect(automaticRefusal("crash", t, {}, none)).toMatch(/Not allowed in an automatic fix/);
    }
    const names = automaticTools(TOOL_SPECS).map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(["multi_edit", "append_file"]));
    expect(names).not.toContain("run_python");
  });

  it("multi_edit and append_file get the same check for injected code as edit_file", () => {
    expect(automaticRefusal("crash", "multi_edit", { path: "bot.py", edits: [{ old_text: "x = 1", new_text: "import requests\nx = 1" }] }, none)).toMatch(/internet access/);
    expect(automaticRefusal("crash", "append_file", { path: "bot.py", content: "import os\nprint(os.environ)" }, none)).toMatch(/secrets or the environment/);
    expect(automaticRefusal("crash", "append_file", { path: "data/x.json", content: "{}" }, none)).toMatch(/saved data/);
    expect(automaticRefusal("crash", "multi_edit", { path: "bot.py", edits: [{ old_text: "d[k]", new_text: "d.get(k)" }] }, none)).toBeNull();
  });
});
