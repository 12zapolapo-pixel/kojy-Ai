import { it, expect, vi } from "vitest";
const warn = vi.fn();
vi.mock("../../apps/api/src/utils/logger.ts", () => ({ createLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
it("L-01 both-direction warnings", async () => {
  process.env.TRUSTED_PROXY_IPS = "10.0.0.1";
  const { resolveClientIp } = await import("../../apps/api/src/utils/clientIp.ts");
  resolveClientIp("10.0.0.1", undefined); resolveClientIp("10.0.0.1", undefined);       // trusted peer, no XFF (twice -> one warning)
  resolveClientIp("127.0.0.1", undefined);                                              // loopback exempt
  resolveClientIp("203.0.113.9", "1.2.3.4"); resolveClientIp("203.0.113.9", "1.2.3.4"); // untrusted peer + XFF (twice -> one warning)
  resolveClientIp("10.0.0.1", "198.51.100.7");                                          // healthy -> silent
  const msgs = warn.mock.calls.map((c) => String(c[1]));
  expect(msgs.filter((m) => /not forwarding client IPs/.test(m))).toHaveLength(1);
  expect(msgs.filter((m) => /NOT in TRUSTED_PROXY_IPS/.test(m))).toHaveLength(1);
  expect(warn).toHaveBeenCalledTimes(2);
  expect(resolveClientIp("10.0.0.1", "198.51.100.7")).toBe("198.51.100.7");
});
