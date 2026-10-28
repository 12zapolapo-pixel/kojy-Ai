import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import {
  evaluateEvent, ModerationTracker, registerScriptPlugin, clearScriptPlugins, isAddressed, HighriseClient,
} from "../../../packages/engine/src/runtime/index.js";
import { stripEsmExport } from "../../../packages/engine/src/runtime/ScriptSandbox.js";
import { createDefaultPersonalityProfile } from "../../../packages/engine/src/personality/index.js";

const personality = { ...createDefaultPersonalityProfile("bot-uuid-1"), id: "p", createdAt: "" } as any;
const chat = (message: string, whisper = false) => ({ _type: "ChatEvent", user: { id: "u1", username: "alice" }, message, whisper }) as any;

describe("JavaScript bots", () => {
  afterEach(() => clearScriptPlugins("bot-uuid-1"));

  it("runs scripts registered under the bot's KojyAI id", () => {
    registerScriptPlugin("bot-uuid-1", "s1", () => [{ kind: "chat", reason: "t", request: { _type: "ChatRequest", message: "from script" } }] as any);
    const actions = evaluateEvent(chat("!ping"), { botUserId: "hr-user-9", botUuid: "bot-uuid-1", personality }, new ModerationTracker());
    expect(actions.some((a: any) => a.request?.message === "from script")).toBe(true);
  });

  it("only answers when talked to", () => {
    const ctx = { botUserId: "hr-user-9", botUuid: "bot-uuid-1", botUsername: "KojyBot", personality };
    expect(evaluateEvent(chat("hi everyone"), ctx, new ModerationTracker())).toEqual([]);
    expect(evaluateEvent(chat("hi @KojyBot"), ctx, new ModerationTracker()).length).toBe(1);
    expect(evaluateEvent(chat("hello", true), ctx, new ModerationTracker()).length).toBe(1);
    expect(isAddressed("kojybotty", "KojyBot")).toBe(false);
  });

  it("turns TypeScript scripts into runnable JavaScript", () => {
    for (const code of [
      `import type { X } from "y";\nexport default function handler(event: any, ctx: { a: number }): any[] { return [] as any[]; }`,
      `export default function (event: any) { return []; }`,
      `export default (event: any) => [];`,
    ]) {
      expect(typeof new Function(`${stripEsmExport(code)}\nreturn handler;`)()).toBe("function");
    }
  });

  it("stops for good when Highrise says not to reconnect", async () => {
    const wss = new WebSocketServer({ port: 0 });
    let connections = 0;
    wss.on("connection", (ws) => {
      connections++;
      ws.send(JSON.stringify({ _type: "Error", message: "Invalid API token", do_not_reconnect: true }));
    });
    const port = (wss.address() as AddressInfo).port;
    const client = new HighriseClient({ apiKey: "bad", roomId: "r", baseUrl: `ws://127.0.0.1:${port}`, maxBackoffMs: 50 } as any);
    client.on("error", () => undefined);
    await expect(client.connect()).rejects.toThrow("Invalid API token");
    await new Promise((r) => setTimeout(r, 1500));
    client.stop();
    wss.close();
    expect(connections).toBe(1);
  });
});
