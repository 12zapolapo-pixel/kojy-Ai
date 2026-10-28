import type { Config } from "drizzle-kit";

// `generate` only diffs the schema against migrations/, so it needs no
// database; `migrate` and `studio` read DATABASE_URL.
export default {
  schema:  "./src/schema.ts",
  out:     "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/kojyai",
  },
  verbose: true,
  strict:  true,
} satisfies Config;
