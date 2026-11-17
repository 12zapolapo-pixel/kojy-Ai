/**
 * Phase 6: a saved test passes only when the bot did what was expected —
 * judged on the bot's own actions, not on the room's lines.
 */
import { describe, expect, it } from "vitest";
import { missingExpectations } from "../../../apps/runner/src/agent/tools.js";

describe("missingExpectations", () => {
  const actions = ["(amy joins)", "say: Welcome amy!", "(amy tips the bot 50 gold)", "say: Thanks amy for 50 gold", "emote emote-wave on u-amy"];

  it("finds each expected text in what the bot said or did, ignoring case", () => {
    expect(missingExpectations(actions, ["welcome AMY", "50 gold", "emote-wave"])).toEqual([]);
  });

  it("reports what the bot didn't do", () => {
    expect(missingExpectations(actions, ["Bye amy", "Welcome"])).toEqual(["Bye amy"]);
  });

  it("doesn't count the room's own lines as the bot's", () => {
    expect(missingExpectations(["(amy joins)", "(amy says: hello bot)"], ["hello bot"])).toEqual(["hello bot"]);
  });
});
