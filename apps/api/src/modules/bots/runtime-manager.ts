/**
 * Bot Runtime Manager
 * OWNERSHIP: apps/api/src/modules/bots
 *
 * ARCHITECTURE:
 * - Each bot is an async loop (not a separate OS process in dev;
 *   Docker-isolated process in production via BOT_RUNTIME_MODE=docker)
 * - BotRuntimeManager is a singleton — one per API pod
 * - On API restart: queries DB for previously-online bots → restores them
 * - Health scoring: updated every 30s based on latency, error rate, uptime
 *
 * SCALING:
 * - Each pod handles up to 50 concurrent bot loops (configurable)
 * - Horizontal scaling: bots distributed across pods via Redis lock
 * - Bot assignment: first pod to acquire Redis lock "bot:lock:{id}" owns it
 *
 * FAILURE:
 * - Bot loop crashes → caught, status set to "error", restart queued
 * - All pods crash → bots detected as offline on next pod startup → restored
 */

import { eq, and }      from "drizzle-orm";
import { db, schema }   from "../../db/client.js";
import { getRedis, getRedisSubscriber } from "../../utils/redis.js";
import { createLogger } from "../../utils/logger.js";
import { broadcastBotEvent } from "../../websocket/gateway.js";
import { decryptApiKey } from "@kojyai/shared/crypto"; // BUG-3 FIX: decrypt stored key before use
import { verifyBotControlMessage } from "@kojyai/shared/crypto"; // SECURITY FIX (C-03)
import type { BotStatus } from "@kojyai/shared/types";
import type { PersonalityDNA } from "@kojyai/shared/types";
import {
  HighriseClient,
  type HighriseConnectionStatus,
  type HighriseEvent,
  evaluateEvent,
  isAddressed,
  ModerationTracker,
  resolveAIProvider,
  generateChatReply,
  registerScriptPlugin,
  clearScriptPlugins,
  getScriptPluginIds,
  type ScriptPlugin,
} from "@kojyai/engine";
import { buildPersonalityPrompt, createDefaultPersonalityProfile } from "@kojyai/engine/personality";
import { stripEsmExport } from "@kojyai/engine/delegation";
import { ActivityRecorder, notifyUser, sendAlert } from "@kojyai/db";
import { scanToxicityFast, scanToxicityDeep } from "@kojyai/security";
import { emitSecurityEvent } from "../../events/audit.js";
import ivm from "isolated-vm";

const log = createLogger("bot-runtime");

// ─── Live Script Isolation (SECURITY FIX C-02) ─────────────────────────────
//
// loadBotScripts() previously ran every live AI-generated script through
// vm.runInNewContext with a sandbox object that also passed in the HOST's
// real Math/JSON/Array/Object/etc built-ins by reference (not vm-context-
// native copies). Confirmed live: a script using e.g. `Array.constructor`
// (the *host* Array, passed by reference) reaches the real host Function
// constructor and, from there, the real `process` — full read of env vars,
// cwd, pid — regardless of `process`/`require`/`global` being individually
// set to undefined on the sandbox object, because the escape never
// references those names directly. This function shares a process with the
// API server, which holds ENCRYPTION_KEY/JWT_SECRET/DATABASE_URL/
// REDIS_PASSWORD as env vars — a single malicious or compromised bot script
// was a path to full platform compromise.
//
// Fix: real V8 isolate per script (isolated-vm) — a genuinely separate heap
// and global object, not a same-process object with swapped-out property
// names. Nothing is passed into the isolate from the host realm by
// reference (no Math/Array/Object injection at all — the isolate has its
// own native copies automatically), so there is no host-realm object for a
// script to pivot through. Chosen over Docker (this codebase's other real
// isolation mode, used for Composer/Delegation *testing* — see
// ScriptSandbox.ts) because this function is a hot path that fires on every
// bot connect/reconnect and then again on every single chat/game event for
// that bot's whole session — a per-event container spin-up is far too slow
// here. isolated-vm keeps `applySync`, preserving the synchronous
// ScriptPlugin contract every caller (ReactiveEngine.ts) already relies on,
// while still applying a real timeout and a real per-script memory cap.
//
// Live tests run against this exact fix: the host-object-reference escape
// above now throws "process is not defined" inside the isolate; a normal
// script's actions still round-trip correctly; a script under an isolate
// memory cap is now killed instead of able to balloon the API process's
// own heap.

const LIVE_SCRIPT_MEMORY_LIMIT_MB = 64;
const LIVE_SCRIPT_TIMEOUT_MS = 2000;

/** Tracks live isolates per bot so a reload/stop disposes the old ones instead of leaking. */
const liveScriptIsolates = new Map<string, ivm.Isolate[]>();

function disposeLiveScriptIsolates(botUuid: string): void {
  const isolates = liveScriptIsolates.get(botUuid);
  if (!isolates) return;
  for (const isolate of isolates) {
    try {
      if (!isolate.isDisposed) isolate.dispose();
    } catch (err) {
      log.warn({ err }, `Failed to dispose a live-script isolate for bot ${botUuid}`);
    }
  }
  liveScriptIsolates.delete(botUuid);
}

// ─── Bot Loop State ────────────────────────────────────────────────────────────

interface BotLoopState {
  botId:     string;
  botDbId:   number;
  orgId:     number;
  status:    BotStatus;
  startedAt: Date;
  abortController: AbortController;
  errorCount:  number;
  messageCount: number;
  lastHeartbeat: Date;
  client?: HighriseClient;
  /** Highrise refused the bot for good (bad token, banned…): don't auto-restart. */
  fatalError?: string;
}

const activeLoops = new Map<string, BotLoopState>();

// Room activity for the analytics pages (batched writes to bot_activity).
let activity: ActivityRecorder | null = null;
function recordActivity(state: BotLoopState, kind: string, user?: { id: string; username: string } | null): void {
  activity ??= new ActivityRecorder(db, 5000, (err) => log.warn({ err }, "Could not save bot activity"));
  activity.record({ orgId: state.orgId, source: "bot", sourceId: state.botDbId, kind, actorId: user?.id ?? null, actorName: user?.username ?? null });
}

async function notifyBotOwner(state: BotLoopState, type: "bot_error" | "bot_offline", title: string, body: string): Promise<void> {
  const [bot] = await db.select({ ownerId: schema.bots.ownerId, name: schema.bots.name }).from(schema.bots).where(eq(schema.bots.id, state.botDbId)).limit(1);
  if (!bot) return;
  await notifyUser(db, bot.ownerId, type, `${bot.name}: ${title}`, body, `/bots/${state.botId}`);
  void sendAlert(`⚠️ ${bot.name}: ${title} — ${body}`);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export async function initBotRuntimeManager(): Promise<void> {
  // Restore bots that were online before this API pod restarted
  const previouslyOnline = await db
    .select()
    .from(schema.bots)
    .where(and(eq(schema.bots.status, "online"), eq(schema.bots.isActive, true)));

  for (const bot of previouslyOnline) {
    log.info(`Restoring bot ${bot.name} (${bot.uuid})`);
    // BUG-3 FIX: highriseApiKey is stored encrypted (AES-256-GCM iv:ct:tag).
    // Must decrypt before passing to the bot loop — passing ciphertext would
    // cause every Highrise auth attempt to fail silently.
    let plainKey: string;
    try {
      plainKey = decryptApiKey(bot.highriseApiKey);
    } catch (err) {
      log.error({ err }, `Cannot restore bot ${bot.uuid} — API key decryption failed`);
      await db.update(schema.bots)
        .set({ status: "error", connectionError: "API key decryption failed — re-save the key." })
        .where(eq(schema.bots.id, bot.id));
      continue;
    }
    await startBotLoop(bot.uuid, bot.id, bot.orgId, plainKey, bot.activeRoomId ?? "");
  }

  log.info(`Runtime manager initialized — ${previouslyOnline.length} bots restored`);

  // Heartbeat monitor — detect dead loops every 60s
  setInterval(() => monitorHeartbeats(), 60_000);

  // Listen for control commands from the worker (start/stop/restart/broadcast).
  // This is the actual link between bots.start/stop/restart/broadcastMessage
  // (tRPC -> BullMQ job -> this channel) and the live Highrise connection —
  // without it those endpoints only ever flipped a DB status flag.
  initBotControlSubscriber();
}

// ─── Control Channel Subscriber ────────────────────────────────────────────────

function initBotControlSubscriber(): void {
  const sub = getRedisSubscriber();
  if (!sub) {
    log.warn("Redis subscriber unavailable — bot control commands (start/stop/restart/broadcast from UI) will not reach the runtime manager");
    return;
  }

  void sub.psubscribe("bot_control:*");

  sub.on("pmessage", (pattern: string, channel: string, raw: string) => {
    if (pattern !== "bot_control:*") return; // not ours — gateway.ts owns bot:*/org:*/sim:*/system

    const botUuid = channel.slice("bot_control:".length);

    // SECURITY FIX (C-03): verify the HMAC before acting on anything here.
    // This channel is trusted-by-design once a message arrives — the real
    // authorization boundary is (a) requiring REDIS_PASSWORD in production
    // (boot.ts) and (b) this signature check, so that even a compromised or
    // misconfigured Redis ACL that lets something publish here still can't
    // make the runtime manager act on it without ENCRYPTION_KEY.
    const verified = verifyBotControlMessage(botUuid, raw);
    if (!verified.ok) {
      log.warn(`Rejected unverified bot_control message on ${channel}: ${verified.reason}`);
      return;
    }

    handleControlCommand(botUuid, verified.action, verified.payload).catch((err) => {
      log.error({ err }, `Failed to handle control command '${verified.action}' for bot ${botUuid}`);
    });
  });
}

async function handleControlCommand(
  botUuid: string,
  action: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  switch (action) {
    case "start": {
      if (activeLoops.has(botUuid)) return; // already running
      const [bot] = await db.select().from(schema.bots).where(eq(schema.bots.uuid, botUuid)).limit(1);
      if (!bot) { log.warn(`bot_control start: bot ${botUuid} not found`); return; }

      let plainKey: string;
      try {
        plainKey = decryptApiKey(bot.highriseApiKey);
      } catch (err) {
        log.error({ err }, `Cannot start bot ${botUuid} — API key decryption failed`);
        await updateBotStatus(bot.id, botUuid, "error", "API key decryption failed — re-save the key.");
        return;
      }

      await startBotLoop(botUuid, bot.id, bot.orgId, plainKey, bot.activeRoomId ?? "");
      break;
    }

    case "stop": {
      await stopBotLoop(botUuid);
      break;
    }

    case "restart": {
      await restartBotLoop(botUuid);
      break;
    }

    case "broadcast": {
      const state = activeLoops.get(botUuid);
      const message = String(payload?.message ?? "");
      if (!state?.client?.connected) {
        log.warn(`bot_control broadcast: bot ${botUuid} is not connected — message dropped`);
        broadcastBotEvent(botUuid, {
          type: "bot_log", botId: botUuid, level: "warn", source: "manager",
          message: `Broadcast skipped — bot is offline: "${message}"`, ts: Date.now(),
        });
        return;
      }
      state.client.sendChat(message);
      break;
    }

    case "reload_scripts": {
      // The Delegation agent just deployed a new script — reload all active
      // bot_scripts rows for this bot and register them as ScriptPlugins.
      log.info(`bot_control reload_scripts: reloading scripts for ${botUuid}`);
      await loadBotScripts(botUuid).catch((err) =>
        log.error({ err }, `Script reload failed for ${botUuid}`)
      );
      broadcastBotEvent(botUuid, {
        type: "bot_log", botId: botUuid, level: "info", source: "manager",
        message: "Bot scripts reloaded — new behavior is live.", ts: Date.now(),
      });
      break;
    }

    default:
      log.warn(`Unknown bot_control action: ${action}`);
  }
}

// ─── Start Bot ────────────────────────────────────────────────────────────────

export async function startBotLoop(
  botUuid:  string,
  botDbId:  number,
  orgId:    number,
  apiKey:   string,
  roomId:   string,
): Promise<void> {
  if (activeLoops.has(botUuid)) {
    log.warn(`Bot ${botUuid} already running — skipping start`);
    return;
  }

  // Acquire distributed lock (prevents two pods running same bot)
  const redis = getRedis();
  if (redis) {
    const lockKey = `bot:lock:${botUuid}`;
    const acquired = await redis.set(lockKey, process.pid, "EX", 120, "NX");
    if (!acquired) {
      log.info(`Bot ${botUuid} already claimed by another pod`);
      return;
    }
  }

  const controller = new AbortController();
  const state: BotLoopState = {
    botId:    botUuid,
    botDbId,
    orgId,
    status:   "connecting",
    startedAt: new Date(),
    abortController: controller,
    errorCount: 0,
    messageCount: 0,
    lastHeartbeat: new Date(),
  };

  activeLoops.set(botUuid, state);

  // Update DB status
  await updateBotStatus(botDbId, botUuid, "connecting", null);

  // Run the bot loop in the background
  runBotLoop(state, apiKey, roomId).catch((err) => {
    log.error({ err }, `Bot loop crashed: ${botUuid}`);
    void handleBotCrash(state, err instanceof Error ? err.message : "Unknown crash");
  });
}

// ─── Bot Loop ─────────────────────────────────────────────────────────────────

// ─── Personality Loading ──────────────────────────────────────────────────────

async function loadPersonality(botDbId: number, botUuid: string): Promise<PersonalityDNA> {
  const [profile] = await db
    .select()
    .from(schema.botPersonalityProfiles)
    .where(and(eq(schema.botPersonalityProfiles.botId, botDbId), eq(schema.botPersonalityProfiles.isActive, true)))
    .limit(1);

  if (!profile) {
    const def = createDefaultPersonalityProfile(botUuid);
    return { ...def, id: `default-${botUuid}`, createdAt: new Date().toISOString() };
  }

  return {
    id: String(profile.id),
    botId: botUuid,
    version: profile.version,
    traits: {
      openness: profile.openness,
      conscientiousness: profile.conscientiousness,
      extraversion: profile.extraversion,
      agreeableness: profile.agreeableness,
      neuroticism: profile.neuroticism,
      humor: profile.humor,
      empathy: profile.empathy,
      assertiveness: profile.assertiveness,
      creativity: profile.creativity,
    },
    voice: {
      tone: profile.tone as PersonalityDNA["voice"]["tone"],
      pace: "normal",
      verbosity: profile.verbosity as PersonalityDNA["voice"]["verbosity"],
      useEmoji: profile.useEmoji,
      signaturePhrase: profile.signaturePhrase,
    },
    behaviorRules: (profile.behaviorRules as PersonalityDNA["behaviorRules"]) ?? [],
    evolvedState: (profile.evolvedState as Record<string, unknown>) ?? {},
    createdAt: profile.createdAt.toISOString(),
  };
}

// ─── Connection Status Mapping ────────────────────────────────────────────────

function mapConnectionStatus(status: HighriseConnectionStatus): BotStatus {
  switch (status) {
    case "online":       return "online";
    case "connecting":
    case "reconnecting": return "connecting";
    case "error":        return "error";
    case "stopped":      return "offline";
  }
}

function describeEvent(event: HighriseEvent): string {
  switch (event._type) {
    case "ChatEvent":        return `${event.user.username}: ${event.message}`;
    case "UserJoinedEvent":  return `${event.user.username} joined the room`;
    case "UserLeftEvent":    return `${event.user.username} left the room`;
    case "EmoteEvent":       return `${event.user.username} used emote ${event.emote_id}`;
    case "ReactionEvent":    return `${event.user.username} reacted ${event.reaction} to ${event.receiver.username}`;
    case "TipReactionEvent": return `${event.sender.username} tipped ${event.receiver.username}`;
    case "UserMovedEvent":   return `${event.user.username} moved`;
    default:                 return event._type;
  }
}

// ─── Bot Loop ─────────────────────────────────────────────────────────────────

async function runBotLoop(
  state:  BotLoopState,
  apiKey: string,
  roomId: string,
): Promise<void> {
  const { signal } = state.abortController;

  log.info(`Bot loop started: ${state.botId}`);

  const personality  = await loadPersonality(state.botDbId, state.botId);
  const systemPrompt = buildPersonalityPrompt(personality);
  const aiProvider   = resolveAIProvider();
  const tracker      = new ModerationTracker();

  if (aiProvider) {
    log.info(`Bot ${state.botId} — AI replies via ${aiProvider.name} (${aiProvider.model})`);
  } else {
    log.info(`Bot ${state.botId} — no AI provider configured; using ReactiveEngine templates only`);
  }

  const client = new HighriseClient({ apiKey, roomId });
  state.client = client;

  // The bot's own Highrise username (from the room's user list on connect),
  // so it answers when people talk to it — not to every message in the room.
  let botUsername: string | undefined;
  // Last few public lines, so AI replies follow the conversation.
  const recentChat: string[] = [];
  const lastReplyTo = new Map<string, number>();
  let lastReplyAt = 0;

  client.on("status", (status: HighriseConnectionStatus, detail?: string) => {
    state.status = mapConnectionStatus(status);
    void updateBotStatus(state.botDbId, state.botId, state.status, status === "error" ? (detail ?? "Connection error") : null);
  });

  client.on("session", (meta) => {
    recordActivity(state, "start");
    log.info(`Bot ${state.botId} connected to room ${roomId} (connection ${meta.connection_id})`);
    broadcastBotEvent(state.botId, {
      type: "bot_log", botId: state.botId, level: "info", source: "highrise",
      message: `Connected to "${meta.room_info.room_name}" as ${meta.user_id}`, ts: Date.now(),
    });
    void client.getRoomUsers().then((res) => {
      const content = (res as unknown as { content?: [{ id: string; username: string }, unknown][] }).content ?? [];
      botUsername = content.find(([u]) => u.id === meta.user_id)?.[0].username;
      if (botUsername) log.info(`Bot ${state.botId} is "${botUsername}" in the room`);
    }).catch(() => undefined);
    // Load Delegation-deployed scripts when the bot comes online
    loadBotScripts(state.botId).catch((err) =>
      log.warn({ err }, `Script load on connect failed for ${state.botId}`)
    );
  });

  client.on("error", (err: { message?: string; do_not_reconnect?: boolean } | Error) => {
    state.errorCount += 1;
    const message = err instanceof Error ? err.message : err.message ?? "Unknown Highrise error";
    if (!(err instanceof Error) && err.do_not_reconnect) state.fatalError = message;
    log.warn(`Bot ${state.botId} Highrise error: ${message}`);
    broadcastBotEvent(state.botId, {
      type: "bot_log", botId: state.botId, level: "error", source: "highrise", message, ts: Date.now(),
    });
  });

  client.on("event", (event: HighriseEvent) => {
    state.messageCount += 1;
    if (event._type === "ChatEvent" && event.user.id !== client.sessionMetadata?.user_id) recordActivity(state, event.whisper ? "whisper" : "chat", event.user);
    else if (event._type === "UserJoinedEvent") recordActivity(state, "join", event.user);
    else if (event._type === "UserLeftEvent") recordActivity(state, "leave", event.user);
    else if (event._type === "TipReactionEvent") recordActivity(state, "tip", event.sender);
    else if (event._type === "EmoteEvent") recordActivity(state, "emote", event.user);

    broadcastBotEvent(state.botId, {
      type: "bot_log", botId: state.botId, level: "info", source: "highrise",
      message: describeEvent(event), ts: Date.now(),
    });

    const botUserId = client.sessionMetadata?.user_id ?? "";
    const actions = evaluateEvent(event, { botUserId, botUuid: state.botId, personality, ...(botUsername ? { botUsername } : {}) }, tracker);
    if (event._type === "ChatEvent" && !event.whisper && event.user.id !== botUserId) {
      recentChat.push(`${event.user.username}: ${event.message.slice(0, 200)}`);
      if (recentChat.length > 8) recentChat.shift();
    }

    let repliedViaTemplate = false;
    for (const action of actions) {
      try {
        switch (action.kind) {
          case "chat":
            client.sendChat(action.request.message, action.request.whisper_target_id);
            recordActivity(state, "reply");
            repliedViaTemplate = true;
            break;
          case "emote":
            client.sendEmote(action.request.emote_id, action.request.target_user_id);
            break;
          case "reaction":
            client.sendReaction(action.request.reaction, action.request.target_user_id);
            break;
          case "moderate":
            void client.moderateRoom(action.request.user_id, action.request.moderation_action, action.request.action_length ?? undefined)
              .catch((err) => log.warn({ err }, `Bot ${state.botId} moderation action failed`));
            broadcastBotEvent(state.botId, {
              type: "bot_log", botId: state.botId, level: "warn", source: "moderation",
              message: `${action.request.moderation_action} ${action.request.user_id} — ${action.reason}`, ts: Date.now(),
            });
            break;
          case "teleport":
            // Requires Designer rights in the room — if the bot doesn't have
            // them, Highrise rejects the request server-side; that surfaces
            // here as a caught error, same as any other failed action. No
            // local permission pre-check pretends to know something only
            // the live room actually knows.
            void client.teleport(action.request.user_id, action.request.destination)
              .catch((err) => log.warn({ err }, `Bot ${state.botId} teleport failed (may lack Designer rights)`));
            break;
          case "get_room_users":
            void client.getRoomUsers()
              .catch((err) => log.warn({ err }, `Bot ${state.botId} get_room_users failed`));
            break;
          case "get_wallet":
            void client.getWallet()
              .catch((err) => log.warn({ err }, `Bot ${state.botId} get_wallet failed`));
            break;
          case "set_outfit":
            void client.setOutfit(action.request.outfit)
              .catch((err) => log.warn({ err }, `Bot ${state.botId} set_outfit failed (item not owned?)`));
            break;
        }
      } catch (err) {
        state.errorCount += 1;
        log.warn({ err }, `Bot ${state.botId} failed to perform reactive action`);
      }
    }

    // AI-generated reply augments the chat fallback when configured and the
    // deterministic layer didn't already respond (moderation/template).
    // Only when talked to — a whisper, or the bot's name in public chat — and
    // not more than once every 6s per person / 2s overall (Highrise rate
    // limits, and AI cost).
    const now = Date.now();
    const addressed = event._type === "ChatEvent" && (event.whisper || isAddressed(event.message, botUsername));
    if (event._type === "ChatEvent" && addressed && !repliedViaTemplate && event.user.id !== botUserId && aiProvider
      && now - (lastReplyTo.get(event.user.id) ?? 0) > 6_000 && now - lastReplyAt > 2_000) {
      lastReplyTo.set(event.user.id, now);
      lastReplyAt = now;
      const whisperTo = event.whisper ? event.user.id : null;
      const context = !event.whisper && recentChat.length > 1
        ? `Recent room chat:\n${recentChat.slice(0, -1).join("\n")}\n\n` : "";
      void generateChatReply(aiProvider, [
        { role: "system", content: `${systemPrompt}\n\nYou are ${botUsername ?? "the bot"} in a Highrise room. Reply in one or two short sentences (under 200 characters), no markdown.` },
        { role: "user", content: `${context}${event.whisper ? "(whisper) " : ""}${event.user.username}: ${event.message}` },
      ], { maxTokens: 120 }).then(async (rawReply) => {
        if (!rawReply || !client.connected) return;
        const reply = rawReply.replace(/\s+/g, " ").trim().slice(0, 250);

        // SECURITY FIX (H-20): a complete, correctly-working toxicity
        // moderation pipeline (packages/security's scanToxicityFast/Deep)
        // existed but nothing in the live bot event loop ever called it for
        // either direction of traffic — the deterministic template path a
        // few lines above uses `tracker` for its own, unrelated purpose
        // (rate-limiting repeated actions), not content moderation. An
        // AI-generated reply was sent live with zero server-side safety
        // check. Fast-scan is synchronous and cheap (regex only, no I/O) so
        // it costs nothing to run on every reply; only genuinely borderline
        // ("warn") results escalate to the slower AI-based deep scan,
        // keeping the common "allow" case just as fast as before.
        const fastResult = scanToxicityFast(reply);

        let finalResult = fastResult;
        if (fastResult.action === "warn") {
          finalResult = await scanToxicityDeep(reply);
        }

        if (finalResult.action === "block" || finalResult.isToxic) {
          log.warn({ botId: state.botId, categories: finalResult.categories, score: finalResult.score }, "AI-generated reply blocked by moderation pipeline");
          await emitSecurityEvent(db, {
            orgId:    state.orgId,
            severity: "medium",
            category: "toxicity",
            actorId:  null,
            ip:       "unknown",
            payload:  { source: "ai_reply", botId: state.botId, content: reply.slice(0, 100), categories: finalResult.categories, score: finalResult.score },
          });
          broadcastBotEvent(state.botId, {
            type: "bot_log", botId: state.botId, level: "warn", source: "moderation",
            message: `AI reply blocked by moderation (${finalResult.categories.join(", ") || "flagged"})`, ts: Date.now(),
          });
          return;
        }

        client.sendChat(reply, whisperTo);
        recordActivity(state, "reply");
      }).catch((err) => log.warn({ err }, `Bot ${state.botId} AI reply failed`));
    }
  });

  signal.addEventListener("abort", () => client.stop(), { once: true });

  try {
    await client.connect();

    // Heartbeat / health-broadcast loop — runs for the lifetime of the bot.
    while (!signal.aborted) {
      state.lastHeartbeat = new Date();

      if (getRedis()) {
        await getRedis()!.set(`bot:lock:${state.botId}`, process.pid, "EX", 120)
          .catch(() => null); // Refresh lock
      }

      await db.update(schema.bots)
        .set({ lastHeartbeat: new Date() })
        .where(eq(schema.bots.id, state.botDbId));

      broadcastBotEvent(state.botId, {
        type: "bot_health",
        botId: state.botId,
        score: calculateHealthScore(state),
        metrics: {
          responseLatencyMs: 0,
          memoryUsageMb:     process.memoryUsage().heapUsed / 1024 / 1024,
          errorRate:         state.errorCount / Math.max(state.messageCount, 1),
          uptimeSeconds:     Math.floor((Date.now() - state.startedAt.getTime()) / 1000),
        },
        ts: Date.now(),
      });

      await sleep(30_000, signal);
    }
  } catch (err) {
    if ((err as any)?.name === "AbortError") {
      log.info(`Bot ${state.botId} stopped cleanly`);
    } else if (signal.aborted) {
      log.info(`Bot ${state.botId} stopped cleanly during connect`);
    } else {
      throw err;
    }
  } finally {
    client.stop();
    await updateBotStatus(state.botDbId, state.botId, "offline", null);
    activeLoops.delete(state.botId);
    if (getRedis()) await getRedis()!.del(`bot:lock:${state.botId}`).catch(() => null);
  }
}

// ─── Stop Bot ─────────────────────────────────────────────────────────────────

export async function stopBotLoop(botUuid: string): Promise<void> {
  const state = activeLoops.get(botUuid);
  if (!state) {
    log.warn(`Stop requested for non-running bot: ${botUuid}`);
    return;
  }
  state.abortController.abort();
  clearScriptPlugins(botUuid);
  disposeLiveScriptIsolates(botUuid);
  log.info(`Stop signal sent to bot: ${botUuid}`);
}

export async function restartBotLoop(botUuid: string): Promise<void> {
  const state = activeLoops.get(botUuid);
  if (state) await stopBotLoop(botUuid);
  await sleep(2000);

  const [bot] = await db.select().from(schema.bots).where(eq(schema.bots.uuid, botUuid)).limit(1);
  if (!bot) { log.error(`Cannot restart — bot not found: ${botUuid}`); return; }

  // BUG-3 FIX: decrypt before passing — same as initBotRuntimeManager
  let plainKey: string;
  try {
    plainKey = decryptApiKey(bot.highriseApiKey);
  } catch (err) {
    log.error({ err }, `Cannot restart bot ${botUuid} — API key decryption failed`);
    await db.update(schema.bots)
      .set({ status: "error", connectionError: "API key decryption failed — re-save the key." })
      .where(eq(schema.bots.id, bot.id));
    return;
  }

  await startBotLoop(bot.uuid, bot.id, bot.orgId, plainKey, bot.activeRoomId ?? "");
}

// ─── Health Monitoring ────────────────────────────────────────────────────────

async function monitorHeartbeats(): Promise<void> {
  const stale = Date.now() - 90_000; // 90s threshold
  for (const [uuid, state] of activeLoops) {
    if (state.lastHeartbeat.getTime() < stale) {
      log.warn(`Bot ${uuid} heartbeat stale — force-restarting`);
      await handleBotCrash(state, "Heartbeat timeout");
    }
  }
}

// Crashes per bot over the last 30 minutes. Kept outside BotLoopState, which
// is recreated on every restart — counting there meant the limit was never hit
// and a broken bot was restarted forever.
const recentCrashes = new Map<string, number[]>();
const CRASH_WINDOW_MS = 30 * 60_000;
const MAX_CRASHES = 5;

async function handleBotCrash(state: BotLoopState, reason: string): Promise<void> {
  recordActivity(state, "crash");
  // Make sure the old connection is really gone before a restart opens another.
  state.abortController.abort();
  state.client?.stop();
  activeLoops.delete(state.botId);
  await updateBotStatus(state.botDbId, state.botId, "error", reason);

  if (getRedis()) await getRedis()!.del(`bot:lock:${state.botId}`).catch(() => null);

  broadcastBotEvent(state.botId, {
    type: "bot_log", botId: state.botId, level: "error", source: "manager",
    message: `Bot crashed: ${reason}`, ts: Date.now(),
  });

  // Restarting can't fix a token Highrise rejected; it would just knock again
  // every 30s. The owner fixes the token (bot Settings) and starts it.
  if (state.fatalError) {
    log.warn(`Bot ${state.botId} refused by Highrise (${state.fatalError}) — not restarting`);
    await updateBotStatus(state.botDbId, state.botId, "error", `${state.fatalError} — update the token or room in Settings, then start the bot.`);
    await notifyBotOwner(state, "bot_error", "Highrise refused the bot", `${state.fatalError}. Update the token or room in the bot's Settings, then start it again.`);
    return;
  }

  const now = Date.now();
  const crashes = (recentCrashes.get(state.botId) ?? []).filter((t) => now - t < CRASH_WINDOW_MS);
  crashes.push(now);
  recentCrashes.set(state.botId, crashes);

  // Auto-restart after 30s, unless it crashed 5 times in 30 minutes.
  if (crashes.length < MAX_CRASHES) {
    setTimeout(() => void restartBotLoop(state.botId), 30_000);
  } else {
    recentCrashes.delete(state.botId);
    log.error(`Bot ${state.botId} crashed ${MAX_CRASHES} times in 30 minutes — giving up`);
    await notifyBotOwner(state, "bot_offline", "stopped after repeated crashes", `It crashed ${MAX_CRASHES} times in 30 minutes (last: ${reason}). Check its logs, then start it again.`);
    await db.update(schema.bots).set({ status: "suspended" }).where(eq(schema.bots.id, state.botDbId));
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

async function updateBotStatus(dbId: number, uuid: string, status: BotStatus, error: string | null): Promise<void> {
  await db.update(schema.bots).set({ status, connectionError: error, lastSeen: new Date() }).where(eq(schema.bots.id, dbId));
  broadcastBotEvent(uuid, { type: "bot_status", botId: uuid, status, error, ts: Date.now() });
}

function calculateHealthScore(state: BotLoopState): 0 | 1 | 2 | 3 | 4 | 5 {
  const errorRate = state.errorCount / Math.max(state.messageCount, 1);
  const uptimeMins = (Date.now() - state.startedAt.getTime()) / 60_000;

  if (state.status !== "online") return 0;
  if (errorRate > 0.3) return 1;
  if (errorRate > 0.1) return 2;
  if (uptimeMins < 5)  return 3;
  if (errorRate > 0.02) return 4;
  return 5;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
  });
}

export function getRuntimeStats() {
  return { activeBots: activeLoops.size, bots: [...activeLoops.values()].map((s) => ({ id: s.botId, status: s.status, uptime: Date.now() - s.startedAt.getTime(), errors: s.errorCount })) };
}

// ─── Script Loading ───────────────────────────────────────────────────────────
//
// Loads all active bot_scripts rows for a bot and registers them as
// ScriptPlugin functions in the ReactiveEngine plugin registry.
// Called on bot start and when the Delegation agent deploys a new script.

async function loadBotScripts(botUuid: string): Promise<void> {
  const [bot] = await db.select({ id: schema.bots.id }).from(schema.bots).where(eq(schema.bots.uuid, botUuid)).limit(1);
  if (!bot) return;

  const scripts = await db
    .select({ uuid: schema.botScripts.uuid, code: schema.botScripts.code, name: schema.botScripts.name })
    .from(schema.botScripts)
    .where(and(eq(schema.botScripts.botId, bot.id), eq(schema.botScripts.isActive, true)));

  // Clear any previously registered plugins AND dispose their isolates —
  // otherwise every reload/reconnect leaks another 64MB isolate (SECURITY
  // FIX C-02 also fixes what would have been a real memory leak once
  // isolates replaced the old same-process vm contexts).
  clearScriptPlugins(botUuid);
  disposeLiveScriptIsolates(botUuid);

  if (scripts.length === 0) return;

  const isolatesForBot: ivm.Isolate[] = [];

  for (const script of scripts) {
    let isolate: ivm.Isolate | undefined;
    try {
      // SECURITY FIX (C-02): real V8 isolate instead of vm.runInNewContext.
      // Nothing from the host realm (no Math/Array/Object/etc by reference)
      // is exposed to the isolate — it gets its own native built-ins, so
      // there is no host-realm object for a script to pivot through to
      // reach the real `process`. userState/scriptState live INSIDE the
      // isolate (declared once, mutated in place across calls) so plugin
      // state persists between events exactly like the old closure-based
      // Map did, without needing to round-trip it across the isolate
      // boundary on every single event.
      isolate = new ivm.Isolate({ memoryLimit: LIVE_SCRIPT_MEMORY_LIMIT_MB });
      const context = isolate.createContextSync();

      const wrappedCode = `
${stripEsmExport(script.code)}
const __fn__ = (typeof exports !== "undefined" && exports.default)
  ? exports.default
  : (typeof handler !== "undefined" ? handler : null);
const __userState__ = new Map();
const __scriptState__ = {};
function __invoke__(eventJson, botUserId) {
  if (typeof __fn__ !== "function") return JSON.stringify({ __noHandler__: true });
  const event = JSON.parse(eventJson);
  const result = __fn__(event, {
    botUserId,
    userState: __userState__,
    scriptState: __scriptState__,
    emotes: null, // Runtime emote data not yet wired (needs SQLite reader in API)
  });
  return JSON.stringify(Array.isArray(result) ? result : []);
}
`;
      const compiled = isolate.compileScriptSync(wrappedCode);
      compiled.runSync(context);

      const invokeRef = context.global.getSync("__invoke__", { reference: true });

      // One quick call to confirm the script actually exported a handler,
      // matching the old "typeof fn === 'function'" gate — before we
      // register it as a live plugin.
      const probe = JSON.parse(
        invokeRef.applySync(undefined, [JSON.stringify({ _type: "_probe" }), "bot-0000"], {
          timeout: LIVE_SCRIPT_TIMEOUT_MS,
        }) as string,
      );

      if (probe && probe.__noHandler__) {
        log.warn(`Script "${script.name}" did not export a handler function — skipped`);
        isolate.dispose();
        continue;
      }

      const plugin: ScriptPlugin = (event, ctx) => {
        try {
          const raw = invokeRef.applySync(
            undefined,
            [JSON.stringify(event), ctx.botUserId],
            { timeout: LIVE_SCRIPT_TIMEOUT_MS },
          ) as string;
          const result = JSON.parse(raw);
          return Array.isArray(result) ? result : [];
        } catch (err) {
          log.warn({ err }, `Script "${script.name}" (${script.uuid}) runtime error for bot ${botUuid}`);
          return [];
        }
      };

      registerScriptPlugin(botUuid, script.uuid, plugin);
      isolatesForBot.push(isolate);
      log.info(`Script plugin loaded: "${script.name}" (${script.uuid}) for bot ${botUuid} [isolated-vm]`);
    } catch (err) {
      log.error({ err }, `Failed to compile script "${script.name}" for bot ${botUuid}`);
      isolate?.dispose();
    }
  }

  liveScriptIsolates.set(botUuid, isolatesForBot);
  log.info(`${isolatesForBot.length}/${scripts.length} script plugin(s) loaded for bot ${botUuid}`);
}
