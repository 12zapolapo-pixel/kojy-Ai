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

import { grantDir, spawnAs } from "../sandbox.js";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";

/** Answers to the bot's requests; GetRoomUsers and GetRoomPrivilege are worked out per test. */
const RESPONSES: Record<string, Record<string, unknown>> = {
  GetWalletRequest: { content: [{ type: "gold", amount: 1000 }] },
  GetUserOutfitRequest: { outfit: [] },
  GetBackpackRequest: { backpack: [] },
  GetConversationsRequest: { conversations: [], not_joined: 0 },
  GetMessagesRequest: { messages: [] },
  GetInventoryRequest: { items: [] },
  GetBotInfoRequest: { content: { user_id: "bot-test" } },
};

/** One thing that happens in the test room. */
export interface RoomEvent {
  type: "chat" | "whisper" | "join" | "leave" | "tip" | "emote" | "wait";
  /** Who does it (default "tester"). */
  user?: string;
  message?: string;
  /** tip: gold amount (default 10). */
  amount?: number;
  /** emote: the emote id (default "emote-wave"). */
  emote?: string;
  /** wait: seconds before the next event (default 3). */
  seconds?: number;
}

export const ROOM_EVENT_TYPES = ["chat", "whisper", "join", "leave", "tip", "emote", "wait"] as const;
const MAX_EVENTS = 12;

/** Cleans what the AI asked for: known types, short texts, a few users. */
export function normalizeEvents(raw: unknown): RoomEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: RoomEvent[] = [];
  for (const x of raw.slice(0, MAX_EVENTS)) {
    if (!x || typeof x !== "object") continue;
    const e = x as Record<string, unknown>;
    const type = String(e.type ?? "chat") as RoomEvent["type"];
    if (!ROOM_EVENT_TYPES.includes(type)) continue;
    const user = typeof e.user === "string" && /^[\w.-]{1,20}$/.test(e.user) ? e.user : "tester";
    const ev: RoomEvent = { type, user };
    if (typeof e.message === "string") ev.message = e.message.slice(0, 500);
    if (typeof e.amount === "number" && Number.isFinite(e.amount)) ev.amount = Math.min(Math.max(Math.round(e.amount), 1), 10_000);
    if (typeof e.emote === "string") ev.emote = e.emote.slice(0, 60);
    if (typeof e.seconds === "number") ev.seconds = Math.min(Math.max(e.seconds, 0.5), 15);
    out.push(ev);
  }
  return out;
}

/** The old form (tester's chat lines, optional join first) as events. */
export function chatToEvents(chat: string[], join: boolean): RoomEvent[] {
  return [...(join ? [{ type: "join" as const, user: "tester" }] : []), ...chat.map((message) => ({ type: "chat" as const, user: "tester", message }))];
}

const userOf = (name: string) => ({ id: `u-${name}`, username: name });
const SPOT = { x: 5, y: 0, z: 5, facing: "FrontRight" };

/** The SDK message for one event (null for "wait"). */
export function eventMessage(e: RoomEvent): Record<string, unknown> | null {
  const user = userOf(e.user ?? "tester");
  switch (e.type) {
    case "chat": return { _type: "ChatEvent", user, message: e.message ?? "", whisper: false };
    case "whisper": return { _type: "ChatEvent", user, message: e.message ?? "", whisper: true };
    case "join": return { _type: "UserJoinedEvent", user, position: SPOT, anchor: null };
    case "leave": return { _type: "UserLeftEvent", user };
    case "tip": return { _type: "TipReactionEvent", sender: user, receiver: { id: "bot-test", username: "bot" }, item: { type: "gold", amount: e.amount ?? 10 } };
    case "emote": return { _type: "EmoteEvent", user, emote_id: e.emote ?? "emote-wave", receiver: null };
    default: return null;
  }
}

function eventLine(e: RoomEvent): string {
  const who = e.user ?? "tester";
  switch (e.type) {
    case "chat": return `(${who} says: ${e.message ?? ""})`;
    case "whisper": return `(${who} whispers to the bot: ${e.message ?? ""})`;
    case "join": return `(${who} joins)`;
    case "leave": return `(${who} leaves)`;
    case "tip": return `(${who} tips the bot ${e.amount ?? 10} gold)`;
    case "emote": return `(${who} does ${e.emote ?? "emote-wave"})`;
    default: return `(wait ${e.seconds ?? 3}s)`;
  }
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
  /** The project's sandbox user (see sandbox.ts). */
  uid: number;
  projectDir: string;
  python: string;
  launcher: string;
  entrypoint: string;
  env: NodeJS.ProcessEnv;
  /** What happens in the room after the bot starts, ~2.5s apart. */
  events: RoomEvent[];
  /** Whether the bot is a moderator in the test room (default true). */
  moderator?: boolean;
  seconds?: number;
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
  const waits = opts.events.reduce((n, e) => n + (e.type === "wait" ? (e.seconds ?? 3) : 2.5), 0);
  const seconds = Math.min(Math.max(opts.seconds ?? 12 + waits, 8), 60);
  /** Who is in the room: everyone who did something, minus who left. */
  const present = new Map<string, ReturnType<typeof userOf>>([["tester", userOf("tester")]]);

  const work = mkdtempSync(path.join(tmpdir(), "kojy-test-"));
  cpSync(opts.projectDir, work, { recursive: true, filter: (src) => !/[/\\](\.git|node_modules|__pycache__|\.venv)$/.test(src) });
  grantDir(work, opts.uid);

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
      if (msg.rid != null) {
        const type = String(msg._type);
        const extra = type === "GetRoomUsersRequest" ? { content: [...present.values()].map((u) => [u, SPOT]) }
          : type === "GetRoomPrivilegeRequest" ? { content: { moderator: opts.moderator !== false, designer: opts.moderator !== false } }
          : RESPONSES[type] ?? {};
        // Without moderator rights Highrise refuses moving, kicking, muting and banning.
        if (opts.moderator === false && /^(Teleport|ModerateRoom|MoveUserToRoom)Request$/.test(type)) {
          result.actions.push(`(Highrise refused ${type}: the bot isn't a moderator)`);
          return send({ _type: "Error", rid: msg.rid, message: "Not allowed: the bot is not a moderator in this room" });
        }
        send({ _type: type.replace(/Request$/, "Response"), rid: msg.rid, ...extra });
      }
    });
    let at = 3000;
    for (const e of opts.events) {
      if (e.type === "wait") { at += (e.seconds ?? 3) * 1000; continue; }
      const message = eventMessage(e)!;
      setTimeout(() => {
        const name = e.user ?? "tester";
        if (e.type === "leave") present.delete(name); else present.set(name, userOf(name));
        result.actions.push(eventLine(e));
        send(message);
      }, at);
      at += 2500;
    }
  });

  let started: ReturnType<typeof spawnAs>;
  try {
    started = spawnAs(opts.uid, opts.python, [opts.launcher], {
    cwd: work,
    env: {
      ...opts.env,
      KOJY_ENTRY: opts.entrypoint,
      HR_BOTAPI_URL: `ws://127.0.0.1:${port}`,
      HIGHRISE_ROOM_ID: opts.env.HIGHRISE_ROOM_ID ?? "test-room",
      HIGHRISE_BOT_TOKEN: opts.env.HIGHRISE_BOT_TOKEN ?? "test-token",
      PYTHONUNBUFFERED: "1",
      KOJY_WATCHDOG: "off", // a short test run; the fake room doesn't answer room checks
    },
    stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    wss.close();
    rmSync(work, { recursive: true, force: true });
    result.errors.push((err as Error).message);
    return result;
  }
  const { child, kill } = started;
  const collect = (into: string[], isErr: boolean) => (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      if (into.length < 120) into.push(line.slice(0, 400));
      if (isErr && /Traceback|Error|Exception/.test(line) && result.errors.length < 60) result.errors.push(line.slice(0, 400));
    }
  };
  child.stdout?.on("data", collect(result.output, false));
  child.stderr?.on("data", collect(result.output, true));

  await new Promise<void>((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; kill("SIGTERM"); setTimeout(() => kill("SIGKILL"), 3000); }, seconds * 1000);
    child.once("exit", (code) => { clearTimeout(timer); result.exitCode = code; result.exitedEarly = !timedOut; resolve(); });
    child.once("error", (err) => { clearTimeout(timer); result.errors.push(err.message); resolve(); });
  });
  wss.close();
  rmSync(work, { recursive: true, force: true });
  return result;
}
