/**
 * Chat threads with Kojy — shared by a bot's chat (projects router) and the
 * Studio chat (studio router). See project_messages.thread.
 * OWNERSHIP: apps/api/src/modules/projects
 */

import { and, desc, eq, gt, lt } from "drizzle-orm";
import { schema } from "../../db/client.js";
import { getRedis } from "../../utils/redis.js";

const { projectMessages } = schema;

export interface SecretCard { secrets: { name: string; description: string; alreadySet: boolean }[]; resolved: boolean; saved?: string[] }
/** "ui" cards: open a panel, or a button into a bot's chat. */
export interface UiCard { panel?: string; openBot?: { kind: "python" | "javascript"; id: string; name: string } }
/** "plan" cards: Kojy's plan before a bigger change, approved with a button. */
export interface PlanCard { title?: string; steps?: string[]; rejected?: boolean }
/** "todo" cards: Kojy's checklist for a long request (update_todo). */
export interface TodoCard { items?: { step: string; done?: boolean }[] }

/** Messages shown when a chat opens, and per "Load earlier messages". */
const PAGE = 120;

/**
 * New messages after `afterId` (polling), or — with `beforeId` — the page
 * of older messages before it. hasMore: there are older messages than these.
 */
export async function listThread(db: any, thread: string, afterId: number | undefined, beforeId?: number) {
  type Row = typeof projectMessages.$inferSelect;
  const older = beforeId !== undefined;
  const limit = afterId && !older ? 200 : PAGE;
  const fetched: Row[] = await db.select().from(projectMessages)
    .where(and(eq(projectMessages.thread, thread), older ? lt(projectMessages.id, beforeId) : gt(projectMessages.id, afterId ?? 0)))
    .orderBy(desc(projectMessages.id)).limit(limit + 1);
  const hasMore = fetched.length > limit && (older || !afterId);
  const rows = fetched.slice(0, limit);
  return {
    hasMore,
    /** The oldest message in this page (pass it as beforeId for the page before). */
    firstId: rows[rows.length - 1]?.id ?? null,
    lastId: older ? afterId ?? 0 : rows[0]?.id ?? afterId ?? 0,
    messages: rows.reverse()
      // Assistant rows that only carry tool calls have nothing to show.
      .filter((r) => !(r.role === "assistant" && !r.content.trim()))
      .map((r) => {
        const d = (r.data ?? {}) as { summary?: string; ok?: boolean; card?: unknown; name?: string; diff?: string };
        return {
          id: r.id, role: r.role, kind: r.kind, createdAt: r.createdAt,
          content: r.role === "tool" ? r.content.slice(0, 3000) : r.content,
          summary: d.summary ?? null, ok: d.ok ?? null, tool: d.name ?? null,
          diff: typeof d.diff === "string" ? d.diff.slice(0, 6000) : null,
          card: (d.card ?? null) as null | (SecretCard & UiCard & PlanCard & TodoCard),
        };
      }),
  };
}

export async function addToThread(db: any, thread: string, projectId: number, role: string, kind: string, content: string) {
  await db.insert(projectMessages).values({ thread, projectId, role, kind, content });
}

/**
 * Message kind for "the owner changed the code themselves". Kept apart from
 * "event" because, unlike other app notes, it must neither start a new
 * request nor end the limits of an automatic run (see the runner's
 * automatedKind / requestIndex).
 */
export const OWNER_EDIT_KIND = "owner_edit";

/**
 * Tells Kojy the owner changed files outside the chat, so it re-reads them
 * instead of working from an old copy. A note identical to the newest message
 * isn't repeated (saving the same file five times is one note).
 */
export async function noteOwnerEdit(db: any, projectId: number, content: string) {
  const thread = `project:${projectId}`;
  const [last] = await db.select({ kind: projectMessages.kind, content: projectMessages.content }).from(projectMessages)
    .where(eq(projectMessages.thread, thread)).orderBy(desc(projectMessages.id)).limit(1);
  if (last && last.kind === OWNER_EDIT_KIND && last.content === content) return;
  await addToThread(db, thread, projectId, "user", OWNER_EDIT_KIND, content);
}

export async function agentProgress(key: string): Promise<string | null> {
  try { return (await getRedis()?.get(`agent_progress:${key}`)) ?? null; } catch { return null; }
}
