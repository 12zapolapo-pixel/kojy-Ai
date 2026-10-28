import { runHarness } from "../../../apps/runner/src/agent/jsTools.js";

const tester = { id: "u1", username: "tester" };
const chat = (message: string) => ({ _type: "ChatEvent", user: tester, message, whisper: false });

describe("JS script tester", () => {
  it("runs a TypeScript handler and returns its actions", async () => {
    const code = `import type { X } from "y";
export default function handler(event: any, ctx: { scriptState: Record<string, number> }): any[] {
  if (event._type !== "ChatEvent") return [];
  ctx.scriptState.n = (ctx.scriptState.n ?? 0) + 1;
  if (event.message === "!ping") return [{ kind: "chat", reason: "ping", request: { _type: "ChatRequest", message: "pong " + ctx.scriptState.n } }];
  return [];
}`;
    const r = await runHarness(code, [chat("hi"), chat("!ping")]);
    expect(r.error).toBeUndefined();
    expect(r.results?.[1]?.actions?.[0]).toMatchObject({ request: { message: "pong 2" } });
  });

  it("reports errors and runs without the runner's environment", async () => {
    const r = await runHarness(`export default function handler(e) { return [{ kind: "chat", request: { message: String(process.env.DATABASE_URL) } }]; }`, [chat("x")]);
    expect(r.results?.[0]?.actions?.[0]).toMatchObject({ request: { message: "undefined" } });
    const bad = await runHarness(`export default function handler(e) { throw new Error("boom"); }`, [chat("x")]);
    expect(bad.results?.[0]?.error).toContain("boom");
    const loop = await runHarness(`export default function handler(e) { while (true) {} }`, [chat("x")]);
    expect(loop.error).toMatch(/Timed out/);
  }, 15000);
});
