import { Agent, pairToolCalls } from "../../../apps/runner/src/agent/agent.js";
import type { ChatMessage } from "../../../apps/runner/src/agent/groq.js";

const call = (id: string): ChatMessage => ({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "list_files", arguments: "{}" } }] });
const result = (id: string): ChatMessage => ({ role: "tool", tool_call_id: id, content: "ok" });
const user = (content: string): ChatMessage => ({ role: "user", content });

describe("coder AI history", () => {
  it("moves a message sent mid-step after the tool results", () => {
    const out = pairToolCalls([user("a"), call("1"), user("b"), result("1")]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
  });

  it("drops tool calls that never got a result, keeping their text", () => {
    const out = pairToolCalls([user("a"), { ...call("1"), content: "let me look" }, user("b")]);
    expect(out).toEqual([user("a"), { role: "assistant", content: "let me look" }, user("b")]);
  });

  it("drops results without a call", () => {
    expect(pairToolCalls([user("a"), result("x")])).toEqual([user("a")]);
  });

  it("starts at a user message when the 80-row window, not the budget, begins mid-task", async () => {
    // Oldest first: the window opens on one of Kojy's steps (Gemini refuses a tool call that doesn't follow a user turn).
    const oldestFirst = [
      { role: "assistant", kind: "text", content: "", data: { toolCalls: [{ id: "c1", type: "function", function: { name: "list_files", arguments: "{}" } }] } },
      { role: "tool", kind: "tool", content: "bot.py", data: { toolCallId: "c1", summary: "Listed files" } },
      { role: "assistant", kind: "text", content: "Done.", data: null },
      { role: "user", kind: "text", content: "hi", data: null },
    ];
    const rows = [...oldestFirst].reverse(); // the runner reads newest first
    const db = { select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => rows }) }) }) }) };
    const agent = new Agent(db as any, {} as any, null);
    const messages: ChatMessage[] = await (agent as any).buildMessages({ thread: "project:1", projectId: 1, system: async () => "SYS" }, 30_000);
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
  });
});

describe("coder AI history on a long task", () => {
  it("keeps the owner's request first when 80 rows of steps pushed it out", async () => {
    const steps: Record<string, unknown>[] = [];
    for (let i = 0; i < 40; i++) {
      steps.push({ role: "assistant", kind: "text", content: "", data: { toolCalls: [{ id: `c${i}`, type: "function", function: { name: "list_files", arguments: "{}" } }] } });
      steps.push({ role: "tool", kind: "tool", content: "ok", data: { toolCallId: `c${i}`, summary: "Listed" } });
    }
    const ask = { role: "user", kind: "text", content: "add !dice", data: null };
    const answers = [[...steps].reverse(), [ask]];
    const db = { select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => answers.shift() ?? [] }) }) }) }) };
    const agent = new Agent(db as any, {} as any, null);
    const messages: ChatMessage[] = await (agent as any).buildMessages({ thread: "project:1", projectId: 1, system: async () => "SYS" }, 200_000);
    expect(messages.slice(0, 3).map((m) => [m.role, m.content])).toEqual([["system", "SYS"], ["user", "add !dice"], ["assistant", null]]);
    expect(messages.filter((m) => m.role === "tool")).toHaveLength(40);
  });
});

describe("coder AI history on a small plan", () => {
  it("keeps the request and the newest steps when the current task alone is over the budget", async () => {
    const rows: Record<string, unknown>[] = [{ role: "user", kind: "text", content: "fix the bot", data: null }];
    for (let i = 0; i < 30; i++) {
      rows.push({ role: "assistant", kind: "text", content: "", data: { toolCalls: [{ id: `c${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }] } });
      rows.push({ role: "tool", kind: "tool", content: "x".repeat(400), data: { toolCallId: `c${i}`, summary: "Read" } });
    }
    const db = { select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [...rows].reverse() }) }) }) }) };
    const agent = new Agent(db as any, {} as any, null);
    const messages: ChatMessage[] = await (agent as any).buildMessages({ thread: "project:1", projectId: 1, system: async () => "SYS" }, 1200);
    expect(messages[1]).toEqual({ role: "user", content: "fix the bot" });
    const tools = messages.filter((m) => m.role === "tool");
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.length).toBeLessThan(30);
    expect((tools[tools.length - 1] as { tool_call_id: string }).tool_call_id).toBe("c29"); // the newest step is kept
  });
});
