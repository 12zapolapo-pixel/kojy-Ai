/**
 * Tooltip — Hover popover for labels and shortcuts
 * OWNERSHIP: packages/ui/src/components
 */

import {
  useState, useRef, useCallback, useEffect,
  type ReactNode, type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";

export type TooltipPlacement = "top" | "bottom" | "left" | "right";

interface TooltipProps {
  content:    ReactNode;
  children:   ReactNode;
  placement?: TooltipPlacement;
  delay?:     number;
  disabled?:  boolean;
  shortcut?:  string;
}

export function Tooltip({
  content,
  children,
  placement = "top",
  delay     = 400,
  disabled  = false,
  shortcut,
}: TooltipProps) {
  const [visible, setVisible]   = useState(false);
  const [coords,  setCoords]    = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLSpanElement>(null);
  const timerRef   = useRef<ReturnType<typeof setTimeout>>();

  const compute = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const gap = 6;
    const offset: Record<TooltipPlacement, CSSProperties> = {
      top:    { bottom: window.innerHeight - r.top + gap, left: r.left + r.width / 2, transform: "translateX(-50%)" },
      bottom: { top: r.bottom + gap, left: r.left + r.width / 2, transform: "translateX(-50%)" },
      left:   { top: r.top + r.height / 2, right: window.innerWidth - r.left + gap, transform: "translateY(-50%)" },
      right:  { top: r.top + r.height / 2, left: r.right + gap, transform: "translateY(-50%)" },
    };
    setCoords(offset[placement]);
  }, [placement]);

  const show = useCallback(() => {
    if (disabled) return;
    timerRef.current = setTimeout(() => { compute(); setVisible(true); }, delay);
  }, [disabled, delay, compute]);

  const hide = useCallback(() => {
    clearTimeout(timerRef.current);
    setVisible(false);
  }, []);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <>
      <span ref={triggerRef} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} className="inline-flex">
        {children}
      </span>
      {visible && createPortal(
        <div
          className={clsx(
            "fixed z-[800] px-2 py-1 rounded-md pointer-events-none select-none",
            "bg-[#14142e] border border-white/10",
            "text-[11px] text-white/80 font-mono whitespace-nowrap",
            "shadow-[0_4px_12px_rgba(0,0,0,0.6)]",
            "animate-fade-in",
          )}
          style={coords}
        >
          {content}
          {shortcut && (
            <kbd className="ml-1.5 text-[10px] bg-white/10 border border-white/15 rounded px-1 py-0.5">
              {shortcut}
            </kbd>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
