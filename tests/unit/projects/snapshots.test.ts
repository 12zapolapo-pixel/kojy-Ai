/** Undo for code: going back saves the code as it is now first, so an undo can be undone. */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.PROJECTS_DIR = mkdtempSync(path.join(tmpdir(), "kojy-snapshots-"));
const files = await import("../../../packages/shared/src/projects/files.js");
const uuid = "00000000-0000-4000-8000-0000000000aa";

describe("snapshots", () => {
  it("restoring saves the current code first, with its label, and the restore can be undone", () => {
    const dir = files.ensureProjectDir(uuid);
    writeFileSync(path.join(dir, "bot.py"), "v1");
    const first = files.snapshotProject(uuid, "Before Kojy: “add a !dance command”");
    writeFileSync(path.join(dir, "bot.py"), "v2");

    files.restoreSnapshot(uuid, first.id, "Before going back");
    expect(readFileSync(path.join(dir, "bot.py"), "utf8")).toBe("v1");

    const list = files.listSnapshots(uuid);
    expect(list.map((s) => s.reason)).toEqual(["Before going back", "Before Kojy: “add a !dance command”"]);
    files.restoreSnapshot(uuid, list[0]!.id);
    expect(readFileSync(path.join(dir, "bot.py"), "utf8")).toBe("v2");
  });

  it("keeps the version being restored even when saving the current one prunes old ones", () => {
    const id = "00000000-0000-4000-8000-0000000000bb";
    const dir = files.ensureProjectDir(id);
    writeFileSync(path.join(dir, "bot.py"), "oldest");
    const oldest = files.snapshotProject(id, "oldest");
    for (let i = 0; i < 24; i++) files.snapshotProject(id, `n${i}`);
    writeFileSync(path.join(dir, "bot.py"), "now");
    files.restoreSnapshot(id, oldest.id, "Before going back");
    expect(readFileSync(path.join(dir, "bot.py"), "utf8")).toBe("oldest");
  });

  it("knows whether there is code to save", () => {
    const id = "00000000-0000-4000-8000-0000000000cc";
    files.ensureProjectDir(id);
    expect(files.hasCode(id)).toBe(false);
  });
});
