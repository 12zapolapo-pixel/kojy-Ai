/**
 * The room doctor: Highrise's own words decide what's wrong — the owner's
 * token, room or the bot's access (only they can fix those), or something
 * passing — and KojyAI's own question to Highrise (askHighrise) is answered
 * by a stand-in Highrise here: let in, refused in its words, refused at the
 * HTTP level, behind a firewall, or no answer at all.
 */
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { askHighrise, highriseMessage, ownersRefusal, refusalAdvice, refusalKind } from "../../../apps/runner/src/roomDoctor.js";

describe("Highrise's words", () => {
  it("are read out of the SDK's ERROR lines", () => {
    expect(highriseMessage("ERROR: Error(message='API token not found', do_not_reconnect=False, rid=None)")).toBe("API token not found");
    expect(highriseMessage(`ERROR: Error(message="Can't join: room is closed", do_not_reconnect=True, rid=None)`)).toBe("Can't join: room is closed");
    expect(highriseMessage("ERROR: Invalid room id or api token closing connection with ID: abc-123")).toBe("Invalid room id or api token");
    expect(highriseMessage(null)).toBe("");
  });

  it("say whether it's the owner's token, room or access — or something passing", () => {
    const cases: [string, string][] = [
      ["API token not found", "token"], // what Highrise really sends for a bad token
      ["Invalid API key", "token"],
      ["Unauthorized", "token"],
      ["Invalid room id or api token", "credentials"],
      ["Room not found", "room"],
      ["Bot is banned from this room", "access"],
      ["Bot is not allowed in this room", "access"],
      ["Bot already connected", "duplicate"],
      ["Rate limit exceeded", "busy"],
      ["Service temporarily unavailable", "busy"],
      ["Highrise answered HTTP 403 (Invalid response status)", "unknown"], // a firewall can do that: not Highrise's verdict
      ["Highrise answered HTTP 503 (Invalid response status)", "busy"],
      ["Something new", "unknown"],
    ];
    for (const [said, kind] of cases) expect([said, refusalKind(said)]).toEqual([said, kind]);
    expect(["token", "credentials", "room", "access"].every((k) => ownersRefusal(k as never))).toBe(true);
    expect(["duplicate", "busy", "unknown"].some((k) => ownersRefusal(k as never))).toBe(false);
    expect(refusalAdvice("token", "API token not found")).toMatch(/^Highrise doesn't accept the bot's token \(Highrise said: “API token not found”\)\. Copy the bot's token again from create\.highrise\.game into HIGHRISE_BOT_TOKEN/);
  });
});

describe("asking Highrise (a stand-in Highrise)", () => {
  let http: Server;
  let url = "";
  const seen: Record<string, string | undefined>[] = [];
  /** What the stand-in does, by room ID. */
  const behaviour: Record<string, (ws: import("ws").WebSocket) => void> = {
    "room-ok": (ws) => ws.send(JSON.stringify({ _type: "SessionMetadata", user_id: "bot1", room_info: { owner_id: "o1", room_name: "Japalo's Lounge" }, rate_limits: {}, connection_id: "c1" })),
    "room-bad-token": (ws) => ws.send(JSON.stringify({ _type: "Error", message: "API token not found", do_not_reconnect: false, rid: null })),
    "room-busy": (ws) => ws.send(JSON.stringify({ _type: "Error", message: "Rate limit exceeded", do_not_reconnect: false, rid: null })),
    "room-silent": () => undefined,
  };

  beforeAll(async () => {
    http = createServer();
    const wss = new WebSocketServer({ noServer: true });
    http.on("upgrade", (req, socket, head) => {
      const room = String(req.headers["room-id"]);
      seen.push({ room, token: req.headers["api-token"] as string | undefined, agent: req.headers["user-agent"] });
      if (room === "room-403") { socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"); return; }
      if (room === "room-firewall") { socket.end("HTTP/1.1 403 Forbidden\r\ncf-mitigated: challenge\r\nContent-Length: 0\r\n\r\n"); return; }
      wss.handleUpgrade(req, socket, head, (ws) => behaviour[room]?.(ws));
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/web/botapi`;
  });
  afterAll(() => { http.closeAllConnections(); http.close(); });

  it("sends the bot's token and room ID the way the SDK does, and a let-in is \"ok\" with the room's name", async () => {
    expect(await askHighrise("room-ok", "token-1", { url })).toEqual({ kind: "ok", roomName: "Japalo's Lounge", userId: "bot1" });
    expect(seen.at(-1)).toEqual({ room: "room-ok", token: "token-1", agent: "highrise-python-bot-sdk/25.1.0" });
  });

  it("an Error from Highrise is its verdict on the token and room; a busy one is only waiting", async () => {
    expect(await askHighrise("room-bad-token", "t", { url })).toEqual({ kind: "refused", message: "API token not found", refusal: "token" });
    expect(await askHighrise("room-busy", "t", { url })).toEqual({ kind: "unreachable", why: "Highrise said: Rate limit exceeded" });
  });

  it("refused at the HTTP level is a refusal; behind a firewall challenge, or no answer at all, it's unreachable", async () => {
    expect(await askHighrise("room-403", "t", { url })).toEqual({ kind: "refused", message: "HTTP 403", refusal: "unknown" });
    expect(await askHighrise("room-firewall", "t", { url })).toEqual({ kind: "unreachable", why: "Highrise answered HTTP 403" });
    expect(await askHighrise("room-silent", "t", { url, timeoutMs: 1000 })).toEqual({ kind: "unreachable", why: "Highrise didn't answer within 1s" });
    const refused = await askHighrise("x", "t", { url: "ws://127.0.0.1:9/nothing", timeoutMs: 2000 });
    expect(refused.kind).toBe("unreachable");
  });
});
