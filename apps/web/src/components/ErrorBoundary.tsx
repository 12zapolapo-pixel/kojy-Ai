/**
 * ErrorBoundary — React class component
 * OWNERSHIP: apps/web/src/components
 *
 * Extracted from PageLoader.tsx so App.tsx can import it correctly.
 * Catches unhandled render errors in child trees and shows a recovery UI.
 *
 * Usage:
 *   <ErrorBoundary>
 *     <SomePage />
 *   </ErrorBoundary>
 *
 *   <ErrorBoundary fallback={<CustomFallback />}>
 *     <SomePage />
 *   </ErrorBoundary>
 */

import { Component, type ReactNode, type ErrorInfo } from "react";
import { reportUiError } from "../lib/errorTracking";

interface ErrorBoundaryProps {
  children:  ReactNode;
  fallback?: ReactNode;
  onError?:  (error: Error, errorInfo: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError:  boolean;
  error:     Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[ErrorBoundary]", error, errorInfo);
    reportUiError(error, errorInfo.componentStack);
    this.props.onError?.(error, errorInfo);
    this.setState({ errorInfo });
  }

  private reset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    if (this.props.fallback) return this.props.fallback;

    return (
      <div className="h-full w-full flex items-center justify-center p-8">
        <div className="max-w-md w-full bg-white border border-red-500/20 rounded-2xl p-6 space-y-4">
          <div className="flex items-center gap-3">
            <span className="text-red-700 text-xl">⚠</span>
            <h2 className="text-sm font-semibold text-ink">Something went wrong</h2>
          </div>

          <p className="text-xs text-ink-3 font-mono bg-ink/[0.04] rounded-lg p-3 overflow-auto max-h-32 whitespace-pre-wrap">
            {this.state.error?.message ?? "Unknown error"}
          </p>

          {process.env.NODE_ENV === "development" && this.state.errorInfo && (
            <details className="text-xs text-ink-3 font-mono">
              <summary className="cursor-pointer text-ink-3 mb-1">Stack trace</summary>
              <pre className="overflow-auto max-h-40 bg-ink/[0.04] rounded p-2 text-[10px]">
                {this.state.errorInfo.componentStack}
              </pre>
            </details>
          )}

          <div className="flex gap-3">
            <button
              onClick={this.reset}
              className="px-4 py-2 bg-co/10 border border-co/30 text-co-ink rounded-lg text-xs font-medium hover:bg-co/20 transition-colors"
            >
              Try Again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-ink/[0.04] border border-line text-ink-3 rounded-lg text-xs font-medium hover:bg-ink/[0.06] transition-colors"
            >
              Reload Page
            </button>
          </div>
        </div>
      </div>
    );
  }
}
