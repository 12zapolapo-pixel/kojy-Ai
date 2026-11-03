import { describe, expect, it } from "vitest";
import { readAiUsage } from "../../../apps/api/src/modules/projects/aiUsage.js";

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const lane = (o: object) => JSON.stringify(o);

function redis(hashes: Record<string, Record<string, string>>) {
  return { hgetall: async (k: string) => hashes[k] ?? {} };
}

describe("readAiUsage", () => {
  it("lists models in try-order with today's counts", async () => {
    const r = await readAiUsage(redis({
      ai_lanes: {
        "gemini:g-flash:0": lane({ order: 2, provider: "gemini", model: "g-flash", keyNo: 1, coolUntil: 0, kind: null, reason: "" }),
        "mistral:large-4": lane({ order: 0, provider: "mistral", model: "large-4", keyNo: 1, coolUntil: 0, kind: null, reason: "" }),
        "groq:oss": lane({ order: 3, provider: "groq", model: "oss", keyNo: 1, coolUntil: 0, kind: null, reason: "" }),
      },
      "ai_usage:2026-11-02": {
        "mistral:large-4|req": "5", "mistral:large-4|in": "1200", "mistral:large-4|out": "340", "mistral:large-4|last": String(NOW - 5000),
        "gemini:g-flash:0|req": "2", "gemini:g-flash:0|fail": "1",
      },
    }), NOW);
    expect(r.date).toBe("2026-11-02");
    expect(r.models.map((m) => m.id)).toEqual(["mistral:large-4", "gemini:g-flash:0", "groq:oss"]);
    expect(r.models[0]).toMatchObject({ requests: 5, tokensIn: 1200, tokensOut: 340, state: "ready", lastUsedAt: NOW - 5000 });
    expect(r.models[1]).toMatchObject({ requests: 2, failures: 1 });
    expect(r.models[2]).toMatchObject({ requests: 0, tokensIn: 0, lastUsedAt: null });
  });

  it("shows a resting model with its reason and time left, and ready again once the time has passed", async () => {
    const hashes = {
      ai_lanes: {
        "a": lane({ order: 0, provider: "gemini", model: "m", keyNo: 1, coolUntil: NOW + 90_000, kind: "out_of_quota", reason: "Gemini m (key 1) is out of quota" }),
        "b": lane({ order: 1, provider: "gemini", model: "m", keyNo: 2, coolUntil: NOW - 1000, kind: "rate_limited", reason: "old" }),
      },
    };
    const r = await readAiUsage(redis(hashes), NOW);
    expect(r.models[0]).toMatchObject({ state: "out_of_quota", restSeconds: 90, reason: "Gemini m (key 1) is out of quota" });
    expect(r.models[1]).toMatchObject({ state: "ready", restSeconds: 0, reason: "" });
  });

  it("only reads today's counts (UTC)", async () => {
    const r = await readAiUsage(redis({
      ai_lanes: { x: lane({ order: 0, provider: "groq", model: "m", keyNo: 1, coolUntil: 0, kind: null, reason: "" }) },
      "ai_usage:2026-11-01": { "x|req": "99" },
    }), NOW);
    expect(r.models[0]!.requests).toBe(0);
  });

  it("copes with no Redis and with unreadable entries", async () => {
    expect(await readAiUsage(null, NOW)).toEqual({ date: "2026-11-02", models: [] });
    const r = await readAiUsage(redis({ ai_lanes: { bad: "not json", ok: lane({ order: 0, provider: "groq", model: "m", keyNo: 1, coolUntil: 0, kind: null, reason: "" }) } }), NOW);
    expect(r.models.map((m) => m.id)).toEqual(["ok"]);
  });
});
