/**
 * Delegation Agent — Main Orchestrator
 * OWNERSHIP: packages/engine/src/delegation
 *
 * Runs the full agent pipeline for one user request:
 *
 *   1. PLANNING    — AgentPlanner breaks down the request into a structured plan
 *   2. CODING      — AgentCoder generates TypeScript from the plan
 *   3. TESTING     — SandboxExecutor runs the code against test cases
 *   4. [REFLECTION — AgentReflection fixes failures, up to MAX_RETRIES times]
 *   5. DEPLOYING   — write to bot_scripts; signal runtime to load it
 *   6. MEMORY      — store the outcome in pgvector for future recall
 *
 * The orchestrator emits status events throughout via the provided
 * `onStatus` callback, which the delegation tRPC router uses to:
 *   a) update delegation_sessions.taskStatus in Postgres
 *   b) publish a DelegationStatusEvent to Redis → WS gateway → frontend
 *
 * This class is stateless — one instance per pipeline run.
 * Database writes are done by the caller (delegation router / BullMQ processor).
 */

import { resolveAIProvider, type AIProviderConfig } from "../runtime/AIProvider.js";
import { planFeatureRequest, type PlannerInput, type TaskPlan } from "./AgentPlanner.js";
import { generateBotScript, type CoderResult } from "./AgentCoder.js";
import { executeNaturalLanguageCases } from "../runtime/ScriptSandbox.js";
import { reflectAndFix, MAX_REFLECTION_RETRIES } from "./AgentReflection.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type DelegationTaskStatus =
  | "idle"
  | "planning"
  | "coding"
  | "testing"
  | "deploying"
  | "done"
  | "failed";

export interface DelegationRunInput {
  userRequest: string;
  sessionUuid: string;
  userId:      number;
  orgId:       number;
  botUuid:     string;
  botName:     string;
  roomId:      string;
  existingScripts: string[];
  pastContext:     string[];
  emoteCatalog: Array<{
    commandNum: number;
    emoteId:   string;
    name:      string;
    rarity:    string;
  }> | null;
}

export interface DelegationRunResult {
  success:    boolean;
  scriptName: string;
  code:       string;
  description: string;
  testOutput: string;
  testStatus: "passed" | "failed" | "timeout" | "error";
  retries:    number;
  /** The plan produced in Stage 1, for storage in the session memory. */
  plan:       TaskPlan | null;
  errorMessage?: string;
}

export type StatusCallback = (
  status: DelegationTaskStatus,
  message: string,
) => void | Promise<void>;

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export async function runDelegationAgent(
  input: DelegationRunInput,
  onStatus: StatusCallback,
): Promise<DelegationRunResult> {
  const provider = resolveAIProvider();
  if (!provider) {
    await onStatus("failed", "No AI provider configured — set GROQ_API_KEY, OPENAI_API_KEY, or MISTRAL_API_KEY in your .env");
    return {
      success:     false,
      scriptName:  "unknown",
      code:        "",
      description: "",
      testOutput:  "",
      testStatus:  "error",
      retries:     0,
      plan:        null,
      errorMessage: "No AI provider configured",
    };
  }

  // ─── Stage 1: Planning ────────────────────────────────────────────────────

  await onStatus("planning", `Planning: "${input.userRequest.slice(0, 80)}${input.userRequest.length > 80 ? "…" : ""}"`);

  const plannerInput: PlannerInput = {
    userRequest:           input.userRequest,
    botUuid:               input.botUuid,
    botName:               input.botName,
    roomId:                input.roomId,
    existingScripts:       input.existingScripts,
    pastContext:           input.pastContext,
    emoteCatalogAvailable: input.emoteCatalog !== null && input.emoteCatalog.length > 0,
    emoteCatalogCount:     input.emoteCatalog?.length ?? 0,
  };

  const plan = await planFeatureRequest(provider, plannerInput);

  if (!plan) {
    await onStatus("failed", "Planning failed — the AI couldn't parse your request. Please try rephrasing it.");
    return {
      success: false, scriptName: "unknown", code: "", description: "",
      testOutput: "Planning failed: AI returned no structured plan",
      testStatus: "error", retries: 0, plan: null,
      errorMessage: "Planning stage returned null",
    };
  }

  await onStatus("coding", `Coding: ${plan.scriptName} (${plan.complexity} complexity)…`);

  // ─── Stage 2: Coding ──────────────────────────────────────────────────────

  const coderResult: CoderResult | null = await generateBotScript(
    provider,
    plan,
    plan.needsEmoteCatalog ? input.emoteCatalog : null,
  );

  if (!coderResult) {
    await onStatus("failed", "Code generation failed — the AI couldn't produce valid code. Please try again.");
    return {
      success: false, scriptName: plan.scriptName, code: "", description: plan.description,
      testOutput: "Code generation failed: AI returned no code",
      testStatus: "error", retries: 0, plan,
      errorMessage: "Coding stage returned null",
    };
  }

  // ─── Stages 3–4: Test + Reflect loop ─────────────────────────────────────

  let currentCode = coderResult.code;
  let sandboxResult = await runSandboxTest(currentCode, plan, onStatus, 1);
  let retries = 0;

  while (sandboxResult.status !== "passed" && retries < MAX_REFLECTION_RETRIES) {
    retries++;
    await onStatus(
      "coding",
      `Test failed (attempt ${retries}/${MAX_REFLECTION_RETRIES}) — reflecting and fixing…`,
    );

    const fixedCode = await reflectAndFix(provider, {
      failedCode:     currentCode,
      sandboxResult,
      userRequest:    input.userRequest,
      scriptName:     plan.scriptName,
      attemptNumber:  retries,
    });

    if (!fixedCode) {
      // LLM returned nothing — break early rather than retrying with same code
      break;
    }

    currentCode = fixedCode;
    sandboxResult = await runSandboxTest(currentCode, plan, onStatus, retries + 1);
  }

  // ─── Stage 5: Evaluate final result ──────────────────────────────────────

  if (sandboxResult.status !== "passed") {
    const errMsg = sandboxResult.status === "timeout"
      ? "Script execution timed out in the sandbox. Simplify the logic."
      : sandboxResult.status === "error"
      ? `Script threw an error: ${sandboxResult.output}`
      : `Tests did not pass after ${retries} fix attempts.`;

    await onStatus("failed", errMsg);
    return {
      success: false, scriptName: plan.scriptName, code: currentCode,
      description: plan.description, testOutput: sandboxResult.output,
      testStatus: sandboxResult.status, retries, plan,
      errorMessage: errMsg,
    };
  }

  // ─── Stage 6: Ready to deploy ─────────────────────────────────────────────

  await onStatus("deploying", `All tests passed — deploying "${plan.scriptName}" to ${input.botName}…`);

  return {
    success:     true,
    scriptName:  plan.scriptName,
    code:        currentCode,
    description: plan.description,
    testOutput:  sandboxResult.output,
    testStatus:  "passed",
    retries,
    plan,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function runSandboxTest(
  code: string,
  plan: TaskPlan,
  onStatus: StatusCallback,
  attempt: number,
): Promise<Awaited<ReturnType<typeof executeNaturalLanguageCases>>> {
  await onStatus(
    "testing",
    `Running ${plan.testCases.length} test case${plan.testCases.length === 1 ? "" : "s"}${attempt > 1 ? ` (attempt ${attempt})` : ""}…`,
  );
  return executeNaturalLanguageCases(code, plan.testCases);
}
