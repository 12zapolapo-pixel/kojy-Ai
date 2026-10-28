/**
 * Audit Flush Processor
 *
 * FIX-19: QUEUE_NAMES.AUDIT_FLUSH ("audit:flush") existed in shared constants
 * but had zero worker implementation — any enqueued audit jobs sat in Redis
 * forever and were never processed.
 *
 * WHAT IT DOES:
 * Receives a batch of audit log entries (enqueued from the API layer) and
 * writes them to the audit_logs table in a single transaction. Batching at
 * the queue layer keeps the API path non-blocking and prevents DB write spikes.
 *
 * JOB PAYLOAD SHAPE:
 *   { entries: AuditEntry[] }
 *
 * RETRY STRATEGY:
 * BEST_EFFORT — one attempt. If the flush fails, the entries are lost.
 * Acceptable for audit logs (eventual consistency); billing events use a
 * separate queue with CRITICAL options.
 */

import type { Job } from "bullmq";
import { db, schema } from "../db/client.js";
import { createLogger } from "../services/logger.js";

const log = createLogger("audit-flush");

// FIX-AUDIT: This interface previously used field names (userId, orgId,
// entityType, entityId) that don't exist on the real `audit_logs` schema
// (schema.ts defines actorId/actorType/resourceType/resourceId, with
// actorType NOT NULL and never populated by the old code) — every insert
// below would have thrown at the DB layer on the first real job, silently
// losing the batch (BEST_EFFORT retry = none). Aligned field-for-field with
// the already-correct, already-proven shape in apps/api/src/events/audit.ts
// (emitAuditLog) so a future producer enqueuing onto this queue can pass the
// same shape it already uses for direct, synchronous audit writes.
interface AuditEntry {
  actorId:      number;
  actorType:    "user" | "bot" | "system";
  action:       string;
  resourceType: string;
  resourceId:   string;
  beforeState?: Record<string, unknown> | null;
  afterState?:  Record<string, unknown> | null;
  ip?:          string | null;
  userAgent?:   string | null;
}

export async function processAuditFlush(job: Job): Promise<void> {
  const { entries } = job.data as { entries: AuditEntry[] };

  if (!Array.isArray(entries) || entries.length === 0) {
    log.warn({ jobId: job.id }, "Audit flush job had no entries");
    return;
  }

  const rows = entries.map((e) => ({
    actorId:      e.actorId,
    actorType:    e.actorType,
    action:       e.action,
    resourceType: e.resourceType,
    resourceId:   e.resourceId,
    beforeState:  e.beforeState ?? null,
    afterState:   e.afterState  ?? null,
    ip:           e.ip          ?? null,
    userAgent:    e.userAgent   ?? null,
  }));

  try {
    await db.insert(schema.auditLogs).values(rows);
    log.info({ count: rows.length, jobId: job.id }, "Audit flush complete");
  } catch (err) {
    log.error({ err, count: rows.length, jobId: job.id }, "Audit flush failed");
    throw err;
  }
}
