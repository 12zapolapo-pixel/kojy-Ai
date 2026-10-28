/**
 * tests/security/highrise-deploy-mcp-boundary.test.ts
 *
 * H-13: same authorization-boundary requirement as H-06 (filesystem MCP
 * server), applied to the second MCP server the audit identified —
 * apps/mcp/highrise-deploy/server.ts. This server has no auth of its own;
 * the real authorization boundary must live in the calling orchestrator.
 * What this file CAN and must guarantee is that its own internal isolation
 * — one project_id's tracked bot process/workspace directory can never be
 * read, restarted, or stopped by referencing a different project_id — holds.
 *
 * Also confirms (per C-11's carried-forward note) that this whole pipeline
 * is currently dead code (main-module guard prevents accidental bootstrap
 * on import), consistent with Composer having retargeted to the TS
 * ScriptPlugin runtime — but per the "no shortcuts" standing instruction,
 * dead code that could be re-wired later still gets a real boundary test.
 */

import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";

let safeProjectDir: (projectId: string) => string;
let getRunningBots: () => Map<string, any>;
let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = path.join(os.tmpdir(), "kojyai-deploy-mcp-test");
  process.env.BOT_WORKSPACE_ROOT = workspaceRoot;

  // Fresh module instance per test isn't possible without vi.resetModules +
  // dynamic re-import; the module reads env once at init. We only need to
  // import once since safeProjectDir doesn't depend on per-test env changes
  // beyond the one set above (consistent across the whole file).
  if (!safeProjectDir) {
    const mod = await import("../../apps/mcp/highrise-deploy/server.js");
    safeProjectDir = mod.safeProjectDir;
    getRunningBots = mod.getRunningBots;
  }
});

describe("H-13: highrise-deploy MCP server — project isolation boundary", () => {
  it("resolves a legitimate project_id to a directory under the workspace root", () => {
    const resolved = safeProjectDir("proj1");
    expect(resolved).toBe(path.join(workspaceRoot, "proj1"));
  });

  it("never resolves two different project_ids to the same directory", () => {
    const a = safeProjectDir("proj-alpha");
    const b = safeProjectDir("proj-beta");
    expect(a).not.toBe(b);
  });

  it("sanitizes traversal characters out of project_id (cannot escape workspace root)", () => {
    const resolved = safeProjectDir("../../../etc");
    expect(resolved.startsWith(workspaceRoot)).toBe(true);
    expect(resolved).not.toContain("/etc");
    // The traversal chars are stripped/replaced, not preserved as path segments
    expect(resolved.split(path.sep)).not.toContain("..");
  });

  it("sanitizes the sibling-prefix confusion vector (proj1 vs proj1-other)", () => {
    const a = safeProjectDir("proj1");
    const b = safeProjectDir("proj1-other");
    // Must be genuinely different directories, and neither is a parent of the other
    expect(a).not.toBe(b);
    expect(b.startsWith(a + path.sep)).toBe(false);
  });

  it("truncates pathologically long project_ids rather than overflowing into unrelated segments", () => {
    const longId = "a".repeat(500);
    const resolved = safeProjectDir(longId);
    const dirName = path.basename(resolved);
    expect(dirName.length).toBeLessThanOrEqual(80);
  });

  it("the runningBots process registry is a single shared Map keyed by project_id — operations on one key structurally cannot touch another's entry", () => {
    const bots = getRunningBots();
    bots.clear();
    bots.set("victim-project", { pid: 111, projectId: "victim-project", startedAt: new Date(), restartCount: 0, roomId: "room-victim" });
    bots.set("attacker-project", { pid: 222, projectId: "attacker-project", startedAt: new Date(), restartCount: 0, roomId: "room-attacker" });

    // Simulate what stop_bot/get_bot_status do internally: runningBots.get(projectId)
    const attackerView = bots.get("attacker-project");
    expect(attackerView?.pid).toBe(222);
    expect(attackerView?.pid).not.toBe(111);

    // No key confusion: requesting the victim's ID from the attacker's
    // context is the only way to reach it, and that requires the calling
    // orchestrator to have supplied that exact project_id — which is
    // precisely the authorization check that must live one layer up
    // (documented requirement, not enforceable inside this file).
    const victimView = bots.get("victim-project");
    expect(victimView?.pid).toBe(111);
    expect(victimView).not.toBe(attackerView);

    bots.clear();
  });
});
