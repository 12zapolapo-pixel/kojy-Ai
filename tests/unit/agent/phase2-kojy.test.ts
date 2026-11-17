/**
 * Kojy can test more than chat, says what happened when a tool call was cut
 * off, doesn't take "yes please" for a new request, and reads lessons by size
 * rather than only the newest 15.
 */
import { brokenCall } from "../../../apps/runner/src/agent/agent.js";
import { describeEvent, parseEvents, testUser, wireEvent } from "../../../apps/runner/src/agent/mockRoom.js";
import { isContinuation, requestIndex } from "../../../apps/runner/src/agent/taskMemory.js";
import { pickMemories } from "../../../apps/runner/src/agent/tools.js";
import { automaticRefusal } from "../../../apps/runner/src/agent/autoFix.js";
import { runHarness } from "../../../apps/runner/src/agent/jsTools.js";

describe("room events for tests", () => {
  it("cleans the AI's events: defaults, limits, unknown types dropped", () => {
    const ev = parseEvents([{ type: "tip" }, { type: "chat", user: "@Owner", text: "!addword x" }, { type: "fly" }, "nope", { type: "leave", user: "maya" }]);
    expect(ev.map((e) => [e.type, e.user])).toEqual([["tip", "tester"], ["chat", "Owner"], ["leave", "maya"]]);
    expect(ev[0]!.amount).toBe(10);
    expect(parseEvents(Array.from({ length: 30 }, () => ({ type: "join" })))).toHaveLength(12);
  });

  it("builds the messages Highrise sends, from the room owner too", () => {
    const [tip, owner, dm] = parseEvents([{ type: "tip", amount: 100 }, { type: "chat", user: "owner", text: "!voice" }, { type: "dm", text: "hi" }]);
    expect(wireEvent(tip!)).toMatchObject({ _type: "TipReactionEvent", sender: { username: "tester" }, item: { type: "gold", amount: 100 } });
    expect(wireEvent(owner!)).toMatchObject({ _type: "ChatEvent", user: { id: "u-owner" }, message: "!voice", whisper: false });
    expect(wireEvent(dm!)).toBeNull(); // sent as a MessageEvent with a conversation
    expect(describeEvent(tip!)).toBe("tester tips the bot 100 gold");
    expect(testUser("Maya").id).toBe("u-maya");
  });

  it("a JS script sees a tip event", async () => {
    const code = `export default function handler(event) {
      if (event._type === "TipReactionEvent") return [{ kind: "chat", request: { _type: "ChatRequest", message: "thanks " + event.sender.username + " for " + event.item.amount, whisper_target_id: null } }];
      return [];
    }`;
    const w = wireEvent(parseEvents([{ type: "tip", amount: 50 }])[0]!)!;
    const r = await runHarness(code, [{ ...w, __label: "tester tips the bot 50 gold" }]);
    expect(r.error).toBeUndefined();
    expect(r.results?.[0]).toMatchObject({ event: "tester tips the bot 50 gold" });
    expect(JSON.stringify(r.results?.[0]?.actions)).toContain("thanks tester for 50");
  });
});

describe("a tool call cut off by the length limit", () => {
  it("is explained instead of reported as an invalid path", () => {
    const r = brokenCall("write_file", '{"path":"bot.py","content":"import os\\nclass Bot', true);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/cut off/);
    expect(r.output).toMatch(/append: true/);
    expect(brokenCall("edit_file", "{not json}", false).output).toMatch(/weren't valid JSON/);
  });

  it("an append in a crash fix is checked as the whole new file", () => {
    const refusal = automaticRefusal("crash", "write_file", { path: "bot.py", append: true, content: "import subprocess" }, () => "print(1)");
    expect(refusal).toMatch(/running programs/);
  });
});

describe("what counts as a new request", () => {
  it("short yeses and thanks keep the current request", () => {
    for (const t of ["yes please", "ok go ahead", "Sounds good 👍", "do it", "👍", "thanks!", "yes, continue please"]) expect(isContinuation(t)).toBe(true);
    for (const t of ["yes, and add a !dance command", "fix the greeting", "no", "make it say hi in Spanish"]) expect(isContinuation(t)).toBe(false);
    const rows = [{ role: "user", kind: "text", content: "add a !dance command" }, { role: "assistant", kind: "text", content: "plan?" }, { role: "user", kind: "text", content: "yes please" }];
    expect(requestIndex(rows)).toBe(0);
  });
});

describe("lessons Kojy reads", () => {
  it("this bot's first, then all bots', newest first, within the size budget, oldest first in the end", () => {
    const rows = [
      { id: 1, content: "old lesson for every bot", projectId: null },
      { id: 2, content: "x".repeat(50), projectId: 9 }, // another bot's
      ...Array.from({ length: 20 }, (_, i) => ({ id: 10 + i, content: `bot lesson ${i}`, projectId: 5 })),
    ];
    const picked = pickMemories(rows, 5, 10_000);
    expect(picked).toHaveLength(21); // not capped at 15
    expect(picked[0]).toBe("old lesson for every bot");
    expect(picked).not.toContain("x".repeat(50));
    const small = pickMemories(rows, 5, 60);
    expect(small.every((m) => m.startsWith("bot lesson"))).toBe(true);
  });
});
