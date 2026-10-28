/**
 * KojyAI — Root ESLint Flat Config (eslint.config.js)
 *
 * Applies to the entire monorepo. Each app/package can override
 * specific rules in their own eslint.config.js (they inherit this base).
 *
 * USAGE:
 *   pnpm lint             # lint everything from root
 *   pnpm lint:fix         # auto-fix everything
 *
 * RULE PHILOSOPHY:
 *   - Errors: things that cause bugs or security issues at runtime
 *   - Warnings: style/maintainability issues, not build-blockers
 *   - Off: rules that conflict with our toolchain (Prettier, TypeScript)
 */

import js              from "@eslint/js";
import tseslint        from "typescript-eslint";
import reactPlugin     from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import importPlugin    from "eslint-plugin-import";

export default tseslint.config(
  // ── Ignored paths ──────────────────────────────────────────────────────────
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.turbo/**",
      "**/coverage/**",
      "infrastructure/migrations/**",
    ],
  },

  // ── Base JS rules (all files) ──────────────────────────────────────────────
  js.configs.recommended,

  // ── TypeScript rules (all .ts/.tsx files) ─────────────────────────────────
  ...tseslint.configs.recommendedTypeChecked,
  {
    files:          ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService:         true,
        tsconfigRootDir:        import.meta.dirname,
        warnOnUnsupportedTypeScriptVersion: false,
      },
    },
    plugins: {
      import: importPlugin,
    },
    rules: {
      // ── TypeScript ─────────────────────────────────────────────────────────
      "@typescript-eslint/no-explicit-any":          "warn",
      "@typescript-eslint/no-unused-vars":           ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-floating-promises":     "error",   // unhandled async = bugs
      "@typescript-eslint/await-thenable":           "error",
      "@typescript-eslint/no-misused-promises":      "error",
      "@typescript-eslint/require-await":            "warn",
      "@typescript-eslint/prefer-nullish-coalescing": "warn",
      "@typescript-eslint/no-non-null-assertion":    "warn",
      "@typescript-eslint/consistent-type-imports":  ["error", { prefer: "type-imports" }],

      // ── Security-relevant ──────────────────────────────────────────────────
      "no-eval":                   "error",
      "no-implied-eval":           "error",
      "no-new-func":               "error",
      "no-script-url":             "error",

      // ── Imports ────────────────────────────────────────────────────────────
      "import/no-cycle":           "error",     // circular deps cause runtime failures
      "import/no-self-import":     "error",
      "import/no-duplicates":      "warn",

      // ── General ────────────────────────────────────────────────────────────
      "no-console":                ["warn", { allow: ["warn", "error"] }],
      "prefer-const":              "error",
      "no-var":                    "error",
      "eqeqeq":                    ["error", "always", { null: "ignore" }],
      "no-throw-literal":          "error",

      // ── Off — handled by Prettier / TypeScript compiler ───────────────────
      "indent":                    "off",
      "quotes":                    "off",
      "semi":                      "off",
      "@typescript-eslint/indent": "off",
    },
  },

  // ── React rules (web app only) ─────────────────────────────────────────────
  {
    files: ["apps/web/**/*.tsx", "apps/web/**/*.ts"],
    plugins: {
      react:        reactPlugin,
      "react-hooks": reactHooksPlugin,
    },
    settings: {
      react: { version: "detect" },
    },
    rules: {
      "react/react-in-jsx-scope":         "off",   // not needed in React 17+
      "react/prop-types":                 "off",   // we use TypeScript for props
      "react/display-name":               "warn",
      "react/no-unescaped-entities":      "error",
      "react-hooks/rules-of-hooks":       "error",
      "react-hooks/exhaustive-deps":      "warn",
    },
  },

  // ── Test files — relaxed rules ─────────────────────────────────────────────
  {
    files: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.spec.ts",
      "tests/**/*.ts",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-console":                         "off",
      "@typescript-eslint/require-await":   "off",
    },
  },
);
