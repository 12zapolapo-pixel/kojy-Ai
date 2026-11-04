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

/** Index of the owner's message that started the current request (-1 if none). Oldest-first rows. */
export function requestIndex(rows: { role: string; kind: string; content: string }[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.role === "user" && r.kind !== "event" && !CONTINUE.test(r.content)) return i;
  }
  return -1;
}

/** `rows` are oldest first. Works on the whole stored conversation, not only what fits the budget. */
export function taskMemory(rows: TaskRow[]): TaskMemory {
  const start = requestIndex(rows);
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

/** How many times in a row Kojy is told to do the step it only described. */
export const MAX_NUDGES = 3;
export const NUDGE = "You only described your next step and didn't take it. Take it now by calling the tool (don't describe it again). If the request is finished, reply with your short final summary for the owner instead.";

/**
 * A reply without a tool call that only says what comes next ("Let's check
 * line 137…", "I will examine the file", "Now let's restart the bot"): the
 * model meant to keep going but didn't call the tool, which used to end the
 * request and leave the owner typing "continue". A question for the owner, a
 * "let me know…" or a summary of finished work is a real end.
 */
export function announcesNextStep(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.endsWith("?")) return false;
  const tail = t.slice(-300).replace(/\blet me know\b/gi, "");
  return /\b(let'?s|let me|i will|i'll|i am going to|i'm going to|going to now|next,? i)\b/i.test(tail);
}
export function continuesAutomatically(outcome: PartOutcome, part: number, maxParts: number, aborted: boolean): boolean {
  return outcome === "limit" && !aborted && part + 1 < maxParts;
}
