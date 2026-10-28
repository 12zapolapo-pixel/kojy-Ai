/**
 * Badge — Status and label pill
 * OWNERSHIP: packages/ui/src/primitives
 */

import clsx from "clsx";
import type { ReactNode } from "react";

export type BadgeVariant = "default" | "primary" | "success" | "warning" | "danger" | "info" | "accent" | "outline";
export type BadgeSize    = "xs" | "sm" | "md";

interface BadgeProps {
  variant?:   BadgeVariant;
  size?:      BadgeSize;
  dot?:       boolean;     // Show animated pulsing dot before label
  pulse?:     boolean;     // Animate the dot
  className?: string;
  children:   ReactNode;
}

const variantClasses: Record<BadgeVariant, string> = {
  default: "bg-white/5 text-white/50 border border-white/8",
  primary: "bg-[#00b8f5]/12 text-[#00b8f5] border border-[#00b8f5]/25",
  success: "bg-[#22d3a5]/12 text-[#22d3a5] border border-[#22d3a5]/25",
  warning: "bg-[#f59e0b]/12 text-[#f59e0b] border border-[#f59e0b]/25",
  danger:  "bg-red-500/12 text-red-400 border border-red-500/25",
  info:    "bg-sky-500/12 text-sky-400 border border-sky-500/25",
  accent:  "bg-[#7c3aed]/12 text-[#a78bfa] border border-[#7c3aed]/25",
  outline: "bg-transparent text-white/60 border border-white/15",
};

const dotColors: Record<BadgeVariant, string> = {
  default: "bg-white/30",
  primary: "bg-[#00b8f5]",
  success: "bg-[#22d3a5]",
  warning: "bg-[#f59e0b]",
  danger:  "bg-red-400",
  info:    "bg-sky-400",
  accent:  "bg-[#a78bfa]",
  outline: "bg-white/40",
};

const sizeClasses: Record<BadgeSize, string> = {
  xs: "text-[10px] px-1.5 py-0.5 gap-1   rounded",
  sm: "text-[11px] px-2   py-0.5 gap-1   rounded-md",
  md: "text-xs     px-2.5 py-1   gap-1.5 rounded-md",
};

export function Badge({
  variant   = "default",
  size      = "sm",
  dot       = false,
  pulse     = false,
  className,
  children,
}: BadgeProps) {
  return (
    <span
      className={clsx(
        "inline-flex items-center font-mono font-medium whitespace-nowrap",
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
    >
      {dot && (
        <span className="relative flex-shrink-0 flex items-center justify-center w-1.5 h-1.5">
          {pulse && (
            <span
              className={clsx("absolute inset-0 rounded-full opacity-75 animate-ping", dotColors[variant])}
            />
          )}
          <span className={clsx("relative rounded-full w-1.5 h-1.5", dotColors[variant])} />
        </span>
      )}
      {children}
    </span>
  );
}

/** Convenience: bot status badge */
export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { variant: BadgeVariant; label: string; pulse?: boolean }> = {
    online:     { variant: "success", label: "online",     pulse: true },
    connecting: { variant: "primary", label: "connecting", pulse: true },
    offline:    { variant: "default", label: "offline" },
    error:      { variant: "danger",  label: "error",      pulse: true },
    suspended:  { variant: "warning", label: "suspended" },
  };
  const cfg = map[status] ?? { variant: "default" as BadgeVariant, label: status };
  return (
    // FIX-23: cfg.pulse is boolean|undefined — !! coerces to boolean so the prop
    // satisfies exactOptionalPropertyTypes (explicit undefined is rejected).
    <Badge variant={cfg.variant} dot pulse={!!cfg.pulse} size="xs">
      {cfg.label}
    </Badge>
  );
}
