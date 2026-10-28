/**
 * Vitest Config — Integration Tests
 * Fixes: 14 (shutdown hooks), 23 (globs), 24 (resolve.alias), 31 (skipIf infrastructure)
 */
import { defineConfig } from "vitest/config";
import path             from "path";

const REDIS_AVAILABLE = !!process.env.REDIS_URL;
const DB_AVAILABLE    = !!process.env.DATABASE_URL;

export default defineConfig({
  // Fix 24
  resolve: {
    alias: {
      "@kojyai/shared":   path.resolve("packages/shared/src"),
      "@kojyai/engine":   path.resolve("packages/engine/src"),
      "@kojyai/security": path.resolve("packages/security/src"),
    },
  },

  test: {
    globals:     true,
    environment: "node",

    // Fix 23 — exact integration glob
    include: ["tests/integration/**/*.test.ts"],
    exclude: ["tests/unit/**", "tests/e2e/**", "node_modules/**"],

    // Fix 8 — sequential so each test suite owns the DB cleanly
    pool:        "forks",
    poolOptions: { forks: { singleFork: true } },

    testTimeout:  45_000,
    hookTimeout:  30_000,
    clearMocks:   true,
    restoreMocks: true,

    // Fix 31 — infrastructure availability exported so tests can skipIf
    provide: {
      REDIS_AVAILABLE,
      DB_AVAILABLE,
    },

    env: {
      NODE_ENV:       "test",
      DATABASE_URL:   process.env.DATABASE_URL   ?? "",
      REDIS_URL:      process.env.REDIS_URL       ?? "",
      // Secrets must come from environment — never hardcoded here.
      // For local integration test runs, copy .env.example to .env.test and fill in.
      JWT_SECRET:     process.env.JWT_SECRET      ?? "",
      ENCRYPTION_KEY: process.env.ENCRYPTION_KEY  ?? "",
      GROQ_API_KEY:   process.env.GROQ_API_KEY    ?? "",
    },
  },
});
