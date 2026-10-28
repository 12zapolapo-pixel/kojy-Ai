#!/usr/bin/env node
/**
 * Filesystem MCP Server
 * OWNERSHIP: apps/mcp/filesystem
 *
 * Secure, sandboxed file I/O for Highrise bot project workspaces.
 * Used by the Composer orchestrator to read/write/update generated files.
 *
 * All file operations are scoped to BOT_WORKSPACE_ROOT — no path traversal.
 * Each project gets its own subdirectory: <root>/<projectId>/
 *
 * TOOLS:
 *   read_file(projectId, path)              → string content
 *   write_file(projectId, path, content)    → written bytes count
 *   update_file(projectId, path, oldStr, newStr) → surgical patch (like str_replace)
 *   list_files(projectId)                   → [{path, size, mtime}]
 *   delete_file(projectId, path)            → success bool
 *   create_project_dir(projectId)           → absolute path
 *   zip_project(projectId)                  → base64 of a standard .zip (deflate)
 *
 * CONFIGURATION:
 *   BOT_WORKSPACE_ROOT env var — defaults to /tmp/kojyai-bots
 *   BOT_WORKSPACE_MAX_FILES / BOT_WORKSPACE_MAX_BYTES — per-project quota (default 500 files / 50MB)
 *
 * ADD TO AGENT:
 *   In ~/.claude/mcp.json (for Claude Code) or KojyAI's internal MCPClient:
 *   { "filesystem": { "command": "node", "args": ["apps/mcp/filesystem/server.js"] } }
 */

import { Server }               from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs   from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

const WORKSPACE_ROOT = process.env.BOT_WORKSPACE_ROOT ?? "/tmp/kojyai-bots";
const MAX_FILE_SIZE  = 5 * 1024 * 1024; // 5 MB per file

// L-13: the per-file cap alone let a generation loop write unlimited files just
// under 5MB each. Cap the project as a whole too.
function limitFromEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
const MAX_PROJECT_FILES = limitFromEnv("BOT_WORKSPACE_MAX_FILES", 500);
const MAX_PROJECT_BYTES = limitFromEnv("BOT_WORKSPACE_MAX_BYTES", 50 * 1024 * 1024); // 50 MB

function projectRootOf(projectId: string): string {
  const safeId = projectId.replace(/[^a-zA-Z0-9-]/g, "_").slice(0, 80);
  return path.resolve(WORKSPACE_ROOT, safeId);
}

interface WorkspaceFile { full: string; rel: string; size: number; mtime: Date }

/** Regular files only — symlinks are skipped so listing/zipping/quota can't follow a link out of the workspace. */
export async function walkWorkspace(root: string): Promise<WorkspaceFile[]> {
  const out: WorkspaceFile[] = [];
  async function walk(dir: string): Promise<void> {
    let items;
    try { items = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) await walk(full);
      else if (item.isFile()) {
        try {
          const st = await fs.stat(full);
          out.push({ full, rel: path.relative(root, full), size: st.size, mtime: st.mtime });
        } catch { /* vanished mid-walk */ }
      }
    }
  }
  await walk(root);
  return out;
}

/** Throws if writing `newSize` bytes to `target` would push the project past its quota. */
export async function assertWorkspaceQuota(root: string, target: string, newSize: number): Promise<void> {
  const files = await walkWorkspace(root);
  const existing = files.find((f) => f.full === target);
  const bytesAfter = files.reduce((n, f) => n + f.size, 0) - (existing?.size ?? 0) + newSize;
  const filesAfter = files.length + (existing ? 0 : 1);
  if (filesAfter > MAX_PROJECT_FILES) throw new Error(`Project file limit reached (${MAX_PROJECT_FILES} files)`);
  if (bytesAfter > MAX_PROJECT_BYTES) throw new Error(`Project size limit reached (${MAX_PROJECT_BYTES} bytes)`);
}

// Serialize writes per project so two concurrent writes can't both pass the
// quota check and then jointly exceed it.
const projectLocks = new Map<string, Promise<unknown>>();
function withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const key  = projectRootOf(projectId);
  const prev = projectLocks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  projectLocks.set(key, next);
  void next.finally(() => { if (projectLocks.get(key) === next) projectLocks.delete(key); }).catch(() => undefined);
  return next;
}

// ─── Real ZIP writer (L-14) ──────────────────────────────────────────────────
// Minimal, dependency-free PKZIP: deflate (or stored when that's smaller),
// UTF-8 names, CRC32, standard central directory. Binary-safe (the old
// "zip" decoded files as UTF-8 text, corrupting anything that wasn't).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function buildZip(entries: Array<{ name: string; data: Buffer; mtime: Date }>): Buffer {
  if (entries.length > 0xffff) throw new Error("Too many files for a zip archive");
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name.split(path.sep).join("/"), "utf8");
    const deflated = zlib.deflateRawSync(e.data, { level: 6 });
    const useDeflate = deflated.length < e.data.length;
    const body = useDeflate ? deflated : e.data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(e.data);
    const { time, date } = dosDateTime(e.mtime);
    if (body.length > 0xffffffff || e.data.length > 0xffffffff) throw new Error("File too large for a zip archive");

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(e.data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(((0o100644) << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += lh.length + name.length + body.length;
  }

  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ─── Path safety ─────────────────────────────────────────────────────────────

export function safePath(projectId: string, filePath: string): string {
  // Sanitize projectId — alphanumeric + dash only
  const safeId = projectId.replace(/[^a-zA-Z0-9-]/g, "_").slice(0, 80);
  // Resolve within project root, reject any path escaping it
  const projectRoot = path.join(WORKSPACE_ROOT, safeId);
  const resolved    = path.resolve(projectRoot, filePath.replace(/^\/+/, ""));
  // FIX-AUDIT: `resolved.startsWith(projectRoot)` alone is the classic
  // prefix-bypass bug — it also matches sibling directories whose name happens
  // to start with the same string. E.g. projectRoot "/tmp/kojyai-bots/proj1"
  // and filePath "../proj1-other/secrets.txt" resolves to
  // "/tmp/kojyai-bots/proj1-other/secrets.txt", which DOES start with
  // "/tmp/kojyai-bots/proj1" as a raw string even though it's a completely
  // different project's directory. Requiring the next character to be the
  // path separator (or an exact match) closes that gap.
  if (resolved !== projectRoot && !resolved.startsWith(projectRoot + path.sep)) {
    throw new Error(`Path traversal detected: "${filePath}"`);
  }
  return resolved;
}

// FIX-AUDIT / DESIGN NOTE for whoever wires this server into the live
// orchestrator (per HighriseOrchestrator.ts: "Until the MCP deploy is wired,
// the deploy stage returns immediately" — not yet connected as of this audit):
//
// This server has NO authentication or authorization of its own. It is a
// stdio subprocess with no session/user/org context in its tool arguments —
// it trusts whatever `project_id` it's handed and will happily read/write/
// delete any project's entire workspace for it. That is fine ONLY if the
// calling orchestrator validates that the current user/org actually owns
// `project_id` (against composerProjects in the DB) before ever constructing
// a tool call to this server — and does so on every call, not just once at
// pipeline start, since an LLM agent driving tool-call arguments could in
// principle be steered (via prompt injection in fetched content, user input,
// etc.) into supplying a different project_id than the one it was given.
// This file cannot enforce that itself; it's documented here so it isn't
// silently assumed when the integration lands.

async function ensureProjectDir(projectId: string): Promise<string> {
  const safeId = projectId.replace(/[^a-zA-Z0-9-]/g, "_").slice(0, 80);
  const dir    = path.join(WORKSPACE_ROOT, safeId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "filesystem", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "read_file",
      description: "Read the content of a file in a bot project workspace",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          path:       { type: "string", description: "File path relative to project root (e.g. 'main.py')" },
        },
        required: ["project_id", "path"],
      },
    },
    {
      name: "write_file",
      description: "Write (create or overwrite) a file in a bot project workspace",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          path:       { type: "string" },
          content:    { type: "string", description: "Full file content" },
        },
        required: ["project_id", "path", "content"],
      },
    },
    {
      name: "update_file",
      description: "Apply a surgical text replacement to a file (like str_replace). Fails if old_str not found exactly once.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          path:       { type: "string" },
          old_str:    { type: "string", description: "Exact string to replace (must appear exactly once)" },
          new_str:    { type: "string", description: "Replacement string" },
        },
        required: ["project_id", "path", "old_str", "new_str"],
      },
    },
    {
      name: "list_files",
      description: "List all files in a bot project workspace with sizes and modification times",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string" },
        },
        required: ["project_id"],
      },
    },
    {
      name: "delete_file",
      description: "Delete a file from a bot project workspace",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          path:       { type: "string" },
        },
        required: ["project_id", "path"],
      },
    },
    {
      name: "create_project_dir",
      description: "Create the workspace directory for a new project",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string" },
        },
        required: ["project_id"],
      },
    },
    {
      name: "zip_project",
      description: "Zip all files in a project workspace and return base64-encoded zip content",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string" },
        },
        required: ["project_id"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    switch (name) {
      case "read_file": {
        const filePath = safePath(args!.project_id as string, args!.path as string);
        const stat = await fs.stat(filePath);
        if (stat.size > MAX_FILE_SIZE) {
          return { content: [{ type: "text", text: `Error: file too large (${stat.size} bytes > ${MAX_FILE_SIZE} limit)` }] };
        }
        const content = await fs.readFile(filePath, "utf8");
        return { content: [{ type: "text", text: content }] };
      }

      case "write_file": {
        const filePath = safePath(args!.project_id as string, args!.path as string);
        const content  = args!.content as string;
        const size     = Buffer.byteLength(content);
        if (size > MAX_FILE_SIZE) {
          return { content: [{ type: "text", text: `Error: content too large` }] };
        }
        await withProjectLock(args!.project_id as string, async () => {
          await assertWorkspaceQuota(projectRootOf(args!.project_id as string), filePath, size); // L-13
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, content, "utf8");
        });
        return { content: [{ type: "text", text: `Written ${size} bytes to ${args!.path}` }] };
      }

      case "update_file": {
        const filePath = safePath(args!.project_id as string, args!.path as string);
        const current  = await fs.readFile(filePath, "utf8");
        const oldStr   = args!.old_str as string;
        const newStr   = args!.new_str as string;
        const occurrences = current.split(oldStr).length - 1;
        if (occurrences === 0) {
          return { content: [{ type: "text", text: `Error: old_str not found in ${args!.path}` }] };
        }
        if (occurrences > 1) {
          return { content: [{ type: "text", text: `Error: old_str found ${occurrences} times — must appear exactly once` }] };
        }
        // split/join instead of replace(): String.replace treats "$&", "$1" etc. in
        // the REPLACEMENT as special patterns and would silently corrupt code
        // containing them (regexes, template strings, shell snippets).
        const updated = current.split(oldStr).join(newStr);
        const size    = Buffer.byteLength(updated);
        if (size > MAX_FILE_SIZE) {
          return { content: [{ type: "text", text: `Error: updated file would exceed the ${MAX_FILE_SIZE} byte limit` }] };
        }
        await withProjectLock(args!.project_id as string, async () => {
          await assertWorkspaceQuota(projectRootOf(args!.project_id as string), filePath, size); // L-13
          await fs.writeFile(filePath, updated, "utf8");
        });
        return { content: [{ type: "text", text: `Updated ${args!.path} successfully` }] };
      }

      case "list_files": {
        const projectDir = await ensureProjectDir(args!.project_id as string);
        const entries = (await walkWorkspace(path.resolve(projectDir)))
          .map((f) => ({ path: f.rel, size: f.size, mtime: f.mtime.toISOString() }));

        const listing = entries.map(e => `${e.path.padEnd(40)} ${(e.size / 1024).toFixed(1)}KB  ${e.mtime.slice(0, 16)}`).join("\n");
        return { content: [{ type: "text", text: entries.length > 0 ? `Files in project:\n${listing}` : "Project is empty" }] };
      }

      case "delete_file": {
        const filePath = safePath(args!.project_id as string, args!.path as string);
        await fs.unlink(filePath);
        return { content: [{ type: "text", text: `Deleted ${args!.path}` }] };
      }

      case "create_project_dir": {
        const dir = await ensureProjectDir(args!.project_id as string);
        return { content: [{ type: "text", text: `Project directory created: ${dir}` }] };
      }

      case "zip_project": {
        const projectDir = await ensureProjectDir(args!.project_id as string);
        // L-14: a real .zip now (was a gzip of "===FILE:" text blocks that no
        // unzip tool could open). Raw bytes, not UTF-8 text, so binary files survive.
        const files = await walkWorkspace(path.resolve(projectDir));
        const entries: Array<{ name: string; data: Buffer; mtime: Date }> = [];
        for (const f of files) {
          entries.push({ name: f.rel, data: await fs.readFile(f.full), mtime: f.mtime });
        }
        const zipped = buildZip(entries);
        return { content: [{ type: "text", text: zipped.toString("base64") }] };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${msg}` }] };
  }
});

// SECURITY FIX (H-06): guard the stdio bootstrap behind a main-module check.
// Previously this ran unconditionally at import time, which meant the only
// way to unit-test safePath()'s traversal/authorization boundary was to
// spawn a real subprocess. Exporting safePath() (above) and gating the
// actual server startup here lets tests/security/filesystem-mcp-boundary.test.ts
// import and exercise the boundary logic directly and fast.
const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[filesystem MCP] Server running — workspace: ${WORKSPACE_ROOT}`);
}
