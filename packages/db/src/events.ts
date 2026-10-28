/**
 * Activity, notifications and alerts — shared by the API, runner and worker.
 * OWNERSHIP: packages/db
 *
 * ActivityRecorder batches bot_activity rows (a busy room can produce many
 * events a second) and writes them every few seconds. notifyUser() adds a
 * notification to the bell menu. sendAlert() also posts to ALERT_WEBHOOK_URL
 * when it's set (a Discord or Slack-compatible incoming webhook), so the
 * owner hears about a bot going down without having the site open.
 */

import type { Database } from "./client.js";
import { botActivity, notifications } from "./schema.js";

export type ActivityRow = typeof botActivity.$inferInsert;

export class ActivityRecorder {
  private queue: ActivityRow[] = [];
  private timer: NodeJS.Timeout;

  constructor(private db: Database, flushMs = 5000, private onError?: (err: unknown) => void) {
    this.timer = setInterval(() => void this.flush(), flushMs);
    this.timer.unref();
  }

  record(row: ActivityRow): void {
    // A runaway bot can't grow this without bound.
    if (this.queue.length < 5000) this.queue.push({ ...row, actorName: row.actorName?.slice(0, 100) ?? null, actorId: row.actorId?.slice(0, 64) ?? null });
  }

  async flush(): Promise<void> {
    if (!this.queue.length) return;
    const rows = this.queue.splice(0, this.queue.length);
    try {
      for (let i = 0; i < rows.length; i += 500) await this.db.insert(botActivity).values(rows.slice(i, i + 500));
    } catch (err) {
      this.onError?.(err);
    }
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }
}

export type NotificationType = typeof notifications.$inferInsert["type"];

export async function notifyUser(
  db: Database, userId: number, type: NotificationType, title: string, body: string, actionUrl?: string,
): Promise<void> {
  try {
    await db.insert(notifications).values({ userId, type, title: title.slice(0, 200), body, actionUrl: actionUrl ?? null });
  } catch { /* a notification must never break the caller */ }
}

/** Posts to ALERT_WEBHOOK_URL (Discord/Slack-style `{content, text}`), if set. */
export async function sendAlert(text: string): Promise<void> {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text.slice(0, 1900), text: text.slice(0, 1900) }),
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* best effort */ }
}
