/**
 * Test room — runs a copy of the bot against a fake Highrise server, so the
 * coder AI can check its changes without touching the real room.
 * OWNERSHIP: apps/runner/src/agent
 *
 * The fake server speaks the SDK's JSON protocol (HR_BOTAPI_URL): it sends
 * SessionMetadata, then the chat lines the AI asked for, answers every request
 * with a plausible empty response, and records what the bot sent back. The bot
 * runs in a temporary copy of the project (data included) so a test never
 * changes the real bot's files or database.
 */

import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";

const RESPONSES: Record<string, Record<string, unknown>> = {
  GetRoomUsersRequest: { content: [[{ id: "u-tester", username: "tester" }, { x: 5, y: 0, z: 5, facing: "FrontRight" }]] },
  GetWalletRequest: { content: [{ type: "gold", amount: 1000 }] },
  GetUserOutfitRequest: { outfit: [] },
  GetBackpackRequest: { backpack: [] },
  GetConversationsRequest: { conversations: [], not_joined: 0 },
  GetMessagesRequest: { messages: [] },
  GetRoomPrivilegeRequest: { content: { moderator: true, designer: true } },
  GetInventoryRequest: { items: [] },
  GetBotInfoRequest: { content: { user_id: "bot-test" } },
};

export interface RoomTestResult {
  connected: boolean;
  /** The bot quit by itself before the test ended (a crash, usually). */
  exitedEarly: boolean;
  exitCode: number | null;
  /** What the bot did, in order: "say: …", "whisper to tester: …", "emote …", "TeleportRequest" … */
  actions: string[];
  output: string[];
  errors: string[];
}

export interface RoomTestOptions {
  projectDir: string;
  python: string;
  launcher: string;
  entrypoint: string;
  env: NodeJS.ProcessEnv;
  /** Chat lines sent by user "tester" after the bot starts, ~2.5s apart. */
  chat: string[];
  /** Also send a join event for "tester" first. */
  join?: boolean;
  seconds?: number;
  /** Settings for this test only, e.g. a short timer interval. Can't change the room or token. */
  extraEnv?: Record<string, string>;
}

function describe(msg: Record<string, unknown>): string | null {
  switch (msg._type) {
    case "ChatRequest": return msg.whisper_target_id ? `whisper to ${msg.whisper_target_id}: ${msg.message}` : `say: ${msg.message}`;
    case "EmoteRequest": return `emote ${msg.emote_id}${msg.target_user_id ? ` on ${msg.target_user_id}` : ""}`;
    case "SendMessageRequest": return `DM: ${msg.content}`;
    case "ReactionRequest": return `react ${msg.reaction} to ${msg.target_user_id}`;
    case "KeepaliveRequest": return null;
    default: return String(msg._type);
  }
}

export async function runRoomTest(opts: RoomTestOptions): Promise<RoomTestResult> {
  const result: RoomTestResult = { connected: false, exitedEarly: false, exitCode: null, actions: [], output: [], errors: [] };
  const seconds = Math.min(Math.max(opts.seconds ?? 12 + opts.chat.length * 2.5, 8), 60);

  const work = mkdtempSync(path.join(tmpdir(), "kojy-test-"));
  cpSync(opts.projectDir, work, { recursive: true, filter: (src) => !/[/\\](\.git|node_modules|__pycache__|\.venv)$/.test(src) });

  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const port = (wss.address() as AddressInfo).port;

  wss.on("connection", (ws) => {
    result.connected = true;
    const send = (m: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
    send({
      _type: "SessionMetadata", user_id: "bot-test", room_info: { owner_id: "u-owner", room_name: "Kojy test room" },
      rate_limits: { client: [100, 1], socials: [100, 1] }, connection_id: "test-conn", sdk_version: "25.1.0",
    });
    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg._type === "KeepaliveRequest") return send({ _type: "KeepaliveResponse" });
      const line = describe(msg);
      if (line && result.actions.length < 80) result.actions.push(line.slice(0, 300));
      if (msg.rid != null) send({ _type: String(msg._type).replace(/Request$/, "Response"), rid: msg.rid, ...(RESPONSES[String(msg._type)] ?? {}) });
    });
    let delay = 3000;
    if (opts.join) {
      setTimeout(() => send({ _type: "UserJoinedEvent", user: { id: "u-tester", username: "tester" }, position: { x: 5, y: 0, z: 5, facing: "FrontRight" }, anchor: null }), delay);
      delay += 2000;
    }
    opts.chat.forEach((message, i) => setTimeout(() => {
      result.actions.push(`(tester says: ${message})`);
      send({ _type: "ChatEvent", user: { id: "u-tester", username: "tester" }, message, whisper: false });
    }, delay + i * 2500));
  });

  const child = spawn(opts.python, [opts.launcher], {
    cwd: work,
    env: {
      ...opts.env,
      ...opts.extraEnv,
      KOJY_ENTRY: opts.entrypoint,
      HR_BOTAPI_URL: `ws://127.0.0.1:${port}`,
      HIGHRISE_ROOM_ID: opts.env.HIGHRISE_ROOM_ID ?? "test-room",
      HIGHRISE_BOT_TOKEN: opts.env.HIGHRISE_BOT_TOKEN ?? "test-token",
      PYTHONUNBUFFERED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (into: string[], isErr: boolean) => (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      if (into.length < 120) into.push(line.slice(0, 400));
      if (isErr && /Traceback|Error|Exception/.test(line) && result.errors.length < 60) result.errors.push(line.slice(0, 400));
    }
  };
  child.stdout.on("data", collect(result.output, false));
  child.stderr.on("data", collect(result.output, true));

  await new Promise<void>((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 3000); }, seconds * 1000);
    child.once("exit", (code) => { clearTimeout(timer); result.exitCode = code; result.exitedEarly = !timedOut; resolve(); });
    child.once("error", (err) => { clearTimeout(timer); result.errors.push(err.message); resolve(); });
  });
  wss.close();
  rmSync(work, { recursive: true, force: true });
  return result;
}
