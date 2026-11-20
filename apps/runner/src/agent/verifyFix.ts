/**
 * Checking an automatic fix — the runner's own checks after Kojy changed the
 * code for a crash, so a fix stays because it passed them, not because the
 * AI said it was done. A fix that fails them is undone (agent.ts).
 * OWNERSHIP: apps/runner/src/agent
 *
 *   1. the code loads (check_code: compiles, the bot class imports, no
 *      placeholder method hides a real one);
 *   2. the crash, replayed in a test room on the code from before the fix and
 *      on the fixed code: the handler that failed gets its event again (the
 *      chat command, a join, a tip…), a crash while starting just starts. If
 *      the old code crashes that way, the fixed code must not — that proves
 *      the fix, and the replay is kept as a saved test. If the old code
 *      doesn't crash there (the bug needs a certain message or state), the
 *      replay only has to run without new errors;
 *   3. saved tests: none that passed before fails now.
 * Then (agent.ts) the real bot is started with the fix and has to get back
 * into its room.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { roomTests } from "@kojyai/db/schema";
import { extractSnapshot, isStartCommand, projectDir } from "@kojyai/shared/projects";
import { LAUNCHER } from "../supervisor.js";
import { sandboxUid } from "../sandbox.js";
import { runRoomTest, type RoomEvent, type RoomTestResult } from "./mockRoom.js";
import { runTool, type ToolContext, type ToolResult } from "./tools.js";
import { tracebackSignatures } from "./autoFix.js";

/** The handler that was running when it failed, and the chat command, if any. */
export interface FixEvent { handler?: string; command?: string }

/** What to do in the test room to make the crash happen again, or null when there's no way to tell. */
export function replayEvents(event: FixEvent | undefined, phase: string | undefined): RoomEvent[] | null {
  if (phase === "import" || phase === "startup") return [{ type: "wait", seconds: 4 }];
  const message = event?.command ?? "hello";
  switch (event?.handler) {
    case "on_chat": return [{ type: "chat", user: "tester", message }];
    case "on_whisper": return [{ type: "whisper", user: "tester", message }];
    case "on_user_join": return [{ type: "join", user: "visitor" }];
    case "on_user_leave": return [{ type: "join", user: "visitor" }, { type: "leave", user: "visitor" }];
    case "on_tip": return [{ type: "tip", user: "tester", amount: 10 }];
    case "on_emote": return [{ type: "emote", user: "tester" }];
    case "on_start": return [{ type: "wait", seconds: 4 }];
    default: return null;
  }
}

export interface FixCheck {
  ok: boolean;
  /** One line per check, for the chat ("✓ the code loads"). */
  steps: string[];
  /** Why it failed — for Kojy's next attempt and the owner. */
  failure?: string;
  /** The crash happened in the test room before the fix and not after it. */
  proven: boolean;
  /** The replay that proved it (kept as a saved test). */
  events?: RoomEvent[];
}

/** What the checks use (swapped in tests). */
export interface CheckDeps {
  runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
  replay(ctx: ToolContext, events: RoomEvent[], dir: string): Promise<RoomTestResult>;
}

export const defaultCheckDeps: CheckDeps = {
  runTool,
  async replay(ctx, events, dir) {
    const uuid = ctx.project.uuid;
    const python = await ctx.supervisor.ensureVenv(uuid, projectDir(uuid), ctx.project.id);
    const env = await ctx.supervisor.botEnv(ctx.project, python, projectDir(uuid));
    return runRoomTest({ uid: sandboxUid(ctx.project.id), projectDir: dir, python, launcher: LAUNCHER, entrypoint: ctx.project.entrypoint, env, events, moderator: true });
  },
};

export async function checkFix(
  ctx: ToolContext,
  fix: { signature: string; snapshotId: string; event?: FixEvent | undefined; phase?: string | undefined },
  deps: CheckDeps = defaultCheckDeps,
): Promise<FixCheck> {
  const steps: string[] = [];
  const fail = (failure: string): FixCheck => ({ ok: false, steps: [...steps, `✗ ${failure}`], failure, proven: false });

  const code = await deps.runTool("check_code", {}, ctx);
  if (!code.ok) return fail(`the code check failed (${code.summary})`);
  steps.push("✓ the code loads");

  let proven = false;
  const events = isStartCommand(ctx.project.entrypoint) ? null : replayEvents(fix.event, fix.phase);
  if (events) {
    const before = mkdtempSync(path.join(tmpdir(), "kojy-before-fix-"));
    try {
      extractSnapshot(ctx.project.uuid, fix.snapshotId, before);
      const [old, now] = await Promise.all([deps.replay(ctx, events, before), deps.replay(ctx, events, projectDir(ctx.project.uuid))]);
      const startCrash = fix.phase === "import" || fix.phase === "startup";
      const oldErrors = tracebackSignatures(old.output);
      const newErrors = tracebackSignatures(now.output);
      const crashedBefore = oldErrors.includes(fix.signature) || (startCrash && !old.connected);
      if (crashedBefore && (newErrors.includes(fix.signature) || (startCrash && !now.connected))) return fail("the crash still happens when it's replayed in a test room");
      const added = newErrors.filter((sig) => !oldErrors.includes(sig));
      if (now.exitedEarly && !old.exitedEarly) return fail(`the fixed code crashed in the test room${added[0] ? ` (${added[0]})` : ""}`);
      if (added.length) return fail(`the fixed code has a new error in the test room (${added[0]})`);
      proven = crashedBefore;
      steps.push(crashedBefore ? "✓ replayed in a test room: it crashed before the fix and not after" : "✓ replayed in a test room without errors (the crash itself didn't show there)");
    } catch (err) {
      steps.push(`– couldn't replay it in a test room (${(err as Error).message.slice(0, 120)})`);
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  }

  const tests = await ctx.db.select({ name: roomTests.name, lastResult: roomTests.lastResult }).from(roomTests).where(eq(roomTests.projectId, ctx.project.id));
  if (tests.length) {
    const passedBefore = tests.filter((t) => t.lastResult === "passed").map((t) => t.name);
    const saved = await deps.runTool("run_saved_tests", {}, ctx);
    const failing = tests.map((t) => t.name).filter((name) => saved.output.includes(`FAIL ${name}:`));
    const broke = failing.filter((name) => passedBefore.includes(name));
    if (broke.length) return fail(`saved test${broke.length > 1 ? "s" : ""} that passed before now fail${broke.length > 1 ? "" : "s"}: ${broke.slice(0, 3).join(", ")}`);
    steps.push(failing.length ? `✓ saved tests: none broken by the fix (${failing.length} were already failing)` : "✓ saved tests pass");
  }
  return { ok: true, steps, proven, ...(proven && events ? { events } : {}) };
}

/** Saved tests KojyAI keeps by itself (a replay that proved a fix) start with this. */
export const AUTO_TEST_PREFIX = "auto: ";
const MAX_AUTO_TESTS = 5;

/** Keeps the replay that proved a fix as a saved test, so the bug can't come back unnoticed (the newest 5 per bot). */
export async function saveRegressionTest(ctx: ToolContext, summary: string, events: RoomEvent[]): Promise<void> {
  const name = `${AUTO_TEST_PREFIX}${summary}`.slice(0, 80);
  const stored = events as unknown as Record<string, unknown>[];
  await ctx.db.insert(roomTests).values({ projectId: ctx.project.id, name, events: stored, expect: [], moderator: true, lastResult: "passed", lastRunAt: new Date() })
    .onConflictDoUpdate({ target: [roomTests.projectId, roomTests.name], set: { events: stored, lastResult: "passed", lastRunAt: new Date(), updatedAt: new Date() } });
  const autos = (await ctx.db.select({ id: roomTests.id, name: roomTests.name }).from(roomTests).where(eq(roomTests.projectId, ctx.project.id)))
    .filter((t) => t.name.startsWith(AUTO_TEST_PREFIX)).sort((a, b) => b.id - a.id);
  for (const old of autos.slice(MAX_AUTO_TESTS)) await ctx.db.delete(roomTests).where(eq(roomTests.id, old.id));
}
