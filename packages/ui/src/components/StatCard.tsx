/**
 * StatCard — KPI metric panel used in dashboards
 * OWNERSHIP: packages/ui/src/components
 */

import clsx from "clsx";
import type { ReactNode } from "react";

interface StatCardProps {
  label:     string;
  value:     string | number;
  subvalue?: string;
  icon?:     ReactNode;
  trend?:    { value: number; label?: string }; // positive = up, negative = down
  variant?:  "default" | "primary" | "success" | "warning" | "danger";
  className?: string;
}

const variantGlow: Record<string, string> = {
  default: "",
  primary: "shadow-[0_0_20px_rgba(0,184,245,0.06)] border-[#00b8f5]/15",
  success: "shadow-[0_0_20px_rgba(34,211,165,0.06)] border-[#22d3a5]/15",
  warning: "shadow-[0_0_20px_rgba(245,158,11,0.06)] border-[#f59e0b]/15",
  danger:  "shadow-[0_0_20px_rgba(239,68,68,0.06)]  border-red-500/15",
};

const variantIcon: Record<string, string> = {
  default: "bg-white/5 text-white/30",
  primary: "bg-[#00b8f5]/10 text-[#00b8f5]",
  success: "bg-[#22d3a5]/10 text-[#22d3a5]",
  warning: "bg-[#f59e0b]/10 text-[#f59e0b]",
  danger:  "bg-red-500/10   text-red-400",
};

export function StatCard({
  label, value, subvalue, icon, trend, variant = "default", className,
}: StatCardProps) {
  const isPositive = trend && trend.value > 0;
  const isNegative = trend && trend.value < 0;

  return (
    <div
      className={clsx(
        "bg-[#0a0a1a] border border-white/5 rounded-xl p-4",
        variantGlow[variant],
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <p className="text-[11px] font-medium text-white/40 uppercase tracking-wider">{label}</p>
        {icon && (
          <span className={clsx("flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-sm", variantIcon[variant])}>
            {icon}
          </span>
        )}
      </div>

      <p className="text-2xl font-semibold text-white/90 font-mono tabular-nums">{value}</p>

      {(subvalue || trend) && (
        <div className="flex items-center gap-2 mt-1.5">
          {trend && (
            <span className={clsx(
              "inline-flex items-center gap-0.5 text-[11px] font-mono",
              isPositive ? "text-[#22d3a5]" : isNegative ? "text-red-400" : "text-white/30",
            )}>
              {isPositive ? "↑" : isNegative ? "↓" : "—"}
              {Math.abs(trend.value)}%
            </span>
          )}
          {subvalue && <span className="text-[11px] text-white/25">{subvalue}</span>}
        </div>
      )}
    </div>
  );
}
