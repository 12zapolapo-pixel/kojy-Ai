import { shrinkOld, SCOUT_TOOLS } from "../../../apps/runner/src/agent/scout.js";
import type { ChatMessage } from "../../../apps/runner/src/agent/groq.js";

describe("code scout", () => {
  it("only reads: no tool that changes the bot, costs anything or goes online", () => {
    for (const name of ["edit_file", "write_file", "replace_lines", "delete_file", "bot_control", "save_test", "remember", "request_secrets", "web_search", "fetch_url", "explore"]) {
      expect(SCOUT_TOOLS.has(name), name).toBe(false);
    }
  });

  it("keeps the newest readings whole and shrinks older ones to their summary", () => {
    const msgs: ChatMessage[] = [{ role: "system", content: "S" }, { role: "user", content: "Q" }];
    const summaries = new Map<string, string>();
    for (let i = 0; i < 5; i++) {
      msgs.push({ role: "assistant", content: null, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }] });
      msgs.push({ role: "tool", tool_call_id: `c${i}`, content: `whole file ${i}` });
      summaries.set(`c${i}`, `Read file ${i}`);
    }
    const out = shrinkOld(msgs, summaries, 2).filter((m) => m.role === "tool").map((m) => m.content);
    expect(out).toEqual(["(read earlier) Read file 0", "(read earlier) Read file 1", "(read earlier) Read file 2", "whole file 3", "whole file 4"]);
  });
});
