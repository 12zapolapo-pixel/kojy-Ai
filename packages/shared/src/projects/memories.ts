/**
 * Which of Kojy's saved lessons (agent_memories) go into its prompt. Used by
 * the runner (the prompt) and the API ("What Kojy knows" shows which are read).
 * OWNERSHIP: packages/shared/src/projects
 */

export interface MemoryRow { id: number; content: string; projectId: number | null; source: string; pinned: boolean }

/** About this much of the prompt goes to lessons (~800 tokens). */
export const MEMORY_CHAR_BUDGET = 3200;
export const MEMORY_MAX_ITEMS = 30;

/** Two notes that differ only in case, spaces or punctuation are the same lesson. */
export const normalizeNote = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The lessons for one chat (`projectId` -1 = Studio/JS chats: only notes for
 * all bots). Priority: pinned notes, then what the owner taught, then Kojy's
 * notes about this bot, then Kojy's notes for all bots — newest first within
 * each — until the budget is used. Pinned and owner notes are always kept.
 * Repeats count once. Returned oldest first.
 */
export function pickMemories<T extends MemoryRow>(rows: T[], projectId: number): T[] {
  const relevant = rows.filter((r) => r.projectId === null || r.projectId === projectId);
  const rank = (r: MemoryRow) => (r.pinned ? 0 : r.source === "owner" ? 1 : r.projectId !== null ? 2 : 3);
  const ordered = [...relevant].sort((a, b) => rank(a) - rank(b) || b.id - a.id);
  const seen = new Set<string>();
  const out: T[] = [];
  let used = 0;
  for (const r of ordered) {
    const key = normalizeNote(r.content);
    if (!key || seen.has(key)) continue;
    const cost = r.content.length + 3;
    if (rank(r) > 1 && (used + cost > MEMORY_CHAR_BUDGET || out.length >= MEMORY_MAX_ITEMS)) continue;
    seen.add(key);
    used += cost;
    out.push(r);
  }
  return out.sort((a, b) => a.id - b.id);
}
