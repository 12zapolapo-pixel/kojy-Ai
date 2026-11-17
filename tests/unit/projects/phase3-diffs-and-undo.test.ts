/**
 * Phase 3: line diffs (Kojy's changes in the chat) and the undo preview
 * (what restoring a snapshot would change).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { lineDiff } from "../../../packages/shared/src/projects/diff.js";

describe("lineDiff", () => {
  it("shows the changed lines with a little context and where they are", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
    const after = ["a", "b", "c", "d", "E", "f", "g", "h"].join("\n");
    const d = lineDiff(before, after, 1)!;
    expect(d).toMatchObject({ added: 1, removed: 1 });
    expect(d.text).toBe(["@@ line 4 @@", " d", "-e", "+E", " f"].join("\n"));
  });

  it("handles a new file, a deleted file and no change", () => {
    expect(lineDiff("", "x\ny\n")).toMatchObject({ added: 2, removed: 0, text: "@@ line 1 @@\n+x\n+y" });
    expect(lineDiff("x\n", "")).toMatchObject({ added: 0, removed: 1 });
    expect(lineDiff("same\n", "same\n")).toMatchObject({ added: 0, removed: 0, text: "" });
  });

  it("keeps separate hunks apart in a long file", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const changed = [...lines];
    changed[10] = "ten";
    changed[80] = "eighty";
    const d = lineDiff(lines.join("\n"), changed.join("\n"), 2)!;
    expect(d.text.match(/^@@/gm)).toHaveLength(2);
    expect(d.text).toContain("@@ line 9 @@");
    expect(d.text).toContain("@@ line 79 @@");
  });

  it("gives up on files too big to compare line by line", () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join("\n");
    expect(lineDiff(a, b)).toBeNull();
  });
});

describe("compareSnapshot", () => {
  let dir: string;
  let files: typeof import("../../../packages/shared/src/projects/files.js");
  const uuid = "22222222-2222-4222-8222-222222222222";
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "kojy-cmp-"));
    process.env.PROJECTS_DIR = dir;
    vi.resetModules();
    files = await import("../../../packages/shared/src/projects/files.js");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("lists what restoring would bring back, remove and change — and ignores the bot's data", () => {
    files.ensureProjectDir(uuid);
    files.writeProjectFile(uuid, "bot.py", "print('one')\n");
    files.writeProjectFile(uuid, "old.py", "x = 1\n");
    files.writeProjectFile(uuid, "data/coins.json", "{}");
    const snap = files.snapshotProject(uuid, "Before Kojy: add !dance");
    files.writeProjectFile(uuid, "bot.py", "print('two')\n");
    files.deleteProjectPath(uuid, "old.py");
    files.writeProjectFile(uuid, "new.py", "y = 2\n");
    files.writeProjectFile(uuid, "data/coins.json", '{"amy": 5}');

    const { files: changes, more } = files.compareSnapshot(uuid, snap.id);
    expect(more).toBe(0);
    expect(changes.map((c) => [c.path, c.change])).toEqual([["bot.py", "modified"], ["new.py", "removed"], ["old.py", "added"]]);
    expect(changes[0]!.diff).toContain("-print('two')");
    expect(changes[0]!.diff).toContain("+print('one')");
    expect(files.listSnapshots(uuid)[0]!.reason).toBe("Before Kojy: add !dance");
  });
});
