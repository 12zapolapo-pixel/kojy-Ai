/**
 * Highrise Bot Composer — Python Sandbox Executor
 * OWNERSHIP: packages/engine/src/highrise/sandbox
 *
 * Two real, honest tiers — never fake substring matching:
 *
 *   1. AST validation (always available): real Python syntax parsing via
 *      validate_python.py, plus real function-definition/string-literal
 *      checks via AST traversal. Zero code-execution risk. Catches syntax
 *      errors and confirms handlers/commands are genuinely defined — not
 *      just present as text somewhere in the file.
 *
 *   2. Docker execution (when available): genuine dynamic execution.
 *      Writes the generated file + a stub `highrise` module + a driver
 *      script into a disposable container (--network=none --read-only
 *      --memory=256m --cpus=0.5, matching the exact isolation flags
 *      already used by packages/engine/src/delegation/SandboxExecutor.ts),
 *      instantiates the bot's class, calls the real handler with a
 *      synthetic event, and reports the actions it genuinely performed —
 *      or the real exception it raised. This catches classes of bugs AST
 *      checking cannot: wrong internal logic, calling a method that
 *      doesn't exist on the real SDK surface (a common LLM hallucination),
 *      unhandled None, etc.
 *
 * Controlled by COMPOSER_SANDBOX_MODE=docker|ast (default: ast if Docker
 * isn't detected, docker if it is and the env var is unset).
 *
 * NOTE ON PACKAGING: this module resolves its sibling .py files relative to
 * import.meta.url, which is correct for this project's actual runtime path
 * (tsx resolving @kojyai/engine straight from src/ — verified true for
 * every service in this monorepo). A future dist/-based build pipeline for
 * this package would need to copy these .py files alongside the compiled
 * output; this package has not needed a non-TS runtime asset until now.
 */

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs   from "node:fs/promises";
import os   from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

/**
 * Runs a command, writes `input` to its stdin, and resolves with stdout.
 * Needed because the promisified execFile has no stdin-piping option (that
 * only exists on the synchronous execFileSync/execSync APIs) — spawn +
 * manual stdin write is the correct async equivalent.
 */
function runWithStdin(command: string, args: string[], input: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}: ${stderr || stdout}`));
        return;
      }
      resolve(stdout);
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

const SANDBOX_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCKER_IMAGE = process.env.COMPOSER_SANDBOX_IMAGE ?? "python:3.12-slim";
const EXEC_TIMEOUT_MS = 8000; // container startup + script budget

export interface EventArgSpec {
  _type?: "User" | "Position" | "Item" | "CurrencyItem" | "SessionMetadata";
  [key: string]: unknown;
}

export interface SandboxExecResult {
  ok: boolean;
  calls: Array<{ action: string; [key: string]: unknown }>;
  error: string | null;
  traceback?: string;
}

export interface AstValidationResult {
  syntaxValid: boolean;
  syntaxError: string | null;
  foundHandlers: string[];
  missingHandlers: string[];
  foundCommands: string[];
  missingCommands: string[];
}

// L-38: availability used to be probed ONCE per process and cached forever — in both
// directions. A "yes" went stale if the daemon later died; worse, a "no" (Docker not
// started yet when the API booted, or one slow probe) permanently downgraded every
// later request to the weaker AST-only tier with nothing to say so. Now each answer
// has a TTL (a "no" is retried sooner), concurrent probes share one in-flight check,
// and any real execution failure invalidates the cache. The probe also asks the
// DAEMON (`docker version` needs a server) — `docker --version` only proves the CLI
// binary exists.
const DOCKER_UP_TTL_MS   = 60_000;
const DOCKER_DOWN_TTL_MS = 15_000;
let _dockerCheck: { available: boolean; at: number } | null = null;
let _dockerProbe: Promise<boolean> | null = null;

export function invalidateDockerAvailability(): void { _dockerCheck = null; }

async function isDockerAvailable(): Promise<boolean> {
  if (_dockerCheck && Date.now() - _dockerCheck.at < (_dockerCheck.available ? DOCKER_UP_TTL_MS : DOCKER_DOWN_TTL_MS)) {
    return _dockerCheck.available;
  }
  _dockerProbe ??= (async () => {
    let available = false;
    try {
      await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 3000 });
      available = true;
    } catch { /* CLI missing or daemon unreachable */ }
    _dockerCheck = { available, at: Date.now() };
    return available;
  })().finally(() => { _dockerProbe = null; });
  return _dockerProbe;
}

/**
 * Tier 1 — real AST-based structural validation. Always available, zero
 * execution risk. Runs validate_python.py as a subprocess with the code
 * piped over stdin (never shell-interpolated).
 */
export async function validatePythonAst(
  code: string,
  expectedHandlers: string[],
  expectedCommands: string[],
): Promise<AstValidationResult> {
  const scriptPath = path.join(SANDBOX_DIR, "validate_python.py");
  const payload = JSON.stringify({ code, expected_handlers: expectedHandlers, expected_commands: expectedCommands });

  try {
    const stdout = await runWithStdin("python3", [scriptPath], payload, 5000);
    const parsed = JSON.parse(stdout.trim());
    return {
      syntaxValid:      parsed.syntax_valid,
      syntaxError:      parsed.syntax_error,
      foundHandlers:    parsed.found_handlers,
      missingHandlers:  parsed.missing_handlers,
      foundCommands:    parsed.found_commands,
      missingCommands:  parsed.missing_commands,
    };
  } catch (err) {
    // python3 not available at all, or the validator itself crashed —
    // report this as a genuine failure rather than silently passing.
    return {
      syntaxValid: false,
      syntaxError: `Validator could not run: ${err instanceof Error ? err.message : String(err)}`,
      foundHandlers: [], missingHandlers: expectedHandlers,
      foundCommands: [], missingCommands: expectedCommands,
    };
  }
}

/**
 * Tier 2 — genuine dynamic execution in an isolated Docker container.
 * Returns null (rather than throwing) if Docker isn't available, so
 * callers can fall back to Tier 1 without treating that as a test failure.
 */
export async function runPythonBotHandler(
  mainFileContent: string,
  handlerName: string,
  eventArgs: Record<string, EventArgSpec | string | number | boolean>,
): Promise<SandboxExecResult | null> {
  if (!(await isDockerAvailable())) return null;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kojyai-composer-sandbox-"));
  try {
    await fs.writeFile(path.join(tmpDir, "bot.py"), mainFileContent, "utf8");
    await fs.copyFile(path.join(SANDBOX_DIR, "highrise_stub.py"), path.join(tmpDir, "highrise_stub.py"));
    await fs.copyFile(path.join(SANDBOX_DIR, "driver.py"), path.join(tmpDir, "driver.py"));

    const payload = JSON.stringify({ handler: handlerName, event_args: eventArgs });
    await fs.writeFile(path.join(tmpDir, "input.json"), payload, "utf8");

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
        "sh", "-c", "python3 driver.py < input.json",
      ],
      { timeout: EXEC_TIMEOUT_MS },
    );

    return JSON.parse(stdout.trim()) as SandboxExecResult;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // L-38: the cached "available" answer just proved wrong (or at least unverified).
    invalidateDockerAvailability();
    // Docker itself is unreachable (not the user's bot failing): report "no Docker
    // tier" so the caller falls back to AST validation, rather than failing the bot.
    if (/Cannot connect to the Docker daemon|error during connect|ENOENT|docker\.sock|command not found/i.test(msg)) return null;
    return { ok: false, calls: [], error: `Sandbox execution failed: ${msg}` };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => null);
  }
}
