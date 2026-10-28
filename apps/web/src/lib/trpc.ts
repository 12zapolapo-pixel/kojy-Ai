/**
 * tRPC Client — Frontend
 * OWNERSHIP: apps/web/src/lib
 *
 * AppRouter is imported as a TYPE-ONLY import from @kojyai/contracts.
 * That package owns the stable boundary between the API and any consumer.
 *
 * Why @kojyai/contracts and not apps/api/src directly?
 *   The contracts package is a clean workspace package with its own
 *   versioned public surface. The API's internal folder structure can
 *   change freely without breaking this file. Type-only imports are
 *   erased at compile time and never appear in the browser bundle.
 *
 * To update the router shape:
 *   1. Change apps/api/src/router.ts
 *   2. packages/contracts re-exports it automatically
 *   3. Frontend picks up the new types on next typecheck
 */

import { createTRPCReact } from "@trpc/react-query";
import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { AppRouter }  from "@kojyai/contracts";
import { useAuthStore } from "../state/authStore";

export const trpc = createTRPCReact<AppRouter>();
export type { AppRouter };

/**
 * What each procedure really returns/accepts, inferred from the API router.
 * Prefer these over hand-written shapes: superjson keeps Dates as Dates and
 * database ids are numbers, which hand-written "id: string" types got wrong.
 */
export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type RouterInputs  = inferRouterInputs<AppRouter>;

// ─── Vanilla client ────────────────────────────────────────────────────────
//
// Every feature page calls `trpc.X.Y.query(...)` / `trpc.X.Y.mutate(...)`
// directly inside @tanstack/react-query's queryFn/mutationFn. The React proxy
// from createTRPCReact() does NOT support `.query()`/`.mutate()` — only
// `.useQuery()`/`.useMutation()` hooks — so those calls throw at runtime
// ("hooks[lastArg] is not a function"), breaking every data call in the app.
//
// trpcClient is a plain callable client — built via trpc.createClient(), the
// same typed factory used for the trpc.Provider client in App.tsx, with an
// identical link config — exposing the `.query()`/`.mutate()` shape those
// call sites expect.
export const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      transformer: superjson,
      url: `${import.meta.env.VITE_API_URL ?? "/api"}/trpc`,
      headers: () => {
        const token = useAuthStore.getState().token;
        return token ? { Authorization: `Bearer ${token}` } : {};
      },
      fetch: (url, init) => {
        const { signal, ...rest } = (init ?? {}) as RequestInit;
        return fetch(url, { ...rest, ...(signal ? { signal } : {}), credentials: "include" });
      },
    }),
  ],
});
