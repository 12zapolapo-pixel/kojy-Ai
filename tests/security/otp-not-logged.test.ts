/**
 * V-08: verification / password-reset codes must not reach production logs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const lines: string[] = [];
vi.mock("../../apps/api/src/utils/logger.js", () => {
  const rec = (...a: unknown[]) => { lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
  const logger = { info: rec, warn: rec, error: rec, debug: rec, child: () => logger };
  return { createLogger: () => logger, logger };
});
vi.mock("../../apps/api/src/jobs/queues.js", () => ({ enqueue: vi.fn() }));

async function deliver(env: Record<string, string>) {
  vi.resetModules();
  lines.length = 0;
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const { deliverCode } = await import("../../apps/api/src/modules/auth/codes.js");
  await deliverCode("password_reset", "owner@example.com", "482913");
  return lines.join("\n");
}

afterEach(() => vi.unstubAllEnvs());

describe("OTP delivery without email (V-08)", () => {
  it("production: the code is not logged, and the operator is told why nothing was sent", async () => {
    const out = await deliver({ NODE_ENV: "production", RESEND_API_KEY: "", LOG_EMAIL_CODES: "" });
    expect(out).not.toContain("482913");
    expect(out).toMatch(/NOT sent/);
  });

  it("production with the explicit opt-in: logged (operator's choice)", async () => {
    const out = await deliver({ NODE_ENV: "production", RESEND_API_KEY: "", LOG_EMAIL_CODES: "true" });
    expect(out).toContain("482913");
  });

  it("development: still logged, as before", async () => {
    const out = await deliver({ NODE_ENV: "development", RESEND_API_KEY: "" });
    expect(out).toContain("482913");
  });
});
