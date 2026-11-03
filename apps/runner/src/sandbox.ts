/**
 * Sandbox — runs each project's Python code as its own Linux user.
 * OWNERSHIP: apps/runner
 *
 * SECURITY FIX (V-01): bots, `pip install` (whose setup.py runs arbitrary
 * code), check_code and test_in_room used to run as the runner's own user.
 * Same user means a bot could read /proc/<runner>/environ (ENCRYPTION_KEY,
 * DATABASE_URL, every API key in .env) and every other project's code and
 * SQLite data on the shared volume.
 *
 * Now each project gets uid/gid = RUNNER_SANDBOX_UID_BASE + project id:
 *  - Processes start through HELPER, a copy of util-linux `setpriv` that only
 *    the runner's group may execute and that carries just CAP_SETUID and
 *    CAP_SETGID (set in the Dockerfile). Bot users aren't in that group, so
 *    they can't use it to switch back or into another project.
 *  - A different uid can't read the runner's /proc/<pid>/environ.
 *  - Folders: PROJECTS_DIR and VENVS_DIR roots are traverse-only for others
 *    (0711) and every child is closed to others. Each project's own folder and
 *    venv get POSIX ACL entries for that project's user, plus default entries
 *    so files either side creates stay readable/writable by both.
 *  - Signals: a different uid can't be signalled by the runner, so stop/kill
 *    also goes through HELPER (as the bot's own user).
 *
 * RUNNER_SANDBOX=auto (default) uses it when the self-test passes and logs a
 * loud warning otherwise; =on refuses to run Python code without it; =off
 * turns it off. Not covered here (needs host-level changes): network egress
 * filtering and CPU/memory limits per bot.
 */

import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger } from "./logger.js";

const log = createLogger("sandbox");

const MODE = (process.env.RUNNER_SANDBOX ?? "auto").toLowerCase();
const HELPER = process.env.RUNNER_SANDBOX_HELPER ?? "/usr/local/libexec/kojy-setpriv";
const UID_BASE = Number(process.env.RUNNER_SANDBOX_UID_BASE ?? 20000);
const KILL_PY = "import os,sys; os.kill(int(sys.argv[1]), int(sys.argv[2]))";
const PYTHON_BIN = process.env.PYTHON_BIN ?? "python3";

let state: { enabled: boolean; reason: string } | null = null;

export class SandboxUnavailableError extends Error {}

/** The Linux user a project's code runs as. */
export function sandboxUid(projectId: number): number {
  if (!Number.isInteger(projectId) || projectId <= 0) throw new Error(`Bad project id ${projectId}`);
  return UID_BASE + projectId;
}

function helperArgs(uid: number): string[] {
  return [`--reuid=${uid}`, `--regid=${uid}`, "--clear-groups", "--no-new-privs", "--inh-caps=-all", "--"];
}

function acl(args: string[]): void {
  const r = spawnSync("setfacl", args, { encoding: "utf8" });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`setfacl ${args.join(" ")} failed: ${(r.stderr || "").trim()}`);
}

/**
 * Checks once whether sandboxing works here: the helper can switch users and
 * the volume supports ACLs. Also closes the shared roots to other users.
 */
export function initSandbox(roots: string[]): { enabled: boolean; reason: string } {
  if (state) return state;
  if (MODE === "off") {
    state = { enabled: false, reason: "RUNNER_SANDBOX=off" };
  } else {
    try {
      if (!existsSync(HELPER)) throw new Error(`helper ${HELPER} not found`);
      const probe = spawnSync(HELPER, [...helperArgs(UID_BASE), "id", "-u"], { encoding: "utf8" });
      if (probe.status !== 0 || probe.stdout.trim() !== String(UID_BASE)) {
        throw new Error(`helper can't switch users (${(probe.stderr || probe.error?.message || "").trim() || `exit ${probe.status}`})`);
      }
      for (const root of roots) {
        mkdirSync(root, { recursive: true });
        // Others may pass through to their own folder, but not list or read.
        chmodSync(root, 0o711);
        // New folders the API/runner create here start closed to others.
        acl(["-m", "d:o::-", root]);
        for (const name of readdirSync(root)) {
          const p = path.join(root, name);
          try { acl(["-m", "o::-", p]); } catch (err) { log.warn({ err, path: p }, "Could not close a folder to other users"); }
        }
      }
      // ACLs must really work on this volume (some network disks don't have them).
      const t = mkdtempSync(path.join(roots[0] ?? tmpdir(), ".acl-probe-"));
      try { acl(["-m", `u:${UID_BASE}:rwx`, t]); } finally { rmSync(t, { recursive: true, force: true }); }
      state = { enabled: true, reason: `each project runs as uid ${UID_BASE}+id` };
    } catch (err) {
      state = { enabled: false, reason: (err as Error).message };
    }
  }
  if (state.enabled) log.info({ reason: state.reason }, "Bot sandbox is on");
  else if (MODE === "on") log.error({ reason: state.reason }, "RUNNER_SANDBOX=on but the sandbox can't work — Python code will NOT be run");
  else log.warn({ reason: state.reason }, "⚠ Bot sandbox is OFF — bots run as the runner's own user and can read its secrets and other projects' files. See docs/SECURITY_RUNNER.md.");
  return state;
}

function sandboxState(): { enabled: boolean; reason: string } {
  return state ?? { enabled: false, reason: "not initialised" };
}

/**
 * Gives `uid` read/write on `dir` (recursively) and makes new files there
 * readable/writable by both the project user and the runner/API user.
 */
export function grantDir(dir: string, uid: number): void {
  if (!sandboxState().enabled) return;
  const me = process.getuid?.() ?? 1000;
  const fileSpec = [`u:${uid}:rwX`, "m::rwX", "o::-"].join(",");
  const dirSpec = [fileSpec, `d:u:${uid}:rwX`, `d:u:${me}:rwX`, "d:m::rwX", "d:o::-"].join(",");
  // Only entries the runner owns: files the bot made already carry the
  // inherited ACL (and only their owner may change it). Never follows or
  // touches symlinks, so a link a bot plants can't redirect a grant onto
  // another project's folder.
  for (const [type, spec] of [["d", dirSpec], ["f", fileSpec]] as const) {
    const r = spawnSync("find", [dir, "-type", type, "-uid", String(me), "-exec", "setfacl", "-m", spec, "{}", "+"], { encoding: "utf8" });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`Could not grant ${dir} to uid ${uid}: ${(r.stderr || "").trim().slice(0, 300)}`);
  }
}

/** Like grantDir, but the (large) recursive pass only runs once per folder and uid. */
export function grantDirOnce(dir: string, uid: number): void {
  if (!sandboxState().enabled) return;
  const marker = path.join(dir, ".kojy-sandbox-uid");
  if (existsSync(marker) && readFileSync(marker, "utf8").trim() === String(uid)) return;
  grantDir(dir, uid);
  writeFileSync(marker, String(uid));
}

export interface Sandboxed {
  child: ChildProcess;
  /** Signal the process (works across users). */
  kill: (signal?: NodeJS.Signals) => void;
}

/**
 * Spawns `cmd` as the project's user when the sandbox is on. With
 * RUNNER_SANDBOX=on and no working sandbox, throws instead of running.
 */
export function spawnAs(uid: number, cmd: string, args: string[], opts: SpawnOptions): Sandboxed {
  const { enabled, reason } = sandboxState();
  if (!enabled && MODE === "on") throw new SandboxUnavailableError(`The bot sandbox isn't working (${reason}); Python code won't run.`);
  const child = enabled ? spawn(HELPER, [...helperArgs(uid), cmd, ...args], opts) : spawn(cmd, args, opts);
  const kill = (signal: NodeJS.Signals = "SIGTERM") => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    if (!enabled) { child.kill(signal); return; }
    const num = signalNumber(signal);
    const k = spawn(HELPER, [...helperArgs(uid), PYTHON_BIN, "-c", KILL_PY, String(child.pid), String(num)], { stdio: "ignore", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    k.once("error", (err) => log.warn({ err, pid: child.pid }, "Could not signal a sandboxed process"));
  };
  child.once("error", () => undefined);
  return { child, kill };
}

function signalNumber(signal: NodeJS.Signals): number {
  const map: Partial<Record<NodeJS.Signals, number>> = { SIGTERM: 15, SIGKILL: 9, SIGINT: 2, SIGHUP: 1 };
  return map[signal] ?? 15;
}

/** For tests: forget the cached self-test result. */
export function _resetSandboxForTests(): void {
  state = null;
}
