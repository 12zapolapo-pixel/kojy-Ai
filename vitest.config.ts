import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@kojyai/shared":    path.resolve("packages/shared/src"),
      "@kojyai/engine":    path.resolve("packages/engine/src"),
      "@kojyai/security":  path.resolve("packages/security/src"),
      "@kojyai/billing":   path.resolve("packages/billing/src"),
      "@kojyai/analytics": path.resolve("packages/analytics/src"),
    },
  },
  test: {
    globals:     true,
    environment: "node",
    include: [
      "tests/unit/**/*.test.ts",
      "tests/chaos/**/*.test.ts",
      "tests/invariants/**/*.test.ts",
      "tests/observability/**/*.test.ts",
      "tests/security/**/*.test.ts",
      "tests/resource-leaks/**/*.test.ts",
      "tests/migration/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
    ],
    exclude: [
      "tests/integration/**",
      "tests/e2e/**",
      "node_modules/**",
      "dist/**",
    ],
    coverage: {
      provider:  "v8",
      reporter:  ["text","json","lcov","html"],
      include:   ["packages/*/src/**/*.ts","apps/api/src/**/*.ts"],
      exclude:   ["**/*.test.ts","**/node_modules/**","**/dist/**","**/*.d.ts"],
      thresholds:{ lines:75, functions:70, branches:65, statements:75 },
    },
    testTimeout:  15_000,
    hookTimeout:  10_000,
    clearMocks:   true,
    restoreMocks: true,
    mockReset:    true,
  },
});
