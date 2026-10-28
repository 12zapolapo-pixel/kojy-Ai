/**
 * BotStatusBadge — Coloured pill indicating bot online status
 * OWNERSHIP: apps/web/src/components
 */

import clsx from "clsx";
import type { BotStatus } from "@kojyai/shared/types";

interface BadgeProps {
  status: BotStatus;
  showDot?: boolean;
  className?: string;
}

const STATUS_CONFIG: Record<BotStatus, { label: string; pill: string; dot: string }> = {
  online:     { label: "Online",       pill: "bg-[#34d399]/15 text-[#34d399] border-[#34d399]/30", dot: "bg-[#34d399] shadow-[0_0_6px_rgba(34,211,165,0.7)]" },
  offline:    { label: "Offline",      pill: "bg-white/5 text-white/40 border-white/10",            dot: "bg-white/25" },
  connecting: { label: "Connecting",   pill: "bg-amber-400/15 text-amber-400 border-amber-400/30",  dot: "bg-amber-400 animate-pulse" },
  error:      { label: "Error",        pill: "bg-red-500/15 text-red-400 border-red-500/30",        dot: "bg-red-500 animate-pulse" },
  suspended:  { label: "Suspended",    pill: "bg-orange-500/15 text-orange-400 border-orange-500/30", dot: "bg-orange-500" },
};

export function BotStatusBadge({ status, showDot = true, className }: BadgeProps) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.offline;

  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold border",
        cfg.pill,
        className,
      )}
    >
      {showDot && (
        <span className={clsx("w-1.5 h-1.5 rounded-full flex-shrink-0", cfg.dot)} />
      )}
      {cfg.label}
    </span>
  );
}
