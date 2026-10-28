/**
 * Drawer — Sliding side panel (notifications, inspector, logs)
 * OWNERSHIP: packages/ui/src/components
 */

import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";

export type DrawerSide = "left" | "right" | "bottom";

interface DrawerProps {
  open:      boolean;
  onClose:   () => void;
  title?:    string;
  side?:     DrawerSide;
  width?:    string;
  children:  ReactNode;
  footer?:   ReactNode;
  className?: string;
}

const sideClasses: Record<DrawerSide, { base: string; open: string; closed: string }> = {
  right:  {
    base:   "top-0 right-0 h-full",
    open:   "translate-x-0",
    closed: "translate-x-full",
  },
  left:   {
    base:   "top-0 left-0 h-full",
    open:   "translate-x-0",
    closed: "-translate-x-full",
  },
  bottom: {
    base:   "bottom-0 left-0 w-full",
    open:   "translate-y-0",
    closed: "translate-y-full",
  },
};

export function Drawer({
  open, onClose, title, side = "right", width = "w-80", children, footer, className,
}: DrawerProps) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [open, onClose]);

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className={clsx(
          "fixed inset-0 z-[400] bg-black/50 backdrop-blur-sm transition-opacity duration-300",
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        )}
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className={clsx(
          "fixed z-[450] flex flex-col",
          "bg-[#0a0a1a] border-l border-white/8",
          "shadow-[-20px_0_60px_rgba(0,0,0,0.7)]",
          "transition-transform duration-300 ease-[cubic-bezier(0.25,0.46,0.45,0.94)]",
          sideClasses[side].base,
          side !== "bottom" ? width : "h-[60vh]",
          open ? sideClasses[side].open : sideClasses[side].closed,
          className,
        )}
      >
        {/* Header */}
        {title && (
          <div className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b border-white/5">
            <h3 className="text-xs font-semibold text-white/80">{title}</h3>
            <button
              onClick={onClose}
              className="text-white/25 hover:text-white/60 transition-colors"
              aria-label="Close"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">{children}</div>

        {/* Footer */}
        {footer && (
          <div className="flex-shrink-0 px-4 py-3 border-t border-white/5">{footer}</div>
        )}
      </div>
    </>,
    document.body,
  );
}
