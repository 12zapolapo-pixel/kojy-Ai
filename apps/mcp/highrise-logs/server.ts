#!/usr/bin/env node
/**
 * Highrise Logs MCP Server
 * OWNERSHIP: apps/mcp/highrise-logs
 *
 * Streams live bot output back into the Composer page.
 * Reads from the log files written by the deploy MCP,
 * tails them in real-time, and exposes them as MCP tool results.
 *
 * TOOLS:
 *   get_recent_logs(project_id, lines)   → last N log lines
 *   stream_logs(project_id, since_ms)    → lines since timestamp
 *   clear_logs(project_id)               → truncates log file
 *   search_logs(project_id, query)       → grep-style search
 *   get_crash_report(project_id)         → last crash traceback
 */

import { Server }               from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs   from "node:fs/promises";
import path from "node:path";

const RUNTIME_DIR = process.env.BOT_RUNTIME_DIR ?? "/tmp/kojyai-runtime";

// SECURITY FIX (H-14): this MCP server streamed raw bot process stdout/
// stderr straight to the Composer UI with zero filtering. The bot process
// has its own real Highrise API token available as an env var
// (HIGHRISE_TOKEN, HIGHRISE_ROOM_ID — see highrise-deploy/server.ts), and
// its code is AI-generated and not necessarily reviewed before it runs —
// nothing stops a debug print or a poorly-prompted logging call from
// writing the token straight into stdout, which this server would then
// deliver unfiltered.
//
// Note this CANNOT be an exact-value lookup: highrise-logs/server.ts is a
// separate standalone process from highrise-deploy/server.ts (the one that
// actually holds the live token in its own env) — it never has the literal
// token value to match against. So this is deliberately pattern-based,
// exactly as the audit's own "How to Fix" describes: regex against common
// secret shapes, applied uniformly across every handler that returns log
// content, before any of it leaves this process.
const REDACTION_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // "Bearer <token>" — the exact shape HIGHRISE_TOKEN is used in and the
  // most common accidental-log shape for any bearer-style credential.
  { pattern: /\bBearer\s+[A-Za-z0-9\-_.]{16,}/gi, replacement: "Bearer [REDACTED]" },

  // key=value / key: value assignment where the key name signals a secret
  // (env var dumps, `print(f"token={token}")`-style debug lines, etc.)
  { pattern: /\b(token|api[_-]?key|secret|password|passwd|auth(?:orization)?)\s*[:=]\s*['"]?[A-Za-z0-9\-_.]{8,}['"]?/gi, replacement: "$1=[REDACTED]" },

  // The specific env vars highrise-deploy/server.ts sets on the bot
  // process's environment — if the bot dumps its own environment (a common
  // AI-generated debugging mistake), this catches the literal var name even
  // without a "token"/"secret" keyword nearby.
  { pattern: /\bHIGHRISE_TOKEN\s*[:=]\s*\S+/g, replacement: "HIGHRISE_TOKEN=[REDACTED]" },

  // JWT-shaped strings (header.payload.signature, base64url segments) —
  // several third-party services issue these as bearer tokens.
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: "[REDACTED_JWT]" },

  // Generic high-entropy standalone token (40+ chars, no whitespace, mixed
  // alnum/symbols) as a broad safety net for opaque tokens that don't match
  // any keyword above — deliberately broad since false positives here
  // (over-redacting a harmless long string) are far cheaper than a real
  // credential leak.
  { pattern: /\b[A-Za-z0-9_-]{40,}\b/g, replacement: "[REDACTED_TOKEN]" },
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// L-25: lines are timestamped by the deploy MCP when written ("<ISO> <text>").
const LOG_TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) /;

/**
 * Lines strictly newer than `sinceMs`. A line with no timestamp (legacy files,
 * or a continuation) inherits the previous line's time; lines before the first
 * timestamp count as time 0 (i.e. old) and are excluded from incremental reads.
 * `lastTimestampMs` is what the caller should pass as since_ms next poll.
 */
export function selectLinesSince(all: string[], sinceMs: number): { lines: string[]; lastTimestampMs: number } {
  let current = 0;
  let last = sinceMs;
  const lines: string[] = [];
  for (const line of all) {
    const m = LOG_TS_RE.exec(line);
    if (m) current = Date.parse(m[1]!) || current;
    if (current > sinceMs) { lines.push(line); if (current > last) last = current; }
  }
  return { lines, lastTimestampMs: last };
}

function logFilePath(projectId: string): string {
  const safeId = projectId.replace(/[^a-zA-Z0-9-]/g, "_").slice(0, 80);
  return path.join(RUNTIME_DIR, `${safeId}.log`);
}

export async function readLogLines(projectId: string): Promise<string[]> {
  try {
    const content = await fs.readFile(logFilePath(projectId), "utf8");
    // SECURITY FIX (H-14): redact BEFORE splitting/returning — this is the
    // single choke point every tool handler in this file reads through, so
    // applying it here (rather than at each call site) makes it structurally
    // impossible for a future tool handler to forget the redaction pass.
    return redactSecrets(content).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

const server = new Server(
  { name: "highrise-logs", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_recent_logs",
      description: "Get the most recent log lines from a running Highrise bot",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          lines:      { type: "number", default: 100, description: "Number of recent lines to return" },
        },
        required: ["project_id"],
      },
    },
    {
      name: "stream_logs",
      description: "Get log lines since a specific timestamp (for incremental polling)",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          since_ms:   { type: "number", description: "Unix timestamp in milliseconds" },
        },
        required: ["project_id"],
      },
    },
    {
      name: "clear_logs",
      description: "Clear the log file for a bot project",
      inputSchema: {
        type: "object",
        properties: { project_id: { type: "string" } },
        required: ["project_id"],
      },
    },
    {
      name: "search_logs",
      description: "Search bot logs for a specific pattern (case-insensitive)",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          query:      { type: "string" },
        },
        required: ["project_id", "query"],
      },
    },
    {
      name: "get_crash_report",
      description: "Get the most recent Python traceback from a crashed bot",
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
      case "get_recent_logs": {
        const lines  = Number(args?.lines ?? 100);
        const all    = await readLogLines(args!.project_id as string);
        const recent = all.slice(-Math.min(lines, 1000));
        return {
          content: [{
            type: "text",
            text: recent.length > 0
              ? recent.join("\n")
              : "No log output yet — bot may not be running or just started.",
          }],
        };
      }

      case "stream_logs": {
        const sinceMs = Number(args?.since_ms ?? 0);
        const all     = await readLogLines(args!.project_id as string);
        // L-25: this used to ignore since_ms (it returned the last 50 lines every
        // time, so a poller re-received lines it had already seen). Filter by the
        // per-line timestamps the deploy MCP now writes.
        const { lines, lastTimestampMs } = selectLinesSince(all, Number.isFinite(sinceMs) ? sinceMs : 0);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ lines, total: all.length, lastTimestampMs }),
          }],
        };
      }

      case "clear_logs": {
        try {
          await fs.writeFile(logFilePath(args!.project_id as string), "", "utf8");
          return { content: [{ type: "text", text: "Log file cleared" }] };
        } catch {
          return { content: [{ type: "text", text: "No log file to clear" }] };
        }
      }

      case "search_logs": {
        const query = (args!.query as string).toLowerCase();
        const all   = await readLogLines(args!.project_id as string);
        const hits  = all.filter(l => l.toLowerCase().includes(query));
        return {
          content: [{
            type: "text",
            text: hits.length > 0
              ? `Found ${hits.length} matching lines:\n${hits.slice(-50).join("\n")}`
              : `No lines matching "${query}"`,
          }],
        };
      }

      case "get_crash_report": {
        const all = await readLogLines(args!.project_id as string);
        // Find last Traceback block
        const traceStart = [...all].reverse().findIndex(l => l.includes("Traceback (most recent call last)"));
        if (traceStart === -1) {
          return { content: [{ type: "text", text: "No crash traceback found in logs" }] };
        }
        const startIdx = all.length - 1 - traceStart;
        const traceLines = all.slice(startIdx);
        return { content: [{ type: "text", text: traceLines.join("\n") }] };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    }
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
  }
});

const transport = new StdioServerTransport();

// SECURITY FIX (H-14 testability): guard bootstrap behind a main-module
// check, same pattern as the filesystem (H-06) and deploy (H-13) MCP
// servers, so tests/security/highrise-logs-mcp-redaction.test.ts can import
// redactSecrets() directly without spawning a real stdio transport.
const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  await server.connect(transport);
  console.error(`[highrise-logs MCP] runtime=${RUNTIME_DIR}`);
}
