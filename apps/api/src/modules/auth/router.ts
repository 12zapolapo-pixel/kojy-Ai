/**
 * Auth Module Router
 *
 * OWNERSHIP: apps/api/src/modules/auth
 * LAYER: API — authentication and session management
 *
 * PROCEDURES:
 * - auth.register   — creates user + org, sends verification email
 * - auth.login      — validates credentials, creates session, returns sessionId in response body
 * - auth.logout     — destroys session
 * - auth.me         — returns current user context
 * - auth.refresh    — extends session expiry
 * - auth.changePass — requires current password, rotates session
 * - auth.verifyOtp  — verifies email OTP, activates account
 *
 * SECURITY:
 * - Passwords hashed with bcrypt (12 rounds)
 * - Failed logins increment failedLoginCount
 * - Account locked after 5 failures for 15 minutes
 * - All failures emit SecurityEvent (category: "auth")
 * - Session ID is cryptographically random (not derived from user data)
 * - SESSION MODEL (current, as implemented): the session ID is returned as a
 *   plain string in the JSON response body (see `login` below) and the
 *   client is expected to send it back via `Authorization: Bearer <sessionId>`.
 *   There is NO HttpOnly cookie set anywhere in this file today — an earlier
 *   version of this doc described a cookie-based model that was never
 *   actually implemented here (it exists as a separate, still-unwired
 *   capability elsewhere). Do not assume cookie semantics (browser-managed
 *   attachment, XSS opacity, etc.) apply to this session token — it is
 *   handled exactly like any other bearer credential a client must store
 *   and attach itself. If/when an HttpOnly cookie is implemented for this
 *   flow, an Origin check must land on the WebSocket gateway in the same
 *   change (see docs/bugs — WS Origin validation), or a cross-site
 *   WebSocket hijacking hole opens up the moment the cookie exists.
 *
 * BRUTE FORCE PROTECTION:
 * - Per-IP rate limit: 10 attempts/min via RATE_LIMITS.AUTH_LOGIN, layered on
 *   top of (not a replacement for) per-account lockout (enforced directly in
 *   the `login` procedure below, not in shared middleware)
 * - Account lockout: 5 failures → locked 15min → exponential backoff
 * - Lockout also applies to OTP verification
 */

import { z }           from "zod";
import { eq, and, sql } from "drizzle-orm";
import bcrypt          from "bcryptjs";
import { nanoid }      from "nanoid";
import { TRPCError }   from "@trpc/server";
import { router, publicProc, protectedProc } from "../../trpc.js";
import { schema }      from "../../db/client.js"; // FIX-2: schema re-exported from client.ts
import { createLogger } from "../../utils/logger.js";
import { getRedis } from "../../utils/redis.js";
import { checkRateLimit, RATE_LIMITS, lookupIpIntelligence } from "@kojyai/security";
import { emitSecurityEvent } from "../../events/security.js";
import { issueCode, deliverCode } from "./codes.js";
import { QUEUE_NAMES, PLAN_LIMITS } from "@kojyai/shared/constants";

const log = createLogger("auth-module");

const SESSION_EXPIRY_DAYS = 7;

// SECURITY FIX (M-06): login used to return instantly when the email didn't
// exist (no bcrypt) but spend ~350ms in a real bcrypt.compare when it did —
// so response latency alone revealed which emails are registered, defeating
// the deliberately-generic "Invalid email or password" message. The
// not-found path now compares against this throwaway hash so both paths pay
// the same cost. It is a real cost-12 hash (matching production hashes, see
// bcrypt.hash(password, 12) below) of a random value nobody knows — it can
// never validate a real password. Do NOT lower its cost factor: the whole
// point is that it costs the same as a real comparison.
const DUMMY_BCRYPT_HASH = "$2a$12$mfTjfQ5KEG8J57kH3YHCb.IeP3gHbcwawRru3Nybn0ZLBvueazuFq";

// ─── Input Schemas ────────────────────────────────────────────────────────────

const RegisterInput = z.object({
  email:    z.string().email().max(255),
  username: z.string().min(3).max(100).regex(/^[a-zA-Z0-9_-]+$/, "Alphanumeric, dashes, underscores only"),
  password: z.string().min(8).max(128),
  // Blank from the form = not given (falls back to the username).
  orgName:  z.string().trim().max(100).optional().transform((v) => (v ? v : undefined)).pipe(z.string().min(2).optional()),
});

const LoginInput = z.object({
  email:    z.string().email(),
  password: z.string().min(1).max(128),
});

const ChangePassInput = z.object({
  currentPassword: z.string().min(1),
  newPassword:     z.string().min(8).max(128),
});

const VerifyOtpInput = z.object({
  email:   z.string().email(),
  code:    z.string().length(6),
  purpose: z.enum(["verify_email", "password_reset", "mfa"]),   // strict enum — no free strings
});

// ─── Router ───────────────────────────────────────────────────────────────────

export const authRouter = router({

  // ── Register ───────────────────────────────────────────────────────────────

  register: publicProc
    .input(RegisterInput)
    .mutation(async ({ input, ctx }) => {
      const { email, username, password, orgName } = input;

      // SECURITY FIX (C-12): dedicated register throttle — RATE_LIMITS.AUTH_REGISTER
      // already existed, built and correct, and was never called anywhere.
      const regLimit = await checkRateLimit(getRedis(), ctx.ip, RATE_LIMITS.AUTH_REGISTER);
      if (!regLimit.allowed) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many registration attempts. Please try again later." });
      }

      // Check email uniqueness
      const [existing] = await ctx.db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, email.toLowerCase()))
        .limit(1);

      if (existing) {
        throw new TRPCError({ code: "CONFLICT", message: "Email already registered." });
      }

      // Check username uniqueness
      const [existingUsername] = await ctx.db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.username, username.toLowerCase()))
        .limit(1);

      if (existingUsername) {
        throw new TRPCError({ code: "CONFLICT", message: "Username already taken." });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const newUuid = () => nanoid(36).replace(/[^a-z0-9-]/gi, "-").slice(0, 36);
      // Billing off = every feature unlocked, so everyone gets the dev plan.
      const plan = process.env.BILLING_DISABLED === "true" ? "dev" as const : "free" as const;
      const displayOrgName = orgName?.trim() || username;

      // One transaction: a failure part-way (e.g. a taken org slug) used to
      // leave a user without an org who could never register again.
      const result = await ctx.db.transaction(async (tx) => {
        // The very first account is the server's owner: active right away
        // (there may be no email set up yet) and superadmin. After that,
        // sign-ups are closed unless SIGNUPS=open.
        // Serialize registrations so two simultaneous first sign-ups can't
        // both become the owner.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(727001)`);
        const [counted] = await tx
          .select({ userCount: sql<number>`COUNT(*)`.mapWith(Number) })
          .from(schema.users);
        const isOwner = (counted?.userCount ?? 0) === 0;
        if (!isOwner && process.env.SIGNUPS !== "open") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Sign-ups are closed on this server." });
        }

        const [createdUser] = await tx
          .insert(schema.users)
          .values({
            uuid:         newUuid(),
            email:        email.toLowerCase(),
            username:     username.toLowerCase(),
            displayName:  username,
            passwordHash,
            role:         isOwner ? "superadmin" : "user",
            status:       isOwner ? "active" : "pending_verification",
            tier:         plan,
            isDev:        isOwner,
          })
          .returning({ id: schema.users.id });
        const userId = createdUser!.id;

        // Org slugs are unique; two people can pick the same org name, so
        // add a short suffix when the plain slug is taken.
        const baseSlug = displayOrgName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "org";
        const [taken] = await tx.select({ id: schema.organizations.id }).from(schema.organizations)
          .where(eq(schema.organizations.slug, baseSlug)).limit(1);
        const orgSlug = taken ? `${baseSlug}-${nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, "x")}` : baseSlug;

        const [createdOrg] = await tx
          .insert(schema.organizations)
          .values({
            uuid:     newUuid(),
            ownerId:  userId,
            name:     displayOrgName,
            slug:     orgSlug,
            plan,
            status:   "active",
            botQuota: PLAN_LIMITS[plan].maxBots,
          })
          .returning({ id: schema.organizations.id });
        const orgId = createdOrg!.id;

        await tx.insert(schema.orgMembers).values({ orgId, userId, role: "admin" });

        const now = new Date();
        const periodEnd = new Date(now);
        periodEnd.setFullYear(periodEnd.getFullYear() + 1);
        await tx.insert(schema.subscriptions).values({
          uuid:               newUuid(),
          orgId,
          plan,
          status:             "active",
          currentPeriodStart: now,
          currentPeriodEnd:   periodEnd,
          limits:             PLAN_LIMITS[plan],
        });

        return { userId, orgId, isOwner };
      });

      log.info({ userId: result.userId, orgId: result.orgId, owner: result.isOwner }, "User registered");

      if (result.isOwner) {
        return { success: true, verified: true, message: "Owner account created — you can log in now." };
      }

      const code = await issueCode(ctx.db, result.userId, "verify_email");
      await deliverCode("verify_email", email.toLowerCase(), code);
      return { success: true, verified: false, message: "Check your email for a 6-digit code to verify your account." };
    }),

  // ── Resend verification code ───────────────────────────────────────────────

  resendVerification: publicProc
    .input(z.object({ email: z.string().email() }))
    .mutation(async ({ input, ctx }) => {
      const GENERIC_OK = { success: true, message: "If that account is waiting for verification, a new code has been sent." };
      const email = input.email.toLowerCase();

      const limit = await checkRateLimit(getRedis(), `${ctx.ip}:resend`, RATE_LIMITS.AUTH_REGISTER);
      if (!limit.allowed) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many requests. Please try again later." });
      }

      const [user] = await ctx.db.select({ id: schema.users.id, status: schema.users.status })
        .from(schema.users).where(eq(schema.users.email, email)).limit(1);
      if (!user || user.status !== "pending_verification") return GENERIC_OK;

      const code = await issueCode(ctx.db, user.id, "verify_email");
      await deliverCode("verify_email", email, code);
      return GENERIC_OK;
    }),

  // ── Login ──────────────────────────────────────────────────────────────────

  login: publicProc
    .input(LoginInput)
    .mutation(async ({ input, ctx }) => {
      const { email, password } = input;

      // SECURITY FIX (C-12): dedicated login throttle. This is layered on
      // top of — not a replacement for — the per-account lockout logic
      // below (which triggers on repeated failures for one specific
      // account). This one is IP-scoped and catches credential-stuffing
      // across many different accounts from the same source, which the
      // per-account lockout alone can't. RATE_LIMITS.AUTH_LOGIN already
      // existed, built and correct, and was never called anywhere — the
      // login endpoint had no dedicated brute-force protection beyond the
      // generic 30-req/min bucket shared with every other public endpoint.
      const loginLimit = await checkRateLimit(getRedis(), ctx.ip, RATE_LIMITS.AUTH_LOGIN);
      if (!loginLimit.allowed) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many login attempts. Please try again later." });
      }

      const [user] = await ctx.db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, email.toLowerCase()))
        .limit(1);

      // Generic error message — don't leak whether email exists
      const INVALID_CREDS = new TRPCError({
        code:    "UNAUTHORIZED",
        message: "Invalid email or password.",
      });

      if (!user) {
        // M-06: burn the same bcrypt time a real account would, so response
        // latency can't be used to enumerate registered emails.
        await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
        await emitSecurityEvent(ctx.db, {
          orgId:    null, // no user identified — genuinely no org context available
          severity: "low",
          category: "auth",
          actorId:  null,
          ip:       ctx.ip,
          payload:  { reason: "email_not_found", email },
        });
        throw INVALID_CREDS;
      }

      // Check lockout
      if (user.lockedUntil && user.lockedUntil > new Date()) {
        const minutesLeft = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
        throw new TRPCError({
          code:    "TOO_MANY_REQUESTS",
          message: `Account locked. Try again in ${minutesLeft} minutes.`,
        });
      }

      const validPassword = await bcrypt.compare(password, user.passwordHash);

      if (!validPassword) {
        const newFailCount = (user.failedLoginCount ?? 0) + 1;
        const lockedUntil = newFailCount >= 5
          ? new Date(Date.now() + 15 * 60_000 * Math.pow(2, newFailCount - 5))
          : undefined;

        await ctx.db
          .update(schema.users)
          .set({ failedLoginCount: newFailCount, ...(lockedUntil ? { lockedUntil } : {}) })
          .where(eq(schema.users.id, user.id));

        const [failedLoginMember] = await ctx.db
          .select({ orgId: schema.orgMembers.orgId })
          .from(schema.orgMembers)
          .where(eq(schema.orgMembers.userId, user.id))
          .limit(1);

        await emitSecurityEvent(ctx.db, {
          orgId:    failedLoginMember?.orgId ?? null,
          severity: newFailCount >= 5 ? "medium" : "low",
          category: "auth",
          actorId:  user.id,
          ip:       ctx.ip,
          payload:  { reason: "invalid_password", failCount: newFailCount },
        });

        throw INVALID_CREDS;
      }

      // FIX-10: check ALL non-active statuses, not just suspended.
      // pending_verification and deleted accounts must never receive a session.
      // Generic message prevents account-enumeration via different error text.
      if (user.status !== "active") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Account is not active. Contact support." });
      }

      // SECURITY FIX (H-21): lookupIpIntelligence() (packages/security) was
      // fully implemented — geolocation + VPN/Tor/proxy/hosting risk
      // scoring, Redis-cached — with its own header explicitly documenting
      // "Auth module (account takeover detection)" as an intended consumer,
      // yet had zero callers anywhere. Wired in here: flags (does not
      // block) a login from a high-risk IP that also differs from the
      // user's last known login IP — the actual account-takeover signal
      // (a VPN alone isn't suspicious; a VPN AND a location change from a
      // previously-seen IP is). Runs after password verification (so it
      // never leaks info pre-auth) and never blocks the login itself —
      // false positives here (someone legitimately traveling or switching
      // networks) shouldn't lock a real user out; this is a signal for the
      // security dashboard, not an access gate.
      const ipIntel = await lookupIpIntelligence(getRedis(), ctx.ip).catch(() => null);
      if (ipIntel && ipIntel.riskScore > 0.5 && user.lastLoginIp && user.lastLoginIp !== ctx.ip) {
        const [loginRiskMember] = await ctx.db
          .select({ orgId: schema.orgMembers.orgId })
          .from(schema.orgMembers)
          .where(eq(schema.orgMembers.userId, user.id))
          .limit(1);

        await emitSecurityEvent(ctx.db, {
          orgId:    loginRiskMember?.orgId ?? null,
          severity: "medium",
          category: "account_takeover",
          actorId:  user.id,
          ip:       ctx.ip,
          payload:  {
            reason: "high_risk_ip_location_change",
            riskScore: ipIntel.riskScore,
            isVpn: ipIntel.isVpn, isTor: ipIntel.isTor, isProxy: ipIntel.isProxy, isHosting: ipIntel.isHosting,
            previousIp: user.lastLoginIp, country: ipIntel.country,
          },
        });
      }

      // Create session
      const sessionId = nanoid(128);
      const expiresAt = new Date(Date.now() + SESSION_EXPIRY_DAYS * 24 * 3600 * 1000);

      await ctx.db.insert(schema.sessions).values({
        id:        sessionId,
        userId:    user.id,
        expiresAt,
        ip:        ctx.ip,
        userAgent: ctx.req.headers.get("user-agent") ?? "",
      });

      // Reset failed login count
      await ctx.db
        .update(schema.users)
        .set({
          failedLoginCount: 0,
          lockedUntil:      null,
          lastLoginAt:      new Date(),
          lastLoginIp:      ctx.ip,
        })
        .where(eq(schema.users.id, user.id));

      log.info({ userId: user.id, ip: ctx.ip }, "User logged in");

      return {
        sessionId,
        expiresAt: expiresAt.toISOString(),
        user: {
          id:       user.uuid,
          email:    user.email,
          username: user.username,
          role:     user.role,
          tier:     user.tier,
        },
      };
    }),

  // ── Logout ─────────────────────────────────────────────────────────────────

  logout: protectedProc
    .mutation(async ({ ctx }) => {
      await ctx.db
        .delete(schema.sessions)
        .where(eq(schema.sessions.id, ctx.session.id));

      log.info({ userId: ctx.user.id }, "User logged out");
      return { success: true };
    }),

  // ── Me ─────────────────────────────────────────────────────────────────────

  me: protectedProc
    .query(async ({ ctx }) => {
      const [user] = await ctx.db
        .select({
          id:          schema.users.uuid,
          email:       schema.users.email,
          username:    schema.users.username,
          displayName: schema.users.displayName,
          avatarUrl:   schema.users.avatarUrl,
          role:        schema.users.role,
          tier:        schema.users.tier,
          locale:      schema.users.locale,
          timezone:    schema.users.timezone,
          walletBalance: schema.users.walletBalance,
        })
        .from(schema.users)
        .where(eq(schema.users.id, ctx.user.id))
        .limit(1);

      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "User not found." });
      return user;
    }),

  // ── Verify OTP ─────────────────────────────────────────────────────────────

  verifyOtp: publicProc
    .input(VerifyOtpInput)
    .mutation(async ({ input, ctx }) => {
      const { email, code, purpose } = input;

      const [user] = await ctx.db
        // FIX-AUDIT: lockedUntil + failedLoginCount were missing from this select,
        // so the lockout check below always read `undefined` and silently never
        // triggered — OTP brute force was unprotected despite the comment saying
        // otherwise. Both columns are required for the lockout logic to function.
        .select({
          id:               schema.users.id,
          status:           schema.users.status,
          lockedUntil:      schema.users.lockedUntil,
          failedLoginCount: schema.users.failedLoginCount,
        })
        .from(schema.users)
        .where(eq(schema.users.email, email.toLowerCase()))
        .limit(1);

      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "User not found." });

      // ── OTP brute-force protection ─────────────────────────────────────────
      // Track failed OTP attempts per userId+purpose in the same lockout columns
      // used by login. After 5 failures → lock for 15 minutes.
      if (user.lockedUntil && user.lockedUntil > new Date()) {
        const minutesLeft = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
        throw new TRPCError({
          code:    "TOO_MANY_REQUESTS",
          message: `Account locked. Try again in ${minutesLeft} minutes.`,
        });
      }

      const [otp] = await ctx.db
        .select()
        .from(schema.otpCodes)
        .where(
          and(
            eq(schema.otpCodes.userId, user.id),
            eq(schema.otpCodes.code, code),
            eq(schema.otpCodes.purpose, purpose),
            eq(schema.otpCodes.used, false),
          ),
        )
        .limit(1);

      if (!otp || otp.expiresAt < new Date()) {
        // Increment OTP failure counter — same lockout logic as login
        const newFailCount = (user.failedLoginCount ?? 0) + 1;
        const lockedUntil  = newFailCount >= 5
          ? new Date(Date.now() + 15 * 60_000 * Math.pow(2, newFailCount - 5))
          : undefined;

        await ctx.db
          .update(schema.users)
          .set({ failedLoginCount: newFailCount, ...(lockedUntil ? { lockedUntil } : {}) })
          .where(eq(schema.users.id, user.id));

        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid or expired code." });
      }

      // Reset failure counter on success
      await ctx.db
        .update(schema.users)
        .set({ failedLoginCount: 0, lockedUntil: null })
        .where(eq(schema.users.id, user.id));

      // Mark used + activate user
      await ctx.db
        .update(schema.otpCodes)
        .set({ used: true })
        .where(eq(schema.otpCodes.id, otp.id));

      if (purpose === "verify_email" && user.status === "pending_verification") {
        await ctx.db
          .update(schema.users)
          .set({ status: "active" })
          .where(eq(schema.users.id, user.id));
      }

      return { success: true };
    }),

  // ── Request Password Reset ────────────────────────────────────────────────

  requestPasswordReset: publicProc
    .input(z.object({ email: z.string().email() }))
    .mutation(async ({ input, ctx }) => {
      const { email } = input;

      // Always return the same response — don't leak whether email exists
      const GENERIC_OK = { success: true, message: "If that email is registered, a reset link has been sent." };

      const [user] = await ctx.db
        .select({ id: schema.users.id, status: schema.users.status })
        .from(schema.users)
        .where(eq(schema.users.email, email.toLowerCase()))
        .limit(1);

      if (!user || user.status === "suspended") return GENERIC_OK;

      // Rate limit: max 3 reset requests per hour per email
      const oneHourAgo = new Date(Date.now() - 3_600_000);
      const recentCountRows = await ctx.db
        .select({ recentCount: sql<number>`COUNT(*)`.mapWith(Number) })
        .from(schema.otpCodes)
        .where(
          and(
            eq(schema.otpCodes.userId, user.id),
            eq(schema.otpCodes.purpose, "password_reset"),
            sql`${schema.otpCodes.createdAt} > ${oneHourAgo}`,
          ),
        );

      const recentCount = recentCountRows[0]?.recentCount ?? 0;

      if (Number(recentCount) >= 3) return GENERIC_OK;

      const code = await issueCode(ctx.db, user.id, "password_reset");
      // The code travels in the reset link's query string; consuming it needs
      // the resetPassword mutation, so a mail scanner merely opening the link
      // can't burn it.
      await deliverCode("password_reset", email.toLowerCase(), code);

      log.info({ userId: user.id }, "Password reset requested");
      return GENERIC_OK;
    }),

  // ── Reset Password ─────────────────────────────────────────────────────────

  resetPassword: publicProc
    .input(z.object({
      email:       z.string().email(),
      code:        z.string().length(6),
      newPassword: z.string().min(8).max(128),
    }))
    .mutation(async ({ input, ctx }) => {
      const { email, code, newPassword } = input;

      const [user] = await ctx.db
        .select({ id: schema.users.id, failedLoginCount: schema.users.failedLoginCount, lockedUntil: schema.users.lockedUntil })
        .from(schema.users)
        .where(eq(schema.users.email, email.toLowerCase()))
        .limit(1);

      // SECURITY FIX: this was NOT_FOUND while a wrong code is BAD_REQUEST — the
      // differing error CODE told an attacker which emails are registered even
      // though the message text was identical. Same code and message for both.
      if (!user) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid or expired reset code." });

      // Check lockout
      if (user.lockedUntil && user.lockedUntil > new Date()) {
        const minutesLeft = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
        throw new TRPCError({
          code:    "TOO_MANY_REQUESTS",
          message: `Account locked. Try again in ${minutesLeft} minutes.`,
        });
      }

      // Verify OTP
      const [otp] = await ctx.db
        .select()
        .from(schema.otpCodes)
        .where(
          and(
            eq(schema.otpCodes.userId, user.id),
            eq(schema.otpCodes.code, code),
            eq(schema.otpCodes.purpose, "password_reset"),
            eq(schema.otpCodes.used, false),
          ),
        )
        .limit(1);

      if (!otp || otp.expiresAt < new Date()) {
        // Increment failure count
        const newFail = (user.failedLoginCount ?? 0) + 1;
        const lockedUntil = newFail >= 5
          ? new Date(Date.now() + 15 * 60_000 * Math.pow(2, newFail - 5))
          : undefined;
        await ctx.db
          .update(schema.users)
          .set({ failedLoginCount: newFail, ...(lockedUntil ? { lockedUntil } : {}) })
          .where(eq(schema.users.id, user.id));

        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid or expired reset code." });
      }

      // SECURITY FIX: claim the code ATOMICALLY. This used to be a plain
      // "UPDATE ... SET used = true WHERE id = ?" after a separate SELECT, so two
      // concurrent requests carrying the same code both passed the SELECT and
      // both went on to reset the password — single-use wasn't actually enforced.
      // The `used = false` in the WHERE means exactly one request can flip it.
      const claimed = await ctx.db
        .update(schema.otpCodes)
        .set({ used: true })
        .where(and(eq(schema.otpCodes.id, otp.id), eq(schema.otpCodes.used, false)))
        .returning({ id: schema.otpCodes.id });

      if (claimed.length !== 1) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid or expired reset code." });
      }

      // Hash and save new password
      const newHash = await bcrypt.hash(newPassword, 12);
      await ctx.db
        .update(schema.users)
        .set({ passwordHash: newHash, failedLoginCount: 0, lockedUntil: null })
        .where(eq(schema.users.id, user.id));

      // Burn any OTHER outstanding reset codes (up to 3 can be live at once) —
      // after a successful reset an older emailed code must not still work.
      await ctx.db
        .update(schema.otpCodes)
        .set({ used: true })
        .where(and(
          eq(schema.otpCodes.userId, user.id),
          eq(schema.otpCodes.purpose, "password_reset"),
          eq(schema.otpCodes.used, false),
        ));

      // Invalidate ALL existing sessions — security best practice after reset
      await ctx.db
        .delete(schema.sessions)
        .where(eq(schema.sessions.userId, user.id));

      log.info({ userId: user.id }, "Password reset successful — all sessions invalidated");
      return { success: true, message: "Password reset. Please log in with your new password." };
    }),

  // ── Switch Active Org ─────────────────────────────────────────────────────

  switchOrg: protectedProc
    .input(z.object({ orgId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      // Confirm the user is actually a member of this org
      const orgIdNum = parseInt(input.orgId, 10);
      if (!Number.isInteger(orgIdNum) || orgIdNum <= 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid org ID." });
      }

      const [member] = await ctx.db
        .select({ orgId: schema.orgMembers.orgId })
        .from(schema.orgMembers)
        .where(
          and(
            eq(schema.orgMembers.userId, ctx.user.id),
            eq(schema.orgMembers.orgId, orgIdNum),
          ),
        )
        .limit(1);

      if (!member) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You are not a member of this organization." });
      }

      // Persist the active org on the session
      await ctx.db
        .update(schema.sessions)
        .set({ activeOrgId: orgIdNum })
        .where(eq(schema.sessions.id, ctx.session.id));

      log.info({ userId: ctx.user.id, newOrgId: orgIdNum }, "Org switched");
      return { success: true, activeOrgId: orgIdNum };
    }),

  // ── Change Password ────────────────────────────────────────────────────────

  changePassword: protectedProc
    .input(ChangePassInput)
    .mutation(async ({ input, ctx }) => {
      const [user] = await ctx.db
        .select({ passwordHash: schema.users.passwordHash })
        .from(schema.users)
        .where(eq(schema.users.id, ctx.user.id))
        .limit(1);

      if (!user) throw new TRPCError({ code: "NOT_FOUND" });

      const valid = await bcrypt.compare(input.currentPassword, user.passwordHash);
      if (!valid) throw new TRPCError({ code: "UNAUTHORIZED", message: "Current password incorrect." });

      const newHash = await bcrypt.hash(input.newPassword, 12);
      await ctx.db
        .update(schema.users)
        .set({ passwordHash: newHash })
        .where(eq(schema.users.id, ctx.user.id));

      // L-10: invalidates EVERY session for this user — including the one making
      // this request (the comment used to say "all other sessions"). That is
      // deliberate: whoever changes a password may be responding to a
      // compromise, and a stolen session must not survive it. The caller's own
      // session is gone too, so the client must treat success as a sign-out and
      // redirect to /login (SettingsPage does) rather than keep using the token.
      await ctx.db
        .delete(schema.sessions)
        .where(eq(schema.sessions.userId, ctx.user.id));

      log.info({ userId: ctx.user.id }, "Password changed, sessions invalidated");
      return { success: true };
    }),
});
