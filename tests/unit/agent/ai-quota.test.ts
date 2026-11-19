/**
 * Reading what a provider's "no" really means, so a lane rests for the right
 * time: Google's 429 always says "quota" and RESOURCE_EXHAUSTED, also for
 * the per-minute limit, so only its details tell a busy minute from a
 * used-up day (which then rests until Google says it resets).
 */
import { beforeAll, describe, expect, it } from "vitest";

let ai: typeof import("../../../apps/runner/src/agent/groq.js");
beforeAll(async () => { ai = await import("../../../apps/runner/src/agent/groq.js"); });

/** Google's answer through its OpenAI-compatible endpoint (a list holding one error). */
const google = (quotaId: string, quotaValue: string, retryDelay?: string, message = "You exceeded your current quota, please check your plan and billing details.") =>
  JSON.stringify([{ error: {
    code: 429, status: "RESOURCE_EXHAUSTED", message,
    details: [
      { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaId, quotaValue }] },
      ...(retryDelay ? [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay }] : []),
    ],
  } }]);

describe("googleQuota", () => {
  it("a used-up day (the real answer for gemini-3.6-flash: 20 a day): rests until Google's reset time", () => {
    expect(ai.googleQuota(google("GenerateRequestsPerDayPerProjectPerModel-FreeTier", "20", "11051s")))
      .toEqual({ daily: true, noFreeTier: false, retrySeconds: 11051 });
  });

  it("a busy minute is not a used-up day", () => {
    expect(ai.googleQuota(google("GenerateRequestsPerMinutePerProjectPerModel-FreeTier", "10", "37.4s")))
      .toEqual({ daily: false, noFreeTier: false, retrySeconds: 38 });
  });

  it("a model with no free use at all (limit 0)", () => {
    expect(ai.googleQuota(google("GenerateRequestsPerDayPerProjectPerModel-FreeTier", "0"))?.noFreeTier).toBe(true);
  });

  it("the wait from the message when there's no RetryInfo; the plain error object form too", () => {
    const body = JSON.stringify({ error: { code: 429, message: "Quota exceeded. Please retry in 12.5s.", details: [] } });
    expect(ai.googleQuota(body)).toEqual({ daily: false, noFreeTier: false, retrySeconds: 13 });
  });

  it("no details (or not JSON): null, so the old wording check still decides", () => {
    expect(ai.googleQuota(JSON.stringify({ error: { code: 429, message: "You exceeded your current quota" } }))).toBeNull();
    expect(ai.googleQuota("Too Many Requests")).toBeNull();
  });
});
