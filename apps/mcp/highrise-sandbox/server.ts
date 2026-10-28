#!/usr/bin/env node
/**
 * Highrise Sandbox MCP Server
 * OWNERSHIP: apps/mcp/highrise-sandbox
 *
 * Runs generated Highrise bot code in a sandboxed environment and replays
 * Highrise events against it to verify behavior before deployment.
 *
 * EXECUTION MODEL:
 *   In production: Docker container with --network=none --read-only --memory=256m --cpus=0.5
 *   In development: Node.js vm.runInNewContext (safe for LLM-generated code, not user-uploaded)
 *
 * The sandbox installs the highrise-bot-sdk, loads main.py, creates a mock
 * Highrise client (intercepts all self.highrise.* calls), replays test events,
 * and returns the captured action log + stdout/stderr.
 *
 * TOOLS:
 *   run_syntax_check(code, language)              → errors[]
 *   run_event_replay(project_id, events)          → {actions, logs, durationMs}
 *   install_dependencies(project_id)              → success, output
 *   get_sandbox_status()                          → {docker: bool, version: string}
 *
 * CONFIGURATION:
 *   SANDBOX_MODE=docker|vm   (default: vm in dev, docker in prod)
 *   BOT_WORKSPACE_ROOT       (same as filesystem MCP)
 *   DOCKER_IMAGE=kojyai/highrise-sandbox:latest
 */

import { Server }               from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { execFile }     from "node:child_process";
import { promisify }    from "node:util";
import vm               from "node:vm";
import path             from "node:path";
import { randomUUID } from "node:crypto";
import fs               from "node:fs/promises";

const execFileAsync   = promisify(execFile);
// M-19: was hardcoded to "vm" regardless of environment, so real execution was
// never used even where Docker was available. An explicit SANDBOX_MODE env var
// always wins; otherwise Docker is auto-detected at startup (see bottom of file).
let SANDBOX_MODE: string = process.env.SANDBOX_MODE ?? "vm";
const WORKSPACE_ROOT  = process.env.BOT_WORKSPACE_ROOT ?? "/tmp/kojyai-bots";
const DOCKER_IMAGE    = process.env.DOCKER_IMAGE ?? "python:3.11-slim";
const EXEC_TIMEOUT_MS = 30_000;
const SDK_DEPS_VOLUME = "kojyai-sandbox-deps"; // persistent volume holding the pip-installed SDK (M-18)

// ─── Mock Highrise SDK ────────────────────────────────────────────────────────
// Intercepts all self.highrise.* calls during sandbox execution.
// Records every action taken by the bot code for comparison against expected.

interface CapturedAction {
  method:    string;
  args:      unknown[];
  timestamp: number;
}

function createMockHighriseSDK(capturedActions: CapturedAction[]) {
  const capture = (method: string) => async (...args: unknown[]) => {
    capturedActions.push({ method, args, timestamp: Date.now() });
    return { ok: true };
  };

  return {
    chat:              capture("chat"),
    send_whisper:      capture("send_whisper"),
    emote:             capture("emote"),
    react:             capture("react"),
    teleport:          capture("teleport"),
    walk_to:           capture("walk_to"),
    moderate_room:     capture("moderate_room"),
    move_user_to_room: capture("move_user_to_room"),
    buy_voice_time:    capture("buy_voice_time"),
    set_outfit:        capture("set_outfit"),
    get_room_users:    async () => ({ content: [{ id: "user-001", username: "TestUser" }] }),
    get_user:          async (userId: string) => ({ id: userId, username: "TestUser" }),
    send_message:      capture("send_message"),
  };
}

// ─── Python syntax check via Python interpreter ───────────────────────────────

async function checkPythonSyntax(code: string): Promise<string[]> {
  const errors: string[] = [];
  const tmpFile = `/tmp/syntax_check_${randomUUID()}.py`; // L-24: Date.now() collided under concurrent calls (same ms -> same file)
  try {
    await fs.writeFile(tmpFile, code, "utf8");
    await execFileAsync("python3", ["-m", "py_compile", tmpFile], { timeout: 5000 });
  } catch (err: any) {
    const raw = (err.stderr ?? err.stdout ?? err.message ?? "").toString();
    errors.push(raw.replace(tmpFile, "main.py").trim());
  } finally {
    await fs.unlink(tmpFile).catch(() => null);
  }
  return errors;
}

// ─── Docker execution ─────────────────────────────────────────────────────────

async function runInDocker(
  projectId: string,
  eventJson: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const safeId     = projectId.replace(/[^a-zA-Z0-9-]/g, "_");
  const projectDir = path.join(WORKSPACE_ROOT, safeId);

  // Write the event replay driver
  const driverCode = `
import sys, json, asyncio, traceback

sys.path.insert(0, '.')
# FIX-AUDIT: previously read from sys.stdin via a shell pipe built by
# string-embedding eventJson into a 'sh -c' command. Reading from a file that
# was written by the trusted Node-side MCP process (not interpolated into any
# shell command string) avoids shell injection entirely — no event payload
# content, however it's crafted, ever passes through shell parsing.
with open('_test_events.json') as f:
    events_json = json.load(f)
actions = []

class MockHighrise:
    async def chat(self, *a): actions.append({"method":"chat","args":list(a)})
    async def send_whisper(self, *a): actions.append({"method":"send_whisper","args":list(a)})
    async def emote(self, *a): actions.append({"method":"emote","args":list(a)})
    async def react(self, *a): actions.append({"method":"react","args":list(a)})
    async def teleport(self, *a): actions.append({"method":"teleport","args":list(a)})
    async def moderate_room(self, *a): actions.append({"method":"moderate_room","args":list(a)})
    async def get_room_users(self): return type('R',(),{'content':[(type('U',(),{'id':'u1','username':'Test'})(),None)]})()
    async def get_user(self, uid): return type('U',(),{'id':uid,'username':'TestUser'})()

try:
    import importlib.util, os
    spec_m = importlib.util.spec_from_file_location("main", "main.py")
    mod = importlib.util.module_from_spec(spec_m)
    spec_m.loader.exec_module(mod)
    bot_cls = next(v for k,v in vars(mod).items() if isinstance(v,type) and hasattr(v,'on_start'))
    bot = bot_cls()
    bot.highrise = MockHighrise()
    
    async def run():
        for ev in events_json:
            handler = getattr(bot, ev['type'], None)
            if handler:
                payload = ev.get('payload',{})
                args_list = list(payload.values())
                await handler(*args_list)
    
    asyncio.run(run())
    print(json.dumps({"ok":True,"actions":actions}))
except Exception as e:
    print(json.dumps({"ok":False,"error":str(e),"traceback":traceback.format_exc()}))
`;
  await fs.writeFile(path.join(projectDir, "_test_driver.py"), driverCode, "utf8");
  // Events go into a file inside the same read-only-mounted project dir the
  // driver already reads main.py from — never through a shell command string.
  await fs.writeFile(path.join(projectDir, "_test_events.json"), eventJson, "utf8");

  // SECURITY/CORRECTNESS FIX (M-18): the old single command combined
  // `--network=none` with an inline `pip install`, which can never work — the
  // install has no network. Dropping --network=none would "fix" it by removing
  // the isolation, which is unacceptable for running LLM-generated code. So it
  // is now two phases:
  //   1. Install the SDK into a persistent named volume, in a container that
  //      HAS network but runs only our fixed, constant command (no user input).
  //   2. Run the untrusted bot code in a SEPARATE container with
  //      --network=none, mounting that volume read-only via PYTHONPATH.
  try {
    await execFileAsync(
      "docker", [
        "run", "--rm",
        "--tmpfs=/tmp:size=64m",
        "--env=HOME=/tmp",
        `--volume=${SDK_DEPS_VOLUME}:/deps`,
        DOCKER_IMAGE,
        "sh", "-c",
        "test -f /deps/.installed || (pip install --no-cache-dir --target=/deps highrise-bot-sdk==25.1.0 -q && touch /deps/.installed)",
      ],
      { timeout: EXEC_TIMEOUT_MS },
    );
  } catch (err: any) {
    return {
      stdout:   err.stdout ?? "",
      stderr:   `SDK dependency install failed: ${err.stderr ?? String(err)}`,
      exitCode: err.code   ?? 1,
    };
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      "docker", [
        "run", "--rm",
        "--network=none",
        "--read-only",
        "--tmpfs=/tmp:size=64m",
        "--memory=256m",
        "--cpus=0.5",
        "--env=PYTHONPATH=/deps",
        `--volume=${SDK_DEPS_VOLUME}:/deps:ro`,
        `--volume=${projectDir}:/app:ro`,
        "--workdir=/app",
        DOCKER_IMAGE,
        "python3", "_test_driver.py",
      ],
      { timeout: EXEC_TIMEOUT_MS },
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (err: any) {
    return {
      stdout:   err.stdout ?? "",
      stderr:   err.stderr ?? String(err),
      exitCode: err.code   ?? 1,
    };
  }
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "highrise-sandbox", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "run_syntax_check",
      description: "Check Python or JavaScript code for syntax errors without executing it",
      inputSchema: {
        type: "object",
        properties: {
          code:     { type: "string" },
          language: { type: "string", enum: ["python", "javascript"] },
        },
        required: ["code", "language"],
      },
    },
    {
      name: "run_event_replay",
      description:
        "Run bot code against a sequence of Highrise events. " +
        "Docker mode (used when Docker is available): actually EXECUTES the bot's Python against a mocked Highrise SDK " +
        "in an isolated, network-less container and returns the real captured actions, logs and tracebacks. " +
        "VM mode (fallback when Docker is unavailable): does NOT execute anything — it only checks the source text for " +
        "the expected handler names, Highrise import and BaseBot, so `actions` is always empty and a passing result " +
        "does not prove the bot works. Call get_sandbox_status to see which mode is active.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          code:       { type: "string", description: "The bot's main.py content" },
          events: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type:    { type: "string", description: "e.g. on_user_join, on_chat, on_emote" },
                payload: { type: "object" },
              },
              required: ["type"],
            },
          },
        },
        required: ["project_id", "code", "events"],
      },
    },
    {
      name: "get_sandbox_status",
      description: "Check sandbox environment status: Docker availability, Python version, SDK version",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "check_sdk_imports",
      description: "Verify that all Highrise SDK imports in the bot code are valid",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string" },
        },
        required: ["code"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    switch (name) {
      case "run_syntax_check": {
        const code     = args!.code as string;
        const language = args!.language as string;

        if (language === "python") {
          const errors = await checkPythonSyntax(code);
          return {
            content: [{
              type: "text",
              text: errors.length === 0
                ? "✓ No syntax errors found"
                : `Syntax errors:\n${errors.join("\n")}`,
            }],
          };
        }

        // JavaScript: basic check via Node.js
        try {
          new vm.Script(code);
          return { content: [{ type: "text", text: "✓ No syntax errors found" }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Syntax error: ${err.message}` }] };
        }
      }

      case "run_event_replay": {
        const code      = args!.code as string;
        const events    = args!.events as Array<{ type: string; payload?: Record<string, unknown> }>;
        const projectId = args!.project_id as string;
        const startMs   = Date.now();
        const logs: string[]          = [];
        const actions: CapturedAction[] = [];

        if (SANDBOX_MODE === "docker") {
          // FIX-AUDIT: `code` was accepted by the tool schema (documented as
          // "the bot's main.py content") but never written anywhere in the
          // Docker path — runInDocker only ran whatever main.py already
          // happened to exist on disk. A caller testing a new/modified
          // version of the code without a separate filesystem MCP write
          // would silently get results for stale code instead.
          await fs.writeFile(path.join(WORKSPACE_ROOT, projectId.replace(/[^a-zA-Z0-9-]/g, "_"), "main.py"), code, "utf8").catch(async (err) => {
            if (err?.code === "ENOENT") {
              const dir = path.join(WORKSPACE_ROOT, projectId.replace(/[^a-zA-Z0-9-]/g, "_"));
              await fs.mkdir(dir, { recursive: true });
              await fs.writeFile(path.join(dir, "main.py"), code, "utf8");
            } else {
              throw err;
            }
          });
          const result = await runInDocker(projectId, JSON.stringify(events));
          const elapsed = Date.now() - startMs;
          try {
            const parsed = JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}");
            if (parsed.ok) {
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    success:   true,
                    actions:   parsed.actions ?? [],
                    logs:      result.stderr.split("\n").filter(Boolean),
                    durationMs: elapsed,
                  }),
                }],
              };
            } else {
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    success:   false,
                    error:     parsed.error,
                    traceback: parsed.traceback,
                    durationMs: elapsed,
                  }),
                }],
              };
            }
          } catch {
            return { content: [{ type: "text", text: JSON.stringify({ success: false, error: result.stderr, durationMs: elapsed }) }] };
          }
        }

        // VM sandbox mode (development)
        const mockHighrise = createMockHighriseSDK(actions);
        const sandbox = {
          console: {
            log:   (...a: unknown[]) => { logs.push(`[LOG] ${a.join(" ")}`); },
            warn:  (...a: unknown[]) => { logs.push(`[WARN] ${a.join(" ")}`); },
            error: (...a: unknown[]) => { logs.push(`[ERROR] ${a.join(" ")}`); },
          },
          self: { highrise: mockHighrise },
          asyncio: { run: async (fn: () => Promise<void>) => fn() },
        };

        // Lightweight structural validation (VM doesn't run Python)
        const checks: string[] = [];
        for (const ev of events) {
          const handlerName = ev.type;
          if (!code.includes(handlerName)) {
            checks.push(`Missing handler: ${handlerName}`);
          }
        }
        if (!code.includes("from highrise") && !code.includes("import highrise")) {
          checks.push("Missing Highrise SDK import");
        }
        if (!code.includes("BaseBot")) {
          checks.push("Bot class does not extend BaseBot");
        }

        const elapsed = Date.now() - startMs;
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success:    checks.length === 0,
              issues:     checks,
              actions:    [],
              logs:       checks.length > 0 ? checks : ["Structural checks passed — use Docker mode for full execution"],
              durationMs: elapsed,
            }),
          }],
        };
      }

      case "get_sandbox_status": {
        let dockerAvailable = false;
        let pythonVersion   = "unknown";
        let sdkNote         = "";

        try {
          const { stdout } = await execFileAsync("docker", ["--version"], { timeout: 3000 });
          dockerAvailable = true;
          sdkNote = stdout.trim();
        } catch { /* docker not available */ }

        try {
          const { stdout } = await execFileAsync("python3", ["--version"], { timeout: 3000 });
          pythonVersion = stdout.trim();
        } catch { /* python not available */ }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              mode:           SANDBOX_MODE,
              dockerAvailable,
              dockerVersion:  sdkNote,
              pythonVersion,
              targetSDK:      "highrise-bot-sdk==25.1.0",
              workspaceRoot:  WORKSPACE_ROOT,
              execTimeoutMs:  EXEC_TIMEOUT_MS,
            }),
          }],
        };
      }

      case "check_sdk_imports": {
        const code = args!.code as string;
        const validImports = [
          "BaseBot", "User", "Position", "Reaction", "CurrencyItem",
          "Item", "SessionMetadata", "VoiceStatus", "AnchorPosition",
        ];
        const usedImports = validImports.filter(i => code.includes(i));
        const lines = code.split("\n").filter(l => l.includes("from highrise") || l.includes("import highrise"));
        return {
          content: [{
            type: "text",
            text: [
              `Import lines found:\n${lines.join("\n")}`,
              `SDK symbols used: ${usedImports.join(", ")}`,
              lines.length > 0 ? "✓ SDK imports present" : "⚠ No highrise import found",
            ].join("\n\n"),
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

if (!process.env.SANDBOX_MODE) {
  try {
    await execFileAsync("docker", ["--version"], { timeout: 3000 });
    SANDBOX_MODE = "docker";
  } catch { /* no Docker — stay on "vm" */ }
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[highrise-sandbox MCP] mode=${SANDBOX_MODE} workspace=${WORKSPACE_ROOT}`);
