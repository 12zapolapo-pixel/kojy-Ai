/**
 * @kojyai/ui — Cosmic Design System
 *
 * Single entry point. Import anything from "@kojyai/ui".
 *
 * Subpath imports also work:
 *   import { colors, glows } from "@kojyai/ui/theme"
 *   import { Button }        from "@kojyai/ui/primitives"
 *   import { Modal }         from "@kojyai/ui/components"
 *   import { useDebounce }   from "@kojyai/ui/hooks"
 *   import { transition }    from "@kojyai/ui/motion"
 */

// ── Tokens / Theme ────────────────────────────────────────────────────────────
export * from "./theme/index.js";

// ── Primitives ────────────────────────────────────────────────────────────────
export * from "./primitives/index.js";

// ── Components ────────────────────────────────────────────────────────────────
export * from "./components/index.js";

// ── Hooks ─────────────────────────────────────────────────────────────────────
export * from "./hooks/index.js";

// ── Motion ────────────────────────────────────────────────────────────────────
export * from "./motion/index.js";
