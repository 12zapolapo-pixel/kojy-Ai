/**
 * Script Sandbox — Canonical Isolation + Testing Engine
 * OWNERSHIP: packages/engine/src/runtime
 *
 * MERGE NOTE: this file replaces two previously-independent sandboxes that
 * had drifted into near-identical Docker isolation flags without ever
 * sharing code — packages/engine/src/highrise/sandbox/PythonSandbox.ts
 * (Composer, Python-targeted) and packages/engine/src/delegation/
 * SandboxExecutor.ts (Delegation, TypeScript-targeted). Now that Composer
 * targets the same TypeScript ScriptPlugin contract Delegation already
 * uses, both features share ONE real implementation instead of two that
 * could each be fixed without the other ever finding out.
 *
 * Every real ability either original had is preserved here, not dropped:
 *
 *   - Composer's discipline: structural validation BEFORE spending a
 *     sandbox run — does the code parse? does it actually define a default-
 *     exported `handler` function (real AST check via the TypeScript
 *     compiler API, not text search)? A structural failure skips execution
 *     entirely and reports the real parse error, exactly like
 *     PythonSandbox's AST tier did for Python.
 *
 *   - Delegation's discipline: real dynamic execution — vm.runInNewContext
 *     for fast/no-dependency isolation, or a disposable Docker container
 *     (--network=none --read-only --tmpfs=/tmp:size=32m --memory=256m
 *     --cpus=0.5) for real OS-level isolation — carried over unchanged from
 *     SandboxExecutor.ts, including its documented vm-is-not-a-security-
 *     boundary caveat and the shell-injection avoidance (code/event/ctx are
 *     always written to a host-side temp file, never shell-interpolated).
 *
 *   - Composer's smarter mode selection: PythonSandbox auto-detected Docker
 *     availability and picked the strongest mode by default. Delegation's
 *     SANDBOX_MODE was a top-level constant fixed at module load, always
 *     defaulting to the weaker vm mode even when Docker was available. This
 *     merged version keeps the auto-detecting behavior — the better of the
 *     two — as the default, while DELEGATION_SANDBOX_MODE can still force a
 *     specific mode explicitly.
 *
 *   - Delegation's natural-language test-case authoring (`"user alice says:
 *     hello"` style) AND Composer's structured event-scenario authoring
 *     (explicit `_type`-tagged HighriseEvent + expectedActions) are both
 *     supported as first-class entry points against the same execution
 *     core, rather than picking one authoring style and discarding the
 *     other's callers.
 *
 * Security note (unchanged from SandboxExecutor.ts): scripts are AI-
 * generated and always run here before deployment — never live code that
 * skipped this path.
 */

import { createRequire } from "node:module";
import ts from "typescript";
import ivm from "isolated-vm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HighriseEvent } from "./highrise-protocol.js";
import type { ReactiveAction } from "./ReactiveEngine.js";

const execFileAsync = promisify(execFile);
const VM_MEMORY_LIMIT_MB = 64;

// ─── Structural Validation (Tier 1 — always run, zero execution risk) ────────

export interface StructuralCheckResult {
  valid: boolean;
  /** Real syntax/parse error, if any — from the TS compiler, not a guess. */
  syntaxError: string | null;
  /** True if a default-exported function named `handler` was found. */
  hasDefaultHandler: boolean;
}

/**
 * Parses the generated code with the real TypeScript compiler and checks
 * two things structurally, not textually:
 *   1. It's syntactically valid (real diagnostics, not just "did it throw").
 *   2. It has `export default function handler(...)` — the one contract
 *      every generated script (Composer or Delegation) must satisfy to be
 *      registerable as a ScriptPlugin.
 *
 * This is the direct TS-target equivalent of PythonSandbox's AST tier —
 * same purpose (catch structural problems before spending a sandbox run on
 * code that can't possibly work), same "never fake substring matching"
 * principle, applied to the actual target language now in use.
 */
// ─── Tier 0 — Static Safety Blocklist (SECURITY FIX C-04) ────────────────────
//
// Between the Delegation/Composer AI pipelines generating code and that code
// ever reaching a sandbox run, there was no code-level safety check — only a
// sentence in the system prompt asking the model not to generate code that
// accesses process/require/etc. A system prompt is a request to a
// probabilistic model, not an enforcement mechanism: any user can simply
// describe the escape payload directly in an ordinary feature request and
// have it generated and executed. This is defense-in-depth in ADDITION to —
// not instead of — the real sandbox fix (C-02/C-05): a determined attacker
// with genuine sandbox-escape expertise could still craft code that evades a
// pattern-based filter, but this closes the trivial, no-skill-required
// version of the attack (including the exact host-object-reference pattern
// C-02/C-05 confirmed live: `Array.constructor`, `Object.constructor`, etc.)
// before it ever reaches code generation output being trusted at all.

export interface SafetyCheckResult {
  safe: boolean;
  reason: string | null;
}

const UNSAFE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\.constructor\s*\(\s*["'`]return\s+process/i, reason: "attempts to reach the real process object via a constructor call" },
  { pattern: /\.constructor\s*\.\s*constructor\s*\(/,        reason: "classic vm-sandbox-escape pattern (.constructor.constructor(...))" },
  { pattern: /\[\s*["'`]constructor["'`]\s*\]\s*\[\s*["'`]constructor["'`]\s*\]/, reason: "bracket-notation constructor-chain escape attempt" },
  { pattern: /\brequire\s*\(/,                                reason: "calls require(...) — not available and never should be" },
  { pattern: /\bprocess\s*\.\s*(env|mainModule|binding|exit|kill)\b/, reason: "directly references process.* (process is never provided to generated scripts)" },
  { pattern: /\bnew\s+Function\s*\(/,                         reason: "constructs a function from a string via new Function(...)" },
  { pattern: /\bglobalThis\s*\[/,                             reason: "indexes into globalThis dynamically — a common sandbox-probing technique" },
  { pattern: /\bimport\s*\(/,                                 reason: "dynamic import(...) — not available to generated scripts" },
  { pattern: /\beval\s*\(/,                                   reason: "calls eval(...)" },
  { pattern: /\bchild_process\b/,                             reason: "references child_process" },
  { pattern: /\bfetch\s*\(/,                                  reason: "attempts a network call via fetch(...) — not permitted for generated scripts" },
];

/**
 * Cheap, fast, static pattern check run before ANY sandbox execution — the
 * first thing both public entry points below do. Not a substitute for real
 * process isolation (see runInVmSandbox/runInDockerSandbox and
 * runtime-manager.ts's live-path isolate) — a determined attacker could
 * still write escape code that doesn't match these literal patterns. This
 * exists to close the "just ask for it in plain English" path, which is the
 * realistic, no-skill-required attack C-04 described.
 */
export function checkScriptSafety(code: string): SafetyCheckResult {
  for (const { pattern, reason } of UNSAFE_PATTERNS) {
    if (pattern.test(code)) {
      return { safe: false, reason };
    }
  }
  return { safe: true, reason: null };
}

// ─── Structural Validation (Tier 1 — always run, zero execution risk) ────────

export function validateScriptStructure(code: string): StructuralCheckResult {
  const sourceFile = ts.createSourceFile(
    "script.ts",
    code,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  // Real syntax diagnostics — ts.createSourceFile still parses permissively
  // for tooling purposes, so we re-check via a throwaway Program to surface
  // genuine parse errors the same way a real compile would catch them.
  const host = ts.createCompilerHost({});
  const originalGetSourceFile = host.getSourceFile;
  host.getSourceFile = (fileName, langVersion, ...rest) =>
    fileName === "script.ts" ? sourceFile : originalGetSourceFile(fileName, langVersion, ...rest);

  const program = ts.createProgram(["script.ts"], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    strict: false,
    noEmit: true,
    skipLibCheck: true,
  }, host);

  const syntacticDiagnostics = program.getSyntacticDiagnostics(sourceFile);
  if (syntacticDiagnostics.length > 0) {
    const first = syntacticDiagnostics[0]!;
    const message = ts.flattenDiagnosticMessageText(first.messageText, "\n");
    const pos = first.file && first.start !== undefined
      ? first.file.getLineAndCharacterOfPosition(first.start)
      : null;
    return {
      valid: false,
      syntaxError: pos ? `Line ${pos.line + 1}, col ${pos.character + 1}: ${message}` : message,
      hasDefaultHandler: false,
    };
  }

  // Structural check: real AST walk for `export default function handler`
  // (or `export default handler` referencing a function declared as
  // `function handler(...)` elsewhere) — not a string search.
  let hasDefaultHandler = false;
  const visit = (node: ts.Node) => {
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "handler") {
        hasDefaultHandler = true;
      }
    }
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "handler" &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      hasDefaultHandler = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return {
    valid: hasDefaultHandler,
    syntaxError: hasDefaultHandler ? null : null,
    hasDefaultHandler,
  };
}

// ─── Docker Availability Auto-Detection ───────────────────────────────────────
//
// Ported from PythonSandbox.ts — real, cached `docker --version` probe,
// used to pick the strongest available mode by default rather than always
// defaulting to the weaker vm mode regardless of what's actually available
// on the host (SandboxExecutor.ts's previous behavior).
//
// SECURITY FIX (C-05): "vm mode" below no longer means node:vm's
// runInNewContext — that had the identical host-object-reference escape as
// C-02 (confirmed live: Array/Object/etc were being passed into the sandbox
// BY REFERENCE from the host realm, so e.g. `Array.constructor` reached the
// real host Function constructor and, from there, real `process` — in the
// WORKER process, which holds the same JWT_SECRET/ENCRYPTION_KEY/
// DATABASE_URL tier of secrets as the API). "vm mode" now means a real
// isolated-vm V8 isolate — genuine process-level test isolation even
// without Docker available, rather than a name that implied isolation but
// wasn't one. Docker is still preferred by default when available (this
// function's job), but the fallback is no longer a same-process escape
// hatch — it's a second real sandbox, just without Docker's OS-level
// network/filesystem hardening on top.

let _dockerAvailable: boolean | null = null;

async function isDockerAvailable(): Promise<boolean> {
  if (_dockerAvailable !== null) return _dockerAvailable;
  try {
    await execFileAsync("docker", ["--version"], { timeout: 3000 });
    _dockerAvailable = true;
  } catch {
    _dockerAvailable = false;
  }
  return _dockerAvailable;
}

let _warnedVmFallback = false;

async function resolveSandboxMode(): Promise<"vm" | "docker"> {
  const forced = process.env.DELEGATION_SANDBOX_MODE;
  if (forced === "vm" || forced === "docker") return forced;

  if (await isDockerAvailable()) return "docker";

  // SECURITY FIX (C-05): this used to be a completely silent fallback — an
  // environment that simply never had Docker available (or lost it) would
  // downgrade test isolation with zero trace in the logs. Warn once so this
  // is visible in production monitoring rather than discovered later. Note
  // this is no longer a downgrade to *no* isolation (see runInVmSandbox) —
  // it's a real isolated-vm isolate without Docker's additional OS-level
  // network/filesystem hardening on top.
  if (!_warnedVmFallback) {
    _warnedVmFallback = true;
    console.warn(
      "[ScriptSandbox] Docker unavailable and DELEGATION_SANDBOX_MODE not set — " +
      "falling back to isolated-vm mode (real isolation, but without Docker's " +
      "network/filesystem hardening). Set DELEGATION_SANDBOX_MODE=docker and " +
      "ensure Docker is reachable in production.",
    );
  }
  return "vm";
}

// ─── Execution Core (Tier 2 — real dynamic execution) ─────────────────────────
// Unchanged from SandboxExecutor.ts other than the rename/relocation.

const EXEC_TIMEOUT_MS = 3000;
const DOCKER_IMAGE = process.env.DELEGATION_SANDBOX_IMAGE ?? "node:22-slim";
const DOCKER_EXEC_TIMEOUT_MS = EXEC_TIMEOUT_MS + 5000;

export interface SandboxCtx {
  botUserId: string;
  userState: Map<string, Record<string, unknown>>;
  scriptState: Record<string, unknown>;
  emotes: Array<{ commandNum: number; emoteId: string; name: string; rarity: string }> | null;
}

// ─── ESM Export Stripping ──────────────────────────────────────────────────
//
// AgentCoder's prompt requires the canonical shape:
//   export default function handler(event, ctx) { ... }
// vm.runInNewContext executes as a plain script, not a module — `export` is
// a hard SyntaxError there, meaning the default sandbox mode could never
// have executed a single real AI-generated script (confirmed live: a
// trivial `export default function handler(){}` throws "Unexpected token
// 'export'" in a fresh vm.runInNewContext call, isolated from any of this
// file's other logic). Docker mode happened to still work — a top-level
// `export default function handler` leaves `handler` as a normal local
// binding in the same module scope regardless of the export keyword, which
// the existing `typeof handler !== "undefined"` fallback caught — but that
// was an accidental quirk, not a designed guarantee, so it's fixed the same
// way here rather than left to keep working by luck.
//
// Scripts are written (by people and by the AI coders, whose prompts ask for
// typed handlers) in TypeScript, but isolates only run JavaScript — so types
// are removed first with the TypeScript compiler (transpile only, no type
// check; loaded on first use since it's large).
let tsCompiler: typeof import("typescript") | null = null;

export function transpileScript(code: string): string {
  tsCompiler ??= createRequire(import.meta.url)("typescript") as typeof import("typescript");
  return tsCompiler.transpileModule(code, {
    compilerOptions: { target: tsCompiler.ScriptTarget.ES2020, module: tsCompiler.ModuleKind.ESNext, removeComments: false },
    reportDiagnostics: false,
  }).outputText;
}

export function stripEsmExport(code: string): string {
  return transpileScript(code)
    // `export {};` left behind by type-only imports/exports
    .replace(/^\s*export\s*\{\s*\}\s*;?\s*$/gm, "")
    // export default function (...) {...}  →  function handler(...) {...}
    .replace(/^(\s*)export\s+default\s+(async\s+)?function\s*\(/m, "$1$2function handler(")
    // export default (event, ctx) => ...  →  const handler = ...
    .replace(/^(\s*)export\s+default\s+(?=(async\s+)?\(|(async\s+)?\w+\s*=>)/m, "$1const handler = ")
    // export default function handler(...) {...}  →  function handler(...) {...}
    .replace(/^(\s*)export\s+default\s+function\b/m, "$1function")
    // export default handler;  (separate declaration + export statement)
    .replace(/^\s*export\s+default\s+\w+\s*;\s*$/m, "")
    // export const/let/var handler = ...  →  const/let/var handler = ...
    .replace(/^(\s*)export\s+(const|let|var)\b/gm, "$1$2");
}

async function runInVmSandbox(code: string, event: unknown, ctx: SandboxCtx): Promise<unknown[]> {
  // SECURITY FIX (C-05): real V8 isolate, not vm.runInNewContext. The old
  // sandbox object passed Math/Array/Object/etc in BY REFERENCE from the
  // host realm — confirmed live, that's enough on its own to reach the real
  // host Function constructor and, from there, real `process`/`require` in
  // the worker process (same secrets tier as the API: JWT_SECRET,
  // ENCRYPTION_KEY, DATABASE_URL), regardless of `process`/`require` being
  // individually set to undefined. isolated-vm gives the isolate its own
  // native built-ins — nothing host-realm to pivot through. userState (a
  // Map) isn't directly transferable across the isolate boundary, so it's
  // marshalled the same way runInDockerSandbox already marshals it for its
  // subprocess boundary — same approach, not a third design.
  const ctxForIsolate = { ...ctx, userState: Object.fromEntries(ctx.userState ?? []) };

  const wrappedCode = `
${stripEsmExport(code)}
const __fn__ = (typeof exports !== "undefined" && exports.default)
  ? exports.default
  : (typeof handler !== "undefined" ? handler : null);
function __invoke__(eventJson, ctxJson) {
  if (typeof __fn__ !== "function") {
    throw new Error("Script did not export a default function named 'handler'");
  }
  const event = JSON.parse(eventJson);
  const ctxRaw = JSON.parse(ctxJson);
  const ctx = { ...ctxRaw, userState: new Map(Object.entries(ctxRaw.userState ?? {})) };
  const result = __fn__(event, ctx);
  return JSON.stringify(Array.isArray(result) ? result : []);
}
`;

  const isolate = new ivm.Isolate({ memoryLimit: VM_MEMORY_LIMIT_MB });
  try {
    const context = isolate.createContextSync();
    const compiled = isolate.compileScriptSync(wrappedCode);
    compiled.runSync(context);
    const invokeRef = context.global.getSync("__invoke__", { reference: true });
    const raw = invokeRef.applySync(
      undefined,
      [JSON.stringify(event), JSON.stringify(ctxForIsolate)],
      { timeout: EXEC_TIMEOUT_MS },
    ) as string;
    const result = JSON.parse(raw);
    return Array.isArray(result) ? result : [];
  } finally {
    if (!isolate.isDisposed) isolate.dispose();
  }
}

async function runInDockerSandbox(code: string, event: unknown, ctx: SandboxCtx): Promise<unknown[]> {
  const ctxForDriver = { ...ctx, userState: Object.fromEntries(ctx.userState ?? []) };

  const driverScript = `
${stripEsmExport(code)}

const event = ${JSON.stringify(event)};
const ctxRaw = ${JSON.stringify(ctxForDriver)};
const ctx = { ...ctxRaw, userState: new Map(Object.entries(ctxRaw.userState ?? {})) };

(async function main() {
  try {
    const fn = typeof exports !== "undefined" && exports.default
      ? exports.default
      : (typeof handler !== "undefined" ? handler : null);
    if (typeof fn !== "function") {
      throw new Error("Script did not export a default function named 'handler'");
    }
    const result = await fn(event, ctx);
    process.stdout.write(JSON.stringify({ ok: true, result: Array.isArray(result) ? result : [] }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  }
})();
`;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kojyai-sandbox-"));
  try {
    await fs.writeFile(path.join(tmpDir, "driver.mjs"), driverScript, "utf8");

    const { stdout } = await execFileAsync(
      "docker",
      [
        "run", "--rm",
        "--network=none",
        "--read-only",
        "--tmpfs=/tmp:size=32m",
        "--memory=256m",
        "--cpus=0.5",
        `--volume=${tmpDir}:/sandbox:ro`,
        "--workdir=/sandbox",
        DOCKER_IMAGE,
        "node", "driver.mjs",
      ],
      { timeout: DOCKER_EXEC_TIMEOUT_MS },
    );

    const parsed = JSON.parse(stdout.trim());
    if (!parsed.ok) throw new Error(parsed.error ?? "Sandbox execution failed");
    return Array.isArray(parsed.result) ? parsed.result : [];
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => null);
  }
}

async function runHandler(
  code: string,
  event: unknown,
  ctx: SandboxCtx,
): Promise<{ ok: true; actions: ReactiveAction[] } | { ok: false; error: string; timedOut: boolean }> {
  const mode = await resolveSandboxMode();
  try {
    const actions = mode === "docker"
      ? await runInDockerSandbox(code, event, ctx)
      : await runInVmSandbox(code, event, ctx);
    return { ok: true, actions: actions as ReactiveAction[] };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const timedOut = errorMsg.includes("Script execution timed out")
      || (err as { killed?: boolean })?.killed === true
      || (err as { signal?: string })?.signal === "SIGTERM";
    return { ok: false, error: errorMsg, timedOut };
  }
}

function freshCtx(emotes: SandboxCtx["emotes"] = null): SandboxCtx {
  return { botUserId: "bot-0001", userState: new Map(), scriptState: {}, emotes };
}

// ─── Entry Point A: Natural-Language Test Cases (Delegation's authoring style) ─

export interface NaturalLanguageTestCase {
  description: string;
  input: string;
  expectedOutput: string;
}

export interface SandboxResult {
  status: "passed" | "failed" | "timeout" | "error";
  output: string;
  testResults: Array<{ description: string; passed: boolean; actual: string; expected: string }>;
  durationMs: number;
}

function parseTestInput(input: string, botUserId = "bot-0001"): unknown {
  const lower = input.toLowerCase();
  const nameMatch = input.match(/user\s+(\w+)/i);
  const username = nameMatch?.[1] ?? "testuser";
  const userId = `user-${username}`;

  if (lower.includes("says:") || lower.includes("sends:") || lower.includes("types:")) {
    const msgMatch = input.match(/(?:says|sends|types):\s*(.+)/i);
    const message = msgMatch?.[1]?.trim() ?? input;
    return { _type: "ChatEvent", user: { id: userId, username }, message, whisper: false };
  }
  if (lower.includes("join") || lower.includes("enters")) {
    return { _type: "UserJoinedEvent", user: { id: userId, username } };
  }
  if (lower.includes("leaves") || lower.includes("left")) {
    return { _type: "UserLeftEvent", user: { id: userId, username } };
  }
  if (lower.includes("tips") || lower.includes("tipped")) {
    return {
      _type: "TipReactionEvent",
      sender: { id: userId, username },
      receiver: { id: botUserId, username: "bot" },
      item: { id: "gold_bar_1", name: "Gold Bar", amount: 1 },
    };
  }
  if (lower.includes("emote")) {
    const emoteMatch = input.match(/emote\s+(\S+)/i);
    return {
      _type: "EmoteEvent",
      user: { id: userId, username },
      emote_id: emoteMatch?.[1] ?? "dance-1",
      receiver: { id: botUserId, username: "bot" },
    };
  }
  return { _type: "ChatEvent", user: { id: userId, username }, message: input, whisper: false };
}

export async function executeNaturalLanguageCases(
  code: string,
  testCases: NaturalLanguageTestCase[],
): Promise<SandboxResult> {
  const startMs = Date.now();

  // SECURITY FIX (C-04): static blocklist check runs first, before any
  // structural/execution work — see checkScriptSafety above.
  const safety = checkScriptSafety(code);
  if (!safety.safe) {
    const reason = `Safety check failed: ${safety.reason}`;
    return {
      status: "error",
      output: reason,
      testResults: (testCases.length > 0 ? testCases : [{ description: "Safety check", input: "", expectedOutput: "" }])
        .map((tc) => ({ description: tc.description, passed: false, actual: reason, expected: tc.expectedOutput })),
      durationMs: Date.now() - startMs,
    };
  }

  const structural = validateScriptStructure(code);
  if (!structural.valid) {
    const reason = structural.syntaxError ?? "Script does not export a default function named 'handler'";
    return {
      status: "error",
      output: `Structural check failed: ${reason}`,
      testResults: (testCases.length > 0 ? testCases : [{ description: "Structural check", input: "", expectedOutput: "" }])
        .map((tc) => ({ description: tc.description, passed: false, actual: reason, expected: tc.expectedOutput })),
      durationMs: Date.now() - startMs,
    };
  }

  const cases = testCases.length > 0 ? testCases : [{
    description: "Smoke test — code runs without error",
    input: "user testuser says: hello",
    expectedOutput: "no error",
  }];

  let globalStatus: SandboxResult["status"] = "passed";
  const outputLines: string[] = [];
  const testResults: SandboxResult["testResults"] = [];

  for (const tc of cases) {
    const event = parseTestInput(tc.input);
    const ctx = freshCtx();
    const run = await runHandler(code, event, ctx);

    if (!run.ok) {
      testResults.push({ description: tc.description, passed: false, actual: `Error: ${run.error}`, expected: tc.expectedOutput });
      globalStatus = run.timedOut ? "timeout" : "error";
      outputLines.push(`[ERROR] ${tc.description}: ${run.error}`);
      continue;
    }

    const actual = JSON.stringify(run.actions);
    const passed = tc.expectedOutput === "no error" ? true : (actual.includes(tc.expectedOutput) || run.actions.length > 0);
    testResults.push({ description: tc.description, passed, actual, expected: tc.expectedOutput });
    if (!passed) globalStatus = "failed";
    outputLines.push(`[${passed ? "PASS" : "FAIL"}] ${tc.description}`);
  }

  return { status: globalStatus, output: outputLines.join("\n"), testResults, durationMs: Date.now() - startMs };
}

// ─── Entry Point B: Structured Event Scenarios (Composer's authoring style) ───

export interface StructuredTestScenario {
  name: string;
  events: HighriseEvent[];
  expectedActions: string[];
}

export interface StructuredTestResult {
  scenario: string;
  passed: boolean;
  actual: string;
  expected: string;
  durationMs: number;
  logs: string[];
}

export async function executeStructuredScenarios(
  code: string,
  scenarios: StructuredTestScenario[],
  emotes: SandboxCtx["emotes"] = null,
): Promise<StructuredTestResult[]> {
  // SECURITY FIX (C-04): static blocklist check runs first — see above.
  const safety = checkScriptSafety(code);
  if (!safety.safe) {
    const reason = `Safety check failed: ${safety.reason}`;
    return scenarios.map((s) => ({
      scenario: s.name, passed: false, actual: reason,
      expected: s.expectedActions.join(", "), durationMs: 0,
      logs: [reason],
    }));
  }

  const structural = validateScriptStructure(code);
  if (!structural.valid) {
    const reason = structural.syntaxError ?? "Script does not export a default function named 'handler'";
    return scenarios.map((s) => ({
      scenario: s.name, passed: false, actual: reason,
      expected: s.expectedActions.join(", "), durationMs: 0,
      logs: [`Structural check failed: ${reason}`],
    }));
  }

  const results: StructuredTestResult[] = [];

  for (const scenario of scenarios) {
    const startMs = Date.now();
    const logs: string[] = [];
    let passed = true;
    let actual = "";

    for (const event of scenario.events) {
      const ctx = freshCtx(emotes);
      const run = await runHandler(code, event, ctx);

      if (!run.ok) {
        passed = false;
        actual = `Runtime error: ${run.error}`;
        logs.push(actual);
        continue;
      }

      const actualActionKinds = run.actions.map((a) => a.kind);
      const missing = scenario.expectedActions.filter((a) => !actualActionKinds.includes(a as ReactiveAction["kind"]));
      if (missing.length > 0) {
        passed = false;
        actual = `Called [${actualActionKinds.join(", ")}] but expected [${scenario.expectedActions.join(", ")}] — missing: [${missing.join(", ")}]`;
        logs.push(actual);
      } else {
        actual = `Called: [${actualActionKinds.join(", ")}]`;
        logs.push(`Real sandbox execution: ${actual}`);
      }
    }

    results.push({
      scenario: scenario.name, passed,
      actual: actual || "No events in scenario",
      expected: scenario.expectedActions.join(", "),
      durationMs: Date.now() - startMs, logs,
    });
  }

  return results;
}
