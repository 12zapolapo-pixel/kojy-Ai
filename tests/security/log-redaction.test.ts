/** L-27 / L-28: recursive, case-insensitive log redaction from the single shared policy. */
import { describe, it, expect } from "vitest";
import pino from "../../apps/api/node_modules/pino/pino.js";
import { redactSensitive, isSensitiveKey, REDACTED, LOG_REDACT_PATHS } from "../../packages/shared/src/logging/redaction";

describe("redactSensitive", () => {
  it("redacts at depth 1, 3 and 6 (pino's *.x only reached one level)", () => {
    const o = { password: "a", a: { password: "b" }, b: { c: { d: { password: "c" } } }, x: { y: { z: { w: { v: { token: "deep" } } } } } };
    const r = redactSensitive(o) as any;
    expect(r.password).toBe(REDACTED); expect(r.a.password).toBe(REDACTED); expect(r.b.c.d.password).toBe(REDACTED); expect(r.x.y.z.w.v.token).toBe(REDACTED);
  });
  it("is case/format-insensitive and catches compound names", () => {
    const r = redactSensitive({ Authorization: "Bearer x", API_KEY: "k", "X-Api-Key": "k", newPassword: "p", currentPassword: "p", webhookSecret: "s", botToken: "t", "Set-Cookie": "c", SESSION_ID: "s" }) as any;
    for (const v of Object.values(r)) expect(v).toBe(REDACTED);
  });
  it("leaves harmless fields alone, including look-alikes", () => {
    const o = { userId: 1, tokens: 5, maxTokens: 100, author: "me", passwordPolicy: "strict", message: "hi" };
    expect(redactSensitive(o)).toEqual(o);
    expect(isSensitiveKey("tokens")).toBe(false); expect(isSensitiveKey("passwordPolicy")).toBe(false);
  });
  it("walks arrays and returns the SAME reference when nothing needs redacting (no alloc)", () => {
    expect((redactSensitive({ list: [{ token: "t" }, { ok: 1 }] }) as any).list[0].token).toBe(REDACTED);
    const clean = { a: { b: [1, 2, { c: 3 }] } }; expect(redactSensitive(clean)).toBe(clean);
  });
  it("doesn't mutate its input, tolerates cycles and over-deep objects, passes Errors/Dates through", () => {
    const o: any = { password: "p", inner: { token: "t" } }; o.self = o; const r = redactSensitive(o) as any;
    expect(o.password).toBe("p"); expect(o.inner.token).toBe("t"); expect(r.self).toBe("[Circular]");
    let deep: any = { token: "x" }; for (let i = 0; i < 30; i++) deep = { n: deep };
    expect(JSON.stringify(redactSensitive(deep))).not.toContain('"x"');
    const err = new Error("boom"), d = new Date(); const r2 = redactSensitive({ err, d }) as any; expect(r2.err).toBe(err); expect(r2.d).toBe(d);
  });
  it("leaves null/undefined sensitive values alone (no noise)", () => { expect((redactSensitive({ password: null, token: undefined }) as any).password).toBeNull(); });
});

describe("wired into pino exactly as both services do", () => {
  it("nothing sensitive reaches the output stream", () => {
    const lines: string[] = [];
    const log = pino({ formatters: { log: (o: Record<string, unknown>) => redactSensitive(o) }, redact: LOG_REDACT_PATHS }, { write: (s: string) => lines.push(s) } as any);
    log.info({ req: { headers: { Authorization: "Bearer SECRET1" } }, body: { user: { profile: { newPassword: "SECRET2" } } }, ctx: { a: { b: { c: { apiKey: "SECRET3" } } } }, safe: "visible" }, "hello");
    const out = lines.join("");
    expect(out).not.toMatch(/SECRET[123]/); expect(out).toContain("visible");
  });
});
