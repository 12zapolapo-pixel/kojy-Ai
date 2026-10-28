import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";

process.env.PROJECTS_DIR = mkdtempSync(path.join(tmpdir(), "kojy-projects-"));
const files = await import("../../../packages/shared/src/projects/files.js");
const uuid = "00000000-0000-4000-8000-000000000001";

describe("project files", () => {
  it("rejects paths that leave the project", () => {
    for (const bad of ["../x", "/etc/passwd", "a/../../x", "..", ""]) {
      expect(() => files.resolveInside(uuid, bad)).toThrow(files.ProjectFileError);
    }
    expect(files.cleanRelPath("./a\\b.py")).toBe("a/b.py");
  });

  it("refuses to follow a symlink out of the project", () => {
    const dir = files.ensureProjectDir(uuid);
    symlinkSync("/etc", path.join(dir, "escape"));
    expect(() => files.readProjectFile(uuid, "escape/hostname")).toThrow(files.ProjectFileError);
    expect(files.listFiles(uuid).some((f) => f.path.startsWith("escape"))).toBe(false);
  });

  it("strips one top folder, skips junk and keeps the bot's existing data", () => {
    const dir = files.ensureProjectDir(uuid);
    mkdirSync(path.join(dir, "data"), { recursive: true });
    writeFileSync(path.join(dir, "data", "bot.db"), "LIVE");
    const zip = zipSync({
      "japalo/main.py": strToU8("print(1)"),
      "japalo/highrise_bot/bot.py": strToU8("from highrise import BaseBot\nclass HighriseRoomBot(\n    BaseBot,\n    Mixin,\n):\n    pass\n"),
      "japalo/data/bot.db": strToU8("OLD"),
      "japalo/__pycache__/x.pyc": strToU8("x"),
      "japalo/.git/config": strToU8("x"),
    });
    const res = files.extractZip(uuid, zip);
    expect(res.written).toBe(2);
    expect(res.keptData).toEqual(["data/bot.db"]);
    expect(readFileSync(path.join(dir, "data", "bot.db"), "utf8")).toBe("LIVE");
    expect(existsSync(path.join(dir, "__pycache__"))).toBe(false);
    expect(files.detectEntrypoint(uuid)).toBe("highrise_bot.bot:HighriseRoomBot");
  });

  it("reads the console log from a cursor", () => {
    mkdirSync(files.LOG_DIR, { recursive: true });
    const log = path.join(files.LOG_DIR, `${uuid}.log`);
    writeFileSync(log, JSON.stringify({ ts: 1, stream: "stdout", line: "a" }) + "\n");
    const first = files.readLogs(uuid, undefined);
    expect(first.lines.map((l) => l.line)).toEqual(["a"]);
    writeFileSync(log, readFileSync(log, "utf8") + JSON.stringify({ ts: 2, stream: "stderr", line: "b" }) + "\n" + '{"ts":3');
    const next = files.readLogs(uuid, first.cursor);
    expect(next.lines.map((l) => l.line)).toEqual(["b"]);
    expect(files.readLogs(uuid, next.cursor).lines).toEqual([]);
  });
});
