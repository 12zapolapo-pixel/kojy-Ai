/**
 * Chat threads with Kojy — shared by a bot's chat (projects router) and the
 * Studio chat (studio router). See project_messages.thread.
 * OWNERSHIP: apps/api/src/modules/projects
 */

import { and, desc, eq, gt } from "drizzle-orm";
import { schema } from "../../db/client.js";
import { getRedis } from "../../utils/redis.js";

const { projectMessages } = schema;

export interface SecretCard { secrets: { name: string; description: string; alreadySet: boolean }[]; resolved: boolean; saved?: string[] }
/** "ui" cards: open a panel, or a button into a bot's chat. */
export interface UiCard { panel?: string; openBot?: { kind: "python" | "javascript"; id: string; name: string } }
/** "plan" cards: Kojy's plan before a bigger change, approved with a button. */
export interface PlanCard { title?: string; steps?: string[] }

export async function listThread(db: any, thread: string, afterId: number | undefined) {
  type Row = typeof projectMessages.$inferSelect;
  const rows: Row[] = await db.select().from(projectMessages)
    .where(and(eq(projectMessages.thread, thread), gt(projectMessages.id, afterId ?? 0)))
    .orderBy(desc(projectMessages.id)).limit(afterId ? 200 : 120);
  return {
    lastId: rows[0]?.id ?? afterId ?? 0,
    messages: rows.reverse()
      // Assistant rows that only carry tool calls have nothing to show.
      .filter((r) => !(r.role === "assistant" && !r.content.trim()))
      .map((r) => {
        const d = (r.data ?? {}) as { summary?: string; ok?: boolean; card?: unknown; name?: string };
        return {
          id: r.id, role: r.role, kind: r.kind, createdAt: r.createdAt,
          content: r.role === "tool" ? r.content.slice(0, 3000) : r.content,
          summary: d.summary ?? null, ok: d.ok ?? null, tool: d.name ?? null,
          card: (d.card ?? null) as null | (SecretCard & UiCard & PlanCard),
        };
      }),
  };
}

export async function addToThread(db: any, thread: string, projectId: number, role: string, kind: string, content: string) {
  await db.insert(projectMessages).values({ thread, projectId, role, kind, content });
}

export async function agentProgress(key: string): Promise<string | null> {
  try { return (await getRedis()?.get(`agent_progress:${key}`)) ?? null; } catch { return null; }
}
