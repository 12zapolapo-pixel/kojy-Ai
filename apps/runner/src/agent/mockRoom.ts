/**
 * Test room — runs a copy of the bot against a fake Highrise server, so the
 * coder AI can check its changes without touching the real room.
 * OWNERSHIP: apps/runner/src/agent
 *
 * The fake server speaks the SDK's JSON protocol (HR_BOTAPI_URL): it sends
 * SessionMetadata, then the room events the AI asked for (people joining,
 * chatting, whispering, tipping, emoting, leaving — as "tester", the room
 * owner or anyone by name), answers every request with a plausible response,
 * and records what the bot sent back. With moderator: false the bot has no
 * moderator rights, so kicks, mutes and teleports are refused as in a real
 * room. The bot runs in a temporary copy of the project (data included) so a
 * test never changes the real bot's files or database.
 */

import { grantDir, spawnAs } from "../sandbox.js";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";

const RESPONSES: Record<string, Record<string, unknown>> = {
  GetWalletRequest: { content: [{ type: "gold", amount: 1000 }] },
  GetUserOutfitRequest: { outfit: [] },
  GetBackpackRequest: { backpack: {} },
  GetConversationsRequest: { conversations: [], not_joined: 0 },
  GetInventoryRequest: { items: [] },
  GetBotInfoRequest: { content: { user_id: "bot-test" } },
  CheckVoiceChatRequest: { seconds_left: 600, auto_speakers: [], users: {} },
};

/** Need moderator rights in a real room: refused when the test says the bot has none. */
const MODERATOR_ONLY = new Set(["ModerateRoomRequest", "TeleportRequest", "MoveUserToRoomRequest", "ChangeRoomPrivilegeRequest", "InviteSpeakerRequest", "RemoveSpeakerRequest"]);

export const BOT_USER = { id: "bot-test", username: "testbot" };
const OWNER_USER = { id: "u-owner", username: "roomowner" };
const POSITION = { x: 5, y: 0, z: 5, facing: "FrontRight" };

/** One thing that happens in the test room. */
export interface RoomEvent {
  type: "chat" | "whisper" | "join" | "leave" | "tip" | "emote" | "reaction" | "dm";
  /** Who does it: "tester" (default), "owner" (the room owner), or any other name. */
  user: string;
  /** chat, whisper or dm text */
  text: string;
  /** gold, for a tip */
  amount: number;
  /** emote id (emote) or reaction name: clap, heart, thumbs, wave, wink */
  emote: string;
}

export const EVENT_TYPES = ["chat", "whisper", "join", "leave", "tip", "emote", "reaction", "dm"] as const;

/** The AI's `events` argument, cleaned up (unknown types dropped, at most 12). */
export function parseEvents(raw: unknown): RoomEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: RoomEvent[] = [];
  for (const x of raw.slice(0, 12)) {
    if (!x || typeof x !== "object") continue;
    const e = x as Record<string, unknown>;
    const type = String(e.type ?? "") as RoomEvent["type"];
    if (!(EVENT_TYPES as readonly string[]).includes(type)) continue;
    const user = (typeof e.user === "string" && e.user.trim() ? e.user.trim() : "tester").replace(/^@/, "").slice(0, 30);
    out.push({
      type, user,
      text: String(e.text ?? e.message ?? "").slice(0, 500),
      amount: Math.max(1, Math.min(10_000, Math.round(Number(e.amount) || 10))),
      emote: String(e.emote ?? e.reaction ?? (type === "reaction" ? "heart" : "emote-wave")).slice(0, 60),
    });
  }
  return out;
}

/** A Highrise user for a name in a test: tester, the room owner, or anyone. */
export function testUser(name: string): { id: string; username: string } {
  const n = name.toLowerCase();
  if (n === "owner" || n === OWNER_USER.username) return OWNER_USER;
  if (n === "tester") return { id: "u-tester", username: "tester" };
  return { id: `u-${n.replace(/[^a-z0-9_]/g, "") || "guest"}`, username: name };
}

/** The Highrise wire message for an event (the same for Python and JS bots); null for a DM (sent differently). */
export function wireEvent(e: RoomEvent): Record<string, unknown> | null {
  const user = testUser(e.user);
  switch (e.type) {
    case "chat": return { _type: "ChatEvent", user, message: e.text, whisper: false };
    case "whisper": return { _type: "ChatEvent", user, message: e.text, whisper: true };
    case "join": return { _type: "UserJoinedEvent", user, position: POSITION, anchor: null };
    case "leave": return { _type: "UserLeftEvent", user };
    case "tip": return { _type: "TipReactionEvent", sender: user, receiver: BOT_USER, item: { type: "gold", amount: e.amount } };
    case "emote": return { _type: "EmoteEvent", user, emote_id: e.emote, receiver: null };
    case "reaction": return { _type: "ReactionEvent", user, reaction: e.emote, receiver: BOT_USER };
    case "dm": return null;
  }
}

/** "tester tips 100 gold", for the test's action list. */
export function describeEvent(e: RoomEvent): string {
  const who = testUser(e.user).username;
  switch (e.type) {
    case "chat": return `${who} says: ${e.text}`;
    case "whisper": return `${who} whispers to the bot: ${e.text}`;
    case "join": return `${who} joins`;
    case "leave": return `${who} leaves`;
    case "tip": return `${who} tips the bot ${e.amount} gold`;
    case "emote": return `${who} does emote ${e.emote}`;
    case "reaction": return `${who} reacts ${e.emote} to the bot`;
    case "dm": return `${who} sends the bot a DM: ${e.text}`;
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
  /** Chat lines sent by user "tester" after the events, ~2.5s apart. */
  chat: string[];
  /** Also send a join event for "tester" first. */
  join?: boolean;
  /** Room events, in order, after the join and before the chat lines. */
  events?: RoomEvent[];
  /** Whether the bot is a moderator in the test room (default true). */
  moderator?: boolean;
  seconds?: number;
}

function describe(msg: Record<string, unknown>, nameOf: (id: unknown) => string): string | null {
  switch (msg._type) {
    case "ChatRequest": return msg.whisper_target_id ? `whisper to ${nameOf(msg.whisper_target_id)}: ${msg.message}` : `say: ${msg.message}`;
    case "EmoteRequest": return `emote ${msg.emote_id}${msg.target_user_id ? ` on ${nameOf(msg.target_user_id)}` : ""}`;
    case "SendMessageRequest": return `DM: ${msg.content}`;
    case "ReactionRequest": return `react ${msg.reaction} to ${nameOf(msg.target_user_id)}`;
    case "ModerateRoomRequest": return `${msg.moderation_action} ${nameOf(msg.user_id)}${msg.action_length ? ` for ${msg.action_length}s` : ""}`;
    case "TeleportRequest": return `teleport ${nameOf(msg.user_id)}`;
    case "MoveUserToRoomRequest": return `move ${nameOf(msg.user_id)} to another room`;
    case "TipUserRequest": return `tip ${nameOf(msg.user_id)} ${msg.gold_bar}`;
    case "InviteSpeakerRequest": return `invite ${nameOf(msg.user_id)} to voice`;
    case "RemoveSpeakerRequest": return `remove ${nameOf(msg.user_id)} from voice`;
    case "KeepaliveRequest": return null;
    default: return String(msg._type);
  }
}

export async function runRoomTest(opts: RoomTestOptions): Promise<RoomTestResult> {
  const result: RoomTestResult = { connected: false, exitedEarly: false, exitCode: null, actions: [], output: [], errors: [] };
  const events = opts.events ?? [];
  const steps = (opts.join ? 1 : 0) + events.length + opts.chat.length;
  const seconds = Math.min(Math.max(opts.seconds ?? 12 + steps * 2.5, 8), 60);
  const moderator = opts.moderator !== false;

  const work = mkdtempSync(path.join(tmpdir(), "kojy-test-"));
  cpSync(opts.projectDir, work, { recursive: true, filter: (src) => !/[/\\](\.git|node_modules|__pycache__|\.venv)$/.test(src) });
  grantDir(work, opts.uid);

  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const port = (wss.address() as AddressInfo).port;

  // Everyone the test brings into the room, for get_room_users and readable action lines.
  const people = new Map<string, { id: string; username: string }>([["u-tester", testUser("tester")]]);
  for (const e of events) { const u = testUser(e.user); people.set(u.id, u); }
  const inRoom = new Set(people.keys());
  const nameOf = (id: unknown) => people.get(String(id))?.username ?? String(id);
  const dms: { conversation_id: string; content: string; sender_id: string }[] = [];

  wss.on("connection", (ws) => {
    result.connected = true;
    const send = (m: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
    send({
      _type: "SessionMetadata", user_id: BOT_USER.id, room_info: { owner_id: OWNER_USER.id, room_name: "Kojy test room" },
      rate_limits: { client: [100, 1], socials: [100, 1] }, connection_id: "test-conn", sdk_version: "25.1.0",
    });
    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      const type = String(msg._type);
      if (type === "KeepaliveRequest") return send({ _type: "KeepaliveResponse" });
      const refused = !moderator && MODERATOR_ONLY.has(type);
      const line = describe(msg, nameOf);
      if (line && result.actions.length < 80) result.actions.push((refused ? "(refused by Highrise: the bot isn't a moderator) " : "") + line.slice(0, 300));
      if (msg.rid == null) return;
      if (refused) return send({ _type: "Error", message: "You don't have the room privileges to do that", rid: msg.rid });
      const dynamic: Record<string, unknown> =
        type === "GetRoomUsersRequest" ? { content: [...inRoom].map((id) => [people.get(id), POSITION]) }
        : type === "GetRoomPrivilegeRequest" ? { content: msg.user_id === BOT_USER.id ? { moderator, designer: moderator } : { moderator: msg.user_id === OWNER_USER.id, designer: msg.user_id === OWNER_USER.id } }
        : type === "GetMessagesRequest" ? { messages: dms.filter((d) => d.conversation_id === msg.conversation_id).map((d, i) => ({ message_id: `m${i}`, createdAt: null, category: "text", ...d })) }
        : RESPONSES[type] ?? {};
      send({ _type: type.replace(/Request$/, "Response"), rid: msg.rid, ...dynamic });
    });

    const timeline: RoomEvent[] = [
      ...(opts.join ? [{ type: "join", user: "tester", text: "", amount: 0, emote: "" } as RoomEvent] : []),
      ...events,
      ...opts.chat.map((text): RoomEvent => ({ type: "chat", user: "tester", text, amount: 0, emote: "" })),
    ];
    timeline.forEach((e, i) => setTimeout(() => {
      result.actions.push(`(${describeEvent(e)})`);
      const u = testUser(e.user);
      if (e.type === "join") inRoom.add(u.id);
      if (e.type === "leave") inRoom.delete(u.id);
      if (e.type === "dm") {
        const conversation_id = `conv-${u.id}`;
        dms.push({ conversation_id, content: e.text, sender_id: u.id });
        send({ _type: "MessageEvent", user_id: u.id, conversation_id, is_new_conversation: dms.filter((d) => d.conversation_id === conversation_id).length === 1 });
        return;
      }
      const wire = wireEvent(e);
      if (wire) send(wire);
    }, 3000 + i * 2500));
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
