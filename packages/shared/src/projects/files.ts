/**
 * Project files — the code of hosted Python bots on disk.
 * OWNERSHIP: packages/shared/src/projects — used by the API (uploads, editor)
 * and the runner (the coder AI's file tools).
 *
 * PROJECTS_DIR is a volume shared with the runner (it runs the code from the
 * same folders). Every path from a request goes through resolveInside(), which
 * rejects `..`, absolute paths and symlinks pointing out of the project: bot
 * code can create symlinks, and following one from the API would let it read
 * the API container's own files.
 */

import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { unzipSync, zipSync, strFromU8 } from "fflate";

export const PROJECTS_DIR = path.resolve(process.env.PROJECTS_DIR ?? "./data/projects");
export const LOG_DIR = path.join(PROJECTS_DIR, ".logs");
const SNAPSHOT_DIR = path.join(PROJECTS_DIR, ".snapshots");
const MAX_SNAPSHOTS = 15;

/** Never shown, uploaded or zipped. */
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", "__MACOSX", ".pythonlibs", ".cache", ".upm"]);
/** The bot's own saved state — an upload never overwrites these. */
export const isPersistentData = (rel: string) => rel === "data" || rel.startsWith("data/") || /\.(db|sqlite3?)(-wal|-shm|-journal)?$/i.test(rel);

export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;
const MAX_FILES = 5000;
export const MAX_EDIT_BYTES = 1024 * 1024;

export class ProjectFileError extends Error {}

export function projectDir(uuid: string): string {
  return path.join(PROJECTS_DIR, uuid);
}

export function ensureProjectDir(uuid: string): string {
  const dir = projectDir(uuid);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeProjectDir(uuid: string): void {
  rmSync(projectDir(uuid), { recursive: true, force: true });
  rmSync(path.join(LOG_DIR, `${uuid}.log`), { force: true });
  rmSync(path.join(LOG_DIR, `${uuid}.log.1`), { force: true });
}

/** Normalises a user path ("a/b.py") — throws on anything escaping the project. */
export function cleanRelPath(rel: string): string {
  const norm = path.posix.normalize(rel.replace(/\\/g, "/")).replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!norm || norm === "." || norm.startsWith("../") || norm === ".." || path.posix.isAbsolute(norm) || norm.includes("\0")) {
    throw new ProjectFileError(`Invalid path: ${rel}`);
  }
  return norm;
}

/** Absolute path for `rel` inside the project, refusing symlink escapes. */
export function resolveInside(uuid: string, rel: string): string {
  const root = realpathSync(ensureProjectDir(uuid));
  const target = path.join(root, cleanRelPath(rel));
  // Walk up to the deepest part that exists and check where it really points.
  let probe = target;
  while (!existsSync(probe) && probe !== root) probe = path.dirname(probe);
  const real = realpathSync(probe);
  if (real !== root && !real.startsWith(root + path.sep)) throw new ProjectFileError(`Path leaves the project: ${rel}`);
  return target;
}

export interface FileEntry { path: string; size: number; isDir: boolean }

export function listFiles(uuid: string): FileEntry[] {
  const root = ensureProjectDir(uuid);
  const out: FileEntry[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= MAX_FILES) return;
      if (ent.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        out.push({ path: rel, size: 0, isDir: true });
        walk(path.join(dir, ent.name), rel);
      } else if (ent.isFile()) {
        out.push({ path: rel, size: statSync(path.join(dir, ent.name)).size, isDir: false });
      }
    }
  };
  walk(root, "");
  return out;
}

export function readProjectFile(uuid: string, rel: string): { content: string; binary: boolean; size: number } {
  const file = resolveInside(uuid, rel);
  if (!existsSync(file) || !lstatSync(file).isFile()) throw new ProjectFileError(`No such file: ${rel}`);
  const size = statSync(file).size;
  if (size > MAX_EDIT_BYTES) return { content: "", binary: true, size };
  const buf = readFileSync(file);
  const binary = buf.subarray(0, 8000).includes(0);
  return { content: binary ? "" : buf.toString("utf8"), binary, size };
}

export function writeProjectFile(uuid: string, rel: string, content: string): void {
  const file = resolveInside(uuid, rel);
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new ProjectFileError(`Can't write through a link: ${rel}`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
}

export function deleteProjectPath(uuid: string, rel: string): void {
  const target = resolveInside(uuid, rel);
  if (target === realpathSync(projectDir(uuid))) throw new ProjectFileError("Can't delete the project root");
  rmSync(target, { recursive: true, force: true });
}

export interface UploadResult { written: number; keptData: string[]; skipped: number }

/**
 * Unpacks an uploaded zip over the project. A single top-level folder (how
 * most zips are made) is stripped. Existing `data/` and database files are
 * kept, so re-uploading new code never wipes the bot's saved players/coins.
 */
export function extractZip(uuid: string, zip: Uint8Array): UploadResult {
  let files: Record<string, Uint8Array>;
  let total = 0;
  try {
    files = unzipSync(zip, {
      filter: (f) => {
        total += f.originalSize;
        if (total > MAX_UNZIPPED_BYTES) throw new ProjectFileError("Zip is too large once unpacked (200 MB max).");
        return !f.name.endsWith("/");
      },
    });
  } catch (err) {
    if (err instanceof ProjectFileError) throw err;
    throw new ProjectFileError("That file isn't a valid zip.");
  }

  const names = Object.keys(files);
  if (names.length > MAX_FILES) throw new ProjectFileError(`Zip has too many files (${MAX_FILES} max).`);
  const tops = new Set(names.map((n) => n.replace(/\\/g, "/").split("/")[0]));
  const strip = tops.size === 1 && names.every((n) => n.replace(/\\/g, "/").includes("/")) ? `${[...tops][0]}/` : "";

  const result: UploadResult = { written: 0, keptData: [], skipped: 0 };
  for (const [name, data] of Object.entries(files)) {
    let rel: string;
    try { rel = cleanRelPath(name.replace(/\\/g, "/").slice(strip.length)); }
    catch { result.skipped++; continue; }
    if (rel.split("/").some((part) => SKIP_DIRS.has(part)) || rel.endsWith(".pyc") || rel === ".DS_Store") { result.skipped++; continue; }
    const file = resolveInside(uuid, rel);
    if (existsSync(file)) {
      if (isPersistentData(rel)) { result.keptData.push(rel); continue; }
      if (lstatSync(file).isSymbolicLink()) { result.skipped++; continue; }
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, data);
    result.written++;
  }
  return result;
}

/** The whole project as a zip (for download / backup). */
export function zipProject(uuid: string): Uint8Array {
  const root = ensureProjectDir(uuid);
  const entries: Record<string, Uint8Array> = {};
  for (const f of listFiles(uuid)) if (!f.isDir) entries[f.path] = readFileSync(path.join(root, f.path));
  return zipSync(entries, { level: 6 });
}

/**
 * Guesses "module.path:ClassName" for the bot: a class with BaseBot among its
 * bases. Prefers the shallowest file, then bot.py / main.py.
 */
export function detectEntrypoint(uuid: string): string | null {
  const root = projectDir(uuid);
  const candidates: { entry: string; score: number }[] = [];
  for (const f of listFiles(uuid)) {
    if (f.isDir || !f.path.endsWith(".py") || f.size > MAX_EDIT_BYTES) continue;
    if (/^(tests?|tools|scripts|examples?)\//.test(f.path)) continue;
    const src = readFileSync(path.join(root, f.path), "utf8");
    for (const m of src.matchAll(/^class\s+(\w+)\s*\(([^)]*)\)\s*:/gms)) {
      if (!/\bBaseBot\b/.test(m[2]!)) continue;
      const mod = f.path.slice(0, -3).replace(/\/__init__$/, "").replace(/\//g, ".");
      const depth = f.path.split("/").length;
      const name = path.posix.basename(f.path);
      candidates.push({ entry: `${mod}:${m[1]}`, score: depth * 10 - (name === "bot.py" ? 2 : name === "main.py" ? 1 : 0) });
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  return candidates[0]?.entry ?? null;
}

export interface LogLine { ts: number; stream: string; line: string }

/**
 * Console lines written by the runner after byte offset `cursor`. When the log
 * was rotated (file now smaller than the cursor) it starts again from 0.
 */
export function readLogs(uuid: string, cursor: number | undefined, maxBytes = 64 * 1024): { lines: LogLine[]; cursor: number } {
  const file = path.join(LOG_DIR, `${uuid}.log`);
  if (!existsSync(file)) return { lines: [], cursor: 0 };
  const size = statSync(file).size;
  let start = cursor ?? Math.max(0, size - maxBytes);
  if (start > size) start = 0;
  const buf = readFileSync(file).subarray(start, start + maxBytes);
  const text = strFromU8(buf);
  const lastNl = text.lastIndexOf("\n");
  if (lastNl < 0) return { lines: [], cursor: start };
  const lines: LogLine[] = [];
  let body = text.slice(0, lastNl);
  // Starting mid-file (no cursor yet): drop the partial first line.
  if (cursor === undefined && start > 0) body = body.slice(body.indexOf("\n") + 1);
  for (const raw of body.split("\n")) {
    if (!raw) continue;
    try { lines.push(JSON.parse(raw) as LogLine); } catch { /* torn line */ }
  }
  return { lines, cursor: start + Buffer.byteLength(text.slice(0, lastNl + 1)) };
}

// ── snapshots (undo for the coder AI's changes) ──────────────────────────────

export interface Snapshot { id: string; reason: string; createdAt: number; files: number }

/** Zips the project's code (not its data/ or database files). Keeps the last 15. */
export function snapshotProject(uuid: string, reason: string): Snapshot {
  const root = ensureProjectDir(uuid);
  const entries: Record<string, Uint8Array> = {};
  for (const f of listFiles(uuid)) {
    if (f.isDir || isPersistentData(f.path) || f.size > 5 * 1024 * 1024) continue;
    entries[f.path] = readFileSync(path.join(root, f.path));
  }
  const dir = path.join(SNAPSHOT_DIR, uuid);
  mkdirSync(dir, { recursive: true });
  const createdAt = Date.now();
  const id = String(createdAt);
  entries[".kojy-snapshot.json"] = new TextEncoder().encode(JSON.stringify({ reason, createdAt }));
  writeFileSync(path.join(dir, `${id}.zip`), zipSync(entries, { level: 6 }));
  const all = readdirSync(dir).filter((n) => n.endsWith(".zip")).sort();
  for (const old of all.slice(0, Math.max(0, all.length - MAX_SNAPSHOTS))) rmSync(path.join(dir, old), { force: true });
  return { id, reason, createdAt, files: Object.keys(entries).length - 1 };
}

export function listSnapshots(uuid: string): Snapshot[] {
  const dir = path.join(SNAPSHOT_DIR, uuid);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".zip")).sort().reverse().map((name) => {
    const files = unzipSync(readFileSync(path.join(dir, name)));
    const meta = files[".kojy-snapshot.json"];
    const info = meta ? JSON.parse(strFromU8(meta)) as { reason: string; createdAt: number } : { reason: "", createdAt: Number(name.slice(0, -4)) };
    return { id: name.slice(0, -4), reason: info.reason, createdAt: info.createdAt, files: Object.keys(files).length - (meta ? 1 : 0) };
  });
}

/**
 * Puts the code back exactly as it was in the snapshot: changed files are
 * restored and files added since are removed. data/ and databases are untouched.
 */
export function restoreSnapshot(uuid: string, id: string): number {
  if (!/^\d+$/.test(id)) throw new ProjectFileError("Invalid snapshot id");
  const file = path.join(SNAPSHOT_DIR, uuid, `${id}.zip`);
  if (!existsSync(file)) throw new ProjectFileError("That snapshot no longer exists");
  const files = unzipSync(readFileSync(file));
  delete files[".kojy-snapshot.json"];
  const root = ensureProjectDir(uuid);
  for (const f of listFiles(uuid)) {
    if (!f.isDir && !isPersistentData(f.path) && !(f.path in files)) rmSync(path.join(root, f.path), { force: true });
  }
  for (const [rel, data] of Object.entries(files)) {
    const target = resolveInside(uuid, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  return Object.keys(files).length;
}

export function removeSnapshots(uuid: string): void {
  rmSync(path.join(SNAPSHOT_DIR, uuid), { recursive: true, force: true });
}
