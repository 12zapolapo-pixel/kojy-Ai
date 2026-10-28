/**
 * Shared Bot Creation
 * OWNERSHIP: packages/shared/src/highrise
 *
 * The real transaction behind creating a bot: quota check, real Highrise
 * credential validation (validateCredentials.ts), API key encryption,
 * insert bots + default personality profile + stats row, all in one
 * transaction. Used identically by apps/api's bots.create (the "+ New Bot"
 * button) and apps/worker's Composer deploy step — one implementation
 * instead of the worker needing its own copy of a multi-step transaction
 * that includes real security-relevant steps (credential validation, key
 * encryption). Duplicating that logic would risk exactly the kind of
 * copy-drift bug found and fixed elsewhere this session, just with higher
 * stakes (a bot created via one path silently skipping a safety check the
 * other path has).
 *
 * What's deliberately NOT included here, because it differs by caller:
 *   - Audit logging: apps/api uses its own emitAuditLog (in-process,
 *     synchronous); the worker writes directly to audit_logs (see
 *     composerRun.ts) — same destination table, different calling context.
 *   - Auto-deploy/start: apps/api calls startBotLoop() in-process
 *     (runtime-manager.ts is a per-pod in-memory singleton, so a second
 *     process can never call it directly — see runtime-manager.ts's own
 *     doc comment); the worker publishes {action:"start"} on
 *     bot_control:{uuid} instead, which the api process's runtime-manager
 *     picks up. Same eventual effect, different mechanism, because the two
 *     callers run in different processes.
 */

import { encryptApiKey } from "../crypto/apiKeys.js";
import { validateHighriseCredentials } from "./validateCredentials.js";
import { createDefaultPersonalityProfile } from "./defaultPersonality.js";

export interface CreateBotInput {
  orgId: number;
  ownerId: number;
  name: string;
  highriseApiKey: string;
  activeRoomId: string | null;
  greetMessage: string | undefined;
  personality: string | undefined;
  language: string | undefined;
  runtimeMode: "ai" | "scripted" | "hybrid";
  tags: string[] | undefined;
}

export interface CreateBotResult {
  botId: number;
  uuid: string;
  roomName: string;
}

/**
 * Minimal structural shape of what this function needs from a drizzle
 * client — deliberately NOT typed against either app's concrete `schema`
 * module (that would require packages/shared to import one of them,
 * defeating the point). Each app passes its own db instance and its own
 * schema table objects; they're structurally identical (apps/worker's
 * schema.ts is a deliberate mirror of apps/api's — see that file's own
 * header comment) even though they're two separately-instantiated modules.
 */
export interface CreateBotDeps {
  db: {
    transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
    select: (...args: any[]) => any;
  };
  schema: {
    bots: any;
    botPersonalityProfiles: any;
    botStats: any;
    subscriptions: any;
  };
  /** drizzle-orm helpers — passed in rather than imported, to keep this
   *  function free of a hard dependency on a specific drizzle-orm version
   *  living in packages/shared. */
  eq: (...args: any[]) => any;
  and: (...args: any[]) => any;
  count: (...args: any[]) => any;
  /** UUID generator — passed in so both callers use their existing nanoid
   *  setup rather than packages/shared taking on a new dependency for it. */
  makeUuid: () => string;
}

export class BotQuotaExceededError extends Error {
  constructor(public readonly maxBots: number) {
    super(`Bot quota reached (${maxBots}). Upgrade your plan to add more bots.`);
    this.name = "BotQuotaExceededError";
  }
}

export async function createBotRecord(
  input: CreateBotInput,
  deps: CreateBotDeps,
): Promise<CreateBotResult> {
  const { db, schema, eq, and, count, makeUuid } = deps;

  // Quota check — same logic bots.create already had, just parameterized.
  const totalRows = await db
    .select({ total: count() })
    .from(schema.bots)
    .where(and(eq(schema.bots.orgId, input.orgId), eq(schema.bots.isActive, true)));
  const total = totalRows[0]?.total ?? 0;

  const [sub] = await db
    .select({ limits: schema.subscriptions.limits })
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.orgId, input.orgId))
    .limit(1);

  const limits = sub?.limits as any;
  const maxBots = limits?.maxBots ?? 1;
  if (Number(total) >= maxBots) {
    throw new BotQuotaExceededError(maxBots);
  }

  const uuid = makeUuid();

  // Verify these credentials are real BEFORE storing anything — we never
  // accept a token/room that Highrise itself hasn't confirmed. Same rule
  // regardless of which caller is creating the bot.
  const validation = await validateHighriseCredentials(input.highriseApiKey, input.activeRoomId ?? "");

  const encryptedKey = encryptApiKey(input.highriseApiKey);

  const botId = await db.transaction(async (tx: any) => {
    const [{ id: newBotId }] = await tx
      .insert(schema.bots)
      .values({
        uuid,
        orgId:          input.orgId,
        ownerId:        input.ownerId,
        name:           input.name,
        highriseApiKey: encryptedKey,
        activeRoomId:   input.activeRoomId ?? null,
        greetMessage:   input.greetMessage ?? "Welcome! 👋",
        personality:    input.personality ?? "",
        language:       input.language ?? "en",
        runtimeMode:    input.runtimeMode,
        tags:           input.tags ?? [],
        status:         "offline",
        healthScore:    0,
      })
      .returning({ id: schema.bots.id });

    const defaultProfile = createDefaultPersonalityProfile(uuid);
    await tx.insert(schema.botPersonalityProfiles).values({ ...defaultProfile, botId: newBotId });
    await tx.insert(schema.botStats).values({ botId: newBotId });

    return newBotId;
  });

  return { botId, uuid, roomName: validation.roomName };
}
