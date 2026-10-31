/**
 * Test room — runs a copy of the bot against a fake Highrise server, so the
 * coder AI can check its changes without touching the real room.
 * OWNERSHIP: apps/runner/src/agent
 *
 * The fake server speaks the SDK's JSON protocol (HR_BOTAPI_URL): it sends
 * SessionMetadata, then plays the test's steps (chat, whispers, joins, leaves
 * and tips from the room's owner, a moderator or visitors), answers every
 * request with a plausible response (or a Highrise refusal the test asked
 * for), and records what the bot sent back. The bot runs in a temporary copy
 * of the project (data included) so a test never changes the real bot's files
 * or database.
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
  GetInventoryRequest: { items: [] },
  GetBotInfoRequest: { content: { user_id: "bot-test" } },
};

/** One thing that happens in the test room. */
export type RoomEvent =
  | { at: number; type: "chat"; user: string; message: string; whisper: boolean }
  | { at: number; type: "join" | "leave"; user: string }
  | { at: number; type: "tip"; user: string; amount: number };

/** People in the test room: "owner" owns it, "mod" is a moderator, anyone else is a visitor. */
export const userId = (name: string) => (name === "owner" ? "u-owner" : `u-${name}`);
const isStaff = (id: string) => id === "u-owner" || id === "u-mod";

/**
 * Steps → timed events, ~2s apart:
 *   "owner: !mod tester"   chat (also "visitor: hi", "mod: !kick x"; a line without "name:" is tester's)
 *   "whisper owner: !secret"
 *   "join visitor" · "leave visitor" · "tip visitor 10" · "wait 5"
 */
export function parseSteps(steps: string[]): { events: RoomEvent[]; errors: string[]; end: number } {
  const events: RoomEvent[] = [];
  const errors: string[] = [];
  let at = 3000;
  for (const raw of steps.slice(0, 25)) {
    const step = String(raw).trim();
    let m: RegExpExecArray | null;
    if ((m = /^wait\s+(\d+(?:\.\d+)?)$/i.exec(step))) { at += Math.min(Number(m[1]), 30) * 1000; continue; }
    if ((m = /^(join|leave)\s+([\w.-]{1,24})$/i.exec(step))) events.push({ at, type: m[1]!.toLowerCase() as "join" | "leave", user: m[2]! });
    else if ((m = /^tip\s+([\w.-]{1,24})\s+(\d{1,6})$/i.exec(step))) events.push({ at, type: "tip", user: m[1]!, amount: Number(m[2]) });
    else if ((m = /^(whisper\s+)?([\w.-]{1,24}):\s?(.*)$/is.exec(step))) events.push({ at, type: "chat", user: m[2]!, message: m[3]!.slice(0, 300), whisper: !!m[1] });
    else if (step) events.push({ at, type: "chat", user: "tester", message: step.slice(0, 300), whisper: false });
    else errors.push("empty step");
    at += 2000;
  }
  return { events, errors, end: at };
}

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
  /** Chat lines sent by user "tester" after the bot starts (older form of steps). */
  chat?: string[];
  /** What happens in the room, see parseSteps. */
  steps?: string[];
  /** Also send a join event for "tester" first. */
  join?: boolean;
  seconds?: number;
  /** Highrise refusals to simulate: request type → error message, e.g. ChangeRoomPrivilegeRequest → "You can't edit this room." */
  refuse?: Record<string, string>;
  /** Settings for this test only, e.g. a short timer interval. Can't change the room or token. */
  extraEnv?: Record<string, string>;
}

function describe(msg: Record<string, unknown>): string | null {
  switch (msg._type) {
    case "ChatRequest": return msg.whisper_target_id ? `whisper to ${String(msg.whisper_target_id).replace(/^u-/, "")}: ${msg.message}` : `say: ${msg.message}`;
    case "EmoteRequest": return `emote ${msg.emote_id}${msg.target_user_id ? ` on ${msg.target_user_id}` : ""}`;
    case "SendMessageRequest": return `DM: ${msg.content}`;
    case "ReactionRequest": return `react ${msg.reaction} to ${msg.target_user_id}`;
    case "KeepaliveRequest": return null;
    default: return String(msg._type);
  }
}

export async function runRoomTest(opts: RoomTestOptions): Promise<RoomTestResult> {
  const result: RoomTestResult = { connected: false, exitedEarly: false, exitCode: null, actions: [], output: [], errors: [] };
  const { events } = parseSteps([...(opts.join ? ["join tester"] : []), ...(opts.chat ?? []), ...(opts.steps ?? [])]);
  const lastAt = events.length ? events[events.length - 1]!.at : 0;
  const seconds = Math.min(Math.max(opts.seconds ?? lastAt / 1000 + 6, 8), 60);

  const work = mkdtempSync(path.join(tmpdir(), "kojy-test-"));
  cpSync(opts.projectDir, work, { recursive: true, filter: (src) => !/[/\\](\.git|node_modules|__pycache__|\.venv)$/.test(src) });

  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const port = (wss.address() as AddressInfo).port;

  wss.on("connection", (ws) => {
    result.connected = true;
    const send = (m: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
    const present = new Map<string, string>([["u-tester", "tester"]]);
    const person = (name: string) => ({ id: userId(name), username: name });
    send({
      _type: "SessionMetadata", user_id: "bot-test", room_info: { owner_id: "u-owner", room_name: "Kojy test room" },
      rate_limits: { client: [100, 1], socials: [100, 1] }, connection_id: "test-conn", sdk_version: "25.1.0",
    });
    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg._type === "KeepaliveRequest") return send({ _type: "KeepaliveResponse" });
      const line = describe(msg);
      if (line && result.actions.length < 120) result.actions.push(line.slice(0, 300));
      if (msg.rid == null) return;
      const type = String(msg._type);
      const refusal = opts.refuse?.[type];
      if (refusal) return send({ _type: "Error", message: refusal, rid: msg.rid });
      let extra: Record<string, unknown> = RESPONSES[type] ?? {};
      if (type === "GetRoomPrivilegeRequest") {
        const staff = isStaff(String(msg.user_id ?? ""));
        extra = { content: { moderator: staff, designer: msg.user_id === "u-owner" } };
      } else if (type === "GetRoomUsersRequest") {
        extra = { content: [...present].map(([id, username]) => [{ id, username }, { x: 5, y: 0, z: 5, facing: "FrontRight" }]) };
      }
      send({ _type: type.replace(/Request$/, "Response"), rid: msg.rid, ...extra });
    });
    for (const e of events) setTimeout(() => {
      const who = person(e.user);
      if (e.type === "chat") {
        present.set(who.id, who.username);
        result.actions.push(`(${e.user} ${e.whisper ? "whispers" : "says"}: ${e.message})`);
        send({ _type: "ChatEvent", user: who, message: e.message, whisper: e.whisper });
      } else if (e.type === "join") {
        present.set(who.id, who.username);
        result.actions.push(`(${e.user} joins)`);
        send({ _type: "UserJoinedEvent", user: who, position: { x: 5, y: 0, z: 5, facing: "FrontRight" }, anchor: null });
      } else if (e.type === "leave") {
        present.delete(who.id);
        result.actions.push(`(${e.user} leaves)`);
        send({ _type: "UserLeftEvent", user: who });
      } else if (e.type === "tip") {
        result.actions.push(`(${e.user} tips ${e.amount} gold)`);
        send({ _type: "TipReactionEvent", sender: who, receiver: { id: "bot-test", username: "KojyTestBot" }, item: { type: "gold", amount: e.amount } });
      }
    }, e.at);
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
