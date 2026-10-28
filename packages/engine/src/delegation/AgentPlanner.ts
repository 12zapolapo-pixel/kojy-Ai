/**
 * Delegation Agent — Planner
 * OWNERSHIP: packages/engine/src/delegation
 *
 * The first stage of the Delegation agent pipeline. Takes the user's plain-
 * English feature request plus context (existing scripts, similar past requests
 * from memory, emote catalog if relevant) and produces a structured task plan:
 *
 *   - What data is needed (emote catalog? user list? personality rules?)
 *   - What the behavior code must implement (event handlers, conditions)
 *   - What test cases would prove it works
 *   - What the deploy step needs to do
 *
 * The plan is serialized as JSON and passed to AgentCoder, which uses it to
 * generate the actual implementation.
 *
 * Follows ECC's "skills as discrete workflow units" pattern — AgentPlanner is
 * a focused, documented step with clear inputs and a defined output shape,
 * rather than a monolithic "do everything" prompt.
 */

import { generateChatReply, type AIProviderConfig, type ChatMessage } from "../runtime/AIProvider.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PlannerInput {
  /** The user's feature request in plain English. */
  userRequest: string;
  /** The bot's UUID — used to scope which scripts already exist. */
  botUuid: string;
  /** Name of the bot — helps the planner understand context. */
  botName: string;
  /** The bot's room ID — some behaviors are room-specific. */
  roomId: string;
  /** Existing script names for this bot — prevents naming collisions. */
  existingScripts: string[];
  /** Similar past requests from semantic memory recall. */
  pastContext: string[];
  /** True if the emote catalog is available (affects emote-command features). */
  emoteCatalogAvailable: boolean;
  /** Total emotes available in catalog (for context). */
  emoteCatalogCount: number;
}

export interface TaskPlan {
  /** Human-readable name for this script (stored in bot_scripts.name). */
  scriptName: string;
  /** One-sentence description of what this script does. */
  description: string;
  /**
   * The main event types this script needs to handle.
   * e.g. ["ChatEvent", "UserJoinedEvent"]
   */
  requiredEvents: string[];
  /**
   * Whether this script needs access to the emote catalog
   * (true = AgentCoder injects emote data into its context).
   */
  needsEmoteCatalog: boolean;
  /**
   * Step-by-step implementation guide for AgentCoder — not code, but a
   * precise description of the logic that needs to be implemented.
   */
  implementationSteps: string[];
  /**
   * Test cases that prove the implementation is correct.
   * Each test case is: { description, input, expectedOutput }
   */
  testCases: Array<{
    description: string;
    /** The simulated event or message to test against. */
    input: string;
    /** The expected bot action or behavior. */
    expectedOutput: string;
  }>;
  /**
   * Potential edge cases or things AgentCoder should watch out for.
   */
  edgeCases: string[];
  /**
   * Estimated complexity: "simple" | "moderate" | "complex".
   * Used to set AgentCoder's max token budget.
   */
  complexity: "simple" | "moderate" | "complex";
}

// ─── Planner ─────────────────────────────────────────────────────────────────

const PLANNER_SYSTEM_PROMPT = `You are the Delegation Agent Planner for KojyAI, an AI that helps users
add behaviors to their Highrise virtual world bots.

Your job is to analyze the user's feature request and produce a structured JSON plan
that specifies exactly what needs to be implemented, what events to listen for, and
what test cases will prove it works.

The bot runtime uses these event types:
- ChatEvent: user sends a message (fields: user.id, user.username, message, whisper)
- UserJoinedEvent: user enters the room (fields: user.id, user.username)
- UserLeftEvent: user leaves the room (fields: user.id, user.username)
- EmoteEvent: user performs an emote (fields: user.id, emote_id, receiver.id)
- ReactionEvent: user reacts (fields: user.id, reaction, receiver.id)
- TipReactionEvent: user tips (fields: sender.id, receiver.id, item)

Available bot actions:
- chat(message, whisperTargetId?)  — send a chat message, optionally as whisper
- emote(emoteId, targetUserId?)    — perform an emote
- reaction(reaction, targetUserId) — send a reaction (clap/heart/thumbs/wave/wink)
- moderate(userId, action, seconds?) — mute/kick/ban a user

Respond ONLY with a valid JSON object matching this exact shape (no markdown, no preamble):
{
  "scriptName": "string (short, descriptive, 2-5 words)",
  "description": "string (one sentence)",
  "requiredEvents": ["ChatEvent", ...],
  "needsEmoteCatalog": boolean,
  "implementationSteps": ["step 1...", "step 2...", ...],
  "testCases": [
    { "description": "...", "input": "...", "expectedOutput": "..." },
    ...
  ],
  "edgeCases": ["edge case 1...", ...],
  "complexity": "simple" | "moderate" | "complex"
}`;

export async function planFeatureRequest(
  provider: AIProviderConfig,
  input: PlannerInput,
): Promise<TaskPlan | null> {
  const contextParts: string[] = [
    `Bot: ${input.botName} (${input.botUuid}) in room ${input.roomId}`,
    `Existing scripts: ${input.existingScripts.length > 0 ? input.existingScripts.join(", ") : "none"}`,
    `Emote catalog: ${input.emoteCatalogAvailable ? `${input.emoteCatalogCount} emotes available (rare + epic, numbered 1–${Math.min(input.emoteCatalogCount, 200)})` : "not available"}`,
  ];

  if (input.pastContext.length > 0) {
    contextParts.push(`Similar past requests:\n${input.pastContext.map((c) => `- ${c}`).join("\n")}`);
  }

  const messages: ChatMessage[] = [
    { role: "system", content: PLANNER_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Context:\n${contextParts.join("\n")}\n\nUser request: "${input.userRequest}"`,
    },
  ];

  const raw = await generateChatReply(provider, messages, {
    maxTokens: 1500,
    temperature: 0.3, // Low temperature: planning should be precise, not creative
    timeoutMs:   30_000,
  });

  if (!raw) return null;

  try {
    // Strip any markdown fences if the model wrapped the JSON
    const cleaned = raw.replace(/```(?:json)?\n?/g, "").replace(/```/g, "").trim();
    const plan = JSON.parse(cleaned) as TaskPlan;

    return normalizeTaskPlan(plan);
  } catch {
    return null; // JSON parse failed — AgentReflection will retry with a cleaner prompt
  }
}


// ─── Plan normalization (L-36) ────────────────────────────────────────────────

/** botScripts.name is varchar(300); stay well inside it. */
export const MAX_SCRIPT_NAME_LENGTH = 100;

/**
 * Validates and normalizes a model-generated plan. The model's output is
 * untrusted: `scriptName` is stored in the DB and shown in the UI, and it used to
 * be accepted with no length or character bound, so a runaway/hostile generation
 * could store a multi-kilobyte name or control characters / markup.
 * Returns null (-> the caller retries with a cleaner prompt) if the plan is unusable.
 */
export function normalizeTaskPlan(plan: TaskPlan): TaskPlan | null {
  if (!plan || typeof plan !== "object") return null;
  if (typeof plan.scriptName !== "string" || typeof plan.description !== "string" || !Array.isArray(plan.requiredEvents)) {
    return null;
  }

  // Letters/digits (any language), space, and . _ - only; everything else becomes a
  // space, runs collapse, then trim and cap.
  const scriptName = plan.scriptName
    .replace(/[^\p{L}\p{N} ._-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SCRIPT_NAME_LENGTH)
    .trim();
  if (!scriptName) return null;

  plan.scriptName         = scriptName;
  plan.description        = plan.description.slice(0, 2000);
  plan.requiredEvents     = plan.requiredEvents.filter((e): e is string => typeof e === "string" && e.length > 0 && e.length <= 100).slice(0, 50);
  plan.implementationSteps = plan.implementationSteps ?? [];
  plan.testCases           = plan.testCases           ?? [];
  plan.edgeCases           = plan.edgeCases           ?? [];
  plan.complexity          = plan.complexity           ?? "moderate";
  return plan;
}
