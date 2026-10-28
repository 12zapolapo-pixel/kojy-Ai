/**
 * tRPC Context & Middleware
 *
 * OWNERSHIP: apps/api/src
 * LAYER: API — request context and middleware chain
 *
 * CONTEXT LIFECYCLE:
 * Each HTTP request creates a fresh context object.
 * Context flows through the middleware chain, accumulating data:
 *   raw request → rateLimiter → session lookup → user load → permission check
 *
 * MIDDLEWARE ORDER:
 * 1. rateLimiter — blocks before any DB hits
 * 2. requireAuth — validates session, populates ctx.user
 * 3. requirePermission — checks RBAC + tier gates
 * 4. (optional) requireAdmin — shortcut for admin-only procedures
 *
 * SECURITY:
 * - Sessions verified against DB on every request (not just JWT decode)
 * - IP extracted from trusted proxy header
 * - Rate limit keyed by IP + userId when available
 * - Every auth failure emits a SecurityEvent to the security module
 */

import { initTRPC, TRPCError } from "@trpc/server";
import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import superjson from "superjson";
import { ZodError } from "zod";
import { db } from "./db/client.js";
import { schema } from "./db/client.js"; // FIX-2: schema is re-exported from client.ts, not schema.ts
import { eq, and, gt } from "drizzle-orm";
import { getRedis } from "./utils/redis.js";
import { emitAuditLog } from "./events/audit.js";
import { createLogger } from "./utils/logger.js";
import { checkRateLimit, RATE_LIMITS } from "@kojyai/security";
import { hasPermission } from "@kojyai/shared/permissions";
// FIX-3: Permission is defined in @kojyai/shared/permissions (rbac.ts), not in types barrel.
import type { Permission } from "@kojyai/shared/permissions";
import type { UserRole, UserTier } from "@kojyai/shared/types";

const log = createLogger("trpc-context");

// ─── Context ──────────────────────────────────────────────────────────────────

export interface TrpcContext {
  db:       typeof db;
  req:      Request;
  ip:       string;
  // FIX-6: activeOrgId added — auth.switchOrg writes it; bots.resolveOrgId() reads it.
  session:  { id: string; userId: number; activeOrgId: number | null } | null;
  user:     ContextUser | null;
  // Index signature so this satisfies @hono/trpc-server's expected
  // `Record<string, unknown>` return type for createContext — purely a
  // structural-typing accommodation, doesn't change any named-property
  // access elsewhere in the codebase.
  [key: string]: unknown;
}

export interface ContextUser {
  id:       number;
  uuid:     string;
  email:    string;
  username: string;
  role:     UserRole;
  tier:     UserTier;
  orgId:    number | null;
}

// ─── Pre-DB flood guard (M-01) ────────────────────────────────────────────────
//
// SECURITY FIX (M-01): createContext() runs a session + user DB lookup on
// EVERY request, *before* withRateLimit (a procedure middleware) ever gets a
// chance to reject anything — so a request flood could exhaust the MySQL
// connection pool no matter what the rate limiter decided. This is a cheap,
// Redis-only circuit breaker that runs before any DB access at all.
//
// It is deliberately coarse (per-IP, fixed window) and is NOT the primary
// abuse defense — withRateLimit remains that. It exists only to protect the
// database pool. Limit is per HTTP request (a tRPC batch is one request), and
// is generous enough that a normal SPA page load never comes near it; note
// that many users behind one shared NAT/office IP share this bucket.
//
// Fails OPEN on any Redis error: a Redis outage must not take the whole API
// down (withRateLimit's in-memory fallback still applies downstream).
const FLOOD_WINDOW_SECONDS = 10;
const FLOOD_MAX_REQUESTS   = 100;

// INCR + EXPIRE in one atomic step, so a crash between the two can never
// leave a counter key with no TTL (which would lock an IP out forever).
const FLOOD_LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n
`;

async function assertNotFlooding(ip: string): Promise<void> {
  // Without a real client IP there is no meaningful key — sharing one
  // "unknown" bucket would let one caller lock everyone else out.
  if (!ip || ip === "unknown") return;

  const redis = getRedis();
  if (!redis) return;

  let count: number;
  try {
    count = Number(await redis.eval(FLOOD_LUA, 1, `rl:flood:${ip}`, FLOOD_WINDOW_SECONDS));
  } catch (err) {
    log.warn({ err }, "Flood pre-check unavailable — failing open");
    return;
  }

  if (count > FLOOD_MAX_REQUESTS) {
    throw new TRPCError({
      code:    "TOO_MANY_REQUESTS",
      message: "Too many requests. Please slow down.",
    });
  }
}

export async function createContext(
  opts: FetchCreateContextFnOptions & { ip?: string; req: Request },
): Promise<TrpcContext> {
  const ip = opts.ip ?? "unknown";

  // M-01: reject floods before ANY database access.
  await assertNotFlooding(ip);

  // Try to extract session from cookie or Authorization header
  let session: TrpcContext["session"] = null;
  let user: ContextUser | null = null;

  try {
    const sessionId = extractSessionId(opts.req);
    if (sessionId) {
      const [dbSession] = await db
        .select()
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.id, sessionId),
            gt(schema.sessions.expiresAt, new Date()),
          ),
        )
        .limit(1);

      if (dbSession) {
          // FIX-6: carry activeOrgId from the DB row into context
          session = {
            id:          dbSession.id,
            userId:      dbSession.userId,
            activeOrgId: dbSession.activeOrgId ?? null,
          };

        const [dbUser] = await db
          .select({
            id:       schema.users.id,
            uuid:     schema.users.uuid,
            email:    schema.users.email,
            username: schema.users.username,
            role:     schema.users.role,
            tier:     schema.users.tier,
          })
          .from(schema.users)
          .where(
            and(
              eq(schema.users.id, dbSession.userId),
              eq(schema.users.status, "active"),
            ),
          )
          .limit(1);

        if (dbUser) {
          user = { ...dbUser, orgId: null };
        }
      }
    }
  } catch (err) {
    log.warn({ err }, "Session lookup failed");
  }

  return {
    db,
    req:  opts.req,
    ip,
    session,
    user,
  };
}

function extractSessionId(req: Request): string | null {
  // Cookie
  //
  // SECURITY NOTE (M-03) — READ BEFORE WIRING THIS UP:
  // Nothing in this codebase currently SETS a "session" cookie (auth.login
  // returns the session id in the response body, and clients send it as a
  // Bearer token), so this branch is dormant and not exploitable today.
  // The moment anyone makes auth.login set this cookie, every mutating
  // procedure becomes reachable by a forged cross-site request (browsers
  // attach cookies automatically; they never attach Bearer headers). So the
  // SAME change that starts setting this cookie MUST ALSO ship one of:
  //   - the cookie flags  HttpOnly; Secure; SameSite=Strict  (minimum), or
  //   - real CSRF tokens (double-submit or synchronizer) checked on mutations.
  // Do not ship the cookie first and "add CSRF later".
  const cookieHeader = req.headers.get("cookie") ?? "";
  const cookieMatch = cookieHeader.match(/(?:^|;\s*)session=([^;]+)/);
  if (cookieMatch?.[1]) return cookieMatch[1];

  // Authorization: Bearer <token> (fallback for BYOK / API usage)
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    return auth.slice(7) || null;
  }

  return null;
}

// ─── tRPC Init ────────────────────────────────────────────────────────────────

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    const isProd = process.env.NODE_ENV === "production";
    return {
      ...shape,
      data: {
        ...shape.data,
        // [SECURITY PATCH — Phase 6 pentest] tRPC's default shape includes a
        // full server-side stack trace (absolute file paths, dependency
        // versions, internal module structure) on every error response —
        // confirmed leaking to unauthenticated/unauthorized clients via a
        // live IDOR test. Strip it in production; keep it in dev for
        // debugging convenience. The error is still logged server-side in
        // full regardless — see the onError handler on the trpcServer()
        // mount in boot.ts, added alongside this patch.
        stack: isProd ? undefined : shape.data?.stack,
        zodError: error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

export const router          = t.router;
export const publicProcedure = t.procedure;

// ─── Rate Limiter Middleware ───────────────────────────────────────────────────

const withRateLimit = t.middleware(async ({ ctx, next }) => {
  // SECURITY FIX (C-12): this used to fail COMPLETELY open if Redis was
  // unreachable — `if (!redis) return next({ ctx })` skipped rate limiting
  // for the whole platform, including login, for the duration of any Redis
  // outage. checkRateLimit() (packages/security) already existed, fully
  // built and correct, with a bounded in-memory sliding-window fallback for
  // exactly this case — it was simply never called anywhere. Wired in here
  // instead of reimplementing it a second time.
  const redis = getRedis();
  const identifier = String(ctx.user?.id ?? ctx.ip);
  const config = ctx.user ? RATE_LIMITS.API_AUTHED : RATE_LIMITS.API_ANONYMOUS;

  const result = await checkRateLimit(redis, identifier, config);
  if (!result.allowed) {
    throw new TRPCError({
      code:    "TOO_MANY_REQUESTS",
      message: "Rate limit exceeded. Please slow down.",
    });
  }

  return next({ ctx });
});

// ─── Auth Middleware ──────────────────────────────────────────────────────────

const withAuth = t.middleware(({ ctx, next }) => {
  if (!ctx.user || !ctx.session) {
    throw new TRPCError({
      code:    "UNAUTHORIZED",
      message: "You must be logged in to perform this action.",
    });
  }

  return next({
    ctx: {
      ...ctx,
      user:    ctx.user,    // narrowed: not null
      session: ctx.session, // narrowed: not null
    },
  });
});

// ─── Exported Procedures ──────────────────────────────────────────────────────

/** No auth required — login, health checks */
export const publicProc = publicProcedure.use(withRateLimit);

/** Auth required — most API procedures */
export const protectedProc = publicProcedure.use(withRateLimit).use(withAuth);

/** Permission-gated procedure factory */
export function permittedProc(permission: Permission) {
  return protectedProc.use(({ ctx, next }) => {
    const { role, tier } = ctx.user!;
    if (!hasPermission(role, tier, permission)) {
      throw new TRPCError({
        code:    "FORBIDDEN",
        message: `Missing permission: ${permission}`,
      });
    }
    return next({ ctx });
  });
}

// ─── Structural Admin Audit (M-04) ────────────────────────────────────────────
//
// SECURITY FIX (M-04): audit logging used to be purely conventional — every
// procedure had to remember to call emitAuditLog() itself, and several of the
// most consequential ones didn't. This middleware makes it structural: any
// mutation routed through adminProc / superadminProc is logged automatically,
// success OR failure, so a future admin procedure gets an audit trail without
// its author having to remember.
//
// Scope decisions (deliberate):
//  - MUTATIONS only. Admin queries are polled by the UI every ~30s
//    (platformStats, security dashboard); logging each would bury the table
//    in noise, and a read row would carry no useful target anyway (see below).
//  - This is a guaranteed FLOOR, not a replacement. Procedures that know their
//    real target (e.g. admin.update_user_tier) still write their own richer
//    row; both rows existing for one call is expected, and they are told apart
//    by the "trpc." action prefix.
//  - Input is NOT captured: at this position in the chain the middleware runs
//    before .input() parsing, so `input` is undefined here (verified against
//    tRPC v11 — do not "fix" this by reading it; it will silently be empty).
//  - tRPC's next() RESOLVES to { ok, error } — it does not throw on procedure
//    failure — so failures must be detected via result.ok, not try/catch.
//  - emitAuditLog() never throws, so a failed audit write cannot fail the
//    request.
function withAdminAudit(scope: "admin" | "superadmin") {
  return t.middleware(async ({ ctx, path, type, next }) => {
    // next() with NO ctx override on purpose: passing `{ ctx }` here would
    // re-type the context as the base TrpcContext and silently undo the
    // `ctx.user` non-null narrowing that withAuth established, breaking type
    // safety in every adminProc/superadminProc handler.
    const result = await next();

    if (type === "mutation" && ctx.user) {
      await emitAuditLog(db, {
        orgId:        ctx.session?.activeOrgId ?? null,
        actorId:      ctx.user.id,
        actorType:    "user",
        action:       `trpc.${scope}.${path}`,
        resourceType: "trpc_procedure",
        resourceId:   path,
        afterState:   result.ok
          ? { success: true }
          : { success: false, errorCode: result.error.code },
        ip:           ctx.ip,
        userAgent:    ctx.req.headers.get("user-agent"),
      });
    }

    return result;
  });
}

/** Admin-only procedures — mutations are audit-logged structurally (M-04). */
export const adminProc = protectedProc
  .use(({ ctx, next }) => {
    if (ctx.user!.role !== "admin" && ctx.user!.role !== "superadmin") {
      throw new TRPCError({
        code:    "FORBIDDEN",
        message: "Administrator access required.",
      });
    }
    return next({ ctx });
  })
  .use(withAdminAudit("admin"));

/** Superadmin-only procedures — mutations are audit-logged structurally (M-04). */
export const superadminProc = protectedProc
  .use(({ ctx, next }) => {
    if (ctx.user!.role !== "superadmin") {
      throw new TRPCError({
        code:    "FORBIDDEN",
        message: "Superadmin access required.",
      });
    }
    return next({ ctx });
  })
  .use(withAdminAudit("superadmin"));
