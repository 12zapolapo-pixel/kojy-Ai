/**
 * What an automatic fix starts with besides the traceback, so Kojy doesn't
 * spend its first steps (and the AI's limits) finding it:
 *   - the code around where it failed, with line numbers, the failing line marked;
 *   - what changed in the code since the bot last ran fine — most crashes
 *     come from the latest change, and this points straight at it.
 * Both come from the bot's own code files, never its data or the room.
 * OWNERSHIP: apps/runner/src/agent
 */

import { readFileSync } from "node:fs";
import { changesSinceKnownGood, resolveInside } from "@kojyai/shared/projects";

const FRAME = /File "([^"]+)", line (\d+), in (\S+)/;
const LIBRARY = /site-packages|dist-packages|[/\\]lib[/\\]python3|<frozen|launcher\.py$|kojy_launcher\.py$/;

/** The traceback's steps in the bot's own files, innermost last: [relative path, line]. */
export function projectFrames(tail: string[]): [string, number][] {
  const out: [string, number][] = [];
  for (const line of tail) {
    const m = FRAME.exec(line);
    if (!m || LIBRARY.test(m[1]!)) continue;
    const rel = m[1]!.replace(/^.*?[/\\]projects[/\\][^/\\]+[/\\]/, "").replace(/^\/home\/container\//, "");
    if (rel.startsWith("/") || rel.startsWith("<")) continue;
    out.push([rel, Number(m[2])]);
  }
  return out;
}

/** The code around the innermost two places it failed (deduplicated), numbered, the failing line marked with →. "" when unreadable. */
export function codeAround(uuid: string, tail: string[], before = 10, after = 5): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const [rel, line] of projectFrames(tail).reverse()) {
    if (parts.length >= 2 || seen.has(`${rel}:${line}`)) continue;
    seen.add(`${rel}:${line}`);
    let lines: string[];
    try { lines = readFileSync(resolveInside(uuid, rel), "utf8").split("\n"); } catch { continue; }
    const from = Math.max(1, line - before);
    const to = Math.min(lines.length, line + after);
    const width = String(to).length;
    const body = [];
    for (let n = from; n <= to; n++) body.push(`${n === line ? "→" : " "}${String(n).padStart(width)} | ${(lines[n - 1] ?? "").slice(0, 200)}`);
    parts.push(`${rel}:\n${body.join("\n")}`);
  }
  return parts.join("\n\n");
}

/**
 * What changed since the bot last ran fine, the files in the traceback first,
 * cut to `maxChars`. "" when there's no such version or nothing changed.
 */
export function changesSinceGood(uuid: string, tail: string[], maxChars = 3500): string {
  const since = changesSinceKnownGood(uuid, 40);
  if (!since || !since.files.length) return "";
  const inTrace = new Set(projectFrames(tail).map(([rel]) => rel));
  const files = [...since.files].sort((a, b) => Number(inTrace.has(b.path)) - Number(inTrace.has(a.path)));
  const when = new Date(since.savedAt).toISOString().slice(0, 16).replace("T", " ");
  const out: string[] = [`(the last version that ran fine was kept at ${when} UTC)`];
  let size = out[0]!.length;
  for (const f of files) {
    const head = f.change === "modified" ? `--- ${f.path} (changed: +${f.added} −${f.removed})` : `--- ${f.path} (${f.change === "added" ? "new since then" : "removed since then"})`;
    const block = f.change === "modified" && f.diff ? `${head}\n${f.diff}` : head;
    if (size + block.length > maxChars) { out.push(`… and ${files.length - out.length + 1} more file(s) changed`); break; }
    out.push(block);
    size += block.length;
  }
  if (since.more) out.push(`… and ${since.more} more file(s)`);
  return out.join("\n");
}
