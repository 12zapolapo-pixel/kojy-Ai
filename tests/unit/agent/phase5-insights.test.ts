/**
 * Phase 5: the launcher reports a tip's gold and a chat's command word —
 * never the rest of the message — and the activity recorder keeps them tidy.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ActivityRecorder } from "../../../packages/db/src/events.js";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const launcherDir = path.resolve("apps/runner/src");

describe.skipIf(!hasPython)("launcher activity details", () => {
  it("keeps only the command word, lower-cased, and the gold of gold tips", () => {
    const script = `
import json, launcher as L
class Tip:
    def __init__(self, type, amount): self.type, self.amount = type, amount
print(json.dumps([
  L.command_word("!Dance now please"), L.command_word("/tp amy"), L.command_word("hello !dance"),
  L.command_word("!"), L.command_word("!!!"), L.command_word(None),
  L.tip_gold(Tip("gold", 50)), L.tip_gold(Tip("clothing", 1)), L.tip_gold(Tip("gold", -3)), L.tip_gold(None),
]))`;
    const r = spawnSync("python3", ["-c", script], { cwd: launcherDir, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toEqual(["!dance", "/tp", null, null, null, null, 50, null, null, null]);
  });
});

describe("ActivityRecorder", () => {
  it("clamps amounts and trims details before saving", async () => {
    const saved: Record<string, unknown>[] = [];
    const db = { insert: () => ({ values: async (rows: Record<string, unknown>[]) => { saved.push(...rows); } }) };
    const rec = new ActivityRecorder(db as never, 60_000);
    rec.record({ orgId: 1, source: "project", sourceId: 1, kind: "tip", amount: 12.6 });
    rec.record({ orgId: 1, source: "project", sourceId: 1, kind: "tip", amount: Number.NaN });
    rec.record({ orgId: 1, source: "project", sourceId: 1, kind: "chat", detail: `!${"x".repeat(80)}` });
    await rec.stop();
    expect(saved.map((r) => r.amount)).toEqual([13, null, null]);
    expect(String(saved[2]!.detail)).toHaveLength(40);
  });
});
