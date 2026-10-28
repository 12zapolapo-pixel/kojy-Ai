/**
 * PageLoader + ErrorBoundary
 * OWNERSHIP: apps/web/src/components
 */

import { Component, type ReactNode, type ErrorInfo } from "react";

// ─── Page Loader ──────────────────────────────────────────────────────────────

export function PageLoader({ message }: { message?: string }) {
  return (
    <div className="h-full w-full flex flex-col items-center justify-center gap-4 bg-[#030712]">
      {/* Animated cosmic spinner */}
      <div className="relative w-10 h-10">
        <div className="absolute inset-0 rounded-full border-2 border-white/5" />
        <div className="absolute inset-0 rounded-full border-2 border-t-[#49dcb5] border-r-transparent border-b-transparent border-l-transparent animate-spin" />
        <div className="absolute inset-1 rounded-full border border-t-transparent border-r-transparent border-b-[#8b5cf6]/40 border-l-transparent animate-spin [animation-duration:1.5s] [animation-direction:reverse]" />
      </div>
      {message && (
        <p className="text-xs text-white/30 font-mono animate-pulse">{message}</p>
      )}
    </div>
  );
}

// ─── Error Boundary ───────────────────────────────────────────────────────────

interface ErrorBoundaryState {
  hasError: boolean;
  error:    Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  ErrorBoundaryState
> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[ErrorBoundary]", error, errorInfo);
    this.setState({ errorInfo });
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="h-full w-full flex items-center justify-center p-8">
          <div className="max-w-md w-full bg-[#0b1220] border border-red-500/20 rounded-2xl p-6 space-y-4">
            <div className="flex items-center gap-3">
              <span className="text-red-400 text-xl">⚠</span>
              <h2 className="text-sm font-semibold text-white/80">Something went wrong</h2>
            </div>
            <p className="text-xs text-white/40 font-mono bg-black/30 rounded-lg p-3 overflow-auto max-h-32">
              {this.state.error?.message ?? "Unknown error"}
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => this.setState({ hasError: false, error: null, errorInfo: null })}
                className="px-4 py-2 bg-[#49dcb5]/10 border border-[#49dcb5]/30 text-[#49dcb5] rounded-lg text-xs font-medium hover:bg-[#49dcb5]/20 transition-colors"
              >
                Try Again
              </button>
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 bg-white/5 border border-white/10 text-white/50 rounded-lg text-xs font-medium hover:bg-white/10 transition-colors"
              >
                Reload Page
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
