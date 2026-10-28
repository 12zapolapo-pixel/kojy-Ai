/**
 * Delegation Memory Store
 * OWNERSHIP: apps/api/src/db
 *
 * The actual read/write surface over `delegation_memories`. Two operations:
 *
 *   remember(...) — embeds a piece of text (a feature request, a script
 *                   outcome, a learned preference) and stores it.
 *   recall(...)   — embeds a query and finds the most semantically similar
 *                   past memories for that user, via pgvector cosine
 *                   distance — this is what lets the Delegation agent say
 *                   "you asked for something like this before."
 *
 * Both degrade to no-ops (recall returns []) if no embedding provider is
 * configured — callers should treat memory as a pure enhancement, never a
 * hard dependency.
 */

import { sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "./client.js";
import { resolveEmbeddingProvider, embed } from "@kojyai/engine";
import { createLogger } from "../utils/logger.js";

const log = createLogger("delegation-memory");

export interface RememberInput {
  userId: number;
  orgId: number;
  kind: "feature_request" | "script_outcome" | "user_preference" | "fact";
  summary: string;
  delegationSessionId?: number;
  botScriptId?: number;
  metadata?: Record<string, unknown>;
}

export interface RecallResult {
  uuid: string;
  kind: string;
  summary: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  /** Cosine distance — lower is more similar (0 = identical). */
  distance: number;
}

export async function remember(input: RememberInput): Promise<boolean> {
  const provider = resolveEmbeddingProvider();
  if (!provider) {
    log.info("No embedding provider configured — skipping memory write (this is not an error)");
    return false;
  }

  const vector = await embed(provider, input.summary);
  if (!vector) {
    log.warn("Embedding generation failed — skipping memory write");
    return false;
  }

  await db.insert(schema.delegationMemories).values({
    uuid:    nanoid(24),
    userId:  input.userId,
    orgId:   input.orgId,
    kind:    input.kind,
    summary: input.summary,
    embedding: vector,
    delegationSessionId: input.delegationSessionId ?? null,
    botScriptId:          input.botScriptId ?? null,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
  });

  return true;
}

export async function recall(
  userId: number,
  query: string,
  limit = 5,
): Promise<RecallResult[]> {
  const provider = resolveEmbeddingProvider();
  if (!provider) return [];

  const vector = await embed(provider, query);
  if (!vector) return [];

  // pgvector's <=> operator computes cosine distance directly in SQL,
  // letting the HNSW index do the heavy lifting instead of pulling every
  // row back and comparing in application code.
  const vectorLiteral = `[${vector.join(",")}]`;

  const rows = await db
    .select({
      uuid:      schema.delegationMemories.uuid,
      kind:      schema.delegationMemories.kind,
      summary:   schema.delegationMemories.summary,
      metadata:  schema.delegationMemories.metadata,
      createdAt: schema.delegationMemories.createdAt,
      distance:  sql<number>`embedding <=> ${vectorLiteral}::vector`,
    })
    .from(schema.delegationMemories)
    .where(sql`${schema.delegationMemories.userId} = ${userId}`)
    .orderBy(sql`embedding <=> ${vectorLiteral}::vector`)
    .limit(limit);

  return rows.map((r) => ({
    ...r,
    metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null,
  }));
}
