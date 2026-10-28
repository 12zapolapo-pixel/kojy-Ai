/**
 * Delegation Agent — Coder
 * OWNERSHIP: packages/engine/src/delegation
 *
 * The second stage of the Delegation agent pipeline. Takes the structured
 * TaskPlan from AgentPlanner and generates a TypeScript module implementing
 * the feature.
 *
 * OUTPUT FORMAT:
 * The generated code must export a default function conforming to BotScriptFn:
 *
 *   export default function handler(event, ctx): ReactiveAction[] { ... }
 *
 * This plugs directly into the ReactiveEngine's pluggable script evaluator.
 * The sandbox executor runs this code in an isolated VM context, passes in
 * a mock event and ctx, and verifies the output matches the test cases.
 *
 * ARCHITECTURE NOTE — "Python" vs TypeScript:
 * The database schema uses the term "Python source code" in its comment, but
 * the actual execution environment is the Node.js bot runtime (TypeScript).
 * The agent generates TypeScript/JavaScript that follows the ReactiveEngine
 * contract. This allows zero-overhead integration with the existing runtime:
 * no IPC, no language boundary, no Docker Python process required.
 *
 * If the product owner decides to switch to a Python sandbox, the BotScriptFn
 * interface becomes a Python abstract class instead, and the sandbox executor
 * (SandboxExecutor.ts) is swapped for a Docker Python process. The AgentCoder
 * prompt template changes accordingly. Everything else in this pipeline stays
 * identical.
 *
 * @see SandboxExecutor.ts for the isolation layer
 * @see ../runtime/ReactiveEngine.ts for the action type definitions
 */

import { generateChatReply, type AIProviderConfig, type ChatMessage } from "../runtime/AIProvider.js";
import type { TaskPlan } from "./AgentPlanner.js";

// ─── BotScript Contract ───────────────────────────────────────────────────────

/**
 * Every generated script must export a default function matching this
 * signature. The sandbox executor calls this for every event and collects
 * the returned actions to perform.
 *
 * ctx provides a safe read-only view of state the script might need
 * (bot user ID, a simple per-user counter store, the emote catalog if
 * requested). No network calls or timers allowed inside the script.
 */
export interface BotScriptContext {
  /** The bot's own Highrise user_id. Scripts must skip events from self. */
  botUserId: string;
  /** In-memory per-user state (resets when bot restarts). Max 1000 keys. */
  userState: Map<string, Record<string, unknown>>;
  /** Global script state (resets when bot restarts). */
  scriptState: Record<string, unknown>;
  /** Emote catalog — null if not requested in the plan or unavailable. */
  emotes: Array<{
    commandNum: number;   // 1–200
    emoteId:    string;
    name:       string;
    rarity:     "common" | "rare" | "epic";
  }> | null;
}

// ─── Coder ───────────────────────────────────────────────────────────────────

function buildCoderSystemPrompt(plan: TaskPlan): string {
  return `You are the Delegation Agent Coder for KojyAI. You generate TypeScript code
that runs inside a Highrise virtual world bot.

Your output is a complete, runnable TypeScript module. It must:
1. Export a default function: export default function handler(event: any, ctx: any): any[]
2. Return an array of zero or more action objects
3. Never throw errors — use try/catch and return [] on failure
4. Never make network calls or set timers
5. Never access process, require, import, eval, or any globals except Math, JSON, Date, String, Number, Array, Map, Set, RegExp

Available action types to return:
- { kind: "chat",    request: { _type: "ChatRequest",     message: string, whisper_target_id?: string | null } }
- { kind: "emote",   request: { _type: "EmoteRequest",    emote_id: string, target_user_id?: string | null } }
- { kind: "reaction",request: { _type: "ReactionRequest", reaction: "clap"|"heart"|"thumbs"|"wave"|"wink", target_user_id: string } }
- { kind: "moderate",request: { _type: "ModerateRoomRequest", user_id: string, moderation_action: "mute"|"kick"|"ban", action_length?: number } }

Context object (ctx):
- ctx.botUserId: string — skip events where event.user?.id === ctx.botUserId
- ctx.userState: Map<userId, record> — per-user mutable state
- ctx.scriptState: Record<string, unknown> — global mutable state
- ctx.emotes: Array<{commandNum, emoteId, name, rarity}> | null

Event shapes (event._type):
- ChatEvent:       event.user{id,username}, event.message, event.whisper
- UserJoinedEvent: event.user{id,username}
- UserLeftEvent:   event.user{id,username}
- EmoteEvent:      event.user{id}, event.emote_id, event.receiver{id}
- ReactionEvent:   event.user{id}, event.reaction, event.receiver{id}
- TipReactionEvent: event.sender{id}, event.receiver{id}

PLAN TO IMPLEMENT:
${JSON.stringify(plan, null, 2)}

RULES:
- Handle ONLY the event types listed in requiredEvents
- Implement ALL implementationSteps
- Watch out for ALL edgeCases
- Keep the code clean, well-commented, and production-ready
- No placeholder comments like "// TODO" or "// implement this"

Respond with ONLY the TypeScript code. No markdown fences. No explanation. Just the code.
The code must begin with: // KojyAI Bot Script: ${plan.scriptName}`;
}

export interface CoderResult {
  code: string;
  /** Estimated test cases derived from the plan (used by sandbox executor) */
  testCases: TaskPlan["testCases"];
}

export async function generateBotScript(
  provider: AIProviderConfig,
  plan: TaskPlan,
  emoteData?: Array<{ commandNum: number; emoteId: string; name: string; rarity: string }> | null,
): Promise<CoderResult | null> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildCoderSystemPrompt(plan) },
  ];

  // If emote catalog is needed, inject the actual data so the model can
  // hardcode the mapping rather than guessing emote IDs.
  if (plan.needsEmoteCatalog && emoteData && emoteData.length > 0) {
    const emoteJson = JSON.stringify(emoteData.slice(0, 200), null, 2);
    messages.push({
      role: "user",
      content: `Emote catalog (first 200 entries):\n${emoteJson}\n\nGenerate the bot script now.`,
    });
  } else {
    messages.push({
      role: "user",
      content: "Generate the bot script now.",
    });
  }

  // Token budget scales with complexity
  const maxTokens = plan.complexity === "complex" ? 3000
    : plan.complexity === "moderate" ? 2000
    : 1000;

  const code = await generateChatReply(provider, messages, {
    maxTokens,
    temperature: 0.2, // Very low: code generation needs precision
    timeoutMs:   45_000,
  });

  if (!code) return null;

  // Strip markdown fences if the model included them despite instructions
  const cleanCode = code
    .replace(/^```(?:typescript|ts|javascript|js)?\n?/m, "")
    .replace(/```\s*$/m, "")
    .trim();

  return { code: cleanCode, testCases: plan.testCases };
}
