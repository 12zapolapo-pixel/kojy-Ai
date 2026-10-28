/**
 * Toast — Notification toasts
 * OWNERSHIP: packages/ui/src/components
 */

import { useEffect, useCallback, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import clsx from "clsx";

export type ToastVariant = "success" | "error" | "warning" | "info";

interface Toast {
  id:       string;
  variant:  ToastVariant;
  title:    string;
  message?: string | undefined;
  duration: number;
}

interface ToastStore {
  toasts: Toast[];
  add:    (t: Omit<Toast, "id">) => string;
  remove: (id: string) => void;
}

export const useToastStore = create<ToastStore>()(
  immer((set) => ({
    toasts: [],
    add: (t) => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      set((s) => { s.toasts.push({ ...t, id }); });
      return id;
    },
    remove: (id) => set((s) => { s.toasts = s.toasts.filter((t) => t.id !== id); }),
  })),
);

/** Imperative toast API — call anywhere */
export const toast = {
  success: (title: string, message?: string, duration = 4000) =>
    useToastStore.getState().add({ variant: "success", title, message, duration }),
  error: (title: string, message?: string, duration = 6000) =>
    useToastStore.getState().add({ variant: "error", title, message, duration }),
  warning: (title: string, message?: string, duration = 5000) =>
    useToastStore.getState().add({ variant: "warning", title, message, duration }),
  info: (title: string, message?: string, duration = 4000) =>
    useToastStore.getState().add({ variant: "info", title, message, duration }),
};

const icons: Record<ToastVariant, ReactNode> = {
  success: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2.5 7l3 3 6-6" stroke="#22d3a5" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  error:   <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M4 4l6 6M10 4l-6 6" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round"/></svg>,
  warning: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 5v3M7 9.5v.5" stroke="#f59e0b" strokeWidth="1.5" strokeLinecap="round"/><path d="M6.134 2.5l-4.5 7.794A1 1 0 002.5 12h9a1 1 0 00.866-1.5l-4.5-7.794a1 1 0 00-1.732 0z" stroke="#f59e0b" strokeWidth="1.2"/></svg>,
  info:    <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5" stroke="#00b8f5" strokeWidth="1.2"/><path d="M7 6.5v3M7 4.5v.5" stroke="#00b8f5" strokeWidth="1.5" strokeLinecap="round"/></svg>,
};

const barColors: Record<ToastVariant, string> = {
  success: "bg-[#22d3a5]",
  error:   "bg-red-500",
  warning: "bg-[#f59e0b]",
  info:    "bg-[#00b8f5]",
};

function ToastItem({ toast: t, onRemove }: { toast: Toast; onRemove: (id: string) => void }) {
  const remove = useCallback(() => onRemove(t.id), [t.id, onRemove]);

  useEffect(() => {
    const timer = setTimeout(remove, t.duration);
    return () => clearTimeout(timer);
  }, [t.duration, remove]);

  return (
    <div
      className={clsx(
        "relative flex gap-2.5 items-start",
        "bg-[#0f0f24] border border-white/10 rounded-xl p-3 pr-8",
        "shadow-[0_8px_24px_rgba(0,0,0,0.7)]",
        "animate-slide-up min-w-[260px] max-w-[360px]",
        "overflow-hidden",
      )}
    >
      {/* Progress bar */}
      <span
        className={clsx("absolute bottom-0 left-0 h-[2px] rounded-full", barColors[t.variant])}
        style={{ animation: `shrink ${t.duration}ms linear forwards` }}
      />
      <style>{`@keyframes shrink { from { width: 100%; } to { width: 0%; } }`}</style>

      <span className="flex-shrink-0 mt-0.5">{icons[t.variant]}</span>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-white/90">{t.title}</p>
        {t.message && <p className="text-[11px] text-white/45 mt-0.5 leading-relaxed">{t.message}</p>}
      </div>
      <button
        onClick={remove}
        className="absolute top-3 right-3 text-white/20 hover:text-white/50 transition-colors"
        aria-label="Dismiss"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </button>
    </div>
  );
}

function getPortal(): HTMLElement {
  let el = document.getElementById("toast-root");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast-root";
    el.style.cssText = "position:fixed;bottom:1.25rem;right:1.25rem;z-index:700;display:flex;flex-direction:column-reverse;gap:8px;pointer-events:none;";
    document.body.appendChild(el);
  }
  return el;
}

export function ToastProvider() {
  const toasts  = useToastStore((s) => s.toasts);
  const remove  = useToastStore((s) => s.remove);

  if (typeof window === "undefined") return null;

  return createPortal(
    <div style={{ pointerEvents: "auto" }} className="flex flex-col-reverse gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onRemove={remove} />
      ))}
    </div>,
    getPortal(),
  );
}
