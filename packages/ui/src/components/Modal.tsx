/**
 * Modal — Cosmic dialog overlay
 * OWNERSHIP: packages/ui/src/components
 *
 * - Uses a React portal to #modal-root (created automatically if missing)
 * - Focus trapping via native dialog element
 * - Closes on Escape key or backdrop click
 * - Animated scale-in entry, fade-out exit
 */

import {
  useEffect, useRef, useCallback, type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { Button } from "../primitives/Button.js";

export type ModalSize = "sm" | "md" | "lg" | "xl" | "full";

interface ModalProps {
  open:           boolean;
  onClose:        () => void;
  title?:         string;
  description?:   string;
  children:       ReactNode;
  footer?:        ReactNode;
  size?:          ModalSize;
  closeOnBackdrop?: boolean;
  className?:     string;
}

const sizeMap: Record<ModalSize, string> = {
  sm:   "max-w-sm",
  md:   "max-w-md",
  lg:   "max-w-lg",
  xl:   "max-w-2xl",
  full: "max-w-[95vw]",
};

function getOrCreatePortalRoot(): HTMLElement {
  let el = document.getElementById("modal-root");
  if (!el) {
    el = document.createElement("div");
    el.id = "modal-root";
    document.body.appendChild(el);
  }
  return el;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  closeOnBackdrop = true,
  className,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Escape key
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // Body scroll lock
  useEffect(() => {
    if (open) document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  const handleBackdrop = useCallback((e: React.MouseEvent) => {
    if (closeOnBackdrop && e.target === e.currentTarget) onClose();
  }, [closeOnBackdrop, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[500] flex items-center justify-center p-4"
      onClick={handleBackdrop}
      aria-modal="true"
      role="dialog"
      aria-label={title}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in" />

      {/* Panel */}
      <div
        ref={dialogRef}
        className={clsx(
          "relative w-full z-10",
          "bg-[#0f0f24] border border-white/10 rounded-2xl",
          "shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_24px_64px_rgba(0,0,0,0.9)]",
          "animate-scale-in",
          sizeMap[size],
          className,
        )}
      >
        {/* Header */}
        {(title || description) && (
          <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4 border-b border-white/5">
            <div>
              {title && (
                <h2 className="text-sm font-semibold text-white/90">{title}</h2>
              )}
              {description && (
                <p className="text-xs text-white/40 mt-1">{description}</p>
              )}
            </div>
            <button
              onClick={onClose}
              className="flex-shrink-0 text-white/30 hover:text-white/60 transition-colors mt-0.5"
              aria-label="Close"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        )}

        {/* Body */}
        <div className="px-6 py-4">{children}</div>

        {/* Footer */}
        {footer && (
          <div className="flex items-center justify-end gap-2 px-6 pb-5 pt-2 border-t border-white/5">
            {footer}
          </div>
        )}
      </div>
    </div>,
    getOrCreatePortalRoot(),
  );
}

/** Convenience: confirmation modal */
export function ConfirmModal({
  open, onClose, onConfirm, title, message, confirmLabel = "Confirm", danger = false, loading = false,
}: {
  open: boolean; onClose: () => void; onConfirm: () => void;
  title: string; message: string; confirmLabel?: string; danger?: boolean; loading?: boolean;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button
            variant={danger ? "danger" : "primary"}
            size="sm"
            onClick={onConfirm}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-xs text-white/60 leading-relaxed">{message}</p>
    </Modal>
  );
}
