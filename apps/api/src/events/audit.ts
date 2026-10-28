/**
 * Audit + Security Event Emitters
 * OWNERSHIP: apps/api/src/events
 */

import { db, schema } from "../db/client.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("events");

// ─── Audit Log ────────────────────────────────────────────────────────────────

interface AuditLogInput {
  // SECURITY FIX (C-08): optional/nullable — see schema.ts note. Every call
  // site should pass this when an org context exists at write time; there's
  // no way to safely backfill it after the fact for deleted resources.
  orgId?:       number | null;
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

export async function emitAuditLog(dbInst: typeof db, input: AuditLogInput): Promise<void> {
  try {
    await dbInst.insert(schema.auditLogs).values({
      orgId:        input.orgId ?? null,
      actorId:      input.actorId,
      actorType:    input.actorType,
      action:       input.action,
      resourceType: input.resourceType,
      resourceId:   input.resourceId,
      beforeState:  input.beforeState ?? null,
      afterState:   input.afterState  ?? null,
      ip:           input.ip          ?? null,
      userAgent:    input.userAgent   ?? null,
    });
  } catch (err) {
    // Audit log failure must NEVER fail the main request
    log.error({ err, action: input.action }, "Failed to write audit log");
  }
}

// ─── Security Event ───────────────────────────────────────────────────────────

interface SecurityEventInput {
  // SECURITY FIX (C-07): same rationale as AuditLogInput.orgId above.
  orgId?:   number | null;
  severity: "low" | "medium" | "high" | "critical";
  category: "auth" | "rate_limit" | "toxicity" | "fraud" | "impersonation" | "account_takeover";
  actorId:  number | null;
  ip:       string;
  payload:  Record<string, unknown>;
}

export async function emitSecurityEvent(dbInst: typeof db, input: SecurityEventInput): Promise<void> {
  try {
    await dbInst.insert(schema.securityEvents).values({
      orgId:    input.orgId ?? null,
      severity: input.severity,
      category: input.category,
      actorId:  input.actorId,
      ip:       input.ip,
      payload:  input.payload,
      resolved: false,
    });
  } catch (err) {
    log.error({ err, category: input.category }, "Failed to write security event");
  }
}
