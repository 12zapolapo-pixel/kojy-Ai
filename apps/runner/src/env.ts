/**
 * Environment loader — MUST be the first import of boot.ts.
 * See apps/api/src/env.ts for the full explanation: ES imports are evaluated
 * before the importing module's body, so calling dotenv's config() inside
 * boot.ts ran AFTER every imported module (db client, Redis, queues, logger)
 * had already read process.env. Importing this first fixes the ordering.
 */
import { config } from "dotenv";

config();

// A blank setting (`GROQ_MODEL=` in .env, or Docker passing an empty value)
// means "not set". Without this, `process.env.X ?? default` keeps the empty
// string and features silently break, e.g. an AI request with model "".
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && value.trim() === "") delete process.env[key];
}
