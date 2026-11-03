/**
 * check_code's loader check (apps/runner/src/botcheck.py), run for real with
 * python3 on a bot shaped like Japalo: an empty `...` placeholder in an
 * earlier mixin hid the real _is_staff, so nobody counted as staff
 * (2026-11-03). Uses a stand-in for the Highrise SDK.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BOTCHECK } from "../../../apps/runner/src/supervisor.js";
import { hiddenMethods } from "../../../apps/runner/src/agent/tools.js";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const test = hasPython ? it : it.skip;
const dir = mkdtempSync(path.join(tmpdir(), "kojy-botcheck-"));

beforeAll(() => {
  mkdirSync(path.join(dir, "highrise"));
  writeFileSync(path.join(dir, "highrise", "__init__.py"), `
class BaseBot:
    async def on_chat(self, user, message):
        pass
`);
  writeFileSync(path.join(dir, "mybot.py"), `
from highrise import BaseBot

class TeleportCommandsMixin:
    async def _is_staff(self, user_id: str) -> bool: ...
    async def _cmd_tp(self, user, args):
        return await self._is_staff(user)

class ModerationCommandsMixin:
    async def _is_staff(self, user_id: str) -> bool: ...
    async def _is_staff(self, user_id: str) -> bool:
        return user_id == "owner"

class QuietMixin:
    def announce(self):
        pass

class LoudMixin:
    def announce(self):
        print("hello")

class DocPlaceholderMixin:
    def helper(self):
        """Provided by HelperMixin."""
        ...

class HelperMixin:
    def helper(self):
        return 42

class BrokenBot(BaseBot, TeleportCommandsMixin, ModerationCommandsMixin, DocPlaceholderMixin, HelperMixin):
    pass

class FixedBot(BaseBot, ModerationCommandsMixin, TeleportCommandsMixin, HelperMixin, DocPlaceholderMixin):
    pass

class DeliberatelyQuietBot(BaseBot, QuietMixin, LoudMixin):
    pass

class NotABot:
    pass
`);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const check = (entry: string) => {
  const r = spawnSync("python3", [BOTCHECK, entry], { cwd: dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONPATH: dir, PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8" });
  return { out: r.stdout, err: r.stderr };
};

describe("check_code: placeholder methods that hide real ones", () => {
  test("Japalo's bug is found: the teleport mixin's empty _is_staff hides the real one", () => {
    const { out } = check("mybot:BrokenBot");
    expect(out).toContain("IMPORT_OK");
    expect(out).toContain("HIDDEN _is_staff|TeleportCommandsMixin|ModerationCommandsMixin");
    expect(out).toContain("HIDDEN helper|DocPlaceholderMixin|HelperMixin"); // a docstring doesn't make it real
  });

  test("with the real methods first, nothing is reported", () => {
    const { out } = check("mybot:FixedBot");
    expect(out).toContain("IMPORT_OK");
    expect(out).not.toContain("HIDDEN");
  });

  test("a deliberate `pass` override isn't a placeholder", () => {
    expect(check("mybot:DeliberatelyQuietBot").out).not.toContain("HIDDEN");
  });

  test("a class that isn't a Highrise bot fails to load", () => {
    const { out, err } = check("mybot:NotABot");
    expect(out).not.toContain("IMPORT_OK");
    expect(err).toContain("NotABot is not a BaseBot");
  });

  it("the findings are explained for Kojy and the owner", () => {
    expect(hiddenMethods("IMPORT_OK\nHIDDEN _is_staff|TeleportCommandsMixin|ModerationCommandsMixin\n")).toEqual([
      "- _is_staff: the empty placeholder in TeleportCommandsMixin is used instead of the real _is_staff in ModerationCommandsMixin. " +
      "Remove the placeholder, or list TeleportCommandsMixin after ModerationCommandsMixin in the bot class's bases.",
    ]);
    expect(hiddenMethods("IMPORT_OK\n")).toEqual([]);
  });
});
