import { pairToolCalls } from "../../../apps/runner/src/agent/agent.js";
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
});
