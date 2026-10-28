/**
 * tests/security/highrise-logs-mcp-redaction.test.ts
 *
 * H-14: proves the redaction pass added to highrise-logs/server.ts actually
 * catches the realistic ways a Highrise API token could leak into a bot's
 * own stdout/stderr — debug prints, env var dumps, bearer-header logging —
 * and that ordinary, non-secret log content is left untouched (a redaction
 * pass that also destroys normal logs isn't a usable fix).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let redactSecrets: (text: string) => string;
let readLogLines: (projectId: string) => Promise<string[]>;
let runtimeDir: string;

beforeAll(async () => {
  runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "kojyai-logs-mcp-test-"));
  process.env.BOT_RUNTIME_DIR = runtimeDir;

  const mod = await import("../../apps/mcp/highrise-logs/server.js");
  redactSecrets = mod.redactSecrets;
  readLogLines = mod.readLogLines;
});

afterAll(async () => {
  await fs.rm(runtimeDir, { recursive: true, force: true });
});

describe("H-14: highrise-logs MCP server — secret redaction", () => {
  it("redacts a Bearer-header style token leak", () => {
    const line = 'Connecting to Highrise: Authorization: Bearer hR_9fK2mZpQwXeT7vB4nL8sD1cA6yJ0uI3oP5gH';
    const out = redactSecrets(line);
    expect(out).not.toContain("hR_9fK2mZpQwXeT7vB4nL8sD1cA6yJ0uI3oP5gH");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts a debug-print key=value token leak", () => {
    const line = 'print(f"Using token={my_secret_token_value_123456789}") -> token=abc123XYZsecretTokenValueThatIsLongEnough';
    const out = redactSecrets(line);
    expect(out).not.toContain("abc123XYZsecretTokenValueThatIsLongEnough");
  });

  it("redacts a raw HIGHRISE_TOKEN env var dump", () => {
    const line = "os.environ dump: HIGHRISE_TOKEN=hrtok_live_9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c";
    const out = redactSecrets(line);
    expect(out).not.toContain("hrtok_live_9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c");
    expect(out).toContain("HIGHRISE_TOKEN=[REDACTED]");
  });

  it("redacts a JWT-shaped token", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGhpc2lzYXNpZ25hdHVyZXZhbHVl";
    const out = redactSecrets(`Bot received session: ${jwt}`);
    expect(out).not.toContain(jwt);
    expect(out).toContain("[REDACTED_JWT]");
  });

  it("redacts a generic high-entropy standalone token with no keyword nearby", () => {
    const line = "Connected successfully: a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V2";
    const out = redactSecrets(line);
    expect(out).not.toContain("a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V2");
  });

  it("does NOT redact ordinary, non-secret log content", () => {
    const line = "Bot Nova joined room lobby-42 at 2026-07-31T12:00:00Z, greeted 3 users, sentiment avg 0.6";
    const out = redactSecrets(line);
    expect(out).toBe(line);
  });

  it("does NOT redact short, harmless identifiers", () => {
    const line = "userId=42, roomId=lobby-7, status=ok";
    const out = redactSecrets(line);
    expect(out).toBe(line);
  });

  it("end-to-end: a real log file with a leaked token is redacted when read through readLogLines()", async () => {
    const projectId = "e2e-test-project";
    const leakedToken = "Bearer hR_LIVE_TOKEN_1234567890abcdefGHIJKLMNOP";
    await fs.writeFile(
      path.join(runtimeDir, `${projectId}.log`),
      `Bot starting up...\nAuthorization: ${leakedToken}\nBot ready.\n`,
      "utf8",
    );

    const lines = await readLogLines(projectId);
    const joined = lines.join("\n");
    expect(joined).not.toContain("hR_LIVE_TOKEN_1234567890abcdefGHIJKLMNOP");
    expect(joined).toContain("Bot starting up...");
    expect(joined).toContain("Bot ready.");
  });
});
