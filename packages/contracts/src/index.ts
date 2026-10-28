/**
 * @kojyai/contracts — Public API Contract Types
 *
 * OWNERSHIP: packages/contracts
 * PURPOSE:
 *   This package is the stable boundary between the API and any consumer
 *   (web frontend, test suites, external integrations).
 *
 *   The web app imports AppRouter from HERE — not from apps/api/src.
 *   This means the API's internal folder structure can change freely
 *   without breaking the frontend build, as long as this package
 *   continues to export the same type surface.
 *
 * RUNTIME FOOTPRINT: zero.
 *   All exports are `type` — TypeScript erases them at compile time.
 *   Nothing from this package ever lands in the browser bundle.
 *
 * VERSIONING:
 *   When the AppRouter shape changes in a breaking way, bump the version
 *   of this package. Consumers get a clear signal to update their usage.
 *
 * HOW TO ADD A NEW EXPORT:
 *   1. Define or import the type in apps/api (or packages/shared)
 *   2. Re-export it here as a type-only export
 *   3. Consumers import from "@kojyai/contracts"
 */

// ─── tRPC App Router type ─────────────────────────────────────────────────────
// Re-exported from the API router. Type-only — zero bundle impact.
// FIX-4: path corrected — packages/contracts/src → apps/api/src requires ../../../
export type { AppRouter } from "../../../apps/api/src/router.js";

// ─── Shared platform types (convenience re-exports) ──────────────────────────
// Consumers can import commonly paired types from one place.
export type {
  Bot,
  BotStatus,
  BotHealthScore,
  BotStats,
  UserRole,
  UserTier,
  SimulationStatus,
  Simulation,
  Notification,
  NotificationType,
} from "@kojyai/shared/types";

export type {
  ServerEvent,
  ClientEvent,
  SimAgentState,
  SimTickEvent,
} from "@kojyai/shared/events";
