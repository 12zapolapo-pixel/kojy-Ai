/**
 * Highrise Bot API — Wire Protocol Types
 * OWNERSHIP: packages/engine/src/runtime
 *
 * Modeled directly on the official Highrise Python Bot SDK
 * (https://github.com/pocketzworld/python-bot-sdk, src/highrise/models.py).
 *
 * CONNECTION:
 *   wss://highrise.game/web/botapi[?events=chat,user_joined,...]
 *   Headers: room-id: <room id>, api-token: <bot API token>, user-agent: <ua>
 *
 * On connect, the server sends exactly one `SessionMetadata` or `Error`
 * message. After that, a `KeepaliveRequest` ({_type:"KeepaliveRequest"}) must
 * be sent at least every 15s or the server closes the connection.
 *
 * Every message — incoming or outgoing — is a JSON object with a `_type`
 * field whose value is the (Python) class name. Outgoing "Request" messages
 * may include a client-chosen `rid`; the matching response echoes that `rid`.
 */

// ─── Shared Value Types ─────────────────────────────────────────────────────

export interface HighriseUser {
  id: string;
  username: string;
}

export type HighriseReaction = "clap" | "heart" | "thumbs" | "wave" | "wink";
export type HighriseFacing = "FrontRight" | "FrontLeft" | "BackRight" | "BackLeft";

export interface HighrisePosition {
  _type?: "Position";
  x: number;
  y: number;
  z: number;
  facing?: HighriseFacing;
}

export interface HighriseAnchorPosition {
  _type?: "AnchorPosition";
  entity_id: string;
  anchor_ix: number;
}

export type HighriseAnyPosition = HighrisePosition | HighriseAnchorPosition;

export interface HighriseCurrencyItem {
  type: string; // e.g. "gold", "bubbles"
  amount: number;
}

export interface HighriseItem {
  type: "clothing";
  amount: number;
  id: string;
  account_bound?: boolean;
  active_palette?: number | null;
}

export interface HighriseRoomInfo {
  owner_id: string;
  room_name: string;
}

// ─── Session / Errors ────────────────────────────────────────────────────────

export interface SessionMetadata {
  _type: "SessionMetadata";
  user_id: string;
  room_info: HighriseRoomInfo;
  rate_limits: Record<string, [number, number]>;
  connection_id: string;
  sdk_version?: string | null;
}

export interface HighriseError {
  _type: "Error";
  message: string;
  do_not_reconnect?: boolean;
  rid?: string | null;
}

// ─── Incoming Events ─────────────────────────────────────────────────────────

export interface ChatEvent {
  _type: "ChatEvent";
  user: HighriseUser;
  message: string;
  whisper: boolean;
}

export interface EmoteEvent {
  _type: "EmoteEvent";
  user: HighriseUser;
  emote_id: string;
  receiver?: HighriseUser | null;
}

export interface ReactionEvent {
  _type: "ReactionEvent";
  user: HighriseUser;
  reaction: HighriseReaction;
  receiver: HighriseUser;
}

export interface UserJoinedEvent {
  _type: "UserJoinedEvent";
  user: HighriseUser;
  position: HighriseAnyPosition;
}

export interface UserLeftEvent {
  _type: "UserLeftEvent";
  user: HighriseUser;
}

export interface UserMovedEvent {
  _type: "UserMovedEvent";
  user: HighriseUser;
  position: HighriseAnyPosition;
}

export interface ChannelEvent {
  _type: "ChannelEvent";
  sender_id: string;
  msg: string;
  tags: string[];
}

export interface TipReactionEvent {
  _type: "TipReactionEvent";
  sender: HighriseUser;
  receiver: HighriseUser;
  item: HighriseItem | HighriseCurrencyItem;
}

export interface VoiceEvent {
  _type: "VoiceEvent";
  users: Array<[HighriseUser, "voice" | "muted"]>;
  seconds_left: number;
}

export interface MessageEvent {
  _type: "MessageEvent";
  user_id: string;
  conversation_id: string;
  is_new_conversation: boolean;
}

export interface RoomModeratedEvent {
  _type: "RoomModeratedEvent";
  moderatorId: string;
  targetUserId: string;
  moderationType: "kick" | "mute" | "unmute" | "ban" | "unban";
  duration: number | null;
}

export type HighriseEvent =
  | ChatEvent
  | EmoteEvent
  | ReactionEvent
  | UserJoinedEvent
  | UserLeftEvent
  | UserMovedEvent
  | ChannelEvent
  | TipReactionEvent
  | VoiceEvent
  | MessageEvent
  | RoomModeratedEvent;

// ─── Outgoing Requests ───────────────────────────────────────────────────────

export interface ChatRequest {
  _type: "ChatRequest";
  message: string;
  whisper_target_id?: string | null;
  rid?: string | null;
}

export interface EmoteRequest {
  _type: "EmoteRequest";
  emote_id: string;
  target_user_id?: string | null;
  rid?: string | null;
}

export interface ReactionRequest {
  _type: "ReactionRequest";
  reaction: HighriseReaction;
  target_user_id: string;
  rid?: string | null;
}

export interface IndicatorRequest {
  _type: "IndicatorRequest";
  icon?: string | null;
  rid?: string | null;
}

export interface KeepaliveRequest {
  _type: "KeepaliveRequest";
  rid?: string | null;
}

export interface GetRoomUsersRequest {
  _type: "GetRoomUsersRequest";
  rid: string;
}

export interface GetRoomUsersResponse {
  _type?: "GetRoomUsersResponse";
  content: Array<[HighriseUser, HighriseAnyPosition]>;
  rid: string;
}

export interface TeleportRequest {
  _type: "TeleportRequest";
  user_id: string;
  destination: HighrisePosition;
  rid?: string | null;
}

export interface ModerateRoomRequest {
  _type: "ModerateRoomRequest";
  user_id: string;
  moderation_action: "kick" | "ban" | "unban" | "mute";
  action_length?: number | null;
  rid?: string | null;
}

export interface GetWalletRequest {
  _type: "GetWalletRequest";
  rid?: string | null;
}

export interface GetWalletResponse {
  _type?: "GetWalletResponse";
  content: HighriseCurrencyItem[];
  rid: string;
}

/**
 * Confirmed real via pocketzworld/creator-docs (change-bot-appearance.md):
 * "a SetOutfitRequest(outfit) call can be used, in this case outfit is a
 * list of items". A bot may only equip items it owns (or free/rarity:none
 * items) — that ownership check happens server-side; this client just
 * carries the request.
 */
export interface SetOutfitRequest {
  _type: "SetOutfitRequest";
  outfit: HighriseItem[];
  rid?: string | null;
}

export interface SetOutfitResponse {
  _type?: "SetOutfitResponse";
  rid: string;
}

/** Any message that may arrive over the socket after SessionMetadata. */
export type HighriseIncoming = HighriseEvent | HighriseError | { _type: string; rid?: string | null; [key: string]: unknown };

export const HIGHRISE_BOT_API_URL = "wss://highrise.game/web/botapi";
export const HIGHRISE_KEEPALIVE_INTERVAL_MS = 15_000;
export const HIGHRISE_READ_TIMEOUT_MS = 20_000;
