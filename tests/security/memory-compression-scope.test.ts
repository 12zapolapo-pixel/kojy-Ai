/**
 * V-05: a memory-compression job for one bot must never fall through to
 * "every org's raw memories". Only the scheduled sweep may cover all bots.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const queried: string[] = [];
let botsResult: unknown[] = [];

vi.mock("../../apps/worker/src/db/client.js", async () => {
  const schema = await import("../../packages/db/src/schema.js");
  const chain = (table: string) => {
    const result = () => { queried.push(table); return Promise.resolve(table === "bots" ? botsResult : []); };
    const q: any = { where: () => q, limit: result, orderBy: () => q, then: (r: any, j: any) => result().then(r, j) };
    return q;
  };
  return {
    schema,
    db: {
      select: () => ({ from: (t: unknown) => chain(t === schema.bots ? "bots" : "memories") }),
      insert: () => ({ values: () => Promise.resolve() }),
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    },
  };
});

const { processMemoryCompression } = await import("../../apps/worker/src/processors/index.js");
const job = (data: Record<string, unknown>) => ({ data } as any);

beforeEach(() => { queried.length = 0; botsResult = []; });

describe("processMemoryCompression scope (V-05)", () => {
  it("a manual job with an empty botId does nothing (used to compress every org)", async () => {
    await processMemoryCompression(job({ botId: "", type: "manual" }));
    expect(queried).toEqual([]);
  });

  it("a job for an unknown bot stops after the bot lookup (used to compress every org)", async () => {
    await processMemoryCompression(job({ botId: "no-such-bot", type: "manual" }));
    expect(queried).toEqual(["bots"]);
  });

  it("a known bot's job reads only that bot's memories", async () => {
    botsResult = [{ id: 7, orgId: 3 }];
    await processMemoryCompression(job({ botId: "bot-7", type: "manual" }));
    expect(queried).toEqual(["bots", "memories"]);
  });

  it("an org-wide manual job reads only that org's bots' memories", async () => {
    botsResult = [{ id: 7 }, { id: 9 }];
    await processMemoryCompression(job({ orgId: 3, type: "manual_org" }));
    expect(queried).toEqual(["bots", "memories"]);
  });

  it("an org with no bots does nothing", async () => {
    await processMemoryCompression(job({ orgId: 3, type: "manual_org" }));
    expect(queried).toEqual(["bots"]);
  });

  it("the scheduled sweep may still cover all bots", async () => {
    await processMemoryCompression(job({ type: "sweep_all_orgs" }));
    expect(queried).toEqual(["memories"]);
  });
});
