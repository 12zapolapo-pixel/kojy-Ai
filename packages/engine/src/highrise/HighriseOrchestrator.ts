/**
 * Highrise Bot Orchestrator — Composer's Generation Pipeline
 * OWNERSHIP: packages/engine/src/highrise
 *
 * Generates a new bot end-to-end from a plain-English prompt: spec → code →
 * test → fix (bounded retries) → deploy. Targets the same TypeScript
 * reactive-script runtime Delegation's incremental feature agent already
 * targets (ReactiveEngine.ts / ScriptSandbox.ts / bot_scripts) — a bot built
 * here and a bot iterated on later via Delegation are the same kind of
 * thing, not two different runtimes.
 *
 * This does NOT replace Delegation, and never has — they cover different
 * parts of a bot's lifecycle: this pipeline bootstraps a brand-new bot from
 * a single prompt (rich multi-trigger spec, several scripts at once);
 * Delegation adds one incremental feature at a time to an EXISTING bot,
 * conversationally. Both now produce the same kind of output (TS scripts
 * matching the ScriptPlugin contract) and are tested by the same sandbox,
 * but the planning/generation code itself is still separate — this file's
 * spec/coder/fix prompts, Delegation's AgentPlanner/AgentCoder/
 * AgentReflection.
 *
 * PIPELINE:
 *   prompt
 *     → generateHighriseBotSpec  (structured multi-trigger spec — see HighriseBotSpec)
 *     → generateHighriseBotCode  (one or more TS files, each a ScriptPlugin)
 *     → runSandboxTests          (real structural check + real execution, ScriptSandbox.ts)
 *     → autoFixBotCode           (adaptive, attempt-aware repair — bounded, MAX_FIX_RETRIES)
 *
 * This pipeline stops at "the code is generated and tested" — it does not
 * deploy. Deploy (creating/updating the real bot row, writing bot_scripts,
 * signaling bot_control:*) is owned entirely by apps/worker's composerRun.ts,
 * which runs after this pipeline succeeds and knows things this layer
 * deliberately doesn't (whether credentials were even provided, whether this
 * project already has a bot to update vs. create). There used to be a
 * deployHighriseBot stub here that stopped at a fake "is live!" log line —
 * it's been removed rather than left as dead, misleading code.
 *
 * Each stage emits a ComposerStageEvent via the onStage callback; the
 * frontend Composer page renders each stage as it happens.
 *
 * Everything above calls generateChatReply/db/ScriptSandbox directly,
 * in-process — there is no MCP tool-call layer in this pipeline. (An
 * earlier version of this comment listed several MCP integrations —
 * filesystem/database/highrise-sandbox/highrise-deploy/highrise-logs — none
 * of which were ever actually wired in; removed rather than left stale.)
 */

import { generateChatReply, resolveAIProvider, type ChatMessage } from "../runtime/AIProvider.js";
import { executeStructuredScenarios, validateScriptStructure, type StructuredTestScenario } from "../runtime/ScriptSandbox.js";
import type { HighriseEvent as RealHighriseEvent } from "../runtime/highrise-protocol.js";

// ─── Stage Types ──────────────────────────────────────────────────────────────

export type PipelineStage =
  | "idle"
  | "spec"        // Converting prompt → structured Highrise bot spec
  | "codegen"     // Generating TypeScript ScriptPlugin code
  | "sandbox"     // Running code in isolated sandbox
  | "testing"     // Replaying Highrise events against the bot
  | "fixing"      // Auto-repairing failures
  | "deploying"   // Packaging and launching to Highrise room
  | "monitoring"  // Legacy stage from an earlier design — this pipeline never sets it anymore
                  // (kept only so old composer_projects rows with this stored value still type-check)
  | "done"
  | "failed";

export interface ComposerStageEvent {
  stage:     PipelineStage;
  /** Human-readable status line shown in the Composer bottom strip */
  message:   string;
  /** Structured artifact produced at this stage (spec JSON, code string, test results, etc.) */
  artifact?: ComposerArtifact;
  ts:        number;
}

export type ComposerArtifact =
  | { kind: "spec";       spec:    HighriseBotSpec }
  | { kind: "code";       files:   ProjectFile[]   }
  | { kind: "testResult"; results: TestResult[]    }
  | { kind: "log";        line:    string          }
  | { kind: "deploy";     botId: number; botUuid: string; roomName: string }
  | { kind: "deployError"; message: string };

// ─── Highrise Bot Spec ────────────────────────────────────────────────────────

/**
 * A structured Highrise bot specification.
 *
 * This is the intermediate representation between the user's plain-English
 * prompt and the generated Python/JS code. It encodes EVERYTHING the code
 * generator needs to produce correct, SDK-compliant Highrise bot code.
 *
 * Fields map directly to Highrise SDK concepts:
 * - triggers → SDK event handlers (on_user_join, on_chat, on_emote, etc.)
 * - commands → chat commands the bot handles (e.g. "!wave", "!help")
 * - actions  → SDK actions (send_message, emote, move_user, moderate, etc.)
 * - state    → per-user or global state the bot must track
 * - permissions → required room privileges (designer, owner, etc.)
 * - sdkVersion → pins the highrise-bot-sdk version
 * - language → "python" | "javascript"
 */
export interface HighriseBotSpec {
  name:        string;
  description: string;
  language:    "python" | "javascript";
  sdkVersion:  string;   // e.g. "25.1.0"

  /** Highrise SDK event handlers this bot needs */
  triggers: Array<{
    event:       string;    // "on_user_join" | "on_chat" | "on_emote" | "on_tip" | etc.
    description: string;
    conditions?: string[];  // optional filter conditions on the event
  }>;

  /** Chat commands the bot responds to */
  commands: Array<{
    command:      string;   // e.g. "!wave"
    description:  string;
    cooldownSecs: number;
    adminOnly:    boolean;
    args?:        string[]; // named args the command accepts
  }>;

  /** Highrise SDK actions the bot will perform */
  actions: Array<{
    action:      string;   // "send_message" | "emote" | "move_user" | "moderate" | etc.
    description: string;
    parameters:  Record<string, string>;
  }>;

  /** State the bot tracks between events */
  state: Array<{
    name:        string;
    type:        "per_user" | "global";
    description: string;
    initial:     string;   // Python literal
  }>;

  /** Room/bot permissions required */
  permissions: {
    requiresDesigner: boolean;
    requiresOwner:    boolean;
    minSDKVersion:    string;
  };

  /** External API calls the bot makes (if any) */
  externalAPIs: Array<{
    service:  string;
    endpoint: string;
    auth:     "none" | "api_key" | "oauth";
  }>;

  /**
   * Plain-English notes on anything the user's request implied that this
   * runtime can't (yet) actually do — e.g. external network calls (the
   * sandbox blocks fetch entirely, by design), or SDK actions like
   * move_user_to_room/buy_voice_time/walk_to that aren't wired into this
   * runtime's action vocabulary. Surfaced directly to the user rather than
   * silently generating code that can't do what was asked.
   */
  limitations: string[];

  /** Human-readable test scenarios to run in sandbox */
  testScenarios: Array<{
    name:            string;
    events:          HighriseEvent[];
    expectedActions: string[];
  }>;
}

/**
 * A Highrise event (used in test scenarios). Re-exports the real, live
 * wire-protocol event union from highrise-protocol.ts — the same shape
 * ReactiveEngine.evaluateEvent() and ScriptSandbox's structured-scenario
 * runner actually use. Previously this was a loose local placeholder
 * ({type: string; payload: Record<string, unknown>}) that nothing else in
 * the codebase recognized — test scenarios described events in a shape the
 * real runtime would never actually produce.
 */
export type HighriseEvent = RealHighriseEvent;

// ─── Project Files ────────────────────────────────────────────────────────────

export interface ProjectFile {
  path:    string;   // e.g. "main.py", "requirements.txt", "startbot.bat"
  content: string;
  lang:    string;   // "python" | "text" | "batch" | "markdown"
}

// ─── Test Results ─────────────────────────────────────────────────────────────

export interface TestResult {
  scenario:  string;
  passed:    boolean;
  actual:    string;
  expected:  string;
  durationMs: number;
  logs:      string[];
}

// ─── Orchestrator Input ───────────────────────────────────────────────────────

export interface OrchestratorInput {
  /** The user's plain-English bot description */
  userPrompt:    string;
  projectId:     string;
  botName:       string;
  language:      "python" | "javascript";
  roomId:        string;
  /** Encrypted and never exposed to frontend */
  apiTokenRef:   string;
  /** Previous turn context (for multi-turn chat on same project) */
  history:       Array<{ role: "user" | "assistant"; content: string }>;
  /** Existing project files if this is a re-run/fix */
  existingFiles?: ProjectFile[];
  /** Skip straight to fix stage if files already exist */
  startAtStage?: PipelineStage;
}

export interface OrchestratorResult {
  success:      boolean;
  spec:         HighriseBotSpec | null;
  files:        ProjectFile[];
  testResults:  TestResult[];
  errorMessage?: string;
  retries:      number;
}

// ─── Stage Callback ───────────────────────────────────────────────────────────

export type StageCallback = (event: ComposerStageEvent) => void | Promise<void>;

// ─── Main Orchestrator ────────────────────────────────────────────────────────

export const MAX_FIX_RETRIES = 3;

export async function runHighriseOrchestrator(
  input:      OrchestratorInput,
  onStage:    StageCallback,
): Promise<OrchestratorResult> {

  const provider = resolveAIProvider();
  if (!provider) {
    await onStage({ stage: "failed", message: "No AI provider configured. Add GROQ_API_KEY, OPENAI_API_KEY, or MISTRAL_API_KEY to .env", ts: Date.now() });
    return { success: false, spec: null, files: [], testResults: [], errorMessage: "No AI provider", retries: 0 };
  }

  // ── STAGE 1: SPEC ──────────────────────────────────────────────────────────
  await onStage({ stage: "spec", message: `Analyzing prompt and generating Highrise bot spec for "${input.botName}"…`, ts: Date.now() });

  const spec = await generateHighriseBotSpec(provider, input);
  if (!spec) {
    await onStage({ stage: "failed", message: "Failed to generate bot spec. Please rephrase your prompt.", ts: Date.now() });
    return { success: false, spec: null, files: [], testResults: [], errorMessage: "Spec generation failed", retries: 0 };
  }

  await onStage({ stage: "spec", message: `Spec ready: ${spec.triggers.length} triggers, ${spec.commands.length} commands, ${spec.actions.length} actions`, artifact: { kind: "spec", spec }, ts: Date.now() });

  // ── STAGE 2: CODE GENERATION ───────────────────────────────────────────────
  await onStage({ stage: "codegen", message: `Writing ${spec.language === "python" ? "Python" : "JavaScript"} bot code (highrise-bot-sdk v${spec.sdkVersion})…`, ts: Date.now() });

  let files = await generateHighriseBotCode(provider, spec, input);
  if (!files || files.length === 0) {
    await onStage({ stage: "failed", message: "Code generation failed. Retrying with simplified spec…", ts: Date.now() });
    return { success: false, spec, files: [], testResults: [], errorMessage: "Code generation failed", retries: 0 };
  }

  await onStage({ stage: "codegen", message: `Generated ${files.length} files: ${files.map(f => f.path).join(", ")}`, artifact: { kind: "code", files }, ts: Date.now() });

  // ── STAGE 3: SANDBOX + TEST ────────────────────────────────────────────────
  let testResults: TestResult[] = [];
  let retries = 0;
  let allPassed = false;

  while (!allPassed && retries <= MAX_FIX_RETRIES) {
    await onStage({
      stage: retries === 0 ? "sandbox" : "fixing",
      message: retries === 0
        ? `Running ${spec.testScenarios.length} test scenario(s) in sandbox…`
        : `Fix attempt ${retries}/${MAX_FIX_RETRIES} — patching failures…`,
      ts: Date.now(),
    });

    testResults = await runSandboxTests(files, spec);

    await onStage({
      stage: "testing",
      message: `Tests: ${testResults.filter(t => t.passed).length}/${testResults.length} passed`,
      artifact: { kind: "testResult", results: testResults },
      ts: Date.now(),
    });

    allPassed = testResults.every(t => t.passed);

    if (!allPassed && retries < MAX_FIX_RETRIES) {
      const fixedFiles = await autoFixBotCode(provider, spec, files, testResults, retries + 1);
      if (fixedFiles) {
        files = fixedFiles;
        await onStage({
          stage: "fixing",
          message: `Fix attempt ${retries + 1} applied — re-testing…`,
          artifact: { kind: "code", files },
          ts: Date.now(),
        });
      }
      retries++;
    } else {
      break;
    }
  }

  if (!allPassed) {
    const failedCount = testResults.filter(t => !t.passed).length;
    await onStage({ stage: "failed", message: `${failedCount} test(s) still failing after ${retries} fix attempts. Review the errors and try rephrasing your prompt.`, ts: Date.now() });
    return { success: false, spec, files, testResults, errorMessage: `${failedCount} test(s) failed`, retries };
  }

  // ── STAGE 4: Tests passed ──────────────────────────────────────────────────
  //
  // This pipeline's job ends here — it plans, writes, and tests code. The
  // actual deploy (creating/updating the real bot, writing bot_scripts,
  // signaling bot_control:*) happens afterward in composerRun.ts, which
  // knows things this function doesn't (whether roomId/token were even
  // provided, whether this project already has a deployed bot to update
  // rather than create). Broadcasting a "done, deployed" claim from here
  // would be asserting something this function has no way to know is true.
  await onStage({
    stage: "done",
    message: `All ${testResults.length} test scenario(s) passed for "${input.botName}".`,
    ts: Date.now(),
  });

  return { success: true, spec, files, testResults, retries };
}

// ─── Stage Implementations ────────────────────────────────────────────────────

/**
 * Stage 1: Generate a structured Highrise bot spec from the user's prompt.
 *
 * Uses a carefully engineered prompt that gives the AI deep knowledge of:
 * - The Highrise Python SDK event surface
 * - All available bot actions
 * - SDK version conventions
 * - State management patterns
 * - Permission requirements
 */
async function generateHighriseBotSpec(
  provider: ReturnType<typeof resolveAIProvider>,
  input: OrchestratorInput,
): Promise<HighriseBotSpec | null> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: HIGHRISE_SPEC_SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: buildSpecUserPrompt(input),
    },
  ];

  const raw = await generateChatReply(provider!, messages, {
    maxTokens: 2000,
    temperature: 0.2,
    timeoutMs: 45_000,
  });

  if (!raw) return null;

  try {
    const clean = raw.replace(/```(?:json)?\n?/g, "").replace(/```/g, "").trim();
    const spec = JSON.parse(clean) as HighriseBotSpec;
    // Every bot now targets the TS reactive-script runtime regardless of
    // what OrchestratorInput.language says — that field is kept only for
    // backward compatibility with existing composer_projects rows and the
    // DB enum/frontend selector, not because Python generation still works
    // (it doesn't; nothing in this runtime executes it).
    spec.language   = "javascript";
    spec.sdkVersion = "n/a";
    spec.limitations = spec.limitations ?? [];
    return spec;
  } catch {
    return null;
  }
}

/**
 * Stage 2: Generate the actual script files from the spec.
 *
 * Produces one or more TypeScript files, each `export default function
 * handler(event, ctx): ReactiveAction[]` — the same contract Delegation's
 * bot_scripts already use. A spec with multiple triggers/commands may
 * become one combined file or several independent ones (the coder prompt
 * prefers several when the behaviors are logically independent), decided
 * by the LLM, not hardcoded here.
 */
async function generateHighriseBotCode(
  provider: ReturnType<typeof resolveAIProvider>,
  spec:     HighriseBotSpec,
  input:    OrchestratorInput,
): Promise<ProjectFile[] | null> {
  const messages: ChatMessage[] = [
    { role: "system", content: HIGHRISE_CODER_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Generate the complete Highrise bot project for this spec:\n\n${JSON.stringify(spec, null, 2)}\n\nBot name: ${input.botName}\n\nReturn ONLY a JSON array of {path, content, lang} objects. No markdown. No explanation.`,
    },
  ];

  const raw = await generateChatReply(provider!, messages, {
    maxTokens: 4000,
    temperature: 0.15,
    timeoutMs: 60_000,
  });

  if (!raw) return null;

  try {
    const clean = raw.replace(/```(?:json)?\n?/g, "").replace(/```/g, "").trim();
    return JSON.parse(clean) as ProjectFile[];
  } catch {
    return null;
  }
}

/**
 * Stage 3: Run test scenarios against the generated code.
 *
 * Real structural validation (TypeScript compiler AST check) always runs
 * first, then real dynamic execution via ScriptSandbox — the same merged
 * sandbox Delegation's incremental agent uses, not a separate Python path.
 * Every generated file is tested together against each scenario, since a
 * deployed bot runs all its registered scripts against the same event.
 */
export async function runSandboxTests(
  files:    ProjectFile[],
  spec:     HighriseBotSpec,
): Promise<TestResult[]> {
  if (files.length === 0) {
    return spec.testScenarios.map(s => ({
      scenario:   s.name,
      passed:     false,
      actual:     "No script files were generated",
      expected:   s.expectedActions.join(", "),
      durationMs: 0,
      logs:       ["ERROR: coder stage returned zero files"],
    }));
  }

  // Structural check runs first, per file — a syntax error or missing
  // `export default function handler` in ANY file fails every scenario
  // immediately, same discipline the old Python AST tier had: there's no
  // point spending a sandbox run on code that can't even parse.
  for (const file of files) {
    const structural = validateScriptStructure(file.content);
    if (!structural.valid) {
      const reason = structural.syntaxError ?? `${file.path}: does not export a default function named 'handler'`;
      return spec.testScenarios.map(s => ({
        scenario:   s.name,
        passed:     false,
        actual:     `Structural check failed in ${file.path}: ${reason}`,
        expected:   s.expectedActions.join(", "),
        durationMs: 0,
        logs:       [`Real TypeScript compiler check failed for ${file.path}: ${reason}`],
      }));
    }
  }

  // Real execution: a deployed bot runs ALL its registered scripts against
  // every event (see ReactiveEngine.evaluateEvent's plugin loop), so testing
  // one file in isolation would under-test any spec that generated several
  // smaller scripts. Run each scenario against every file and merge the
  // resulting actions, matching production behavior exactly.
  const scenarios: StructuredTestScenario[] = spec.testScenarios.map(s => ({
    name: s.name,
    events: s.events,
    expectedActions: s.expectedActions,
  }));

  const perFileResults = await Promise.all(
    files.map(file => executeStructuredScenarios(file.content, scenarios)),
  );

  return spec.testScenarios.map((scenarioSpec, i) => {
    const acrossFiles = perFileResults.map(r => r[i]!);
    const anyRuntimeError = acrossFiles.find(r => r.actual.startsWith("Runtime error:"));
    if (anyRuntimeError) {
      return {
        scenario: scenarioSpec.name, passed: false,
        actual: anyRuntimeError.actual, expected: scenarioSpec.expectedActions.join(", "),
        durationMs: acrossFiles.reduce((sum, r) => sum + r.durationMs, 0),
        logs: acrossFiles.flatMap(r => r.logs),
      };
    }

    // Merge: did the UNION of actions across all files satisfy what was expected?
    const calledKinds = new Set<string>();
    for (const r of acrossFiles) {
      const match = r.actual.match(/^Called: \[(.*)\]$/);
      if (match?.[1]) match[1].split(", ").filter(Boolean).forEach(k => calledKinds.add(k));
    }
    const missing = scenarioSpec.expectedActions.filter(a => !calledKinds.has(a));
    const passed = missing.length === 0;

    return {
      scenario: scenarioSpec.name,
      passed,
      actual: passed
        ? `Called: [${Array.from(calledKinds).join(", ")}]`
        : `Called: [${Array.from(calledKinds).join(", ")}] but expected [${scenarioSpec.expectedActions.join(", ")}] — missing: [${missing.join(", ")}]`,
      expected: scenarioSpec.expectedActions.join(", "),
      durationMs: acrossFiles.reduce((sum, r) => sum + r.durationMs, 0),
      logs: acrossFiles.flatMap(r => r.logs),
    };
  });
}

/**
 * Stage 4 (on failure): Auto-repair the bot code.
 *
 * Feeds the failing test output back to the LLM with targeted instructions
 * to fix only the broken parts, not rewrite the entire file.
 */
async function autoFixBotCode(
  provider:    ReturnType<typeof resolveAIProvider>,
  spec:        HighriseBotSpec,
  files:       ProjectFile[],
  testResults: TestResult[],
  attempt:     number,
): Promise<ProjectFile[] | null> {
  const failures = testResults
    .filter(t => !t.passed)
    .map(t => `SCENARIO: ${t.scenario}\nISSUES: ${t.actual}\nLOGS:\n${t.logs.join("\n")}`)
    .join("\n\n");

  if (files.length === 0) return null;

  // Adaptive, attempt-aware hinting — ported from Delegation's
  // AgentReflection, which had this and Composer's fixer didn't. Composer
  // could generate several independent script files (one spec, multiple
  // triggers), so this covers all of them, not the single-hint framing
  // AgentReflection used for its always-one-script case.
  const urgencyNote = attempt >= MAX_FIX_RETRIES
    ? "\n\nIMPORTANT: This is the last retry. Simplify the approach if the current one is not working."
    : attempt === 2
    ? "\n\nHint: Check the event._type guard and any user-id comparisons first — these are the most common failure points."
    : "";

  const filesBlock = files.map(f => `FILE: ${f.path}\n${f.content}`).join("\n\n---\n\n");

  const messages: ChatMessage[] = [
    { role: "system", content: HIGHRISE_CODER_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Fix the following Highrise bot scripts. Attempt ${attempt}/${MAX_FIX_RETRIES}.${urgencyNote}

CURRENT FILES:
${filesBlock}

TEST FAILURES (these tests ran ALL of the above files together against each scenario, matching how they'll actually run once deployed):
${failures}

Return ONLY the fixed JSON array of ALL files ({path, content, lang}) — including any files that didn't need changes. No explanation.`,
    },
  ];

  const raw = await generateChatReply(provider!, messages, {
    maxTokens: 4000,
    temperature: 0.1,
    timeoutMs: 60_000,
  });

  if (!raw) return null;

  try {
    const clean = raw.replace(/```(?:json)?\n?/g, "").replace(/```/g, "").trim();
    return JSON.parse(clean) as ProjectFile[];
  } catch {
    return null;
  }
}

// ─── System Prompts ───────────────────────────────────────────────────────────

const HIGHRISE_SPEC_SYSTEM_PROMPT = `You are a Highrise Bot Architect. You convert plain-English bot descriptions into precise, structured JSON specifications for bots that run as TypeScript reactive script plugins on KojyAI's own bot runtime — the same runtime Delegation's incremental feature agent already targets, not the standalone Python SDK.

RUNTIME MODEL:
Each bot script is a single function: \`export default function handler(event: HighriseEvent, ctx: ReactiveContext): ReactiveAction[]\`.
It receives one real room event, reads/writes per-bot state via ctx, and returns zero or more actions to perform. It never calls the network, spawns processes, or blocks — the sandbox that tests every script enforces this before anything is ever deployed.

EVENT TYPES you must know (the "_type" tag on the event object — this is how you tell events apart, there is no "on_chat" method to override):
- ChatEvent — { _type: "ChatEvent", user: {id, username}, message: string, whisper: boolean }
- EmoteEvent — { _type: "EmoteEvent", user, emote_id: string, receiver?: User|null }
- ReactionEvent — { _type: "ReactionEvent", user, reaction: string, receiver: User }
- UserJoinedEvent — { _type: "UserJoinedEvent", user, position }
- UserLeftEvent — { _type: "UserLeftEvent", user }
- UserMovedEvent — { _type: "UserMovedEvent", user, position }
- ChannelEvent — { _type: "ChannelEvent", sender_id: string, msg: string, tags: string[] }
- TipReactionEvent — { _type: "TipReactionEvent", sender, receiver, item: {id, name, amount} }
- VoiceEvent — { _type: "VoiceEvent", users: [User, "voice"|"muted"][], seconds_left: number }
- MessageEvent — { _type: "MessageEvent", user_id, conversation_id, is_new_conversation }
- RoomModeratedEvent — { _type: "RoomModeratedEvent", moderatorId, targetUserId, moderationType, duration }

ACTIONS you can return (each is { kind, request, reason }) — this is the FULL real vocabulary, every one is actually wired to a live Highrise connection, nothing here is aspirational:
- chat — { kind: "chat", request: { _type: "ChatRequest", message, whisper_target_id: string|null } }
- emote — { kind: "emote", request: { _type: "EmoteRequest", emote_id, target_user_id: string|null } }
- reaction — { kind: "reaction", request: { _type: "ReactionRequest", reaction, target_user_id } }
- moderate — { kind: "moderate", request: { _type: "ModerateRoomRequest", user_id, moderation_action: "kick"|"ban"|"unban"|"mute", action_length: number|null } } — REQUIRES the bot to hold Designer rights in the room; if it doesn't, this fails at the real Highrise server, not locally, so flag any moderation-heavy request in "limitations" so the user knows to grant Designer rights.
- teleport — { kind: "teleport", request: { _type: "TeleportRequest", user_id, destination } } — also requires Designer rights.
- get_room_users — { kind: "get_room_users", request: { _type: "GetRoomUsersRequest", rid } } — fires the query but the result does NOT currently feed back into this same handler call (the runtime is synchronous, fire-and-forget for queries). Only use this if the request is satisfied by triggering the lookup itself, not by branching on its result.
- get_wallet — same fire-only limitation as get_room_users.
- set_outfit — { kind: "set_outfit", request: { _type: "SetOutfitRequest", outfit: [{type:"clothing", id, amount}] } } — bot can only equip items it owns or free (rarity:none) items; ownership is checked server-side.

NOT AVAILABLE in this runtime — if the user's request implies any of these, do NOT invent a fake action for it; instead add a clear, specific entry to "limitations":
- Any external network/API call (the sandbox blocks all network access by design — this is a security boundary, not a gap)
- move_user_to_room, buy_voice_time, walk_to — these may exist in the standalone Python SDK but are not wired into this runtime yet

Respond ONLY with a valid JSON object matching this schema:
{
  "name": "string",
  "description": "string",
  "language": "javascript",
  "sdkVersion": "n/a",
  "triggers": [{"event": "ChatEvent" | "EmoteEvent" | "ReactionEvent" | "UserJoinedEvent" | "UserLeftEvent" | "UserMovedEvent" | "ChannelEvent" | "TipReactionEvent" | "VoiceEvent" | "MessageEvent" | "RoomModeratedEvent", "description": "string", "conditions": ["string"]}],
  "commands": [{"command": "string", "description": "string", "cooldownSecs": number, "adminOnly": boolean, "args": ["string"]}],
  "actions": [{"action": "chat"|"emote"|"reaction"|"moderate"|"teleport"|"get_room_users"|"get_wallet"|"set_outfit", "description": "string", "parameters": {}}],
  "state": [{"name": "string", "type": "per_user"|"global", "description": "string", "initial": "string"}],
  "permissions": {"requiresDesigner": boolean, "requiresOwner": boolean, "minSDKVersion": "n/a"},
  "externalAPIs": [],
  "limitations": ["string — plain English, e.g. \\"connecting to a weather API isn't supported — the sandbox blocks all network access\\""],
  "testScenarios": [{"name": "string", "events": [{"_type": "ChatEvent", "user": {"id": "user-1", "username": "TestUser"}, "message": "!wave", "whisper": false}], "expectedActions": ["emote"]}]
}

TEST SCENARIO RULES (executed for real in an isolated sandbox, not just checked for text presence):
- Every event MUST use the exact "_type" tag and field names listed above — these are real TypeScript interfaces, not a loose description.
- "expectedActions" MUST list action "kind" values from the ACTIONS list above (e.g. "chat", "emote", "moderate") — the bare kind name, not the request shape.
- Include at least one test scenario per trigger/command you defined.
- If a trigger implies a Designer-privileged action (moderate, teleport), still write the scenario normally — the sandbox tests the script's own logic, not live room permissions.`;

const HIGHRISE_CODER_SYSTEM_PROMPT = `You are a Highrise Bot Developer expert in KojyAI's TypeScript reactive script runtime — the same runtime and contract Delegation's incremental feature agent targets.

Generate COMPLETE, WORKING TypeScript. Never use placeholders. Never write "// TODO".

REQUIRED SHAPE — every script MUST be exactly this:
\`\`\`typescript
export default function handler(event: HighriseEvent, ctx: ReactiveContext): ReactiveAction[] {
  const actions: ReactiveAction[] = [];

  if (event._type === "ChatEvent" && event.message === "!wave") {
    actions.push({
      kind: "emote",
      request: { _type: "EmoteRequest", emote_id: "wave-1", target_user_id: event.user.id },
      reason: "wave command",
    });
  }

  return actions;
}
\`\`\`

HARD RULES (a script violating any of these will fail the sandbox and never deploy):
- No network access — no fetch, XMLHttpRequest, or any I/O. The sandbox has no network at all; this isn't checked, it's physically blocked.
- No process, require, eval, Function(), setTimeout, setInterval, or any global outside Math/JSON/Date/String/Number/Boolean/Array/Object/Map/Set/RegExp.
- Must run synchronously and return within milliseconds — no long loops, no busy-waiting.
- Always return an array, even when empty ([] is a completely valid, common response — most events don't need a reaction).
- ctx.userState is a Map<string, Record<string, unknown>> keyed by user id — the correct place for per-user state (join counts, cooldown timestamps, etc.). ctx.scriptState is a plain object for state shared across all users.
- Wrap any risky logic (parsing, external-shaped data) in try/catch internally — an uncaught throw fails the whole event, not just this script, for every OTHER script registered on the same bot too.

If the spec has multiple triggers/commands, you may generate either ONE script whose handler checks event._type/message for every case, or SEVERAL smaller scripts (one per trigger/command) — prefer several smaller scripts when the behaviors are logically independent (e.g. a greet-on-join script and a separate !leaderboard command script), since that mirrors how Delegation lets a user edit or remove one feature later without touching the others.

Return ONLY a JSON array of the generated scripts: [{"path": "kebab-case-script-name.ts", "content": "...", "lang": "typescript"}, ...]
Never use markdown code fences. Pure JSON only.`;

function buildSpecUserPrompt(input: OrchestratorInput): string {
  const historyStr = input.history.length > 0
    ? `\nConversation history:\n${input.history.map(h => `${h.role}: ${h.content}`).join("\n")}\n`
    : "";

  return `${historyStr}
Bot name: ${input.botName}
User request: "${input.userPrompt}"

Generate a complete Highrise bot spec JSON for this request. Include at least 2 test scenarios.`;
}
