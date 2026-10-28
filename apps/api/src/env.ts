/**
 * Environment loader — MUST be the first import of boot.ts.
 * OWNERSHIP: apps/api/src
 *
 * RELIABILITY/SECURITY FIX: ES module imports are hoisted and evaluated BEFORE
 * the importing module's own body runs. boot.ts used to call dotenv's config()
 * in its body, i.e. AFTER every imported module had already been evaluated — so
 * any module-level `process.env.X` read (the Stripe client in billing/, the
 * WebSocket origin allowlist in websocket/gateway.ts built from FRONTEND_URL,
 * the logger's dev/prod switch, SQLITE_DIR) silently saw the values from the
 * real process environment only, and ignored a .env file. In production that
 * meant a .env-configured FRONTEND_URL left the WS origin check on its
 * localhost default, and a .env-configured STRIPE_SECRET_KEY left billing
 * disabled. Importing this module first guarantees .env is loaded before any
 * other module is evaluated. (Real environment variables still win; dotenv
 * never overrides an already-set variable.)
 */
import { config } from "dotenv";

config();

// A blank setting (`GROQ_MODEL=` in .env, or Docker passing an empty value)
// means "not set". Without this, `process.env.X ?? default` keeps the empty
// string and features silently break, e.g. an AI request with model "".
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && value.trim() === "") delete process.env[key];
}
