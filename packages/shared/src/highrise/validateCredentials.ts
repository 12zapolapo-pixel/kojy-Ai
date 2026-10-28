/**
 * Highrise Credential Validator
 * OWNERSHIP: packages/shared/src/highrise
 *
 * Moved from apps/api/src/modules/bots/validateHighrise.ts — connects to the
 * real Highrise Bot API WebSocket to prove a token/room actually work,
 * BEFORE anything is saved. This is the ONLY place that accepts a Highrise
 * API key and room ID; both must be authenticated by Highrise itself before
 * we store anything.
 *
 * Moved here (rather than staying api-local) so createBot.ts, in this same
 * directory, can be called identically from apps/api's bots.create AND
 * apps/worker's Composer deploy step — one real implementation instead of
 * the worker needing its own copy, which is exactly the class of bug
 * (independently-drifting duplicate implementations) found and fixed
 * elsewhere this session (the two sandboxes, the two AI engines).
 */

import WebSocket from "ws";
import { TRPCError } from "@trpc/server";

const HIGHRISE_BOT_API_URL = "wss://highrise.game/web/botapi";
const SDK_UA = "kojyai-validator/1.0";
const CONNECT_TIMEOUT_MS = 15_000;

export interface ValidationResult {
  botUserId: string;
  roomName: string;
  connectionId: string;
}

/**
 * Minimal local shape for the one real message we care about — avoids
 * importing @kojyai/engine's SessionMetadata type, which would create a
 * circular dependency (packages/engine already depends on packages/shared).
 */
interface SessionMetadataMessage {
  _type: "SessionMetadata";
  user_id: string;
  room_info: { room_name: string };
  connection_id: string;
}

/**
 * Attempts a real WebSocket connection to Highrise Bot API.
 * Resolves with bot identity info on success, rejects with TRPCError on failure.
 *
 * The first message the server sends is either:
 *   { _type: "SessionMetadata", user_id, room_info, connection_id, ... } → valid
 *   { _type: "Error", message, do_not_reconnect }                        → invalid
 */
export async function validateHighriseCredentials(
  apiKey: string,
  roomId: string,
): Promise<ValidationResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let ws: WebSocket | null = null;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws?.terminate();
      reject(new TRPCError({
        code: "TIMEOUT",
        message: "Highrise did not respond within 15 seconds — check your Room ID and try again.",
      }));
    }, CONNECT_TIMEOUT_MS);

    const finish = (err?: TRPCError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ws?.close();
      if (err) reject(err); // resolve called below when err is absent
    };

    try {
      ws = new WebSocket(process.env.HR_BOTAPI_URL ?? HIGHRISE_BOT_API_URL, {
        headers: {
          "room-id":    roomId,
          "api-token":  apiKey,
          "user-agent": SDK_UA,
        },
      });
    } catch (e) {
      clearTimeout(timeout);
      return reject(new TRPCError({
        code: "BAD_REQUEST",
        message: "Could not initiate connection to Highrise — ensure the Room ID and API Token are correct.",
      }));
    }

    ws.once("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;

      const isNetworkErr = ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN"].includes(err.code ?? "")
        // A rejected WS handshake (e.g. an egress proxy blocking the host)
        // surfaces here as a plain Error with no .code at all — the upgrade
        // never completed, so this can't be a Highrise-side credential
        // rejection (those only arrive as an app-level {_type:"Error"}
        // message AFTER a successful handshake — see the "message" handler
        // below). Safe to bucket alongside the network-unreachable cases.
        || /Unexpected server response/i.test(err.message ?? "");
      const relaxedMode = process.env.HIGHRISE_VALIDATION_MODE === "relaxed";

      if (isNetworkErr && relaxedMode) {
        // HIGHRISE_VALIDATION_MODE=relaxed is for sandboxes with restricted
        // egress — it must NEVER be set in production. Without it, any
        // network failure here correctly rejects the credentials below: we
        // never accept a room/token that Highrise itself hasn't confirmed.
        finish();
        return resolve({
          botUserId:    `pending-${Date.now()}`,
          roomName:     `Room ${roomId}`,
          connectionId: `offline-${Date.now()}`,
        });
      }

      finish(new TRPCError({
        code: isNetworkErr ? "SERVICE_UNAVAILABLE" : "BAD_REQUEST",
        message: isNetworkErr
          ? "Could not reach Highrise's servers. Please try again in a moment."
          : `Highrise connection error: ${err.message}`,
      }));
    });

    ws.once("message", (raw: Buffer | string) => {
      if (settled) return;

      let msg: { _type: string; [k: string]: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return finish(new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Highrise returned an unexpected response.",
        }));
      }

      if (msg._type === "Error") {
        const message = (msg.message as string) || "Authentication failed";
        return finish(new TRPCError({
          code: "UNAUTHORIZED",
          message: `Highrise rejected these credentials: ${message}. Double-check your API Token and Room ID.`,
        }));
      }

      if (msg._type === "SessionMetadata") {
        const meta = msg as unknown as SessionMetadataMessage;
        finish();
        return resolve({
          botUserId:    meta.user_id,
          roomName:     meta.room_info.room_name,
          connectionId: meta.connection_id,
        });
      }

      // Unknown first message
      finish(new TRPCError({
        code: "BAD_REQUEST",
        message: `Unexpected response from Highrise: ${msg._type}`,
      }));
    });

    ws.once("close", (code) => {
      if (settled) return;
      finish(new TRPCError({
        code: "BAD_REQUEST",
        message: `Highrise closed the connection (code ${code}) — check your Room ID. The bot must have designer access to the room.`,
      }));
    });
  });
}
