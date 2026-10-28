/**
 * KOJYAI tRPC App Router
 *
 * OWNERSHIP: apps/api/src
 * LAYER: API — type-safe procedure registry
 *
 * DESIGN:
 * - Root router merges all module routers
 * - Each module is independently defined and typed
 * - Frontend imports AppRouter type only — no runtime coupling
 * - Procedures split into: query (reads), mutation (writes), subscription (WS)
 *
 * ADDING A NEW MODULE:
 * 1. Create /src/modules/{name}/router.ts
 * 2. Import and merge here
 * 3. Frontend immediately gets full type safety
 *
 * SECURITY:
 * - Public procedures: no auth required (login, health)
 * - Protected procedures: JWT required (injected via middleware)
 * - Admin procedures: role check in middleware
 */

import { router } from "./trpc.js";
import { authRouter }         from "./modules/auth/router.js";
import { botsRouter }         from "./modules/bots/router.js";
import { roomsRouter }        from "./modules/rooms/router.js";
import { simulationsRouter }  from "./modules/simulation/router.js";
import { analyticsRouter }    from "./modules/analytics/router.js";
import { intelligenceRouter } from "./modules/intelligence/router.js";
import { notificationsRouter } from "./modules/notifications/router.js";
import { auditRouter }        from "./modules/audit/router.js";
import { billingRouter }      from "./modules/billing/router.js";
import { marketplaceRouter }  from "./modules/marketplace/router.js";
import { securityRouter }     from "./modules/security/router.js";
import { adminRouter }        from "./modules/admin/router.js";
import { delegationRouter }   from "./modules/delegation/router.js";
import { composerRouter }     from "./modules/composer/router.js";
import { gdprRouter }         from "./modules/gdpr/router.js";
import { projectsRouter }     from "./modules/projects/router.js";
import { systemRouter }       from "./modules/system/router.js";
import { studioRouter }       from "./modules/studio/router.js";

export const appRouter = router({
  auth:         authRouter,
  bots:         botsRouter,
  projects:     projectsRouter,
  system:       systemRouter,
  studio:       studioRouter,
  rooms:        roomsRouter,
  simulations:  simulationsRouter,
  analytics:    analyticsRouter,
  intelligence: intelligenceRouter,
  notifications: notificationsRouter,
  audit:        auditRouter,
  billing:      billingRouter,
  marketplace:  marketplaceRouter,
  security:     securityRouter,
  admin:        adminRouter,
  delegation:   delegationRouter,
  composer:     composerRouter,
  gdpr:         gdprRouter,
});

/** Exported type — imported by frontend lib/trpc.ts */
export type AppRouter = typeof appRouter;
