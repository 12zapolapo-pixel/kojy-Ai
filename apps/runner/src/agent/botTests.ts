/**
 * Test checks and saved tests. A test is steps in the test room (see
 * parseSteps) plus checks on what the bot did; each bot keeps its tests in
 * .kojy/tests.json, and all of them run after every change before the real
 * bot restarts.
 * OWNERSHIP: apps/runner/src/agent
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { projectDir } from "@kojyai/shared/projects";
import { KOJY_DIR } from "./codeQuality.js";
import { parseSteps, runRoomTest, type RoomTestOptions, type RoomTestResult } from "./mockRoom.js";

export interface SavedTest {
  name: string;
  steps: string[];
  expect: string[];
  env?: Record<string, string>;
  refuse?: Record<string, string>;
}

const TESTS_FILE = `${KOJY_DIR}/tests.json`;
export const MAX_TESTS = 20;

/** "ChangeRoomPrivilegeRequest=You can't edit this room." → { ChangeRoomPrivilegeRequest: "…" } */
export function parseRefusals(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of (Array.isArray(raw) ? raw : []).slice(0, 10)) {
    const m = /^([A-Z]\w{2,60}Request)=(.{1,200})$/s.exec(String(item).trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

export interface CheckResult { check: string; ok: boolean; why: string }

const SAID = /^(say|whisper to [^:]+|DM): /;

/**
 * Checks on a test run:
 *   "says: <regex>"        the bot said, whispered or DMed something matching (any case)
 *   "not says: <regex>"    it never did
 *   "whispers: <regex>"    a whisper matching
 *   "does: <regex>"        any action matches, e.g. "does: emote", "does: TeleportRequest"
 *   "no errors"            nothing printed an error or traceback
 *   "count says: <regex> = N"  exactly N matching messages
 */
export function evaluate(checks: string[], r: RoomTestResult): CheckResult[] {
  const said = r.actions.filter((a) => SAID.test(a));
  const done = r.actions.filter((a) => !a.startsWith("("));
  const out: CheckResult[] = [];
  for (const raw of checks.slice(0, 20)) {
    const check = String(raw).trim();
    const m = /^(not says|says|whispers|does|count says):\s*(.+?)(?:\s*=\s*(\d+))?$/i.exec(check);
    if (/^no errors$/i.test(check)) {
      const ok = r.errors.length === 0 && !r.exitedEarly;
      out.push({ check, ok, why: ok ? "no errors" : r.exitedEarly ? "the bot exited" : r.errors[0]!.slice(0, 160) });
      continue;
    }
    if (!m) { out.push({ check, ok: false, why: "unknown check (use says: / not says: / whispers: / does: / count says: … = N / no errors)" }); continue; }
    let re: RegExp;
    try { re = new RegExp(m[2]!, "i"); } catch { out.push({ check, ok: false, why: "invalid regular expression" }); continue; }
    const kind = m[1]!.toLowerCase();
    const pool = kind === "does" ? done : kind === "whispers" ? said.filter((a) => a.startsWith("whisper")) : said;
    const hits = pool.filter((a) => re.test(a.replace(SAID, "")) || (kind === "does" && re.test(a)));
    if (kind === "not says") out.push({ check, ok: hits.length === 0, why: hits.length ? `it said: ${hits[0]!.slice(0, 120)}` : "never said it" });
    else if (kind === "count says") {
      const want = Number(m[3] ?? NaN);
      out.push({ check, ok: hits.length === want, why: `${hits.length} matching message${hits.length === 1 ? "" : "s"}` });
    } else out.push({ check, ok: hits.length > 0, why: hits.length ? hits[0]!.slice(0, 120) : `nothing matched; it ${said.length ? `said: ${said.slice(-2).join(" | ").slice(0, 160)}` : "said nothing"}` });
  }
  return out;
}

export function formatChecks(results: CheckResult[]): string {
  return results.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.check} — ${c.why}`).join("\n");
}

// ── saved tests ──────────────────────────────────────────────────────────────

export function loadTests(uuid: string): SavedTest[] {
  const file = path.join(projectDir(uuid), TESTS_FILE);
  if (!existsSync(file)) return [];
  try {
    const list = JSON.parse(readFileSync(file, "utf8")) as SavedTest[];
    return Array.isArray(list) ? list.filter((t) => t && typeof t.name === "string" && Array.isArray(t.steps)) : [];
  } catch { return []; }
}

export function saveTests(uuid: string, tests: SavedTest[]): void {
  const file = path.join(projectDir(uuid), TESTS_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(tests.slice(0, MAX_TESTS), null, 2) + "\n");
}

/** Validates a test from the AI's arguments. */
export function toTest(args: Record<string, unknown>, settings: (raw: unknown) => Record<string, string>): SavedTest | string {
  const name = typeof args.name === "string" ? args.name.trim().slice(0, 80) : "";
  const steps = (Array.isArray(args.steps) ? args.steps : []).map(String).filter((x) => x.trim()).slice(0, 25);
  const expect = (Array.isArray(args.expect) ? args.expect : []).map(String).filter((x) => x.trim()).slice(0, 20);
  if (!name) return "A test needs a name.";
  if (!steps.length) return "A test needs steps.";
  if (!expect.length) return "A test needs at least one check in expect (e.g. \"says: added\"), or it can't fail.";
  const { errors } = parseSteps(steps);
  if (errors.length) return `Bad steps: ${errors.join(", ")}`;
  const env = settings(args.env);
  const refuse = parseRefusals(args.refuse);
  return { name, steps, expect, ...(Object.keys(env).length ? { env } : {}), ...(Object.keys(refuse).length ? { refuse } : {}) };
}

export interface TestRun { test: SavedTest; ok: boolean; checks: CheckResult[]; result: RoomTestResult }

type Base = Omit<RoomTestOptions, "steps" | "chat" | "extraEnv" | "refuse">;

export async function runTest(base: Base, test: SavedTest): Promise<TestRun> {
  const result = await runRoomTest({ ...base, steps: test.steps, extraEnv: test.env ?? {}, refuse: test.refuse ?? {} });
  const checks = evaluate(test.expect, result);
  const ok = result.connected && !result.exitedEarly && checks.every((c) => c.ok);
  return { test, ok, checks, result };
}

/** Runs tests two at a time (each is a small Python process; the server is small). */
export async function runAll(base: Base, tests: SavedTest[]): Promise<TestRun[]> {
  const out: TestRun[] = new Array(tests.length);
  let next = 0;
  const worker = async () => { while (next < tests.length) { const i = next++; out[i] = await runTest(base, tests[i]!); } };
  await Promise.all([worker(), worker()]);
  return out;
}

export function formatRuns(runs: TestRun[]): string {
  return runs.map((r) => {
    const head = `${r.ok ? "PASS" : "FAIL"} ${r.test.name}`;
    if (r.ok) return head;
    const why = !r.result.connected ? "never connected" : r.result.exitedEarly ? `the bot exited (code ${r.result.exitCode})` : "";
    return [head + (why ? ` — ${why}` : ""), formatChecks(r.checks.filter((c) => !c.ok)).replace(/^/gm, "    "),
      r.result.errors.length ? `    errors: ${r.result.errors.slice(0, 4).join(" // ").slice(0, 400)}` : ""].filter(Boolean).join("\n");
  }).join("\n");
}
