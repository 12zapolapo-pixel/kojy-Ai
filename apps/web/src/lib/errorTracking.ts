/**
 * Error tracking in the browser (Sentry) — on only when the server has a DSN
 * (SENTRY_DSN_WEB or SENTRY_DSN, read from /api/client-config). The SDK is
 * downloaded only then, so the site pays nothing for it otherwise. No
 * personal data, cookies or headers, and query strings (which can carry
 * tokens) are cut from URLs.
 * OWNERSHIP: apps/web/src/lib
 */

import type * as SentryBrowser from "@sentry/browser";

let sentry: typeof SentryBrowser | null = null;

const withoutQuery = (url: string) => url.split(/[?#]/)[0] ?? url;

export async function startErrorTracking(): Promise<void> {
  try {
    const res = await fetch("/api/client-config", { credentials: "omit" });
    if (!res.ok) return;
    const { sentryDsn } = (await res.json()) as { sentryDsn?: string | null };
    if (!sentryDsn) return;
    const Sentry = await import("@sentry/browser");
    Sentry.init({
      dsn: sentryDsn,
      environment: import.meta.env.MODE,
      // No user details, cookies, headers, bodies or query strings.
      dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
      tracesSampleRate: 0,
      beforeSend(event) {
        if (event.request) {
          delete event.request.cookies;
          delete event.request.headers;
          if (event.request.url) event.request.url = withoutQuery(event.request.url);
        }
        return event;
      },
      beforeBreadcrumb(crumb) {
        const data = crumb.data as { url?: unknown; from?: unknown; to?: unknown } | undefined;
        if (data) for (const k of ["url", "from", "to"] as const) if (typeof data[k] === "string") data[k] = withoutQuery(data[k]);
        return crumb;
      },
    });
    sentry = Sentry;
  } catch {
    /* error tracking must never break the site */
  }
}

/** For the React error boundary: a render error with the component stack. */
export function reportUiError(error: unknown, componentStack?: string | null): void {
  sentry?.captureException(error, componentStack ? { extra: { componentStack } } : undefined);
}
