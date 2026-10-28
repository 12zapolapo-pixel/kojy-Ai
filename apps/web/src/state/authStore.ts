/**
 * Auth Store — Zustand
 *
 * OWNERSHIP: apps/web/src/state
 * LAYER: Frontend — authentication and session management
 *
 * DESIGN:
 * - Token stored in memory (primary) + sessionStorage (tab persistence)
 * - FIX-AUDIT: corrected claim — sessionStorage does NOT prevent XSS-based
 *   token theft. It is exactly as readable by injected/malicious JS as
 *   localStorage; any script running on this origin can read either one.
 *   The real difference is persistence scope only: sessionStorage clears on
 *   tab close and isn't shared across tabs, which reduces a stolen token's
 *   useful lifetime and blast radius — a real but secondary benefit, not XSS
 *   protection. The genuine defense against XSS-based theft is the separate
 *   HttpOnly cookie below, which JS cannot read at all regardless of XSS.
 *   This sessionStorage-held token exists because the WebSocket gateway
 *   (apps/api/src/websocket/gateway.ts) requires an explicit auth message
 *   with a token after connecting — it doesn't read the HttpOnly cookie
 *   during the WS handshake — so a JS-readable token is a genuine
 *   requirement here, not an oversight. If this app is ever XSS'd, this
 *   token is exposed; that risk is inherent to the current WS auth design,
 *   not something this storage choice can fix.
 * - On app boot: check sessionStorage → validate with trpc.auth.me
 * - On login: server sets HttpOnly cookie + returns token for WS auth
 *
 * FIX: Previously used raw fetch() against tRPC endpoint — bypassed type safety,
 *      superjson transformer, and error middleware. Now uses a lightweight typed
 *      client that respects the tRPC protocol correctly.
 */

import { create } from "zustand";
import { immer }  from "zustand/middleware/immer";
import superjson  from "superjson";
import type { UserRole, UserTier } from "@kojyai/shared/types";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id:          string;
  email:       string;
  username:    string;
  displayName: string | null;
  avatarUrl:   string | null;
  role:        UserRole;
  tier:        UserTier;
  locale:      string;
  timezone:    string;
}

interface AuthStore {
  user:            AuthUser | null;
  token:           string | null;
  isAuthenticated: boolean;
  isLoading:       boolean;
  error:           string | null;

  initialize:  () => Promise<void>;
  setSession:  (token: string, user: AuthUser) => void;
  setUser:     (user: AuthUser) => void;
  logout:      () => Promise<void>;
  clearError:  () => void;
}

const SESSION_KEY = "kojyai_session_token";

// ─── Typed tRPC-compatible fetcher ────────────────────────────────────────────
// Uses the correct tRPC v11 GET query format and handles superjson-wrapped responses.

async function trpcGet<T>(
  procedure: string,
  token: string | null,
): Promise<T | null> {
  const url    = `/api/trpc/${procedure}?input={}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(url, { method: "GET", credentials: "include", headers });
  if (!res.ok) return null;

  // FIX-AUDIT: confirmed empirically against a real tRPC v11 + superjson
  // server that the wire format is result.data.json (superjson always wraps
  // in {json, meta}, even when meta is empty) — NOT result.data directly.
  // The old code returned the raw {json: {...}, meta} envelope as if it were
  // T itself, so every field on the returned object was undefined for any
  // caller (this function's only caller is auth.me in initialize() below —
  // every page load/refresh that restored a session from sessionStorage got
  // a "user" whose email/username/role/tier/etc. were all undefined, while
  // isAuthenticated still correctly showed true). superjson.deserialize()
  // (rather than a plain `.json` property access) also correctly handles any
  // future field needing real deserialization — Date, Map, Set, etc. — not
  // just today's all-string/null AuthUser shape.
  const json = await res.json() as { result?: { data?: unknown } };
  if (json?.result?.data === undefined) return null;
  return superjson.deserialize(json.result.data as any) as T;
}

async function trpcPost(
  procedure: string,
  token: string | null,
  body: object = {},
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  await fetch(`/api/trpc/${procedure}`, {
    method: "POST", credentials: "include", headers,
    body: JSON.stringify({ json: body }),
  });
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useAuthStore = create<AuthStore>()(
  immer((set, get) => ({
    user:            null,
    token:           null,
    isAuthenticated: false,
    isLoading:       true,
    error:           null,

    initialize: async () => {
      set((s) => { s.isLoading = true; });

      try {
        const storedToken = sessionStorage.getItem(SESSION_KEY);
        const user = await trpcGet<AuthUser>("auth.me", storedToken);

        if (user) {
          set((s) => {
            s.user            = user;
            s.token           = storedToken;
            s.isAuthenticated = true;
            s.isLoading       = false;
            s.error           = null;
          });
        } else {
          sessionStorage.removeItem(SESSION_KEY);
          set((s) => { s.user = null; s.token = null; s.isAuthenticated = false; s.isLoading = false; });
        }
      } catch {
        // Network error — don't clear session, let user retry
        set((s) => {
          s.isLoading = false;
          s.error     = "Connection error — check your internet and refresh.";
        });
      }
    },

    setSession: (token, user) => {
      sessionStorage.setItem(SESSION_KEY, token);
      set((s) => { s.token = token; s.user = user; s.isAuthenticated = true; s.error = null; });
    },

    setUser: (user) => set((s) => { s.user = user; }),

    logout: async () => {
      try {
        await trpcPost("auth.logout", get().token);
      } catch {
        // Clear local state regardless of network error
      } finally {
        sessionStorage.removeItem(SESSION_KEY);
        set((s) => { s.user = null; s.token = null; s.isAuthenticated = false; });
        window.location.href = "/login";
      }
    },

    clearError: () => set((s) => { s.error = null; }),
  })),
);

export function initializeAuth(): void {
  void useAuthStore.getState().initialize();
}
