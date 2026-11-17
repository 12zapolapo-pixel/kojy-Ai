import { describe, expect, it } from "vitest";
import { continuesAutomatically, taskMemory, taskMemoryPrompt, TASK_MAX_CHARS, DONE_MAX_ITEMS, announcesNextStep } from "../../../apps/runner/src/agent/taskMemory.js";

const u = (content: string, kind = "text") => ({ role: "user", kind, content });
const a = (content: string) => ({ role: "assistant", kind: "text", content });
const t = (summary: string, ok = true) => ({ role: "tool", kind: "tool", content: "output", summary, ok });

describe("taskMemory", () => {
  it("keeps the request and the finished steps after a 'continue'", () => {
    const rows = [
      u("Add !tp and !bring for moderators in Japalo"),
      a("On it."),
      t("Read bot.py (lines 1-120)"),
      t("Wrote commands/teleport.py"),
      a("I've used my step limit. Send continue."),
      u("continue"),
    ];
    const m = taskMemory(rows);
    expect(m.task).toBe("Add !tp and !bring for moderators in Japalo");
    expect(m.done).toEqual(["Read bot.py (lines 1-120)", "Wrote commands/teleport.py"]);
  });

  it("lists the steps done since the request, and the failures", () => {
    const rows = [
      u("Add !tp"),
      t("Read bot.py"),
      t("Test failed: NameError", false),
      t("Wrote teleport.py"),
      u("continue"),
    ];
    const m = taskMemory(rows);
    expect(m.done).toEqual(["Read bot.py", "Wrote teleport.py"]);
    expect(m.failed).toEqual(["Test failed: NameError"]);
  });

  it("'continue' alone never becomes the task", () => {
    const m = taskMemory([u("Fix the crash"), t("Ran check"), u("continue"), u("keep going")]);
    expect(m.task).toBe("Fix the crash");
  });

  it("a new request starts a fresh list", () => {
    const m = taskMemory([u("Old job"), t("Old step"), u("New job: add a dance command"), t("New step")]);
    expect(m.task).toBe("New job: add a dance command");
    expect(m.done).toEqual(["New step"]);
  });

  it("app events are not requests", () => {
    const m = taskMemory([u("Build the bot"), u("The owner approved the plan", "event")]);
    expect(m.task).toBe("Build the bot");
  });

  it("no request, no memory", () => {
    expect(taskMemory([t("x")])).toEqual({ task: null, done: [], failed: [] });
    expect(taskMemoryPrompt(taskMemory([]))).toBe("");
  });

  it("caps the size of what goes into the prompt", () => {
    const many = Array.from({ length: 60 }, (_, i) => t(`step ${i}`));
    const m = taskMemory([u("x".repeat(5000)), ...many]);
    expect(m.task!.length).toBe(TASK_MAX_CHARS);
    expect(m.done.length).toBe(DONE_MAX_ITEMS);
    expect(m.done.at(-1)).toBe("step 59");
  });

  it("the prompt block has the request and the done list", () => {
    const p = taskMemoryPrompt({ task: "Add !tp", done: ["Read bot.py"], failed: [] });
    expect(p).toContain("Add !tp");
    expect(p).toContain("- Read bot.py");
    expect(p).toContain("keep working on this until it is done");
  });
});

describe("continuesAutomatically", () => {
  it("continues after a step-limit part while parts remain", () => {
    expect(continuesAutomatically("limit", 0, 4, false)).toBe(true);
    expect(continuesAutomatically("limit", 2, 4, false)).toBe(true);
    expect(continuesAutomatically("limit", 3, 4, false)).toBe(false);
  });
  it("never continues after a finished, waiting or stopped part", () => {
    expect(continuesAutomatically("done", 0, 4, false)).toBe(false);
    expect(continuesAutomatically("waiting", 0, 4, false)).toBe(false);
    expect(continuesAutomatically("limit", 0, 4, true)).toBe(false);
  });
});

describe("a reply that only says what comes next", () => {
  // Real replies from Japalo's chat (2026-11-04) that stopped the request and made the owner type "Continue".
  it("is caught, so Kojy is told to take the step", () => {
    for (const stalled of [
      "Let's check `emote_loop.py` line 137: `current = self._loops.get(user_id)` — this gets the current loop for the user. Let's check `emote_loop.py` line 139: `self._loops.pop(user_id, None)` — this removes the loop from the dictionary.",
      "An explanation of the issue with the emote loop stopping process is required. I will examine `emote_loop.py` line by line to locate any logic bugs.",
      "Let's check `moderation_commands.py` line 254: `await self.highrise.change_room_privilege(target.id, RoomPermissions(moderator=grant))` — this is the actual Highrise API call.",
      "Now let's restart the bot to make changes live in the actual room, then check logs!",
      "",
    ]) expect(announcesNextStep(stalled)).toBe(true);
  });

  it("isn't caught when the work is done or the owner is asked something", () => {
    for (const end of [
      "Everything is tested and verified! Here's how `!setmod` works: 1. **Granting Moderator**: the bot calls Highrise's API and clears any cached permissions.",
      "Yes, everything is fixed and verified! !tp and !bring now work for moderators and the owner.",
      "I fixed the stop command and restarted the bot. Let me know if the avatar still keeps dancing.",
      "Should I also add a !dance command? Let's decide together — which emotes do you want?",
    ]) expect(announcesNextStep(end)).toBe(false);
  });
});
