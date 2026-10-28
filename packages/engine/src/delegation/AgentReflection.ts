/**
 * Delegation Agent — Reflection
 * OWNERSHIP: packages/engine/src/delegation
 *
 * The third stage of the Delegation agent pipeline — runs only when the
 * sandbox reports a test failure. Feeds the test output back to the LLM
 * with the original code and plan, requests a targeted fix, and returns
 * the corrected code for another sandbox run.
 *
 * Implements the ECC TDD red-green-improve loop:
 *   plan → code → test → [fail → reflect → re-code → test] → deploy
 *
 * Bounded retry loop (MAX_RETRIES = 3) — after three failed attempts, the
 * agent surfaces the failure to the user rather than looping forever.
 * This prevents runaway LLM usage on unsolvable requests.
 */

import { generateChatReply, type AIProviderConfig, type ChatMessage } from "../runtime/AIProvider.js";
import type { SandboxResult } from "../runtime/ScriptSandbox.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReflectionInput {
  /** The code that failed in the sandbox. */
  failedCode: string;
  /** The structured test output from SandboxExecutor. */
  sandboxResult: SandboxResult;
  /** The original user request (for context). */
  userRequest: string;
  /** The script name from the plan. */
  scriptName: string;
  /** Which attempt this is (1-indexed). Used to vary the reflection prompt. */
  attemptNumber: number;
}

// ─── Reflection ───────────────────────────────────────────────────────────────

const REFLECTION_SYSTEM_PROMPT = `You are the Delegation Agent Debugger for KojyAI.
A bot script failed its test cases. You will be given:
1. The script code that failed
2. The test output showing what went wrong
3. The original user request

Your job: fix the code so all tests pass. Return ONLY the corrected TypeScript code.
No markdown. No explanation. No preamble. Just the fixed code.

Rules:
- Do NOT change the function signature: export default function handler(event, ctx)
- Do NOT use require, import, process, setTimeout, fetch, or any network globals
- Wrap all logic in try/catch — never throw
- Return [] (empty array) if unsure what to do, never throw
- Do NOT hallucinate new action types — stick to: chat, emote, reaction, moderate`;

export async function reflectAndFix(
  provider: AIProviderConfig,
  input: ReflectionInput,
): Promise<string | null> {
  const failedTests = input.sandboxResult.testResults
    .filter((t) => !t.passed)
    .map((t) => `Test: ${t.description}\nExpected: ${t.expected}\nActual: ${t.actual}`)
    .join("\n\n");

  // On later attempts, be more explicit about what to try differently
  const urgencyNote = input.attemptNumber >= 3
    ? "\n\nIMPORTANT: This is the last retry. Simplify the approach if the current one is not working."
    : input.attemptNumber === 2
    ? "\n\nHint: Check the event._type guard and ctx.botUserId comparison first — these are common failure points."
    : "";

  const messages: ChatMessage[] = [
    { role: "system", content: REFLECTION_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Original request: "${input.userRequest}"
Script name: ${input.scriptName}
Attempt: ${input.attemptNumber}${urgencyNote}

Failed code:
${input.failedCode}

Test failures:
${failedTests}

Full sandbox output:
${input.sandboxResult.output}

Fix the code:`,
    },
  ];

  const raw = await generateChatReply(provider, messages, {
    maxTokens:  2500,
    temperature: 0.15, // Very low: this is debugging, not creative
    timeoutMs:   40_000,
  });

  if (!raw) return null;

  // Strip any markdown fences
  return raw
    .replace(/^```(?:typescript|ts|javascript|js)?\n?/m, "")
    .replace(/```\s*$/m, "")
    .trim();
}

export const MAX_REFLECTION_RETRIES = 3;
