/**
 * KOJYAI API Server — Boot Entry Point
 *
 * OWNERSHIP: apps/api
 * LAYER: Platform core — starts before anything else
 *
 * STARTUP ORDER:
 * 1. Validate env vars (hard fail if missing)
 * 2. Connect to Postgres (and apply migrations) + Redis
 * 3. Start Hono HTTP server
 * 4. Attach WebSocket gateway to the same HTTP server
 * 5. Boot bot runtime manager
 * 6. Start background workers
 *
 * FAILURE STRATEGY:
 * - Missing env: process.exit(1) immediately
 * - DB connection fail: retry 3x then exit
 * - Redis fail: warn and continue (Redis is non-critical for auth, critical for WS)
 * - Bot runtime fail: log error, bots enter "error" state, platform stays up
 */

import "./env.js"; // MUST stay first — loads .env before any other module reads process.env at import time
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { logger } from "hono/logger";
import { trpcServer } from "@hono/trpc-server";
import type { Server as HttpServer } from "http";

import { appRouter } from "./router.js";
import { createContext } from "./trpc.js";
import { initWebSocketGateway } from "./websocket/gateway.js";
import { initBotRuntimeManager } from "./modules/bots/runtime-manager.js";
import { createLogger } from "./utils/logger.js";
import { resolveClientIp, getTrustedProxies } from "./utils/clientIp.js";
// NOTE: initJobQueues lives in apps/worker — the API process only enqueues jobs,
// it never initialises queue workers. Removing the dead import prevents a boot crash.
import { connectDB } from "./db/client.js";
import { connectRedis } from "./utils/redis.js";
import { handleStripeWebhook } from "./modules/billing/webhook.js";


const log = createLogger("boot");

// ─── 1. Environment Validation ────────────────────────────────────────────────

const REQUIRED_ENV = [
  "JWT_SECRET",
  "DATABASE_URL",
  "ENCRYPTION_KEY",
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    log.fatal(`Missing required env: ${key}. Check .env.example.`);
    process.exit(1);
  }
}

// At least one AI provider is required — bot chat replies and the
// Delegation agent's planning/coding pipeline both need one. Any of the
// three works; this matches resolveAIProvider()'s own auto-selection order
// in packages/engine/src/runtime/AIProvider.ts, so don't hardcode Groq here.
const AI_PROVIDER_KEYS = ["GROQ_API_KEY", "OPENAI_API_KEY", "MISTRAL_API_KEY"];
if (!AI_PROVIDER_KEYS.some((key) => process.env[key])) {
  log.fatal(`Missing required env: at least one of ${AI_PROVIDER_KEYS.join(", ")} must be set. Check .env.example.`);
  process.exit(1);
}

// SECURITY FIX (L-29): Stripe credentials were never checked at startup. A missing
// or half-set pair meant billing webhooks answered 500 "Stripe not configured"
// at runtime — Stripe retries then gives up, and paid upgrades are silently never
// applied. Fail fast in production instead. Deployments that genuinely run without
// billing set BILLING_DISABLED=true to say so explicitly.
{
  const sk = process.env.STRIPE_SECRET_KEY;
  const wh = process.env.STRIPE_WEBHOOK_SECRET;
  const billingOptOut = process.env.BILLING_DISABLED === "true";
  if (process.env.NODE_ENV === "production" && !billingOptOut) {
    for (const [name, v] of [["STRIPE_SECRET_KEY", sk], ["STRIPE_WEBHOOK_SECRET", wh]] as const) {
      if (!v) {
        log.fatal(`Missing required env: ${name}. Set it, or set BILLING_DISABLED=true if this deployment intentionally has no billing.`);
        process.exit(1);
      }
    }
  } else if (!billingOptOut && (!sk || !wh)) {
    log.warn({ hasSecretKey: !!sk, hasWebhookSecret: !!wh }, "Stripe is not (fully) configured — billing and its webhook are disabled in this environment.");
  }
  if (sk && !/^(sk|rk)_(live|test)_/.test(sk)) log.warn("STRIPE_SECRET_KEY doesn't look like a Stripe secret key (expected sk_live_/sk_test_/rk_...).");
  if (wh && !wh.startsWith("whsec_"))           log.warn("STRIPE_WEBHOOK_SECRET doesn't look like a Stripe webhook secret (expected whsec_...).");
}

// SECURITY FIX (L-02): every production-only guard in this file (FRONTEND_URL,
// REDIS_PASSWORD, HSTS) keys off the EXACT string "production". A typo'd,
// differently-cased, or unset NODE_ENV skips all of them silently. Always log
// which mode was detected, and warn loudly if it isn't a recognised value.
const DETECTED_ENV = process.env.NODE_ENV;
if (DETECTED_ENV === "production" || DETECTED_ENV === "development" || DETECTED_ENV === "test") {
  log.info({ nodeEnv: DETECTED_ENV }, `Starting in ${DETECTED_ENV} mode`);
} else {
  log.warn(
    { nodeEnv: DETECTED_ENV ?? null },
    `NODE_ENV is ${DETECTED_ENV === undefined ? "unset" : `"${DETECTED_ENV}"`}, not one of production/development/test — ` +
    "production-only safeguards (FRONTEND_URL and REDIS_PASSWORD requirements, HSTS) are NOT active. " +
    'If this is a real deployment set NODE_ENV=production exactly (lowercase).',
  );
}

if (process.env.NODE_ENV === "production" && !process.env.FRONTEND_URL) {
  log.fatal("FRONTEND_URL must be set in production.");
  process.exit(1);
}

// SECURITY FIX (C-03): handleControlCommand() in runtime-manager.ts trusts
// every message on bot_control:* completely, by design — anyone who can
// reach an unauthenticated Redis instance could start/stop/restart/
// broadcast through any bot with zero session token or tRPC permission
// check. Requiring a real password here is the first of two layers (the
// second is HMAC-signing the messages themselves — see
// packages/shared/src/crypto/botControlSignature.ts and
// initBotControlSubscriber's verification of it).
if (process.env.NODE_ENV === "production" && !process.env.REDIS_PASSWORD) {
  log.fatal("REDIS_PASSWORD must be set in production — an unauthenticated Redis instance is a full bot-control bypass.");
  process.exit(1);
}

if (process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY.length < 64) {
  log.fatal("ENCRYPTION_KEY must be at least 64 hex characters (256-bit).");
  process.exit(1);
}

// ─── 2. Trusted Proxy Resolution ─────────────────────────────────────────────
// The resolution logic lives in utils/clientIp.ts so the WebSocket gateway
// applies the identical rule (see that file for the spoofing rationale).

// SECURITY FIX (M-02): if TRUSTED_PROXY_IPS is left at its default in
// production, resolveClientIp() can only ever trust loopback — so behind a real
// load balancer the socket peer is the LB itself, XFF is ignored, and EVERY
// anonymous user resolves to the LB's IP and shares ONE rate-limit bucket
// (legit users lock each other out; a credential-stuffer hides in the crowd).
// That failure is completely silent, so surface it loudly at startup.
if (process.env.NODE_ENV === "production" && !process.env.TRUSTED_PROXY_IPS) {
  log.warn(
    { defaultTrusted: [...getTrustedProxies()] },
    "TRUSTED_PROXY_IPS is not set in production — client IPs will resolve to your " +
    "load balancer's address and all anonymous users will share one rate-limit bucket. " +
    "Set TRUSTED_PROXY_IPS to your reverse proxy / load balancer IP(s).",
  );
}

function getClientIp(c: any): string {
  const socketAddr: string | undefined =
    (c.env as any)?.incoming?.socket?.remoteAddress ??
    (c.env as any)?.incoming?.connection?.remoteAddress;
  return resolveClientIp(socketAddr, c.req.header("x-forwarded-for"));
}

// ─── 3. Hono App ──────────────────────────────────────────────────────────────

const app = new Hono();

// Logger — structured Pino in production, pretty in dev
app.use("*", logger());

// Security headers — X-Content-Type-Options, X-Frame-Options, Referrer-Policy,
// etc. This API previously set none of these at all.
app.use(
  "*",
  secureHeaders({
    strictTransportSecurity: process.env.NODE_ENV === "production" ? "max-age=63072000; includeSubDomains; preload" : false,
    xFrameOptions: "DENY",
    xContentTypeOptions: "nosniff",
    referrerPolicy: "strict-origin-when-cross-origin",
  }),
);

// CORS — locked to FRONTEND_URL in production
app.use(
  "*",
  cors({
    origin: process.env.FRONTEND_URL ?? "http://localhost:5173",
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "x-trpc-source"],
    maxAge: 86400,
  }),
);

// SECURITY FIX (L-03): edge-level request body cap. Until now protection against
// oversized bodies depended entirely on every individual zod schema remembering
// to cap its strings/arrays. Largest legitimate request is a Composer turn
// (50 history entries x 8000 chars, ~400KB; ~1.6MB worst case if fully
// multi-byte), so 2MB global leaves headroom; Stripe events are a few KB, so
// the webhook gets a much tighter cap. Checked against Content-Length first
// and, for chunked bodies, while streaming — so it can't be bypassed by
// omitting the header.
const tooLarge = (c: any) => c.json({ error: "Request body too large." }, 413);
app.use("/stripe/webhook", bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge }));
// Bot project zips are the one large upload (30 MB zip, base64 in JSON).
app.use("/trpc/projects.uploadZip", bodyLimit({ maxSize: 42 * 1024 * 1024, onError: tooLarge }));
app.use("*", async (c, next) =>
  c.req.path === "/trpc/projects.uploadZip" ? next() : bodyLimit({ maxSize: 2 * 1024 * 1024, onError: tooLarge })(c, next));

// ─── Stripe Webhook — native Hono route, raw body, real status propagation ───
// MUST be before any body-parsing middleware — Stripe signature verification
// requires the raw byte stream. The Express-adapter pattern was removed because
// it always returned 200 regardless of whether the handler reported success or
// failure, defeating Stripe's retry mechanism on internal errors.
app.post("/stripe/webhook", async (c) => {
  const rawBody   = Buffer.from(await c.req.arrayBuffer());
  const signature = c.req.header("stripe-signature") ?? "";

  const { status, body } = await handleStripeWebhook(rawBody, signature);
  return c.json(body, status as any);
});

// tRPC — all API procedures live here
app.use(
  "/trpc/*",
  trpcServer({
    router: appRouter,
    createContext: (opts, c) =>
      createContext({
        ...opts,
        ip: getClientIp(c),
        req: c.req.raw,
      }),
    onError: ({ error, path, type, ctx }) => {
      // Full detail server-side always — this is the only place the stack
      // trace is visible now that trpc.ts strips it from production
      // responses (see errorFormatter in trpc.ts).
      const meta = { err: error, path, type, userId: (ctx as any)?.user?.id };
      if (error.code === "INTERNAL_SERVER_ERROR") {
        log.error(meta, `Unhandled tRPC error on ${path ?? "unknown procedure"}`);
      } else {
        // Expected errors (NOT_FOUND, UNAUTHORIZED, BAD_REQUEST, etc.) are
        // normal request outcomes, not incidents — log at a lower level so
        // they don't drown out real problems in production log monitoring.
        log.debug(meta, `tRPC ${error.code} on ${path ?? "unknown procedure"}`);
      }
    },
  }),
);

// Health check — used by load balancer and k8s readiness probe
app.get("/health", async (c) => {
  return c.json({
    status: "ok",
    version: process.env.npm_package_version ?? "1.0.0",
    ts: Date.now(),
  });
});

// ─── 4. Startup Sequence ──────────────────────────────────────────────────────

async function main() {
  // DB
  await connectDB();

  // Redis
  try {
    await connectRedis();
    log.info("Redis connected");
  } catch (err) {
    log.warn({ err }, "Redis unavailable — WS fan-out disabled, rate limiting degraded");
  }

  // HTTP + WS Server
  const port = parseInt(process.env.API_PORT ?? "3001", 10);

  const server = serve({ fetch: app.fetch, port }, (info) => {
    log.info(`API server listening on port ${info.port}`);
  }) as unknown as HttpServer;

  // WebSocket gateway attaches to the same HTTP server (no separate port)
  initWebSocketGateway(server);
  log.info("WebSocket gateway initialized");

  // Bot runtime manager — restores bots that were online before restart
  try {
    await initBotRuntimeManager();
    log.info("Bot runtime manager initialized");
  } catch (err) {
    log.error({ err }, "Bot runtime manager failed to initialize");
  }

  // Job queues are initialised by apps/worker — the API only enqueues.
  // See apps/worker/src/queues/jobQueues.ts for the worker-side init.

  // Graceful shutdown — drain in-flight requests, then close all connections.
  // Order matters: stop accepting → drain requests → close queues → close Redis → close DB pool.
  // Without this, K8s/Docker sends SIGTERM then kills after 30s anyway, but connections
  // don't drain cleanly and Postgres sees abrupt disconnects (warning logs, possible corruption).
  const shutdown = async (signal: string) => {
    log.info(`${signal} received — starting graceful shutdown`);

    // 1. Stop accepting new HTTP connections
    server.close(() => {
      log.info("HTTP server closed — no new connections accepted");
    });

    // 2. Give in-flight requests up to 10s to complete
    const drainTimeout = setTimeout(() => {
      log.warn("Drain timeout reached — forcing shutdown");
    }, 10_000);

    try {
      // 3. Close all three Redis clients (main + publisher + subscriber)
      const { getRedis, getRedisPublisher, getRedisSubscriber } = await import("./utils/redis.js");
      await Promise.allSettled([
        getRedis()?.quit(),
        getRedisPublisher()?.quit(),
        getRedisSubscriber()?.quit(),
      ]);
      log.info("Redis connections closed");

      // 4. Drain Postgres pool
      const { getPool } = await import("./db/client.js");
      await getPool().end();
      log.info("Postgres pool closed");

    } catch (err) {
      log.error({ err }, "Error during graceful shutdown cleanup");
    } finally {
      clearTimeout(drainTimeout);
      log.info("Shutdown complete");
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT",  () => void shutdown("SIGINT"));
}

main().catch((err) => {
  log.fatal({ err }, "Boot failed");
  process.exit(1);
});
