/**
 * Kojy round 4: a developer's everyday tools.
 *
 * - edit_lines: replace a range of lines by number, for when an exact-text
 *   edit keeps missing (the free models copy text badly); a guard line makes
 *   sure the numbers are still right.
 * - rename_symbol: renames a name in the code only (Python's tokenizer:
 *   strings and comments stay), across every file, with the diff.
 * - trace_error: the newest traceback in the console, with the code around
 *   every step of it that is in the bot's own files, the failing line marked.
 * - run_unit_tests: runs the bot's own tests (pytest when installed, else a
 *   built-in runner), in a copy of the project, with placeholder values for its secrets.
 * - add_package: looks a package up on PyPI (or maps an import name to its
 *   package), writes it into requirements.txt and installs it; puts the file
 *   back if pip fails.
 * - restore_file: one file back as it was before this request or in the last
 *   version that ran fine.
 * - format_code: ruff format, with the diff.
 * Plus syntaxNote: after every change to a .py file, Python itself says at
 * once whether the file still parses.
 * OWNERSHIP: apps/runner/src/agent
 */

import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  listFiles, resolveInside, cleanRelPath, projectDir, isPersistentData, MAX_EDIT_BYTES, lineDiff, readLogs,
  knownGoodFile, snapshotFile,
} from "@kojyai/shared/projects";
import type { ToolSpec } from "./groq.js";
import type { ToolContext, ToolResult } from "./tools.js";
import type { CodeToolHelpers } from "./codeTools.js";
import { CODEINTEL, TESTRUNNER, VENVS_DIR } from "../supervisor.js";
import { grantDir, sandboxUid } from "../sandbox.js";
import { fetchPublic } from "./webFetch.js";
import { untrusted } from "./prompt.js";
import { projectFrames } from "./crashContext.js";
import { packageFor } from "../packages.js";
import { placeholderSecrets } from "./perfTools.js";

type Args = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : "");
const clip = (t: string, max = 8000) => (t.length > max ? `${t.slice(0, max)}\n… (${t.length - max} more characters)` : t);
const fn = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): ToolSpec => ({
  type: "function", function: { name, description, parameters: { type: "object", properties, required } },
});
const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });

export const DEV_TOOL_SPECS: ToolSpec[] = [
  fn("edit_lines", "Replace lines start_line..end_line (inclusive, as read_file numbers them) with new_text — for when edit_file can't match the text. first_line is the current text of start_line (trimmed), to make sure the numbers are still right. Read the lines again after an earlier edit moved them.",
    { path: str("file path"), start_line: int("first line to replace"), end_line: int("last line to replace (same as start_line for one line)"), new_text: str("the new lines (empty deletes them)"), first_line: str("current text of start_line") },
    ["path", "start_line", "end_line", "new_text", "first_line"]),
  fn("rename_symbol", "Rename a Python name (function, class, method, variable, argument) everywhere in the code — only the code, never text in strings or comments. Shows the diff. Better than replace_in_files for code.",
    { old_name: str("current name"), new_name: str("new name"), folder: str("optional folder") }, ["old_name", "new_name"]),
  fn("trace_error", "The newest error (traceback) in the bot's console, with the code around every step of it in the bot's own files, the failing line marked. Use it first when the bot crashed or printed an error."),
  fn("run_unit_tests", "Run the bot's own unit tests (test_*.py files: test_ functions, async ones too, and unittest classes) in a copy of the project, without its secrets; pytest runs them when it's installed. Shows each test's result and the failures. Write tests for logic you can test without a room (prices, parsing, games) next to the code.",
    { path: str("a test file or folder (default: all)"), match: str("only tests whose name contains this") }),
  fn("add_package", "Add a Python package the bot needs: checks its real name and latest version on PyPI (an import name like 'yaml' or 'PIL' works too), writes it into requirements.txt and installs it. If pip fails, requirements.txt is put back.",
    { name: str("package or import name, e.g. aiohttp, yaml"), version: str("optional exact version, e.g. 2.6.4") }, ["name"]),
  fn("restore_file", "Put ONE file back as it was: from='request' (default) before your changes in this request, from='last_working' as in the last version of the code that ran fine. The other files stay as they are.",
    { path: str("file path"), from: { type: "string", enum: ["request", "last_working"] } }, ["path"]),
  fn("format_code", "Tidy Python code's layout (ruff format: indentation, spacing, line breaks; nothing it does changes what the code does). One file, or every .py file without path.",
    { path: str("optional .py file") }),
];

export const DEV_TOOL_NAMES = new Set(DEV_TOOL_SPECS.map((t) => t.function.name));

const NAME = /^[A-Za-z_]\w{0,80}$/;
const PYTHON = () => process.env.PYTHON_BIN ?? "python3";
const RUFF = () => process.env.KOJY_RUFF ?? "ruff";

// ── syntax check after every change ──────────────────────────────────────────

const PARSE = "import ast,sys\ntry:\n ast.parse(open(sys.argv[1],encoding='utf-8',errors='replace').read(),sys.argv[1])\nexcept SyntaxError as e:\n print(f'{e.lineno}|{e.offset}|{e.msg}')";

/** Whether a .py file still parses: null when it does (or isn't Python), else "line N: message". */
export function syntaxProblem(file: string): Promise<string | null> {
  if (!file.endsWith(".py")) return Promise.resolve(null);
  return new Promise((resolve) => {
    // Parsing runs nothing from the file; ast is safe on any text.
    execFile(PYTHON(), ["-I", "-c", PARSE, file], { timeout: 10_000 }, (err, stdout) => {
      if (err && !stdout) return resolve(null); // no Python here: say nothing rather than something wrong
      const m = /^(\d+)\|(\d*)\|(.*)$/m.exec(stdout);
      resolve(m ? `line ${m[1]}: ${m[3]}` : null);
    });
  });
}

/** Names a .py file uses but never defines or imports (ruff F821/F822/F823), as "line N: message"; [] without ruff. */
export function undefinedNames(file: string): Promise<string[]> {
  if (!file.endsWith(".py")) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(RUFF(), ["check", "--isolated", "--no-cache", "--output-format", "concise", "--select", "F821,F822,F823", file], { timeout: 15_000 }, (_err, stdout) => {
      const out: string[] = [];
      for (const line of String(stdout ?? "").split("\n")) {
        const m = /:(\d+):\d+: (F82\d) (.*)$/.exec(line.trim());
        if (m) out.push(`line ${m[1]}: ${m[3]}`);
      }
      resolve(out.slice(0, 8));
    });
  });
}

/** What to add to a file change's result when the file no longer parses, or uses names that don't exist. */
export async function syntaxNote(file: string, rel: string, partial: boolean): Promise<string | null> {
  const p = await syntaxProblem(file);
  if (p) return `\n⚠ ${rel} doesn't parse now (${p}).${partial ? " If you're still writing it in parts, finish it first; otherwise" : ""} fix this before anything else (read_file around that line).`;
  const names = await undefinedNames(file);
  if (!names.length) return null;
  return `\n⚠ ${rel} uses names that aren't defined or imported anywhere in it: ${names.join("; ")}.${partial ? " If the next part defines them, fine;" : ""} Add the import or definition, or fix the spelling (find_symbol helps).`;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Loaded into pytest when pytest-asyncio isn't installed: without it pytest
 * fails every async test ("async def functions are not natively supported"),
 * and a bot's code is mostly async.
 */
export const ASYNC_PLUGIN = `import asyncio, inspect
import pytest

@pytest.hookimpl(tryfirst=True)
def pytest_pyfunc_call(pyfuncitem):
    if not inspect.iscoroutinefunction(pyfuncitem.obj):
        return None
    names = pyfuncitem._fixtureinfo.argnames
    asyncio.run(pyfuncitem.obj(**{n: pyfuncitem.funcargs[n] for n in names}))
    return True
`;

/** Numbered lines from..to, for showing a region after an edit. */
function numbered(lines: string[], from: number, to: number): string {
  const out: string[] = [];
  for (let n = Math.max(1, from); n <= Math.min(lines.length, to); n++) out.push(`${n}| ${lines[n - 1]}`);
  return out.join("\n");
}

const norm = (t: string) => t.replace(/\s+/g, " ").trim();

/** The newest traceback in some console lines (from "Traceback" to its exception line), or []. */
export function lastTraceback(lines: string[]): string[] {
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.includes("Traceback (most recent call last)")) { start = i; break; }
  if (start < 0) return [];
  const block = [lines[start]!];
  for (let i = start + 1; i < lines.length && block.length < 120; i++) {
    const l = lines[i]!;
    block.push(l);
    if (/^[A-Za-z_][\w.]*(Error|Exception|Exit|Interrupt|Warning)\b/.test(l.trim()) && !/^\s/.test(l)) break;
  }
  return block;
}

/** A requirement line's package name, normalized as pip does. */
const reqName = (line: string) => (/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line)?.[1] ?? "").toLowerCase().replace(/[-_.]+/g, "-");

/** requirements.txt with `pkg` set to `spec` (its old line replaced, or added at the end). */
export function setRequirement(text: string, pkg: string, spec: string): string {
  const want = reqName(pkg);
  const lines = text ? text.replace(/\n$/, "").split("\n") : [];
  const i = lines.findIndex((l) => !l.trim().startsWith("#") && reqName(l) === want);
  if (i >= 0) lines[i] = spec; else lines.push(spec);
  return `${lines.join("\n")}\n`;
}

// ── the tools ────────────────────────────────────────────────────────────────

export async function runDevTool(name: string, args: Args, ctx: ToolContext, h: CodeToolHelpers): Promise<ToolResult | null> {
  const uuid = ctx.project.uuid;
  const dir = projectDir(uuid);
  switch (name) {
    case "edit_lines": {
      const rel = cleanRelPath(s(args.path));
      const file = resolveInside(uuid, rel);
      if (!existsSync(file)) return { ok: false, output: `No such file: ${rel}`, summary: `Couldn't find ${rel}` };
      if (statSync(file).size > MAX_EDIT_BYTES) return { ok: false, output: "File is over 1 MB.", summary: `${rel} is too big` };
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      const start = Math.trunc(Number(args.start_line)), end = Math.trunc(Number(args.end_line));
      if (!(start >= 1) || !(end >= start - 1) || start > lines.length + 1 || end > lines.length) {
        return { ok: false, output: `Lines ${args.start_line}-${args.end_line} aren't in ${rel} (it has ${lines.length} lines). end_line = start_line - 1 inserts before start_line.`, summary: `Edit to ${rel} didn't apply` };
      }
      const guard = s(args.first_line);
      if (end >= start && norm(guard) !== norm(lines[start - 1] ?? "")) {
        return { ok: false, output: `Line ${start} isn't "${guard.slice(0, 80)}" any more — the lines moved. Now:\n${numbered(lines, start - 3, end + 3)}\nUse these numbers.`, summary: `Edit to ${rel} didn't apply (lines moved)` };
      }
      const add = s(args.new_text) === "" ? [] : s(args.new_text).replace(/\n$/, "").split("\n");
      const after = [...lines.slice(0, start - 1), ...add, ...lines.slice(end)];
      const next = after.join("\n");
      h.ensureSnapshot(ctx);
      writeFileSync(file, next);
      ctx.changedFiles.add(rel);
      const note = await syntaxNote(file, rel, false);
      return {
        ok: true,
        output: `Replaced lines ${start}-${end} with ${add.length} line${add.length === 1 ? "" : "s"}. Now:\n${numbered(after, start - 2, start + add.length + 1)}${note ?? ""}`,
        summary: `Edited ${rel} lines ${start}-${end}${note ? " — needs a fix" : ""}`,
        diff: lineDiff(text, next, 2, 4000)?.text ?? "",
      };
    }

    case "rename_symbol": {
      const oldName = s(args.old_name).trim(), newName = s(args.new_name).trim();
      if (!NAME.test(oldName) || !NAME.test(newName)) return { ok: false, output: "Both names must be Python names (letters, digits, _).", summary: "Invalid name" };
      if (oldName === newName) return { ok: false, output: "The names are the same.", summary: "Nothing to rename" };
      const folder = s(args.folder) ? cleanRelPath(s(args.folder)) : ".";
      const uid = sandboxUid(ctx.project.id);
      grantDir(dir, uid);
      const r = await h.runCapture(uid, PYTHON(), ["-I", CODEINTEL, "rename", oldName, newName, folder], dir, { PATH: process.env.PATH, HOME: dir, PYTHONDONTWRITEBYTECODE: "1" }, 60_000);
      let res: { files?: Record<string, string>; counts?: Record<string, number>; fstrings?: string[]; errors?: string[]; error?: string };
      try { res = JSON.parse(r.out.trim().split("\n").pop() ?? "{}") as typeof res; } catch { return { ok: false, output: clip(`The rename failed:\n${r.out}`), summary: "Rename failed" }; }
      if (res.error) return { ok: false, output: res.error, summary: "Rename failed" };
      const entries = Object.entries(res.files ?? {}).filter(([rel]) => !isPersistentData(rel));
      const notes = [
        ...(res.errors ?? []).map((e) => `- ${e}`),
        ...((res.fstrings ?? []).length ? [`- "${oldName}" also appears inside f-strings at ${res.fstrings!.slice(0, 10).join(", ")}: change those with edit_file.`] : []),
      ];
      if (!entries.length) return { ok: false, output: `"${oldName}" isn't used as a name in the code.${notes.length ? `\n${notes.join("\n")}` : ""}`, summary: "Nothing to rename" };
      h.ensureSnapshot(ctx);
      const diffs: string[] = [];
      for (const [rel, text] of entries) {
        const file = resolveInside(uuid, rel);
        const before = readFileSync(file, "utf8");
        writeFileSync(file, text);
        ctx.changedFiles.add(rel);
        diffs.push(`--- ${rel}\n${lineDiff(before, text, 1, 1500)?.text ?? ""}`);
      }
      const total = entries.reduce((a, [rel]) => a + (res.counts?.[rel] ?? 0), 0);
      return {
        ok: true,
        output: `Renamed ${oldName} → ${newName}: ${total} place${total === 1 ? "" : "s"} in ${entries.map(([rel]) => `${rel} (${res.counts?.[rel] ?? 0})`).join(", ")}.${notes.length ? `\n${notes.join("\n")}` : ""}\nRun check_code next.`,
        summary: `Renamed ${oldName} → ${newName} (${total}× in ${entries.length} file${entries.length === 1 ? "" : "s"})`,
        diff: diffs.join("\n").slice(0, 6000),
      };
    }

    case "trace_error": {
      const lines = readLogs(uuid, undefined, 512 * 1024).lines.map((l) => l.line);
      const tb = lastTraceback(lines);
      if (!tb.length) return { ok: true, output: "No traceback in the bot's recent console output. get_logs shows the newest lines.", summary: "No error in the console" };
      const frames = projectFrames(tb);
      const seen = new Set<string>();
      const parts: string[] = [];
      for (const [rel, line] of frames.reverse()) {
        if (seen.has(`${rel}:${line}`) || parts.length >= 4) continue;
        seen.add(`${rel}:${line}`);
        let code: string[];
        try { code = readFileSync(resolveInside(uuid, rel), "utf8").split("\n"); } catch { continue; }
        const from = Math.max(1, line - 6), to = Math.min(code.length, line + 3);
        const body: string[] = [];
        for (let n = from; n <= to; n++) body.push(`${n === line ? "→" : " "}${String(n).padStart(4)}| ${(code[n - 1] ?? "").slice(0, 200)}`);
        parts.push(`${rel}:${line}\n${body.join("\n")}`);
      }
      const exception = tb[tb.length - 1]!.trim();
      return {
        ok: true,
        output: `The newest error:\n${untrusted(tb.slice(-40).join("\n"))}\n\n${parts.length ? `Where it happened in the bot's code (innermost first; read the files again before editing):\n${parts.join("\n\n")}` : "None of its steps are in the bot's own files (it happened inside a library): the bot's call into that library is the place to look (search_code)."}`,
        summary: `Read the newest error: ${exception.slice(0, 70)}`,
      };
    }

    case "run_unit_tests": {
      const target = s(args.path) ? cleanRelPath(s(args.path)) : ".";
      const venvPython = path.join(VENVS_DIR, uuid, "bin", "python");
      const python = existsSync(venvPython) ? venvPython : await ctx.supervisor.ensureVenv(uuid, dir, ctx.project.id);
      const uid = sandboxUid(ctx.project.id);
      const work = mkdtempSync(path.join(tmpdir(), "kojy-unit-"));
      try {
        cpSync(dir, work, { recursive: true, filter: (src) => !/[/\\](\.git|node_modules|__pycache__|venv|\.venv)$/.test(src) });
        grantDir(work, uid);
        // Placeholder values for its secrets: tests never get the real ones, and code that reads them on import still loads.
        const env = { ...await placeholderSecrets(ctx), PATH: process.env.PATH, HOME: work, PYTHONPATH: work, PYTHONDONTWRITEBYTECODE: "1", KOJY_TEST: "1" };
        const match = s(args.match).replace(/[^\w -]/g, "").slice(0, 60);
        const probe = (await h.runCapture(uid, python, ["-c", "import pytest\ntry:\n import pytest_asyncio\n print('ASYNC_OK')\nexcept ImportError:\n print('NO_ASYNC')"], work, env, 20_000));
        const hasPytest = probe.code === 0;
        const plugin: string[] = [];
        if (hasPytest && probe.out.includes("NO_ASYNC")) {
          writeFileSync(path.join(work, "_kojy_async_plugin.py"), ASYNC_PLUGIN);
          plugin.push("-p", "_kojy_async_plugin");
        }
        const r = hasPytest
          ? await h.runCapture(uid, "timeout", ["-k", "5", "120", python, "-m", "pytest", "-q", "-p", "no:cacheprovider", ...plugin, "--no-header", "-rfE", "--tb=short", ...(match ? ["-k", match] : []), target], work, env, 135_000)
          : await h.runCapture(uid, "timeout", ["-k", "5", "120", python, TESTRUNNER, target, ...(match ? ["-k", match] : [])], work, env, 135_000);
        if (/NO_TESTS|no tests ran|collected 0 items/.test(r.out)) {
          return { ok: true, output: "This bot has no unit tests yet (test_*.py files with test_ functions). Write some for logic that can be tested without a room, then run them.", summary: "No unit tests yet" };
        }
        const timedOut = r.code === 124 || r.code === 137;
        let passed = 0, failed = 0, skipped = 0;
        if (hasPytest) {
          passed = Number(/(\d+) passed/.exec(r.out)?.[1] ?? 0); failed = Number(/(\d+) failed/.exec(r.out)?.[1] ?? 0) + Number(/(\d+) errors?/.exec(r.out)?.[1] ?? 0); skipped = Number(/(\d+) skipped/.exec(r.out)?.[1] ?? 0);
        } else {
          const m = /RESULT (\d+) (\d+) (\d+)/.exec(r.out);
          if (m) { passed = Number(m[1]); failed = Number(m[2]); skipped = Number(m[3]); }
        }
        const ok = !timedOut && failed === 0 && (r.code === 0 || (!hasPytest && /RESULT /.test(r.out)));
        return {
          ok,
          output: clip(`${hasPytest ? "pytest" : "Built-in runner (no pytest installed)"}: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}${timedOut ? " — stopped after 120s" : ""}\n${untrusted(r.out.trim())}`, 10_000),
          summary: timedOut ? "Unit tests timed out" : `Unit tests: ${passed} passed${failed ? `, ${failed} failed` : ""}${skipped ? `, ${skipped} skipped` : ""}`,
        };
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    }

    case "add_package": {
      let pkg = s(args.name).trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(pkg)) return { ok: false, output: "Give a package name, e.g. aiohttp.", summary: "Invalid package name" };
      const version = s(args.version).trim();
      if (version && !/^[\w.+!-]{1,40}$/.test(version)) return { ok: false, output: "version is an exact version like 2.6.4.", summary: "Invalid version" };
      const mapped = packageFor(pkg);
      if (mapped && mapped.toLowerCase() !== pkg.toLowerCase()) pkg = mapped;
      let info: { info?: { name?: string; version?: string; requires_python?: string | null; yanked?: boolean }; releases?: Record<string, unknown> };
      try {
        const page = await fetchPublic(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`, undefined, { raw: true });
        if (page.status === 404) return { ok: false, output: `There's no package called "${pkg}" on PyPI. Check the name (web_search "<what it does> python package").`, summary: `No package ${pkg} on PyPI` };
        if (page.status >= 400) return { ok: false, output: `PyPI answered HTTP ${page.status}.`, summary: "PyPI lookup failed" };
        info = JSON.parse(page.text) as typeof info;
      } catch (err) {
        return { ok: false, output: `Couldn't ask PyPI: ${(err as Error).message}`, summary: "PyPI lookup failed" };
      }
      const real = info.info?.name ?? pkg;
      const latest = info.info?.version ?? "";
      if (version && info.releases && !(version in info.releases)) {
        return { ok: false, output: `${real} has no version ${version}. Recent ones: ${Object.keys(info.releases).slice(-8).join(", ")}.`, summary: `${real} ${version} doesn't exist` };
      }
      const spec = version ? `${real}==${version}` : latest ? `${real}>=${latest}` : real;
      const reqFile = path.join(dir, "requirements.txt");
      const before = existsSync(reqFile) ? readFileSync(reqFile, "utf8") : "";
      const next = setRequirement(before, real, spec);
      h.ensureSnapshot(ctx);
      writeFileSync(reqFile, next);
      ctx.changedFiles.add("requirements.txt");
      const since = Date.now();
      try {
        await ctx.supervisor.ensureVenv(uuid, dir, ctx.project.id);
      } catch (err) {
        writeFileSync(reqFile, before);
        const pip = readLogs(uuid, undefined, 128 * 1024).lines.filter((l) => l.ts >= since - 1000).map((l) => l.line).slice(-25).join("\n");
        return { ok: false, output: clip(`Installing ${spec} failed (${(err as Error).message}), so requirements.txt was put back. pip said:\n${untrusted(pip || "(nothing)")}`), summary: `Couldn't install ${real}` };
      }
      const needs = info.info?.requires_python ? ` (needs Python ${info.info.requires_python})` : "";
      return {
        ok: true,
        output: `Added ${spec} to requirements.txt and installed it${needs}. inspect_package ${real.toLowerCase().replace(/-/g, "_")} shows its API (the import name can differ from the package's).`,
        summary: `Added ${spec}`,
        diff: lineDiff(before, next, 1, 2000)?.text ?? "",
      };
    }

    case "restore_file": {
      const rel = cleanRelPath(s(args.path));
      if (isPersistentData(rel)) return { ok: false, output: "The bot's data files aren't restored this way (they're its saved state).", summary: "Refused to restore data" };
      const from = s(args.from) === "last_working" ? "last_working" : "request";
      let kept;
      if (from === "request") {
        if (!ctx.snapshotId) return { ok: false, output: "You haven't changed any files in this request, so it's already as it was.", summary: "Nothing to restore" };
        kept = snapshotFile(uuid, ctx.snapshotId, rel);
      } else {
        kept = knownGoodFile(uuid, rel);
        if (!kept) return { ok: false, output: "No version that ran fine has been kept for this bot yet.", summary: "No working version kept" };
      }
      const file = resolveInside(uuid, rel);
      const now = existsSync(file) ? readFileSync(file, "utf8") : null;
      const label = from === "request" ? "before this request" : "in the last version that ran fine";
      if (!kept.exists) {
        if (now === null) return { ok: true, output: `${rel} didn't exist ${label} and doesn't now.`, summary: "Nothing to restore" };
        h.ensureSnapshot(ctx);
        rmSync(file, { force: true });
        ctx.changedFiles.add(rel);
        return { ok: true, output: `${rel} didn't exist ${label}, so it was removed.`, summary: `Restored ${rel} (removed)` };
      }
      if (kept.text === null) return { ok: false, output: `${rel} isn't a text file.`, summary: "Can't restore a binary file" };
      if (kept.text === now) return { ok: true, output: `${rel} is already as it was ${label}.`, summary: `${rel} already as it was` };
      h.ensureSnapshot(ctx);
      writeFileSync(file, kept.text);
      ctx.changedFiles.add(rel);
      return { ok: true, output: `${rel} is back as it was ${label}. Restart the bot if it runs this code.`, summary: `Restored ${rel} (${from === "request" ? "before this request" : "last working"})`, diff: lineDiff(now ?? "", kept.text, 2, 4000)?.text ?? "" };
    }

    case "format_code": {
      const one = s(args.path) ? cleanRelPath(s(args.path)) : "";
      if (one && !one.endsWith(".py")) return { ok: false, output: "format_code tidies .py files.", summary: "Not a Python file" };
      const targets = one ? [one] : listFiles(uuid).filter((f) => !f.isDir && f.path.endsWith(".py") && !isPersistentData(f.path) && f.size <= MAX_EDIT_BYTES && !/(^|\/)(venv|\.venv|node_modules)\//.test(f.path)).map((f) => f.path).slice(0, 200);
      if (!targets.length) return { ok: true, output: "No Python files to format.", summary: "Nothing to format" };
      const before = new Map(targets.map((rel) => [rel, existsSync(resolveInside(uuid, rel)) ? readFileSync(resolveInside(uuid, rel), "utf8") : ""]));
      if (one && !existsSync(resolveInside(uuid, one))) return { ok: false, output: `No such file: ${one}`, summary: `Couldn't find ${one}` };
      // ruff stops at a syntax error; say where instead of formatting half the project.
      for (const rel of targets) {
        const p = await syntaxProblem(resolveInside(uuid, rel));
        if (p) return { ok: false, output: `${rel} doesn't parse (${p}); fix that first.`, summary: `Can't format: syntax error in ${rel}` };
      }
      h.ensureSnapshot(ctx);
      const uid = sandboxUid(ctx.project.id);
      grantDir(dir, uid);
      const r = await h.runCapture(uid, RUFF(), ["format", "--isolated", "--no-cache", "--line-length", "120", ...targets], dir, { PATH: process.env.PATH, HOME: dir }, 60_000);
      if (r.code === -1 || (r.code !== 0 && /not found|No such file/.test(r.out))) return { ok: false, output: "ruff isn't installed here, so nothing was formatted.", summary: "Formatter unavailable" };
      if (r.code !== 0) return { ok: false, output: clip(`ruff format failed:\n${r.out}`), summary: "Formatting failed" };
      const changed: string[] = [];
      const diffs: string[] = [];
      for (const [rel, old] of before) {
        const now = readFileSync(resolveInside(uuid, rel), "utf8");
        if (now === old) continue;
        changed.push(rel);
        ctx.changedFiles.add(rel);
        diffs.push(`--- ${rel}\n${lineDiff(old, now, 1, 1500)?.text ?? ""}`);
      }
      return {
        ok: true,
        output: changed.length ? `Formatted ${changed.length} file${changed.length === 1 ? "" : "s"}: ${changed.join(", ")}. Line numbers may have moved: read again before line-based edits.` : "Already tidy: nothing changed.",
        summary: changed.length ? `Formatted ${changed.length} file${changed.length === 1 ? "" : "s"}` : "Code already tidy",
        ...(diffs.length ? { diff: diffs.join("\n").slice(0, 6000) } : {}),
      };
    }

    default:
      return null;
  }
}
