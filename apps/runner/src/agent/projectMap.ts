/**
 * The project map: one short line per Python file — its classes, functions,
 * slash and prefix commands, Highrise chat commands and event handlers —
 * read from the code with patterns (nothing runs). It goes into Kojy's
 * instructions so it knows where things are without spending steps (and
 * the free plans' daily requests) listing and reading files to find them.
 * Kept per project until a file changes.
 * OWNERSHIP: apps/runner/src/agent
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isPersistentData, listFiles, projectDir } from "@kojyai/shared/projects";

export const MAP_MAX_CHARS = Number(process.env.AGENT_MAP_CHARS ?? 2400);
const MAX_FILES = 80;

const cache = new Map<string, { key: string; map: string }>();

const uniq = (xs: string[]) => [...new Set(xs)];
const list = (label: string, xs: string[], max = 12) => (xs.length ? `${label} ${xs.slice(0, max).join(", ")}${xs.length > max ? ` +${xs.length - max}` : ""}` : "");

/** What one Python file holds, in a line ("" when nothing worth naming). */
export function describeFile(text: string): string {
  const lines = text.split("\n");
  const classes: string[] = [];
  const functions: string[] = [];
  const handlers: string[] = [];
  const slash: string[] = [];
  const prefix: string[] = [];
  const groups = new Map<string, string>(); // variable → group name
  for (const m of text.matchAll(/^\s*(\w+)\s*=\s*(?:discord\.)?app_commands\.Group\([^)]*?name\s*=\s*["']([\w-]+)["']/gm)) groups.set(m[1]!, m[2]!);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    let m: RegExpExecArray | null;
    if ((m = /^class\s+(\w+)/.exec(l))) { classes.push(m[1]!); continue; }
    if ((m = /^(\s*)(?:async\s+)?def\s+(\w+)/.exec(l))) {
      const name = m[2]!;
      if (/^on_[a-z_]+$/.test(name)) handlers.push(name);
      else if (!name.startsWith("__")) functions.push(name);
      continue;
    }
    if (!l.trim().startsWith("@") || !/command/i.test(l)) continue;
    const named = /name\s*=\s*["']([\w-]+)["']/.exec(l)?.[1];
    const next = lines.slice(i + 1, i + 6).map((x) => /^\s*(?:async\s+)?def\s+(\w+)/.exec(x)?.[1]).find(Boolean);
    const name = named ?? next;
    if (!name) continue;
    const group = /^\s*@(\w+)\.command/.exec(l)?.[1];
    if (/tree\.command|app_commands\.command|hybrid_command/.test(l)) slash.push(`/${name}`);
    else if (group && groups.has(group)) slash.push(`/${groups.get(group)} ${name}`);
    else prefix.push(name);
  }
  // Highrise bots usually match chat text: message.startswith("!coins"), message == "!help", in ("!a", "!b").
  const chat = uniq([...text.matchAll(/(?:startswith|==|\bin)\s*\(?\s*((?:["'][!/.][\w-]+["']\s*,?\s*)+)/g)]
    .flatMap((m) => [...m[1]!.matchAll(/["']([!/.][\w-]+)["']/g)].map((x) => x[1]!)));
  return [
    list("classes", uniq(classes), 6),
    list("handlers", uniq(handlers), 10),
    list("slash", uniq(slash)),
    list("prefix commands", uniq(prefix)),
    list("chat commands", chat, 20),
    list("functions", uniq(functions).filter((f) => !handlers.includes(f)), 14),
  ].filter(Boolean).join(" · ");
}

/** The map of a project's Python code, cut to MAP_MAX_CHARS ("" for a project with none). */
export function projectMap(uuid: string): string {
  let files;
  try { files = listFiles(uuid).filter((f) => !f.isDir && f.path.endsWith(".py") && !isPersistentData(f.path) && f.size <= 300_000 && !/(^|\/)(venv|\.venv|site-packages|node_modules)\//.test(f.path)); } catch { return ""; }
  files = files.slice(0, MAX_FILES);
  const root = projectDir(uuid);
  const key = files.map((f) => { let t = 0; try { t = statSync(path.join(root, f.path)).mtimeMs; } catch { /* gone */ } return `${f.path}:${f.size}:${t}`; }).join("|");
  const hit = cache.get(uuid);
  if (hit && hit.key === key) return hit.map;
  const out: string[] = [];
  let used = 0;
  for (const f of files) {
    let text = "";
    try { text = readFileSync(path.join(root, f.path), "utf8"); } catch { continue; }
    const what = describeFile(text);
    const line = `- ${f.path} (${text.split("\n").length} lines)${what ? `: ${what}` : ""}`;
    if (used + line.length > MAP_MAX_CHARS) { out.push(`- … ${files.length - out.length} more files (list_files)`); break; }
    out.push(line);
    used += line.length + 1;
  }
  const map = out.join("\n");
  cache.set(uuid, { key, map });
  return map;
}
