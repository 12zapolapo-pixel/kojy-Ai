/**
 * V-01: Python bot code runs as a per-project user (apps/runner/src/sandbox.ts).
 *
 * The full isolation (a bot can't read the runner's /proc/<pid>/environ or
 * other projects' files) needs the Docker image's setpriv helper and
 * capabilities, so it is checked in the image, not here. These tests pin the
 * fail-safe behaviour around it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

async function load(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import("../../apps/runner/src/sandbox.js");
}

afterEach(() => { vi.unstubAllEnvs(); });

describe("runner sandbox", () => {
  it("gives each project its own user id above the base", async () => {
    const sb = await load({ RUNNER_SANDBOX_UID_BASE: "20000" });
    expect(sb.sandboxUid(1)).toBe(20001);
    expect(sb.sandboxUid(42)).toBe(20042);
    expect(sb.sandboxUid(1)).not.toBe(sb.sandboxUid(2));
  });

  it("rejects project ids that could collide with the base or other users", async () => {
    const sb = await load({});
    expect(() => sb.sandboxUid(0)).toThrow();
    expect(() => sb.sandboxUid(-5)).toThrow();
    expect(() => sb.sandboxUid(1.5)).toThrow();
  });

  it("with RUNNER_SANDBOX=on and no working helper, refuses to run code at all", async () => {
    const sb = await load({ RUNNER_SANDBOX: "on", RUNNER_SANDBOX_HELPER: "/nonexistent/kojy-setpriv" });
    const state = sb.initSandbox([]);
    expect(state.enabled).toBe(false);
    expect(() => sb.spawnAs(20001, "true", [], { stdio: "ignore" })).toThrow(sb.SandboxUnavailableError);
  });

  it("with RUNNER_SANDBOX=auto and no helper, falls back (and says so) instead of breaking bots", async () => {
    const sb = await load({ RUNNER_SANDBOX: "auto", RUNNER_SANDBOX_HELPER: "/nonexistent/kojy-setpriv" });
    const state = sb.initSandbox([]);
    expect(state.enabled).toBe(false);
    expect(state.reason).toMatch(/not found/);
    const { child } = sb.spawnAs(20001, "true", [], { stdio: "ignore" });
    const code = await new Promise((r) => child.once("exit", r));
    expect(code).toBe(0);
  });
});
