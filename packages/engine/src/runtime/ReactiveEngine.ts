/**
 * Reactive Engine — Moderation & Reactivity (always-on, zero-config)
 * OWNERSHIP: packages/engine/src/runtime
 *
 * Bots aren't just chatbots — this engine handles the moment-to-moment
 * "reflexes" every bot needs regardless of whether an AI provider is
 * configured:
 *
 *   - MODERATION: detect spam/scam patterns in chat and mute/kick offenders
 *   - REACTIVITY: react to joins, tips, emotes, and reactions in real time
 *   - CHAT FALLBACK: personality-flavored templated replies when no AI
 *     provider is configured (see AIProvider.ts)
 *
 * This engine is deterministic and fast (no network calls), so it runs on
 * every event regardless of AI provider availability. The AI provider, when
 * configured, only augments the "chat fallback" case with generated replies
 * — moderation and reactivity always run through here for reliability.
 */

import type { PersonalityDNA } from "@kojyai/shared/types";
import type {
  HighriseEvent,
  ChatRequest,
  EmoteRequest,
  ReactionRequest,
  ModerateRoomRequest,
  TeleportRequest,
  GetRoomUsersRequest,
  GetWalletRequest,
  SetOutfitRequest,
} from "./highrise-protocol.js";

// ─── Script Plugin Registry ────────────────────────────────────────────────────
//
// Deployed bot scripts (from bot_scripts table, written by the Delegation agent)
// register here via loadScriptPlugin(). Each plugin is a function that receives
// the same event + ctx as evaluateEvent() and returns additional ReactiveActions.
//
// The runtime-manager.ts loads scripts on bot startup and when the Delegation
// agent publishes a `reload_scripts` command via `bot_control:{botUuid}`.
//
// Security note (SECURITY FIX C-06 — this comment previously claimed the vm
// sandbox "ensures scripts never access process/network", which was false:
// see C-02/C-05 fix notes for the confirmed live escape that claim ignored.
// As of the C-02/C-05 fixes, script plugins registered here are backed by
// real isolated-vm V8 isolates (runtime-manager.ts's loadBotScripts), so the
// plugin(event, ctx) call below IS now running inside real isolation — but
// that property comes from the isolate the plugin closure was built from,
// not from anything at this call site itself. If this file's invocation
// path ever changes (e.g. a plugin source that isn't isolate-backed), this
// comment needs re-verifying against whatever actually executes the code,
// not re-assumed safe by default.

export type ScriptPlugin = (event: HighriseEvent, ctx: ReactiveContext) => ReactiveAction[];

const scriptPluginRegistry = new Map<string, Map<string, ScriptPlugin>>();

/**
 * Register a deployed script for a specific bot.
 * scriptId is the bot_scripts.uuid — used for deregistration when a new
 * version deploys or the user deletes the script.
 */
export function registerScriptPlugin(botUuid: string, scriptId: string, fn: ScriptPlugin): void {
  if (!scriptPluginRegistry.has(botUuid)) {
    scriptPluginRegistry.set(botUuid, new Map());
  }
  scriptPluginRegistry.get(botUuid)!.set(scriptId, fn);
}

/** Remove a specific script (called on delete or version replacement). */
export function unregisterScriptPlugin(botUuid: string, scriptId: string): void {
  scriptPluginRegistry.get(botUuid)?.delete(scriptId);
}

/** Remove ALL scripts for a bot (called when bot stops). */
export function clearScriptPlugins(botUuid: string): void {
  scriptPluginRegistry.delete(botUuid);
}

/** Get all registered plugin UUIDs for a bot (for diagnostics). */
export function getScriptPluginIds(botUuid: string): string[] {
  return Array.from(scriptPluginRegistry.get(botUuid)?.keys() ?? []);
}

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface ReactiveContext {
  /** The bot's own Highrise user id — never react to or moderate ourselves. */
  botUserId: string;
  /** KojyAI's id for the bot — the key its scripts are registered under. */
  botUuid?: string;
  /** The bot's Highrise username, so it can tell when it's being talked to. */
  botUsername?: string;
  personality: PersonalityDNA;
  /**
   * Additional scam/spam phrases configured for this org/bot, merged with
   * DEFAULT_MODERATION_PHRASES. Case-insensitive substring match.
   */
  extraModerationPhrases?: string[];
}

export type ReactiveAction =
  | { kind: "chat"; request: ChatRequest; reason: string }
  | { kind: "emote"; request: EmoteRequest; reason: string }
  | { kind: "reaction"; request: ReactionRequest; reason: string }
  | { kind: "moderate"; request: ModerateRoomRequest; reason: string }
  /** Requires the bot to hold Designer rights in the room — the real
   *  Highrise server enforces this; a rejection surfaces as a runtime error
   *  on this action, not a local pre-check (no local flag can honestly
   *  represent a permission that's granted server-side, in-app, per room). */
  | { kind: "teleport"; request: TeleportRequest; reason: string }
  | { kind: "get_room_users"; request: GetRoomUsersRequest; reason: string }
  | { kind: "get_wallet"; request: GetWalletRequest; reason: string }
  /** Bot may only equip items it owns or free (rarity:none) items — also
   *  enforced server-side. */
  | { kind: "set_outfit"; request: SetOutfitRequest; reason: string };

// ─── Moderation ───────────────────────────────────────────────────────────────

/**
 * Common scam/spam patterns seen in virtual-world room chats (fake gold
 * giveaways, off-platform "free items" links, phishing). Orgs can extend
 * this via `extraModerationPhrases` — e.g. wired from `behaviorRules` with
 * trigger="moderation_phrase".
 */
export const DEFAULT_MODERATION_PHRASES: readonly string[] = [
  "free gold",
  "free diamonds",
  "click here to claim",
  "dm me for free",
  "highrise-gift",
  "giveaway link",
  "verify your account at",
];

const SHOUTING_MIN_LENGTH = 12;

export interface ModerationVerdict {
  flagged: boolean;
  reason?: string;
  severity?: "warn" | "mute" | "kick";
}

/**
 * Evaluates a chat message against deterministic moderation rules.
 * This is intentionally simple (substring/pattern matching) — it's the fast,
 * always-on first line of defense. A future AI-based "toxicity scan" job
 * (see Skill #9 in the worker) can layer on top for nuanced cases.
 */
export function moderateMessage(message: string, extraPhrases: string[] = []): ModerationVerdict {
  const lower = message.toLowerCase();

  for (const phrase of [...DEFAULT_MODERATION_PHRASES, ...extraPhrases]) {
    if (lower.includes(phrase.toLowerCase())) {
      return { flagged: true, reason: `scam/spam phrase: "${phrase}"`, severity: "mute" };
    }
  }

  // Repeated-character spam, e.g. "AAAAAAAAAAAAAAAA" or "!!!!!!!!!!!!!!!"
  if (/(.)\1{5,}/.test(message)) {
    return { flagged: true, reason: "repeated-character spam", severity: "warn" };
  }

  // Sustained shouting — long all-caps message
  const letters = message.replace(/[^a-zA-Z]/g, "");
  if (letters.length >= SHOUTING_MIN_LENGTH && letters === letters.toUpperCase()) {
    return { flagged: true, reason: "all-caps shouting", severity: "warn" };
  }

  return { flagged: false };
}

// ─── Spam Tracking (per-user rate limiting) ────────────────────────────────────

interface UserActivity {
  recentMessageTimestamps: number[];
  warnings: number;
}

const FLOOD_WINDOW_MS = 10_000;
const FLOOD_MAX_MESSAGES = 6;

/**
 * Tracks per-user message timestamps to detect chat flooding. Stateful by
 * design — one instance should be kept alive per bot connection for the
 * lifetime of the room session.
 */
export class ModerationTracker {
  private readonly activity = new Map<string, UserActivity>();

  /** Records a message and returns true if this user is now flooding. */
  recordAndCheckFlood(userId: string): boolean {
    const now = Date.now();
    const entry = this.activity.get(userId) ?? { recentMessageTimestamps: [], warnings: 0 };
    entry.recentMessageTimestamps = entry.recentMessageTimestamps.filter((t) => now - t < FLOOD_WINDOW_MS);
    entry.recentMessageTimestamps.push(now);
    this.activity.set(userId, entry);
    return entry.recentMessageTimestamps.length > FLOOD_MAX_MESSAGES;
  }

  recordWarning(userId: string): number {
    const entry = this.activity.get(userId) ?? { recentMessageTimestamps: [], warnings: 0 };
    entry.warnings += 1;
    this.activity.set(userId, entry);
    return entry.warnings;
  }

  reset(userId: string): void {
    this.activity.delete(userId);
  }
}

// ─── Chat Templates (personality-flavored, zero-config fallback) ──────────────

const GREETING_PATTERNS = /\b(hi|hello|hey|sup|yo|howdy)\b/i;
const QUESTION_PATTERNS = /\?\s*$/;
const FAREWELL_PATTERNS = /\b(bye|goodbye|see ya|gotta go|cya)\b/i;

function pick<T>(items: readonly T[], seed: number): T {
  return items[Math.abs(seed) % items.length]!;
}

function applyVoice(text: string, personality: PersonalityDNA): string {
  const { voice, traits } = personality;
  let out = text;

  if (voice.useEmoji && traits.extraversion > 0.5) {
    const emojis = ["✨", "😄", "🙌", "💬", "👋"];
    out = `${out} ${pick(emojis, Math.floor(traits.extraversion * 100))}`;
  }

  if (voice.signaturePhrase && traits.extraversion > 0.6) {
    out = `${out} ${voice.signaturePhrase}`;
  }

  if (voice.verbosity === "terse") {
    out = out.split(/[.!]/)[0]!.trim() || out;
  }

  return out;
}

/**
 * Builds a personality-flavored templated reply for an incoming chat
 * message, used when no AI provider is configured (or as an instant
 * fast-path while a slower AI reply is still being generated).
 *
 * Returns `null` if the message doesn't warrant a reply (e.g. doesn't
 * mention the bot and isn't a greeting/question) — bots shouldn't respond
 * to every message in a busy room.
 */
/** True when a public message is aimed at the bot: "@name …" or its name as a word. */
export function isAddressed(message: string, botUsername: string | undefined): boolean {
  if (!botUsername) return false;
  const name = botUsername.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w])@?${name}([^\\w]|$)`, "i").test(message);
}

export function buildTemplateReply(
  message: string,
  ctx: { botUsername?: string; personality: PersonalityDNA; whisper?: boolean },
): string | null {
  const { personality, botUsername } = ctx;
  const { traits, voice } = personality;
  // A whisper is always to the bot.
  const mentionsBot = ctx.whisper === true || isAddressed(message, botUsername);
  const seed = message.length + Math.floor(traits.humor * 100);

  if (GREETING_PATTERNS.test(message)) {
    const greetings = traits.extraversion > 0.6
      ? ["Hey hey!", "Hiii!", "Heyyy, what's up!"]
      : ["Hi there.", "Hello.", "Hey."];
    return applyVoice(pick(greetings, seed), personality);
  }

  if (FAREWELL_PATTERNS.test(message) && mentionsBot) {
    const farewells = ["See you around!", "Take care!", "Catch you later!"];
    return applyVoice(pick(farewells, seed), personality);
  }

  if (mentionsBot && QUESTION_PATTERNS.test(message)) {
    const deflections = traits.humor > 0.6
      ? ["Ha, good question — still thinking on that one!", "Ooh, you're putting me on the spot"]
      : ["That's a good question — let me think about it.", "I'm not sure yet, but I'll keep that in mind."];
    return applyVoice(pick(deflections, seed), personality);
  }

  if (mentionsBot) {
    const acks = traits.agreeableness > 0.6
      ? ["Thanks for the shoutout!", "Aww, hi!", "You called?"]
      : ["Noted.", "Hm?"];
    return applyVoice(pick(acks, seed), personality);
  }

  return null;
}

// ─── Main Evaluation ────────────────────────────────────────────────────────────

/**
 * Evaluates a single Highrise event and returns zero or more actions to
 * perform. Called for every incoming event — keep this fast and
 * side-effect-free (the caller performs the actual sends).
 *
 * Runs the built-in reactive engine first (moderation, greetings, etc.),
 * then runs any registered script plugins from the Delegation agent's
 * deployed bot_scripts. Plugin actions are appended after built-in actions.
 */
export function evaluateEvent(
  event: HighriseEvent,
  ctx: ReactiveContext,
  tracker: ModerationTracker,
): ReactiveAction[] {
  const actions: ReactiveAction[] = [];
  const { botUserId, personality } = ctx;

  switch (event._type) {
    case "ChatEvent": {
      if (event.user.id === botUserId) return actions;

      // Moderation pass
      const verdict = moderateMessage(event.message, ctx.extraModerationPhrases ?? []);
      if (verdict.flagged) {
        if (verdict.severity === "mute") {
          actions.push({
            kind: "moderate",
            reason: verdict.reason!,
            request: { _type: "ModerateRoomRequest", user_id: event.user.id, moderation_action: "mute", action_length: 300 },
          });
          return actions; // don't also reply to the offending message
        }
        if (verdict.severity === "warn") {
          const warnings = tracker.recordWarning(event.user.id);
          if (warnings >= 3) {
            actions.push({
              kind: "moderate",
              reason: `${verdict.reason} (repeated ${warnings}x)`,
              request: { _type: "ModerateRoomRequest", user_id: event.user.id, moderation_action: "mute", action_length: 120 },
            });
            return actions;
          }
        }
      }

      // Flood detection
      if (!event.whisper && tracker.recordAndCheckFlood(event.user.id)) {
        actions.push({
          kind: "moderate",
          reason: "chat flooding",
          request: { _type: "ModerateRoomRequest", user_id: event.user.id, moderation_action: "mute", action_length: 60 },
        });
        return actions;
      }

      // Chat fallback — only when talked to (a whisper, or the bot's name in
      // public chat); answering every "hi" in a busy room is spam.
      const addressed = event.whisper || isAddressed(event.message, ctx.botUsername);
      const reply = addressed ? buildTemplateReply(event.message, { personality, whisper: event.whisper, ...(ctx.botUsername ? { botUsername: ctx.botUsername } : {}) }) : null;
      if (reply) {
        actions.push({
          kind: "chat",
          reason: "templated reply",
          request: {
            _type: "ChatRequest",
            message: reply,
            whisper_target_id: event.whisper ? event.user.id : null,
          },
        });
      }
      break;
    }

    case "UserJoinedEvent": {
      if (event.user.id === botUserId) break;
      if (personality.traits.extraversion > 0.55) {
        actions.push({
          kind: "reaction",
          reason: "greet new arrival",
          request: { _type: "ReactionRequest", reaction: "wave", target_user_id: event.user.id },
        });
      }
      if (personality.traits.extraversion > 0.75 && personality.traits.agreeableness > 0.5) {
        actions.push({
          kind: "chat",
          reason: "welcome message",
          request: { _type: "ChatRequest", message: applyVoice("Welcome!", personality) },
        });
      }
      break;
    }

    case "TipReactionEvent": {
      if (event.receiver.id !== botUserId) break;
      actions.push({
        kind: "reaction",
        reason: "thank tipper",
        request: { _type: "ReactionRequest", reaction: "heart", target_user_id: event.sender.id },
      });
      actions.push({
        kind: "chat",
        reason: "thank-you message",
        request: { _type: "ChatRequest", message: applyVoice("Thank you so much!", personality), whisper_target_id: event.sender.id },
      });
      break;
    }

    case "EmoteEvent": {
      if (!event.receiver || event.receiver.id !== botUserId) break;
      if (event.user.id === botUserId) break;
      if (personality.traits.extraversion > 0.5) {
        actions.push({
          kind: "emote",
          reason: "return emote",
          request: { _type: "EmoteRequest", emote_id: event.emote_id, target_user_id: event.user.id },
        });
      }
      break;
    }

    case "ReactionEvent": {
      if (event.receiver.id !== botUserId) break;
      if (event.user.id === botUserId) break;
      if (personality.traits.agreeableness > 0.5) {
        const reciprocal: ReactionRequest["reaction"] = event.reaction === "heart" ? "heart" : "wave";
        actions.push({
          kind: "reaction",
          reason: "reciprocate reaction",
          request: { _type: "ReactionRequest", reaction: reciprocal, target_user_id: event.user.id },
        });
      }
      break;
    }

    default:
      break;
  }

  // ─── Script Plugins (Delegation agent deployed behaviors) ─────────────────
  // Run AFTER built-in engine: plugins extend, never override, core safety rules.
  // If a plugin throws, log and continue — a bad script never crashes the bot.
  // Scripts are registered under the bot's KojyAI id (runtime-manager's
  // loadBotScripts); looking them up by the Highrise user id meant deployed
  // scripts never ran.
  const botPlugins = scriptPluginRegistry.get(ctx.botUuid ?? ctx.botUserId);
  if (botPlugins && botPlugins.size > 0) {
    botPlugins.forEach((plugin, scriptId) => {
      try {
        const pluginActions = plugin(event, ctx);
        if (Array.isArray(pluginActions)) {
          actions.push(...pluginActions);
        }
      } catch (err) {
        // Script runtime error — log but don't propagate
        console.warn(`[ReactiveEngine] Script plugin ${scriptId} error:`, err);
      }
    });
  }

  return actions;
}
