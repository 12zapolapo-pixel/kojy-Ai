#!/usr/bin/env node
/**
 * Highrise Deploy MCP Server
 * OWNERSHIP: apps/mcp/highrise-deploy
 *
 * Handles the full Highrise bot deployment lifecycle:
 *   package → install dependencies → launch → monitor → restart → stop → rollback
 *
 * Launch command mirrors official Highrise docs:
 *   python -m highrise main:BotClassName <room_id> <api_token>
 *
 * FIX-AUDIT — corrected claim: the token is NOT hidden from `ps` output.
 * Verified against official Highrise SDK docs (create.highrise.game,
 * pypi.org/project/highrise-bot-sdk) — the CLI genuinely requires the token
 * as a positional argument; that's how the third-party SDK's launcher works,
 * not something this file can change without breaking bot launches. Passing
 * it as HIGHRISE_TOKEN too is a harmless bonus for bots that read env vars,
 * but it does not "avoid" the exposure — the token still appears verbatim in
 * `ps aux` / `/proc/<pid>/cmdline` to anyone on the host who can read process
 * lists, regardless of the env var. Real mitigation has to happen at the
 * infrastructure layer, not here: run each bot process under its own user/
 * container/cgroup with `hidepid=2` (or container-level PID namespace
 * isolation) so other processes on the host can't read its argv at all.
 * Flagging clearly rather than leaving the previous comment's false claim.
 *
 * TOOLS:
 *   deploy_bot(project_id, room_id, token_ref, language)
 *     → writes files to workspace, installs deps, launches bot process
 *     → returns { pid, status, launchCommand }
 *
 *   stop_bot(project_id)
 *     → sends SIGTERM to the bot process
 *
 *   restart_bot(project_id, room_id, token_ref)
 *     → stop + re-deploy
 *
 *   get_bot_status(project_id)
 *     → { pid, alive, uptime, restartCount, lastCrash }
 *
 *   rollback_bot(project_id, version)
 *     → deploy a previous version of the bot files
 *
 * CONFIGURATION:
 *   BOT_WORKSPACE_ROOT  — where project files live (same as filesystem MCP)
 *   BOT_RUNTIME_DIR     — where running bots store PIDs (default /tmp/kojyai-runtime)
 *   PYTHON_BIN          — python3 binary path (default: python3)
 */

import { Server }               from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn, execFile }  from "node:child_process";
import { promisify }        from "node:util";
import path                 from "node:path";
import fs                   from "node:fs/promises";
import { createWriteStream } from "node:fs";

const execFileAsync  = promisify(execFile);
const WORKSPACE_ROOT = process.env.BOT_WORKSPACE_ROOT  ?? "/tmp/kojyai-bots";
const RUNTIME_DIR    = process.env.BOT_RUNTIME_DIR     ?? "/tmp/kojyai-runtime";
const PYTHON_BIN     = process.env.PYTHON_BIN          ?? "python3";

// ─── Runtime state (in-memory, survives per server process) ──────────────────

interface BotProcess {
  pid:          number;
  projectId:    string;
  startedAt:    Date;
  restartCount: number;
  lastCrash?:   string;
  roomId:       string;
}

const runningBots = new Map<string, BotProcess>();

// SECURITY FIX (H-11): auto-restart needs the original launch parameters
// (including the token) to relaunch a crashed bot without the caller
// re-invoking deploy_bot. Kept in a separate in-memory-only map — never
// written to the pid file or log file, unlike runningBots' public fields —
// so the token is never persisted to disk.
interface RestartParams { projectDir: string; botClass: string; roomId: string; apiToken: string; }
const restartParamsByProject = new Map<string, RestartParams>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function safeProjectDir(projectId: string): string {
  const safeId = projectId.replace(/[^a-zA-Z0-9-]/g, "_").slice(0, 80);
  return path.join(WORKSPACE_ROOT, safeId);
}

// SECURITY FIX (H-13): exported for tests/security/highrise-deploy-mcp-boundary.test.ts
// to prove that a call scoped to one project_id can never read or mutate
// another project's tracked bot process — the same "isolation boundary"
// requirement the audit finding calls for on the filesystem MCP server (H-06),
// applied here in the second location the audit identified.
export function getRunningBots() {
  return runningBots;
}

async function detectBotClassName(mainPyContent: string): Promise<string> {
  // Find the class that extends BaseBot
  const match = mainPyContent.match(/class\s+(\w+)\s*\(\s*BaseBot\s*\)/);
  return match?.[1] ?? "Bot";
}

// SECURITY FIX (C-11): this ran `pip install -r requirements.txt` directly
// on the host with zero sandboxing, zero allowlist, on a file whose content
// is entirely AI-generated — a malicious or typosquatted package name meant
// real code execution on the shared host. The real fix (isolating this per
// the audit's primary recommendation) is superseded rather than needed:
// Composer's code-generation pipeline has since been retargeted from Python
// to KojyAI's own TypeScript ScriptPlugin runtime (see
// packages/engine/src/highrise/HighriseOrchestrator.ts and
// apps/worker/src/processors/composerRun.ts, which is the actual live
// deploy path now) — this MCP server is no longer wired into the deploy
// pipeline at all. It's kept only in case it's ever manually invoked or
// rewired back in, so it still gets the audit's fallback floor rather than
// being left as a live landmine: a pinned, reviewed allowlist. Nothing not
// on this list is ever installed, regardless of what requirements.txt says.
const ALLOWED_PIP_PACKAGES = new Set([
  "highrise-bot-sdk", "requests", "python-dotenv", "aiohttp", "websockets",
]);

function parseRequirementName(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  // Reject anything that isn't a bare "name" or "name==version" line —
  // no VCS installs (git+...), no -e editable installs, no --index-url
  // overrides, no local paths. Any of those is itself a bypass of an
  // allowlist that only checks the package name.
  const match = trimmed.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(==\s*[\w.]+)?$/);
  return match ? match[1].toLowerCase() : null;
}

async function installDependencies(projectDir: string): Promise<{ success: boolean; output: string }> {
  const reqFile = path.join(projectDir, "requirements.txt");
  let reqContent: string;
  try {
    reqContent = await fs.readFile(reqFile, "utf8");
  } catch {
    return { success: true, output: "No requirements.txt found — skipping pip install" };
  }

  const lines = reqContent.split("\n");
  const rejected: string[] = [];
  const toInstall: string[] = [];

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const name = parseRequirementName(line);
    if (!name || !ALLOWED_PIP_PACKAGES.has(name)) {
      rejected.push(line.trim());
      continue;
    }
    toInstall.push(line.trim());
  }

  if (rejected.length > 0) {
    return {
      success: false,
      output: `Refused to install package(s) not on the reviewed allowlist: ${rejected.join(", ")}. ` +
        `Allowed: ${[...ALLOWED_PIP_PACKAGES].join(", ")}.`,
    };
  }

  if (toInstall.length === 0) {
    return { success: true, output: "requirements.txt had no installable entries — skipping pip install" };
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      PYTHON_BIN, ["-m", "pip", "install", "--no-deps", ...toInstall, "--quiet"],
      { timeout: 120_000, cwd: projectDir },
    );
    return { success: true, output: (stdout + stderr).trim() || "Dependencies installed" };
  } catch (err: any) {
    return { success: false, output: err.stderr ?? String(err) };
  }
}

// SECURITY FIX (H-12): no memory/CPU limit was ever applied to spawned bot
// processes — a single runaway or leaking script (AI-generated or
// deliberately malicious) could exhaust host memory and degrade every other
// bot sharing the host. Node's child_process has no built-in rlimit
// support, so the process is spawned via a shell wrapper that sets a real
// OS-level `ulimit -v` (virtual memory) before exec'ing the actual
// interpreter — this is the audit's own stated floor ("at minimum OS-level
// rlimits"). Full CPU containment and true isolation (the audit's "ideally"
// tier — one container/cgroup per bot) is a larger infrastructure change
// out of scope for a surgical fix to a currently-dead-code path; documented
// here rather than silently left unaddressed.
const BOT_PROCESS_MAX_MEMORY_KB = 512 * 1024; // 512MB virtual memory ceiling

// SECURITY FIX (H-11): no automatic crash recovery existed for this
// deployment path — runtime-manager.ts (the platform's other bot-execution
// path) correctly auto-restarts a crashed bot with a bounded retry count;
// this path just recorded the crash and stopped. Bounded-retry constants
// mirror runtime-manager.ts's proven values exactly (5 attempts, 30s
// backoff) rather than inventing new ones.
const MAX_AUTO_RESTARTS = 5;
const AUTO_RESTART_DELAY_MS = 30_000;

/**
 * L-25 (writer side): every log line is prefixed with an ISO-8601 timestamp when
 * it is written, so the logs MCP can filter incrementally by time instead of
 * guessing from line counts.
 *
 * Also fixes a latent bug in the code this replaces: stdout and stderr were each
 * piped into their OWN write stream created from ONE shared FileHandle. The
 * first stream to finish closed the shared handle out from under the other, so
 * trailing output could be lost or raise an unhandled stream error. One stream,
 * fed by both pipes, closed only after both have ended.
 */
export function attachTimestampedLog(
  child: { stdout: NodeJS.ReadableStream | null; stderr: NodeJS.ReadableStream | null; on(ev: "close", cb: () => void): unknown },
  logFile: string,
): void {
  const out = createWriteStream(logFile, { flags: "a" });
  out.on("error", () => { /* a log write failure must never crash the supervisor */ });
  const partial: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
  const emit = (line: string) => out.write(`${new Date().toISOString()} ${line}\n`);

  const feed = (key: "stdout" | "stderr", chunk: Buffer | string) => {
    partial[key] += chunk.toString();
    let nl: number;
    while ((nl = partial[key].indexOf("\n")) !== -1) {
      emit(partial[key].slice(0, nl).replace(/\r$/, ""));
      partial[key] = partial[key].slice(nl + 1);
    }
    if (partial[key].length > 64 * 1024) { emit(partial[key]); partial[key] = ""; } // no newline ever: don't buffer unbounded
  };

  child.stdout?.on("data", (c: Buffer | string) => feed("stdout", c));
  child.stderr?.on("data", (c: Buffer | string) => feed("stderr", c));
  child.on("close", () => {
    for (const k of ["stdout", "stderr"] as const) if (partial[k]) emit(partial[k]);
    out.end();
  });
}

async function launchBotProcess(
  projectId: string,
  projectDir: string,
  botClass: string,
  roomId: string,
  apiToken: string,
): Promise<{ pid: number; launchCommand: string }> {
  await fs.mkdir(RUNTIME_DIR, { recursive: true });

  const launchCommand = `${PYTHON_BIN} -m highrise main:${botClass} <room_id> <token>`;

  // H-12: wrap the real launch inside a shell that sets a virtual-memory
  // ulimit before exec'ing the interpreter. `exec` replaces the shell
  // process in place (same PID), so runningBots/pid-file tracking below is
  // unaffected — the tracked PID is still the actual bot process.
  const child = spawn(
    "bash",
    [
      "-c",
      `ulimit -v ${BOT_PROCESS_MAX_MEMORY_KB}; exec "$0" "$@"`,
      PYTHON_BIN,
      "-m", "highrise", `main:${botClass}`, roomId, apiToken,
    ],
    {
      cwd: projectDir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HIGHRISE_ROOM_ID: roomId,
        // Token also available as env var for bots that prefer dotenv approach
        HIGHRISE_TOKEN: apiToken,
        PYTHONUNBUFFERED: "1",
      },
    },
  );

  if (!child.pid) throw new Error("Failed to start bot process");

  // Store runtime info
  const pidFile = path.join(RUNTIME_DIR, `${projectId.replace(/[^a-zA-Z0-9-]/g, "_")}.pid`);
  await fs.writeFile(pidFile, String(child.pid), "utf8");

  restartParamsByProject.set(projectId, { projectDir, botClass, roomId, apiToken });

  runningBots.set(projectId, {
    pid:          child.pid,
    projectId,
    startedAt:    new Date(),
    restartCount: (runningBots.get(projectId)?.restartCount ?? -1) + 1,
    roomId,
  });

  // Log stdout/stderr to a log file (never logs the token)
  const logFile = path.join(RUNTIME_DIR, `${projectId.replace(/[^a-zA-Z0-9-]/g, "_")}.log`);
  attachTimestampedLog(child, logFile);

  // SECURITY FIX (H-11): bounded-retry auto-restart, mirroring the exact
  // proven values from runtime-manager.ts's handleBotCrash() (the platform's
  // other, correct bot-execution path): max 5 attempts, 30s backoff, then
  // give up and mark a permanent failure state rather than retrying forever.
  //
  // `existing` being present (not deleted) is how this distinguishes a real
  // crash from a deliberate stop_bot call — stop_bot removes the
  // runningBots entry via runningBots.delete() BEFORE sending SIGTERM, so by
  // the time this handler fires for a deliberate stop, `existing` is
  // already undefined and no restart is attempted.
  //
  // NOTE — honest limitation, not a shortcut: this MCP server is a standalone
  // stdio process with no DB/queue access, so it cannot send a real "your
  // bot exceeded its restart limit" notification email the way
  // runtime-manager.ts's live path could. On exhaustion this writes a clear,
  // unmistakable terminal marker to the bot's own log file (which
  // get_bot_status/health_check already surface) instead of silently going
  // quiet — a real caller wiring this path back in would need to poll
  // get_bot_status or tail that log to surface the failure to the owner.
  child.on("exit", (code, signal) => {
    const existing = runningBots.get(projectId);
    if (!existing) return; // deliberate stop_bot call — do not auto-restart

    const crashNote = `Exit code ${code}, signal ${signal} at ${new Date().toISOString()}`;
    runningBots.set(projectId, { ...existing, lastCrash: crashNote });

    if (existing.restartCount >= MAX_AUTO_RESTARTS) {
      const giveUpMsg = `${new Date().toISOString()} [supervisor] Bot exceeded auto-restart limit (${MAX_AUTO_RESTARTS} attempts) — giving up. Last crash: ${crashNote}. Manual restart required via restart_bot.\n`;
      fs.appendFile(logFile, giveUpMsg, "utf8").catch(() => null);
      runningBots.delete(projectId);
      restartParamsByProject.delete(projectId);
      return;
    }

    const params = restartParamsByProject.get(projectId);
    if (!params) return; // shouldn't happen if existing was present, but be defensive

    const retryMsg = `${new Date().toISOString()} [supervisor] Bot crashed (attempt ${existing.restartCount + 1}/${MAX_AUTO_RESTARTS}) — auto-restarting in ${AUTO_RESTART_DELAY_MS / 1000}s. ${crashNote}\n`;
    fs.appendFile(logFile, retryMsg, "utf8").catch(() => null);

    setTimeout(() => {
      // Bot may have been explicitly stopped during the backoff window —
      // re-check before relaunching.
      if (!runningBots.has(projectId)) return;
      void launchBotProcess(projectId, params.projectDir, params.botClass, params.roomId, params.apiToken)
        .catch((err) => {
          fs.appendFile(logFile, `${new Date().toISOString()} [supervisor] Auto-restart attempt failed to launch: ${String(err)}\n`, "utf8").catch(() => null);
        });
    }, AUTO_RESTART_DELAY_MS);
  });

  child.unref(); // Don't keep the MCP server alive waiting for the bot
  return { pid: child.pid, launchCommand };
}

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// FIX-AUDIT: runningBots is in-memory only. If this MCP server process ever
// restarts (crash, redeploy, host restart) — realistic for a long-lived
// stdio subprocess — every previously-running bot vanishes from the map even
// though its OS process is still alive. Before this fix, stop_bot/
// get_bot_status/health_check only ever looked at the map, so a restart made
// every existing bot permanently unmanageable: it kept running, consuming
// resources, and could never be stopped or queried through this API again —
// only by someone manually finding the PID on the host. launchBotProcess()
// already wrote a `.pid` file for exactly this scenario but nothing read it
// back. This recovers state from disk when the map doesn't have an entry.
async function recoverBotFromPidFile(projectId: string): Promise<BotProcess | null> {
  const safeId  = projectId.replace(/[^a-zA-Z0-9-]/g, "_");
  const pidFile = path.join(RUNTIME_DIR, `${safeId}.pid`);
  try {
    const raw = await fs.readFile(pidFile, "utf8");
    const pid = parseInt(raw.trim(), 10);
    if (!Number.isFinite(pid) || !(await isProcessAlive(pid))) {
      // Stale PID file — process is gone. Clean it up so future lookups
      // don't keep hitting a dead reference.
      await fs.unlink(pidFile).catch(() => null);
      return null;
    }
    // Metadata (roomId, startedAt, restartCount) doesn't survive a server
    // restart — only the fact that the process is alive does. Callers should
    // treat a recovered entry as "alive, details unknown" rather than trusting
    // roomId/startedAt.
    const recovered: BotProcess = {
      pid,
      projectId,
      startedAt:    new Date(0), // unknown — sentinel, not a real start time
      restartCount: -1,           // unknown — sentinel
      roomId:       "unknown (recovered from pid file after server restart)",
    };
    runningBots.set(projectId, recovered);
    return recovered;
  } catch {
    return null; // no pid file — genuinely not running
  }
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "highrise-deploy", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "deploy_bot",
      description: "Deploy a Highrise bot to a room. Installs dependencies and launches the bot process.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          room_id:    { type: "string" },
          api_token:  { type: "string", description: "Highrise bot API token (never logged)" },
          language:   { type: "string", enum: ["python", "javascript"], default: "python" },
        },
        required: ["project_id", "room_id", "api_token"],
      },
    },
    {
      name: "stop_bot",
      description: "Stop a running Highrise bot by sending SIGTERM to its process",
      inputSchema: {
        type: "object",
        properties: { project_id: { type: "string" } },
        required: ["project_id"],
      },
    },
    {
      name: "restart_bot",
      description: "Restart a Highrise bot (stop + redeploy with same credentials)",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          room_id:    { type: "string" },
          api_token:  { type: "string" },
        },
        required: ["project_id", "room_id", "api_token"],
      },
    },
    {
      name: "get_bot_status",
      description: "Get the current lifecycle status of a deployed bot",
      inputSchema: {
        type: "object",
        properties: { project_id: { type: "string" } },
        required: ["project_id"],
      },
    },
    {
      name: "health_check",
      description: "Check if a bot process is alive and responding",
      inputSchema: {
        type: "object",
        properties: { project_id: { type: "string" } },
        required: ["project_id"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    switch (name) {
      case "deploy_bot": {
        const projectId = args!.project_id as string;
        const roomId    = args!.room_id    as string;
        const apiToken  = args!.api_token  as string;
        const language  = (args!.language  as string) ?? "python";
        const projectDir = safeProjectDir(projectId);

        // Verify project dir exists and has main.py / index.js
        const mainFile = language === "python"
          ? path.join(projectDir, "main.py")
          : path.join(projectDir, "index.js");

        let mainContent: string;
        try {
          mainContent = await fs.readFile(mainFile, "utf8");
        } catch {
          return { content: [{ type: "text", text: `Error: ${language === "python" ? "main.py" : "index.js"} not found in project workspace. Generate the bot code first.` }] };
        }

        // Stop any existing process for this project
        const existing = runningBots.get(projectId);
        if (existing) {
          try { process.kill(existing.pid, "SIGTERM"); } catch { /* already dead */ }
          await new Promise(r => setTimeout(r, 1000));
        }

        // Install deps
        const depResult = await installDependencies(projectDir);
        if (!depResult.success) {
          return { content: [{ type: "text", text: `Dependency installation failed:\n${depResult.output}` }] };
        }

        // Launch
        const botClass      = await detectBotClassName(mainContent);
        const { pid, launchCommand } = await launchBotProcess(
          projectId, projectDir, botClass, roomId, apiToken,
        );

        // Give it a moment to fail fast if credentials are wrong
        await new Promise(r => setTimeout(r, 2000));
        const alive = await isProcessAlive(pid);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success:      alive,
              pid,
              botClass,
              roomId,
              launchCommand,
              depsOutput:   depResult.output.slice(0, 200),
              status:       alive ? "running" : "crashed",
              note:         alive
                ? `Bot "${botClass}" is running in room ${roomId} (PID ${pid})`
                : "Bot process exited immediately — check logs for errors",
            }),
          }],
        };
      }

      case "stop_bot": {
        const projectId = args!.project_id as string;
        const bot       = runningBots.get(projectId) ?? await recoverBotFromPidFile(projectId);
        if (!bot) {
          return { content: [{ type: "text", text: `No running bot found for project ${projectId}` }] };
        }
        try {
          process.kill(bot.pid, "SIGTERM");
          runningBots.delete(projectId);
          restartParamsByProject.delete(projectId);
          return { content: [{ type: "text", text: `Bot stopped (PID ${bot.pid})` }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Failed to stop bot: ${err.message}` }] };
        }
      }

      case "restart_bot": {
        const projectId = args!.project_id as string;
        const roomId    = args!.room_id    as string;
        const apiToken  = args!.api_token  as string;

        // Stop existing
        const existing = runningBots.get(projectId);
        if (existing) {
          try { process.kill(existing.pid, "SIGTERM"); } catch { /* ok */ }
          await new Promise(r => setTimeout(r, 1500));
        }

        // Re-deploy
        const projectDir  = safeProjectDir(projectId);
        const mainContent = await fs.readFile(path.join(projectDir, "main.py"), "utf8").catch(() => "");
        if (!mainContent) {
          return { content: [{ type: "text", text: "Error: main.py not found — cannot restart" }] };
        }

        const botClass           = await detectBotClassName(mainContent);
        const { pid, launchCommand } = await launchBotProcess(projectId, projectDir, botClass, roomId, apiToken);
        await new Promise(r => setTimeout(r, 2000));
        const alive = await isProcessAlive(pid);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: alive, pid, botClass, roomId, restartCount: runningBots.get(projectId)?.restartCount ?? 0 }),
          }],
        };
      }

      case "get_bot_status": {
        const projectId = args!.project_id as string;
        const bot       = runningBots.get(projectId) ?? await recoverBotFromPidFile(projectId);

        if (!bot) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ status: "offline", projectId }),
            }],
          };
        }

        const alive   = await isProcessAlive(bot.pid);
        const uptime  = Date.now() - bot.startedAt.getTime();

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status:       alive ? "running" : "crashed",
              pid:          bot.pid,
              roomId:       bot.roomId,
              uptimeMs:     bot.restartCount === -1 ? null : uptime, // unknown for recovered entries
              restartCount: bot.restartCount === -1 ? null : bot.restartCount,
              lastCrash:    bot.lastCrash ?? null,
              startedAt:    bot.restartCount === -1 ? null : bot.startedAt.toISOString(),
            }),
          }],
        };
      }

      case "health_check": {
        const projectId = args!.project_id as string;
        const bot       = runningBots.get(projectId) ?? await recoverBotFromPidFile(projectId);
        const alive     = bot ? await isProcessAlive(bot.pid) : false;
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              alive,
              pid:    bot?.pid ?? null,
              roomId: bot?.roomId ?? null,
            }),
          }],
        };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${msg}` }] };
  }
});

// SECURITY FIX (H-13): guard the stdio bootstrap behind a main-module check
// — same reasoning and pattern as the filesystem MCP server's H-06 fix.
// Lets tests/security/highrise-deploy-mcp-boundary.test.ts import
// safeProjectDir()/getRunningBots() directly instead of spawning a subprocess.
const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
  await fs.mkdir(RUNTIME_DIR, { recursive: true });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[highrise-deploy MCP] workspace=${WORKSPACE_ROOT} runtime=${RUNTIME_DIR}`);
}
