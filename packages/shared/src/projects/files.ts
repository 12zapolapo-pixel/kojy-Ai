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

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { unzip, unzipSync, zip, zipSync, strFromU8, type Unzipped } from "fflate";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { lineDiff, type FileDiff } from "./diff.js";

export const PROJECTS_DIR = path.resolve(process.env.PROJECTS_DIR ?? "./data/projects");
export const LOG_DIR = path.join(PROJECTS_DIR, ".logs");
const SNAPSHOT_DIR = path.join(PROJECTS_DIR, ".snapshots");
/** The code each bot last ran fine with (see saveKnownGood) — apart from Undo's snapshots. */
const KNOWN_GOOD_DIR = path.join(PROJECTS_DIR, ".known-good");
const MAX_SNAPSHOTS = 30;

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
export async function extractZip(uuid: string, data: Uint8Array): Promise<UploadResult> {
  // SECURITY FIX (V-04): fflate's async unzip decompresses in worker threads,
  // so a 200 MB upload no longer freezes the API for everyone; the writes
  // below are async for the same reason.
  let total = 0;
  const files = await new Promise<Unzipped>((resolve, reject) => {
    const fail = (err: unknown) => reject(err instanceof ProjectFileError ? err : new ProjectFileError("That file isn't a valid zip."));
    try {
      unzip(data, {
        filter: (f) => {
          total += f.originalSize;
          if (total > MAX_UNZIPPED_BYTES) throw new ProjectFileError("Zip is too large once unpacked (200 MB max).");
          return !f.name.endsWith("/");
        },
      }, (err, out) => (err ? fail(err) : resolve(out)));
    } catch (err) { fail(err); }
  });

  const names = Object.keys(files);
  if (names.length > MAX_FILES) throw new ProjectFileError(`Zip has too many files (${MAX_FILES} max).`);
  const tops = new Set(names.map((n) => n.replace(/\\/g, "/").split("/")[0]));
  const strip = tops.size === 1 && names.every((n) => n.replace(/\\/g, "/").includes("/")) ? `${[...tops][0]}/` : "";

  const result: UploadResult = { written: 0, keptData: [], skipped: 0 };
  for (const [name, bytes] of Object.entries(files)) {
    let rel: string;
    try { rel = cleanRelPath(name.replace(/\\/g, "/").slice(strip.length)); }
    catch { result.skipped++; continue; }
    if (rel.split("/").some((part) => SKIP_DIRS.has(part)) || rel.endsWith(".pyc") || rel === ".DS_Store") { result.skipped++; continue; }
    const file = resolveInside(uuid, rel);
    if (existsSync(file)) {
      if (isPersistentData(rel)) { result.keptData.push(rel); continue; }
      if (lstatSync(file).isSymbolicLink()) { result.skipped++; continue; }
    }
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    result.written++;
  }
  return result;
}

/** The whole project as a zip (for download / backup). */
export async function zipProject(uuid: string): Promise<Uint8Array> {
  // V-04: async reads + fflate's worker-thread zip keep the API responsive.
  const root = ensureProjectDir(uuid);
  const entries: Record<string, Uint8Array> = {};
  for (const f of listFiles(uuid)) if (!f.isDir) entries[f.path] = await readFile(path.join(root, f.path));
  return new Promise((resolve, reject) => zip(entries, { level: 6 }, (err, out) => (err ? reject(err) : resolve(out))));
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

/** Zips the project's code (not its data/ or database files). Keeps the last 30. */
export function snapshotProject(uuid: string, reason: string): Snapshot {
  const root = ensureProjectDir(uuid);
  const entries: Record<string, Uint8Array> = {};
  for (const f of listFiles(uuid)) {
    if (f.isDir || isPersistentData(f.path) || f.size > 5 * 1024 * 1024) continue;
    entries[f.path] = readFileSync(path.join(root, f.path));
  }
  const dir = path.join(SNAPSHOT_DIR, uuid);
  mkdirSync(dir, { recursive: true });
  // The id is the time in ms; two snapshots in the same millisecond (an undo
  // point, then the next fix's) must not overwrite each other.
  let createdAt = Date.now();
  while (existsSync(path.join(dir, `${createdAt}.zip`))) createdAt++;
  const id = String(createdAt);
  entries[".kojy-snapshot.json"] = new TextEncoder().encode(JSON.stringify({ reason, createdAt }));
  writeFileSync(path.join(dir, `${id}.zip`), zipSync(entries, { level: 6 }));
  const all = readdirSync(dir).filter((n) => n.endsWith(".zip")).sort();
  for (const old of all.slice(0, Math.max(0, all.length - MAX_SNAPSHOTS))) rmSync(path.join(dir, old), { force: true });
  return { id, reason, createdAt, files: Object.keys(entries).length - 1 };
}

/**
 * Snapshot before an owner's own change (a save in the code editor, a delete,
 * a zip upload) — unless the newest snapshot already has this reason and is
 * younger than `withinMs`, so a burst of saves doesn't push out older versions.
 */
export function snapshotUnlessRecent(uuid: string, reason: string, withinMs: number): Snapshot | null {
  if (!listFiles(uuid).some((f) => !f.isDir && !isPersistentData(f.path))) return null; // nothing to keep yet
  const newest = listSnapshots(uuid)[0];
  if (newest && newest.reason === reason && Date.now() - newest.createdAt < withinMs) return null;
  return snapshotProject(uuid, reason);
}

export function listSnapshots(uuid: string): Snapshot[] {
  const dir = path.join(SNAPSHOT_DIR, uuid);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".zip")).sort().reverse().map((name) => {
    // V-04: only decompress the small metadata entry; count the rest from the
    // zip's directory instead of unpacking every snapshot on every listing.
    let count = 0;
    const files = unzipSync(readFileSync(path.join(dir, name)), {
      filter: (f) => { if (f.name === ".kojy-snapshot.json") return true; if (!f.name.endsWith("/")) count++; return false; },
    });
    const meta = files[".kojy-snapshot.json"];
    const info = meta ? JSON.parse(strFromU8(meta)) as { reason: string; createdAt: number } : { reason: "", createdAt: Number(name.slice(0, -4)) };
    return { id: name.slice(0, -4), reason: info.reason, createdAt: info.createdAt, files: count };
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

/**
 * What restoring a snapshot would change, file by file: "added" = the
 * snapshot brings it back, "removed" = restoring deletes it (it was added
 * since), "modified" = with the diff from now to the snapshot's version.
 */
export function compareSnapshot(uuid: string, id: string, maxFiles = 30): { files: FileDiff[]; more: number } {
  if (!/^\d+$/.test(id)) throw new ProjectFileError("Invalid snapshot id");
  const file = path.join(SNAPSHOT_DIR, uuid, `${id}.zip`);
  if (!existsSync(file)) throw new ProjectFileError("That snapshot no longer exists");
  const snap = unzipSync(readFileSync(file));
  delete snap[".kojy-snapshot.json"];
  const root = ensureProjectDir(uuid);
  const current = new Set(listFiles(uuid).filter((f) => !f.isDir && !isPersistentData(f.path) && f.size <= 5 * 1024 * 1024).map((f) => f.path));
  const text = (b: Uint8Array): string | null => (b.length > MAX_EDIT_BYTES || b.includes(0) ? null : strFromU8(b));
  const out: FileDiff[] = [];
  for (const rel of [...new Set([...current, ...Object.keys(snap)])].sort()) {
    const then = snap[rel];
    if (!current.has(rel)) {
      const t = then ? text(then) : null;
      out.push({ path: rel, change: "added", added: t ? t.split("\n").length : 0, removed: 0, diff: null });
      continue;
    }
    const nowBytes = readFileSync(path.join(root, rel));
    if (!then) { out.push({ path: rel, change: "removed", added: 0, removed: (text(nowBytes) ?? "").split("\n").length, diff: null }); continue; }
    if (Buffer.from(nowBytes).equals(Buffer.from(then))) continue;
    const a = text(nowBytes), b = text(then);
    const d = a !== null && b !== null ? lineDiff(a, b, 2, 4000) : null;
    out.push({ path: rel, change: "modified", added: d?.added ?? 0, removed: d?.removed ?? 0, diff: d?.text ?? null });
  }
  return { files: out.slice(0, maxFiles), more: Math.max(0, out.length - maxFiles) };
}

export function removeSnapshots(uuid: string): void {
  rmSync(path.join(SNAPSHOT_DIR, uuid), { recursive: true, force: true });
  rmSync(path.join(KNOWN_GOOD_DIR, `${uuid}.zip`), { force: true });
}

// ── the last code the bot ran fine with ─────────────────────────────────────

/**
 * Keeps the bot's code as "the last version that ran fine" (one per bot,
 * not in Undo). Called after a run went well for a while; does nothing when
 * that code is already the one kept. Returns whether it saved.
 */
export function saveKnownGood(uuid: string): boolean {
  const fingerprint = codeFingerprint(uuid);
  if (!Object.keys(fingerprint).length) return false;
  const file = path.join(KNOWN_GOOD_DIR, `${uuid}.zip`);
  const kept = knownGood(uuid);
  if (kept && JSON.stringify(kept.fingerprint) === JSON.stringify(fingerprint)) return false;
  const root = projectDir(uuid);
  const entries: Record<string, Uint8Array> = {};
  for (const rel of Object.keys(fingerprint)) entries[rel] = readFileSync(path.join(root, rel));
  entries[".kojy-known-good.json"] = new TextEncoder().encode(JSON.stringify({ savedAt: Date.now(), fingerprint }));
  mkdirSync(KNOWN_GOOD_DIR, { recursive: true });
  writeFileSync(file, zipSync(entries, { level: 6 }));
  return true;
}

/** A file as a saved version holds it: absent, or there (text null when it isn't text). */
export type KeptFile = { exists: false } | { exists: true; text: string | null };

const keptFile = (zipFile: string, rel: string): KeptFile => {
  const got = unzipSync(readFileSync(zipFile), { filter: (f) => f.name === rel })[rel];
  if (!got) return { exists: false };
  return { exists: true, text: got.includes(0) ? null : strFromU8(got) };
};

/** One file as it was in the last version that ran fine; null when no such version was kept. */
export function knownGoodFile(uuid: string, rel: string): KeptFile | null {
  const file = path.join(KNOWN_GOOD_DIR, `${uuid}.zip`);
  if (!existsSync(file)) return null;
  try { return keptFile(file, rel); } catch { return null; }
}

/** When the last version that ran fine was kept, and its fingerprint; null when there's none. */
export function knownGood(uuid: string): { savedAt: number; fingerprint: Record<string, string> } | null {
  const file = path.join(KNOWN_GOOD_DIR, `${uuid}.zip`);
  if (!existsSync(file)) return null;
  try {
    const meta = unzipSync(readFileSync(file), { filter: (f) => f.name === ".kojy-known-good.json" })[".kojy-known-good.json"];
    return meta ? JSON.parse(strFromU8(meta)) as { savedAt: number; fingerprint: Record<string, string> } : null;
  } catch {
    return null;
  }
}

/**
 * What changed in the code since the last version that ran fine, file by
 * file ("modified" with the diff from then to now, "added" = new since,
 * "removed" = gone since). null when no such version was kept.
 */
export function changesSinceKnownGood(uuid: string, maxFiles = 30): { savedAt: number; files: FileDiff[]; more: number } | null {
  const file = path.join(KNOWN_GOOD_DIR, `${uuid}.zip`);
  if (!existsSync(file)) return null;
  const then = unzipSync(readFileSync(file));
  const meta = then[".kojy-known-good.json"];
  delete then[".kojy-known-good.json"];
  const savedAt = meta ? (JSON.parse(strFromU8(meta)) as { savedAt: number }).savedAt : 0;
  const root = projectDir(uuid);
  const now = codeFingerprint(uuid);
  const text = (b: Uint8Array): string | null => (b.length > MAX_EDIT_BYTES || b.includes(0) ? null : strFromU8(b));
  const out: FileDiff[] = [];
  for (const rel of [...new Set([...Object.keys(now), ...Object.keys(then)])].sort()) {
    const old = then[rel];
    if (!(rel in now)) { out.push({ path: rel, change: "removed", added: 0, removed: old ? (text(old) ?? "").split("\n").length : 0, diff: null }); continue; }
    const current = readFileSync(path.join(root, rel));
    if (!old) { out.push({ path: rel, change: "added", added: (text(current) ?? "").split("\n").length, removed: 0, diff: null }); continue; }
    if (Buffer.from(current).equals(Buffer.from(old))) continue;
    const a = text(old), b = text(current);
    const d = a !== null && b !== null ? lineDiff(a, b, 2, 4000) : null;
    out.push({ path: rel, change: "modified", added: d?.added ?? 0, removed: d?.removed ?? 0, diff: d?.text ?? null });
  }
  return { savedAt, files: out.slice(0, maxFiles), more: Math.max(0, out.length - maxFiles) };
}

/**
 * Puts the code back as it was the last time the bot ran fine (see
 * saveKnownGood); data/ and database files stay as they are. The current
 * code is kept as an Undo snapshot first (`label`). Returns when that code
 * was kept and the Undo snapshot's id — or null when there's nothing to go
 * back to (none kept, or the code is already that code).
 */
export function restoreKnownGood(uuid: string, label: string): { savedAt: number; snapshotId: string } | null {
  const file = path.join(KNOWN_GOOD_DIR, `${uuid}.zip`);
  if (!existsSync(file)) return null;
  const then = unzipSync(readFileSync(file));
  const metaBytes = then[".kojy-known-good.json"];
  delete then[".kojy-known-good.json"];
  if (!metaBytes || !Object.keys(then).length) return null;
  const meta = JSON.parse(strFromU8(metaBytes)) as { savedAt: number; fingerprint: Record<string, string> };
  const now = codeFingerprint(uuid);
  if (fingerprintChanges(now, meta.fingerprint).length === 0) return null;
  const snapshot = snapshotProject(uuid, label);
  const root = projectDir(uuid);
  for (const rel of Object.keys(now)) if (!(rel in then)) rmSync(path.join(root, rel), { force: true });
  for (const [rel, data] of Object.entries(then)) {
    const target = resolveInside(uuid, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  return { savedAt: meta.savedAt, snapshotId: snapshot.id };
}

/**
 * Writes a snapshot's code into `dest` (an empty folder), plus the bot's
 * current data/ and database files (snapshots don't keep those) — the code
 * as it was, with the data as it is, e.g. to run the old code in a test room.
 */
export function extractSnapshot(uuid: string, id: string, dest: string): void {
  if (!/^\d+$/.test(id)) throw new ProjectFileError("Invalid snapshot id");
  const file = path.join(SNAPSHOT_DIR, uuid, `${id}.zip`);
  if (!existsSync(file)) throw new ProjectFileError("That snapshot no longer exists");
  const files = unzipSync(readFileSync(file));
  delete files[".kojy-snapshot.json"];
  const root = path.resolve(dest);
  for (const [rel, data] of Object.entries(files)) {
    const target = path.resolve(root, rel);
    if (!target.startsWith(root + path.sep)) continue; // never outside dest
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  const live = projectDir(uuid);
  for (const f of listFiles(uuid)) {
    if (f.isDir || !isPersistentData(f.path)) continue;
    const target = path.join(root, f.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(path.join(live, f.path)));
  }
}

/** One file as an Undo snapshot holds it. */
export function snapshotFile(uuid: string, id: string, rel: string): KeptFile {
  if (!/^\d+$/.test(id)) throw new ProjectFileError("Invalid snapshot id");
  const file = path.join(SNAPSHOT_DIR, uuid, `${id}.zip`);
  if (!existsSync(file)) throw new ProjectFileError("That snapshot no longer exists");
  return keptFile(file, rel);
}

/** Removes one snapshot (e.g. one taken before a change that never happened). */
export function deleteSnapshot(uuid: string, id: string): void {
  if (!/^\d+$/.test(id)) throw new ProjectFileError("Invalid snapshot id");
  rmSync(path.join(SNAPSHOT_DIR, uuid, `${id}.zip`), { force: true });
}

/**
 * path → sha256 of each code file (what a snapshot keeps: not data/ or
 * databases, nothing over 5 MB). Two fingerprints differ when anyone changed,
 * added or removed code in between.
 */
export function codeFingerprint(uuid: string): Record<string, string> {
  const root = projectDir(uuid);
  const out: Record<string, string> = {};
  if (!existsSync(root)) return out;
  for (const f of listFiles(uuid)) {
    if (f.isDir || isPersistentData(f.path) || f.size > 5 * 1024 * 1024) continue;
    try { out[f.path] = createHash("sha256").update(readFileSync(path.join(root, f.path))).digest("hex"); } catch { /* gone meanwhile */ }
  }
  return out;
}

/** Files that were added, removed or changed between two fingerprints. */
export function fingerprintChanges(before: Record<string, string>, after: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((p) => before[p] !== after[p]).sort();
}
