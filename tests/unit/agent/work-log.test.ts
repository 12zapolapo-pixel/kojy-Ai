import { describe, expect, it } from "vitest";
import { formatEntry, likePattern, recentWorkPrompt, summarizeWork, type WorkRow } from "../../../apps/runner/src/agent/workLog.js";

let id = 0;
const at = new Date("2026-11-03T10:00:00Z");
const row = (role: string, content: string, data: Record<string, unknown> | null = null, kind = "text"): WorkRow =>
  ({ id: ++id, role, kind, content, data, createdAt: at });
const call = (cid: string, name: string, args: object) => ({ id: cid, type: "function", function: { name, arguments: JSON.stringify(args) } });
const result = (cid: string, name: string, summary: string, ok = true) => row("tool", "out", { toolCallId: cid, name, summary, ok }, "tool");

describe("summarizeWork", () => {
  const rows = [
    row("user", "Old request"),
    row("assistant", "old answer"),
    row("user", "Add !tp and !bring for moderators"),
    row("assistant", "", { toolCalls: [call("c1", "read_file", { path: "bot.py" }), call("c2", "write_file", { path: "commands/teleport.py", content: "..." })] }),
    result("c1", "read_file", "Read bot.py (lines 1-120)"),
    result("c2", "write_file", "Wrote commands/teleport.py"),
    row("assistant", "", { toolCalls: [call("c3", "edit_file", { path: "bot.py" }), call("c4", "test_in_room", {})] }),
    result("c3", "edit_file", "Edited bot.py"),
    result("c4", "test_in_room", "Tested in a fake room: errors", false),
    row("assistant", "I've used my step limit.", null, "event"),
    row("user", "continue"),
    row("assistant", "", { toolCalls: [call("c5", "edit_file", { path: "commands/teleport.py" }), call("c6", "delete_file", { path: "old.py" })] }),
    result("c5", "edit_file", "Edited commands/teleport.py"),
    result("c6", "delete_file", "Deleted old.py"),
    row("assistant", "Added !tp and !bring; the room test passes now."),
  ];
  const w = summarizeWork(rows)!;

  it("finds the real request, not 'continue'", () => {
    expect(w.request).toBe("Add !tp and !bring for moderators");
    expect(w.requestMessageId).toBe(rows[2]!.id);
  });

  it("lists each changed file once, with its latest change", () => {
    expect(w.files).toEqual([
      { path: "bot.py", change: "edited" },
      { path: "commands/teleport.py", change: "edited" },
      { path: "old.py", change: "deleted" },
    ]);
  });

  it("keeps the steps that worked and the ones that failed", () => {
    expect(w.actions).toContain("Wrote commands/teleport.py");
    expect(w.failed).toEqual(["Tested in a fake room: errors"]);
  });

  it("uses Kojy's latest text answer as the result, not app events", () => {
    expect(w.summary).toBe("Added !tp and !bring; the room test passes now.");
  });

  it("a file whose change failed is not listed", () => {
    const r = [row("user", "Change x"), row("assistant", "", { toolCalls: [call("z1", "write_file", { path: "x.py" })] }), result("z1", "write_file", "Couldn't write x.py", false)];
    expect(summarizeWork(r)!.files).toEqual([]);
  });

  it("no request, no entry", () => {
    expect(summarizeWork([row("assistant", "hi")])).toBeNull();
  });
});

describe("work log in the prompt", () => {
  const e = (request: string, status = "done", minutes = 0) => ({
    id: 1, thread: "project:1", projectId: 1, requestMessageId: 1, request, status, summary: "Did it.",
    files: [{ path: "bot.py", change: "edited" }], actions: [], failed: [],
    startedAt: at, updatedAt: new Date(at.getTime() + minutes * 60_000),
  });

  it("shows earlier requests newest last and skips the current one", () => {
    const p = recentWorkPrompt([e("Current job", "in_progress", 3), e("Second", "done", 2), e("First", "done", 1)], "Current job");
    expect(p).toContain("Work log of this chat");
    expect(p.indexOf("First")).toBeLessThan(p.indexOf("Second"));
    expect(p).not.toContain("Current job");
    expect(p).toContain("edited bot.py");
  });

  it("is empty when there is nothing earlier", () => {
    expect(recentWorkPrompt([], null)).toBe("");
    expect(recentWorkPrompt([e("Only")], "Only")).toBe("");
  });

  it("keeps each line short", () => {
    const line = formatEntry(e("x".repeat(1000)));
    expect(line.length).toBeLessThan(400);
  });
});

describe("likePattern", () => {
  it("matches the owner's words literally", () => {
    expect(likePattern("100%_done")).toBe("%100\\%\\_done%");
    expect(likePattern("a\\b")).toBe("%a\\\\b%");
  });
});
