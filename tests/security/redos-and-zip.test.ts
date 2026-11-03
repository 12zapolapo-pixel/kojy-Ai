/**
 * V-04: search_code's regex runs in a time-limited worker, and project zips
 * are packed/unpacked off the main thread.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { searchInWorker } from "../../apps/runner/src/agent/tools.js";

describe("search_code (V-04)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kojy-search-"));
  writeFileSync(path.join(dir, "bot.py"), "class Bot:\n    async def on_chat(self, user, message):\n        pass\n" + "a".repeat(40) + "!\n");
  const files = [{ rel: "bot.py", abs: path.join(dir, "bot.py") }];

  it("finds matches", async () => {
    expect(await searchInWorker("on_chat", files)).toEqual(["bot.py:2: async def on_chat(self, user, message):"]);
  });

  it("a catastrophic-backtracking pattern is stopped and the main thread keeps running", async () => {
    let ticks = 0;
    const iv = setInterval(() => ticks++, 20);
    const t0 = Date.now();
    const r = await searchInWorker("^(a+)+$", files);
    clearInterval(iv);
    expect(r).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(ticks).toBeGreaterThan(50); // the event loop was never blocked
  }, 15000);
});
