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

/**
 * User-role rows written by the app, not typed by the owner: notes such as
 * "secrets saved" (event) or "the owner edited bot.py" (owner_edit). They
 * never start a request.
 */
export const APP_NOTE_KINDS = new Set(["event", "owner_edit"]);

/** Index of the owner's message that started the current request (-1 if none). Oldest-first rows. */
export function requestIndex(rows: { role: string; kind: string; content: string }[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.role === "user" && !APP_NOTE_KINDS.has(r.kind) && !CONTINUE.test(r.content)) return i;
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
// ── false "I can't" ──────────────────────────────────────────────────────────

/** How many times in a row a reply that wrongly says Kojy can't do it is held back and asked again. */
export const MAX_DENIALS = 2;

const DENIAL: RegExp[] = [
  // "I don't have the ability / tools / access …", "I lack the capability …"
  /\b(?:i|we)\s+(?:currently\s+|really\s+|unfortunately\s+)?(?:do not|don['’]t|cannot|can['’]?t|can not|have no|lack)\s+(?:have\s+)?(?:the\s+|any\s+|a\s+)?(?:direct\s+|necessary\s+|required\s+)?(?:ability|abilities|capabilit(?:y|ies)|tools?|access|permissions?|means)\b/i,
  // "I'm unable to write files", "I am not able to run commands"
  /\b(?:i['’]m|i am)\s+(?:currently\s+|unfortunately\s+)?(?:unable|not able)\s+to\s+(?:directly\s+)?(?:write|create|edit|modify|change|update|run|execute|access|save|code|build|make|apply|install|read|use)\b/i,
  // "I can't edit the files", "I cannot run commands"
  /\b(?:i|we)\s+(?:cannot|can['’]?t|can not)\s+(?:directly\s+|actually\s+)?(?:write|create|edit|modify|change|update|run|execute|access|save|apply|install|read|touch|code)\s+(?:the\s+|your\s+|any\s+|these\s+|this\s+)?(?:files?|code|commands?|bot['’]?s?\s+(?:code|files)|terminal|shell|scripts?|programs?|changes?|edits?|packages?)\b/i,
  /\b(?:beyond|outside(?: of)?)\s+(?:my|the scope of my)\s+(?:capabilities|abilities|tools|access)\b/i,
  /\bas an ai\b[^.]{0,60}\b(?:can['’]?t|cannot|unable|don['’]t have)\b/i,
  // Handing the work back: "you'll need to paste this yourself", "copy it in manually"
  /\byou(?:['’]ll| will)?\s+(?:need|have)\s+to\s+(?:paste|copy|add|apply|put|insert|make|create|do|edit)\s+(?:it|this|that|these|them|the (?:code|changes?|file|snippet|lines))\b[^.]{0,40}\b(?:yourself|manually|by hand)\b/i,
  /\bdon['’]t have (?:a |the |any )?(?:tool|way|function) (?:to|for)\b/i,
];

/**
 * Things only the owner can do; a reply about these is right to say Kojy
 * can't (a portal switch, a secret's value, an account, a payment).
 */
const OWNER_ONLY = /developer portal|discord\.com\/developers|portal|highrise (?:app|settings|room settings)|room settings|moderator|your account|password|log ?in to your|billing|payment|credit card|secret value|token value|api key from|your phone|your computer|captcha/i;

/**
 * A reply with no tool call that tells the owner Kojy can't do it, has no
 * tools, access or ability, or that they should paste the code in
 * themselves. In a bot's chat that's (almost) never true: the agent then
 * holds the reply back and tells Kojy what it has. One about something only
 * the owner can do (a Developer Portal switch, a secret value) isn't counted.
 */
export function deniesCapability(text: string): boolean {
  const t = text.trim();
  if (!t || OWNER_ONLY.test(t)) return false;
  return DENIAL.some((re) => re.test(t));
}

/** Sent after a false "I can't" in a bot's chat (not stored; the reply that said it isn't kept). */
export const CAPABILITY_NUDGE =
  "[app] Your last reply said you can't do this, or don't have the tools or access for it. That isn't right: in this chat your tools work. " +
  "You can read, write and edit the bot's files (read_file, write_file, append_file, edit_file, multi_edit), run shell commands and Python in its folder (run_command, run_python), " +
  "install packages (requirements.txt then check_code, or pip with run_command), check and test code (check_code, test_in_room, run_saved_tests), " +
  "start, stop or restart it (bot_control), read its logs (get_logs), use git, search the web and read pages (web_search, fetch_url), and understand code (outline_file, find_symbol, inspect_package, show_changes). " +
  "Do what the owner asked now by calling the right tool; don't describe it and don't ask the owner to do it. " +
  "Only if it truly needs something only the owner can do (a switch in Discord's Developer Portal or in Highrise, a secret's value, a payment), say exactly what and why.";

/** The same, for the Studio chat. */
export const STUDIO_CAPABILITY_NUDGE =
  "[app] Your last reply said you can't do this. In the Studio chat you can create bots (create_bot), start, stop or restart them (control_bot), " +
  "and hand any change, fix or setup of a bot's code to Kojy in that bot's own chat with work_on_bot — it has every coding tool there. Do that now instead of saying you can't.";

export function continuesAutomatically(outcome: PartOutcome, part: number, maxParts: number, aborted: boolean): boolean {
  return outcome === "limit" && !aborted && part + 1 < maxParts;
}
