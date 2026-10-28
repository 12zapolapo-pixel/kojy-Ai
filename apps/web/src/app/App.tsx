/**
 * KOJYAI Web App — Root Component
 *
 * OWNERSHIP: apps/web/src/app
 * LAYER: Frontend — application entry and provider hierarchy
 *
 * PROVIDER ORDER (outermost → innermost):
 * 1. QueryClientProvider — tRPC/React Query cache
 * 2. BrowserRouter — routing context
 * 3. ThemeProvider — design system tokens
 * 4. AuthProvider — session state + auth guard
 * 5. WsProvider — WebSocket connection lifecycle
 * 6. CommandPaletteProvider — global keyboard shortcut listener
 * 7. Routes — lazy-loaded feature pages
 *
 * ROUTE STRATEGY:
 * - All routes except login are wrapped in AuthGuard
 * - Every feature page is lazy-loaded (React.lazy + Suspense)
 * - Route-level error boundaries catch feature-level failures
 * - 404 handler for unknown routes
 *
 * BUNDLE STRATEGY:
 * - login: eagerly loaded (used immediately)
 * - All other features: lazy (split at route boundary)
 * - packages/ui primitives: eagerly loaded (shared)
 * - Three.js (NeuralMap, SimScene): dynamically imported inside their components
 */

import { Suspense, lazy, useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate, Outlet, useParams } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { trpc } from "../lib/trpc";
import { useWsStore } from "../state/wsStore";
import { useAuthStore } from "../state/authStore";
import { AppShell } from "../layouts/AppShell";
import { PageLoader }     from "../components/PageLoader";
import { ErrorBoundary }  from "../components/ErrorBoundary";
import { ToastProvider }  from "@kojyai/ui";
import LoginPage from "../features/auth/LoginPage";

// ─── Lazy-loaded routes ───────────────────────────────────────────────────────

const BotsPage          = lazy(() => import("../features/bots/BotsPage"));
const BotDetailPage     = lazy(() => import("../features/bots/BotDetailPage"));
const StudioPage        = lazy(() => import("../features/studio/StudioPage"));
const IntelligencePage  = lazy(() => import("../features/intelligence/IntelligencePage"));
const AnalyticsPage     = lazy(() => import("../features/analytics/AnalyticsPage"));
const MarketplacePage   = lazy(() => import("../features/marketplace/MarketplacePage"));
const InfraPage         = lazy(() => import("../features/infrastructure/InfraPage"));
const SecurityPage      = lazy(() => import("../features/security/SecurityPage"));
const SettingsPage      = lazy(() => import("../features/settings/SettingsPage"));
const OnboardingPage    = lazy(() => import("../features/onboarding/OnboardingPage"));
const AdminPage         = lazy(() => import("../features/admin/AdminPage"));
// The Bot Composer — the primary product surface. All other nav items orbit this.

// ─── tRPC + React Query ───────────────────────────────────────────────────────

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime:          30_000,
      gcTime:             5 * 60_000,
      retry:              (count, err: any) => count < 2 && err?.data?.code !== "UNAUTHORIZED",
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});

const trpcClient = trpc.createClient({
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

// ─── Root Component ───────────────────────────────────────────────────────────

export default function App() {
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <WsBootstrap />
          <ToastProvider />
          <Routes>
            {/* Public routes */}
            <Route path="/login"      element={<LoginPage />} />
            <Route path="/auth/reset-password" element={<LoginPage />} />
            <Route path="/onboarding" element={<AuthGuard><OnboardingPage /></AuthGuard>} />

            {/* Protected app routes — all wrapped in AppShell */}
            <Route
              path="/"
              element={
                <AuthGuard>
                  <AppShell>
                    <Outlet />
                  </AppShell>
                </AuthGuard>
              }
            >
              <Route index element={<Navigate to="/studio" replace />} />


              <Route path="bots">
                <Route
                  index
                  element={
                    <RouteWrapper>
                      <BotsPage />
                    </RouteWrapper>
                  }
                />
                <Route
                  path=":id"
                  element={
                    <RouteWrapper>
                      <BotDetailPage />
                    </RouteWrapper>
                  }
                />
                <Route path="new" element={<Navigate to="/bots?new=true" replace />} />
              </Route>

              <Route path="studio">
                <Route index element={<RouteWrapper><StudioPage /></RouteWrapper>} />
                <Route path=":kind" element={<RouteWrapper><StudioPage /></RouteWrapper>} />
                <Route path=":kind/:id" element={<RouteWrapper><StudioPage /></RouteWrapper>} />
              </Route>
              {/* Old Python Bots addresses now open in the Studio. */}
              {/* Pages the Studio replaced: old links land in the right place. */}
              <Route path="composer/*" element={<Navigate to="/studio/new" replace />} />
              <Route path="delegation" element={<Navigate to="/studio" replace />} />
              <Route path="mission-control" element={<Navigate to="/studio" replace />} />
              <Route path="simulation/*" element={<Navigate to="/studio" replace />} />
              <Route path="projects" element={<Navigate to="/studio" replace />} />
              <Route path="projects/:id" element={<ProjectRedirect />} />

              <Route
                path="intelligence"
                element={
                  <RouteWrapper>
                    <IntelligencePage />
                  </RouteWrapper>
                }
              />

              <Route
                path="analytics"
                element={
                  <RouteWrapper>
                    <AnalyticsPage />
                  </RouteWrapper>
                }
              />

              <Route
                path="marketplace"
                element={
                  <RouteWrapper>
                    <MarketplacePage />
                  </RouteWrapper>
                }
              />

              <Route
                path="infrastructure"
                element={
                  <RouteWrapper>
                    <InfraPage />
                  </RouteWrapper>
                }
              />

              <Route
                path="security"
                element={
                  <RouteWrapper>
                    <SecurityPage />
                  </RouteWrapper>
                }
              />

              <Route
                path="settings"
                element={
                  <RouteWrapper>
                    <SettingsPage />
                  </RouteWrapper>
                }
              />

              {/* Admin — superadmin only */}
              <Route
                path="admin"
                element={
                  <RouteWrapper>
                    <AdminPage />
                  </RouteWrapper>
                }
              />

              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

// ─── Auth Guard ───────────────────────────────────────────────────────────────

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuthStore();

  if (isLoading) return <PageLoader message="Authenticating…" />;
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

// ─── WS Bootstrap ────────────────────────────────────────────────────────────
// Initializes WS connection once after auth — not inside AuthGuard
// so the connection is established once, not per-route-change

function WsBootstrap() {
  const { isAuthenticated } = useAuthStore();
  const { connect, disconnect } = useWsStore();

  useEffect(() => {
    if (isAuthenticated) {
      connect();
    } else {
      disconnect();
    }
    return () => {
      // Don't disconnect on unmount (SPA — component never truly unmounts)
    };
  }, [isAuthenticated, connect, disconnect]);

  return null;
}

// ─── Route Wrapper ────────────────────────────────────────────────────────────

function RouteWrapper({ children }: { children: React.ReactNode }) {
  return (
    <ErrorBoundary>
      <Suspense fallback={<PageLoader />}>
        {children}
      </Suspense>
    </ErrorBoundary>
  );
}

// ─── 404 ─────────────────────────────────────────────────────────────────────

function NotFound() {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center space-y-4">
        <p className="text-6xl font-mono text-white/10">404</p>
        <p className="text-white/40">Page not found</p>
        <a href="/studio" className="text-[#49dcb5] text-sm hover:underline">
          Back to Mission Control
        </a>
      </div>
    </div>
  );
}

function ProjectRedirect() {
  const { id } = useParams();
  return <Navigate to={`/studio/p/${id}`} replace />;
}
