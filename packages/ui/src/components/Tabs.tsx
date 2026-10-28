/**
 * Tabs — Segmented navigation tabs
 * OWNERSHIP: packages/ui/src/components
 */

import { useState, useRef, useEffect, type ReactNode } from "react";
import clsx from "clsx";

export interface TabItem {
  id:      string;
  label:   string;
  badge?:  number | string;
  icon?:   ReactNode;
}

interface TabsProps {
  items:     TabItem[];
  active:    string;
  onChange:  (id: string) => void;
  variant?:  "underline" | "pill" | "segment";
  size?:     "sm" | "md";
  className?: string;
}

export function Tabs({
  items,
  active,
  onChange,
  variant   = "underline",
  size      = "md",
  className,
}: TabsProps) {
  const listRef    = useRef<HTMLDivElement>(null);
  const activeRef  = useRef<HTMLButtonElement>(null);
  const [indicatorStyle, setIndicatorStyle] = useState({ left: 0, width: 0 });

  // Animate indicator
  useEffect(() => {
    const el = activeRef.current;
    const container = listRef.current;
    if (!el || !container) return;
    const r   = el.getBoundingClientRect();
    const cr  = container.getBoundingClientRect();
    setIndicatorStyle({ left: r.left - cr.left, width: r.width });
  }, [active, items]);

  const textSize = size === "sm" ? "text-[11px]" : "text-xs";

  if (variant === "segment") {
    return (
      <div className={clsx("flex gap-0.5 bg-white/[0.04] border border-white/8 rounded-lg p-0.5", className)}>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onChange(item.id)}
            className={clsx(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-all duration-150",
              textSize,
              active === item.id
                ? "bg-[#00b8f5]/15 text-[#00b8f5] border border-[#00b8f5]/25"
                : "text-white/40 hover:text-white/60 hover:bg-white/5",
            )}
          >
            {item.icon && <span className="w-3.5 h-3.5">{item.icon}</span>}
            {item.label}
            {item.badge != null && (
              <span className="ml-0.5 px-1 py-px bg-white/10 text-white/40 rounded text-[9px] font-mono">
                {item.badge}
              </span>
            )}
          </button>
        ))}
      </div>
    );
  }

  if (variant === "pill") {
    return (
      <div className={clsx("flex gap-1", className)}>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onChange(item.id)}
            className={clsx(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-full font-medium transition-all duration-150",
              textSize,
              active === item.id
                ? "bg-[#00b8f5]/15 text-[#00b8f5]"
                : "text-white/40 hover:text-white/65 hover:bg-white/5",
            )}
          >
            {item.icon && <span>{item.icon}</span>}
            {item.label}
          </button>
        ))}
      </div>
    );
  }

  // underline (default)
  return (
    <div
      ref={listRef}
      className={clsx("relative flex gap-1 border-b border-white/5", className)}
    >
      {items.map((item) => (
        <button
          key={item.id}
          ref={active === item.id ? activeRef : null}
          type="button"
          onClick={() => onChange(item.id)}
          className={clsx(
            "flex items-center gap-1.5 px-3 pb-2.5 pt-1 font-medium transition-colors duration-150",
            textSize,
            active === item.id
              ? "text-[#00b8f5]"
              : "text-white/40 hover:text-white/65",
          )}
        >
          {item.icon && <span className="w-3.5 h-3.5 opacity-70">{item.icon}</span>}
          {item.label}
          {item.badge != null && (
            <span className={clsx(
              "px-1.5 py-px rounded text-[9px] font-mono",
              active === item.id ? "bg-[#00b8f5]/15 text-[#00b8f5]" : "bg-white/8 text-white/30",
            )}>
              {item.badge}
            </span>
          )}
        </button>
      ))}
      {/* Sliding underline indicator */}
      <span
        className="absolute bottom-0 h-[2px] bg-[#00b8f5] rounded-full transition-all duration-200 ease-out"
        style={{ left: indicatorStyle.left, width: indicatorStyle.width }}
      />
    </div>
  );
}
