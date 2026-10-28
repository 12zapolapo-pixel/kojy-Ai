/**
 * Dropdown — Context menus, select dropdowns, action menus
 * OWNERSHIP: packages/ui/src/components
 */

import {
  useState, useRef, useEffect, useCallback,
  type ReactNode, type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";

export interface DropdownItem {
  id:       string;
  label:    string;
  icon?:    ReactNode;
  shortcut?: string;
  danger?:  boolean;
  disabled?: boolean;
  divider?: boolean; // Insert divider BEFORE this item
}

interface DropdownProps {
  trigger:  ReactNode;
  items:    DropdownItem[];
  onSelect: (id: string) => void;
  align?:   "left" | "right";
  disabled?: boolean;
}

export function Dropdown({ trigger, items, onSelect, align = "right", disabled = false }: DropdownProps) {
  const [open, setOpen]       = useState(false);
  const [coords, setCoords]   = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);

  const compute = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setCoords({
      top:   r.bottom + 6,
      ...(align === "right"
        ? { right: window.innerWidth - r.right }
        : { left:  r.left }),
    });
  }, [align]);

  const toggle = useCallback(() => {
    if (disabled) return;
    if (!open) compute();
    setOpen((v) => !v);
  }, [disabled, open, compute]);

  // Close on outside click / scroll
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (!triggerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        onClick={toggle}
        className="inline-flex select-none"
        disabled={disabled}
        type="button"
      >
        {trigger}
      </button>

      {open && createPortal(
        <div
          className={clsx(
            "fixed z-[600] min-w-[160px] py-1",
            "bg-[#0f0f24] border border-white/10 rounded-xl",
            "shadow-[0_8px_32px_rgba(0,0,0,0.8)]",
            "animate-scale-in",
          )}
          style={coords}
        >
          {items.map((item) => (
            <span key={item.id}>
              {item.divider && <span className="block h-px bg-white/5 my-1" />}
              <button
                type="button"
                disabled={item.disabled}
                onClick={() => { onSelect(item.id); setOpen(false); }}
                className={clsx(
                  "w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left",
                  "transition-colors duration-100 select-none",
                  item.danger
                    ? "text-red-400 hover:bg-red-500/10"
                    : "text-white/70 hover:text-white/90 hover:bg-white/5",
                  item.disabled && "opacity-40 cursor-not-allowed",
                )}
              >
                {item.icon && <span className="flex-shrink-0 w-4 h-4 opacity-70">{item.icon}</span>}
                <span className="flex-1">{item.label}</span>
                {item.shortcut && (
                  <kbd className="text-[10px] text-white/25 font-mono bg-white/5 px-1 rounded">
                    {item.shortcut}
                  </kbd>
                )}
              </button>
            </span>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
