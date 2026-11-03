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

import { normalizeTurns, supersededResults } from "../../../apps/runner/src/agent/agent.js";
import { isNetworkFailure } from "../../../apps/runner/src/agent/autoFix.js";

describe("reading the same thing twice (2026-11-03: Kojy re-read bot.py in a loop)", () => {
  const callRow = (id: number, callId: string, name: string, args: string) =>
    ({ id, role: "assistant", data: { toolCalls: [{ id: callId, type: "function", function: { name, arguments: args } }] } });
  const resultRow = (id: number, callId: string) => ({ id, role: "tool", data: { toolCallId: callId } });

  it("only the newest copy of a repeated read stays in full", () => {
    const rows = [
      { id: 1, role: "user", data: null },
      callRow(2, "a", "read_file", '{"path":"bot.py","start":1,"end":200}'), resultRow(3, "a"),
      callRow(4, "b", "read_file", '{"path":"bot.py","start":201,"end":400}'), resultRow(5, "b"),
      // same range again, arguments in another order
      callRow(6, "c", "read_file", '{"end":200,"path":"bot.py","start":1}'), resultRow(7, "c"),
      callRow(8, "d", "get_logs", '{"lines":40}'), resultRow(9, "d"),
      callRow(10, "e", "get_logs", '{"lines":120}'), resultRow(11, "e"),
      callRow(12, "f", "edit_file", '{"path":"bot.py"}'), resultRow(13, "f"),
      callRow(14, "g", "edit_file", '{"path":"bot.py"}'), resultRow(15, "g"),
    ];
    // The older bot.py 1-200 read and the older logs; different ranges and edits are kept.
    expect([...supersededResults(rows)].sort((x, y) => x - y)).toEqual([3, 9]);
  });
});

describe("auto-fix after a crash", () => {
  it("a network error isn't treated as a bug to fix", () => {
    expect(isNetworkFailure([
      "Traceback (most recent call last):",
      '  File "/app/venvs/x/lib/python3.11/site-packages/aiohttp/connector.py", line 1025, in _create_direct_connection',
      "aiohttp.client_exceptions.ClientConnectorError: Cannot connect to host highrise.game:443 ssl:default [Temporary failure in name resolution]",
    ])).toBe(true);
  });

  it("a code error is", () => {
    expect(isNetworkFailure([
      "Traceback (most recent call last):",
      '  File "/app/projects/x/highrise_bot/bot.py", line 302, in on_user_join',
      "TypeError: '<=' not supported between instances of 'float' and 'NoneType'",
    ])).toBe(false);
  });
});

describe("turn order (2026-11-03: Gemini refused every request)", () => {
  it("a history that opens with Kojy's tool call gets a user turn first", () => {
    const out = normalizeTurns([call("1"), result("1"), user("go on")]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(String(out[0]!.content)).toMatch(/^\[app\] \(Earlier messages/);
  });

  it("a leading result whose call is out of view is dropped", () => {
    expect(normalizeTurns([result("0"), user("hi")])).toEqual([user("hi")]);
  });

  it("an app note right before a step becomes one assistant turn", () => {
    const note: ChatMessage = { role: "assistant", content: "Still on it — part 2 of 4." };
    const out = normalizeTurns([user("fix !tp"), note, call("1"), result("1")]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(out[1]).toMatchObject({ content: "Still on it — part 2 of 4.", tool_calls: [{ id: "1" }] });
  });

  it("a normal history is left as it is", () => {
    const msgs = [user("a"), call("1"), result("1"), { role: "assistant", content: "done" } as ChatMessage, user("b")];
    expect(normalizeTurns(msgs)).toEqual(msgs);
  });
});
