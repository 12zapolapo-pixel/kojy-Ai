/**
 * Shell + git plumbing shared by the API and the runner.
 * OWNERSHIP: packages/shared/src/projects
 *
 * Shell (a terminal in the bot's folder):
 *   browser ⇄ /ws/terminal (API) ⇄ Redis ⇄ runner ⇄ kojy_shell.py ⇄ bash
 *   - The API opens one with a signed `terminal_open` control message on
 *     project_control:<uuid> carrying a random session id (sid).
 *   - Keystrokes, resizes, keep-alives and close go API → runner on
 *     term_in:<sid>, each signed like a control message (sid as the id).
 *   - Output and the exit go runner → API on term_out:<sid>.
 *
 * Git (runs in the runner as the project's sandbox user, never in the API —
 * a project's .git/config is the owner's to edit, and settings such as
 * core.fsmonitor run commands):
 *   - The API sends a signed `git` control message with a request id; the
 *     runner answers once on runner_reply:<requestId>.
 */

export const TERM_IN_PREFIX = "term_in:";
export const TERM_OUT_PREFIX = "term_out:";
export const RUNNER_REPLY_PREFIX = "runner_reply:";

/** No keep-alive from the API for this long: the browser is gone, close the shell. */
export const TERM_STALE_MS = 75_000;
/** How often the API sends keep-alives. */
export const TERM_PING_MS = 20_000;
/** No keystroke for this long: close the shell. */
export const TERM_IDLE_MS = 60 * 60_000;

/** API → runner, on term_in:<sid> (signed; the action is the message type). */
export type TermInAction = "in" | "resize" | "ping" | "close";

/** Runner → API, on term_out:<sid>. `d` is base64 of the raw terminal bytes. */
export type TermOut =
  | { t: "o"; d: string }
  | { t: "ready" }
  | { t: "exit"; code: number | null }
  | { t: "err"; m: string };

// ── git ──────────────────────────────────────────────────────────────────────

export type GitOp = "status" | "connect" | "pull" | "commit" | "push" | "import";

export interface GitRequest {
  requestId: string;
  op: GitOp;
  url?: string;
  branch?: string;
  message?: string;
}

export interface GitChange { path: string; status: string }
export interface GitCommit { hash: string; author: string; at: number; subject: string }

export interface GitStatus {
  repo: boolean;
  branch: string | null;
  remote: string | null;
  /** Commits not on GitHub yet / on GitHub but not here (as of the last fetch). */
  ahead: number;
  behind: number;
  /** Whether the branch has an upstream on the remote yet. */
  tracking: boolean;
  changes: GitChange[];
  commits: GitCommit[];
}

export type GitReply =
  | { ok: true; message: string; status: GitStatus; changedFiles?: boolean }
  | { ok: false; message: string; status?: GitStatus };

/** Only GitHub over HTTPS: the token is only ever sent there. */
const GITHUB_URL = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;

/** "https://github.com/me/bot" (or owner/repo) → its clone URL, or null if it isn't a GitHub repo. */
export function normalizeGitHubUrl(input: string): string | null {
  let s = input.trim();
  if (/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(s)) s = `https://github.com/${s}`;
  s = s.replace(/^http:\/\//i, "https://").replace(/^https:\/\/www\.github\.com\//i, "https://github.com/");
  const m = GITHUB_URL.exec(s);
  if (!m) return null;
  const [, owner, repo] = m;
  if (repo === "." || repo === "..") return null;
  return `https://github.com/${owner}/${repo}.git`;
}

/** A branch name git and GitHub both accept (a safe subset). */
export function isSafeBranch(name: string): boolean {
  return /^[A-Za-z0-9._/-]{1,100}$/.test(name)
    && !name.startsWith("-") && !name.startsWith("/") && !name.endsWith("/") && !name.endsWith(".")
    && !name.includes("..") && !name.includes("//") && !name.endsWith(".lock") && name !== "HEAD";
}

// ── start commands (any program, not only Highrise bots) ─────────────────────
//
// A project's entrypoint is either a Highrise bot class ("module.path:Class",
// started by the launcher) or a start command ("run: python main.py"),
// started with bash in the bot's folder — a Discord or Telegram bot, a
// scheduler, any long-running program. Both get the same Run/Stop, console,
// crash restarts, secrets and sandbox.

export const START_COMMAND_PREFIX = "run:";
const BOT_CLASS = /^[A-Za-z_][\w.]*:[A-Za-z_]\w*$/;

export function isStartCommand(entrypoint: string | null | undefined): boolean {
  return !!entrypoint && entrypoint.startsWith(START_COMMAND_PREFIX);
}

/** "run: python main.py" → "python main.py". */
export function startCommand(entrypoint: string): string {
  return entrypoint.slice(START_COMMAND_PREFIX.length).trim();
}

/** null when fine, otherwise what's wrong (for the owner or Kojy). */
export function entrypointProblem(entrypoint: string): string | null {
  const e = entrypoint.trim();
  if (isStartCommand(e)) {
    const cmd = startCommand(e);
    if (!cmd) return "Write the command after run:, e.g. run: python main.py";
    if (cmd.length > 300) return "The start command is too long (300 characters at most).";
    if (/[\r\n\0]/.test(cmd)) return "The start command must be one line.";
    return null;
  }
  return BOT_CLASS.test(e) ? null : "Use module.path:ClassName for a Highrise bot (e.g. bot:MyBot), or run: <command> for any other program (e.g. run: python main.py).";
}
