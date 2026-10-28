/** L-33: user-controlled values must not become markup in outbound emails. */
import { describe, it, expect, vi } from "vitest";
vi.mock("../../apps/worker/src/db/client.js", () => ({ db: {}, getPool: () => ({}), schema: {} }));
describe("buildTemplate escaping", async () => {
  const { buildTemplate } = await import("../../apps/worker/src/processors/index.ts");
  const evil = `</strong><img src=x onerror=alert(1)><a href="https://phish.example">click`;
  it("bot_offline: bot name is escaped in the HTML body, and CR/LF can't enter the subject", () => {
    const t = buildTemplate("bot_offline", { botName: evil + "\r\nBcc: attacker@x.io" });
    expect(t.html).not.toContain("<img src=x"); expect(t.html).not.toContain('<a href="https://phish.example">'); expect(t.html).toContain("&lt;img src=x");
    expect(t.subject).not.toMatch(/[\r\n]/);
  });
  it("billing_upgraded: plan is escaped", () => { expect(buildTemplate("billing_upgraded", { plan: "<script>alert(1)</script>" }).html).not.toContain("<script>"); });
  it("links: only http(s) survive; quotes can't break out of href", () => {
    expect(buildTemplate("password_reset", { link: "javascript:alert(1)" }).html).toContain('href="#"');
    expect(buildTemplate("verify_email", { link: "data:text/html,<b>x" }).html).not.toContain("data:text/html");
    const ok = buildTemplate("password_reset", { link: 'https://app.kojyai.com/auth/reset?email=a%40b.c&code=123456"onmouseover="x' }).html;
    expect(ok).not.toContain('"onmouseover="'); expect(ok).toContain("https://app.kojyai.com/auth/reset");
  });
  it("normal values still render", () => {
    expect(buildTemplate("bot_offline", { botName: "My Cool Bot" }).html).toContain("<strong>My Cool Bot</strong>");
    expect(buildTemplate("welcome", {}).html).toContain("https://app.kojyai.com");
  });
});
