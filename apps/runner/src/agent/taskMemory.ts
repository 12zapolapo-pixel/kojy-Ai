/**
 * What the coder AI must never forget during a long task: the owner's request
 * and the steps already finished on it. History can be cut to fit the free
 * plan's budget, but this is written into the system prompt, which is never cut.
 * OWNERSHIP: apps/runner/src/agent
 */

export interface TaskRow {
  role: string;
  kind: string;
  content: string;
  /** For tool results: the one-line summary and whether the call worked. */
  summary?: string | undefined;
  ok?: boolean | undefined;
}

export interface TaskMemory {
  /** The owner's request this work is about (null when there isn't one). */
  task: string | null;
  /** Finished steps since that request, oldest first. */
  done: string[];
  /** Steps that failed since that request. */
  failed: string[];
}

/** Messages that only say "keep going" and so don't start a new task. */
const CONTINUE = /^\s*(continue|go on|keep going|carry on|go ahead|yes|ok|okay|sure|please continue|pls continue|next)[\s.!?]*$/i;

export const TASK_MAX_CHARS = 1200;
export const DONE_MAX_ITEMS = 25;
export const ITEM_MAX_CHARS = 120;

/** `rows` are oldest first. Works on the whole stored conversation, not only what fits the budget. */
export function taskMemory(rows: TaskRow[]): TaskMemory {
  let start = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.role === "user" && r.kind !== "event" && !CONTINUE.test(r.content)) { start = i; break; }
  }
  if (start < 0) return { task: null, done: [], failed: [] };

  const done: string[] = [];
  const failed: string[] = [];
  for (let i = start + 1; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.role !== "tool" || !r.summary) continue;
    const line = r.summary.replace(/\s+/g, " ").slice(0, ITEM_MAX_CHARS);
    (r.ok === false ? failed : done).push(line);
  }
  return {
    task: rows[start]!.content.slice(0, TASK_MAX_CHARS),
    done: done.slice(-DONE_MAX_ITEMS),
    failed: failed.slice(-DONE_MAX_ITEMS),
  };
}

/** The text added to the system prompt, or "" when there's no task. */
export function taskMemoryPrompt(memory: TaskMemory): string {
  if (!memory.task) return "";
  const lines = [
    "",
    "## The owner's current request (keep working on this until it is done)",
    memory.task,
  ];
  if (memory.done.length) {
    lines.push("", "## Already done on this request (don't redo these; continue from here)");
    lines.push(...memory.done.map((d) => `- ${d}`));
  }
  if (memory.failed.length) {
    lines.push("", "## Tried and failed on this request");
    lines.push(...memory.failed.map((d) => `- ${d}`));
  }
  return lines.join("\n");
}

/** What the runner does after one part of a task ends. */
export type PartOutcome = "limit" | "done" | "waiting";
export function continuesAutomatically(outcome: PartOutcome, part: number, maxParts: number, aborted: boolean): boolean {
  return outcome === "limit" && !aborted && part + 1 < maxParts;
}
