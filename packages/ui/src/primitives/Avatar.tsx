/**
 * Avatar — User / Bot avatar with initials fallback
 * OWNERSHIP: packages/ui/src/primitives
 */

import clsx from "clsx";

export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

interface AvatarProps {
  src?:       string | null;
  name?:      string;
  size?:      AvatarSize;
  status?:    "online" | "offline" | "error" | "connecting" | null;
  className?: string;
}

const sizeMap: Record<AvatarSize, { container: string; text: string; dot: string }> = {
  xs: { container: "w-5 h-5",   text: "text-[9px]",  dot: "w-1.5 h-1.5 -bottom-px -right-px" },
  sm: { container: "w-7 h-7",   text: "text-[11px]", dot: "w-2 h-2 -bottom-px -right-px" },
  md: { container: "w-9 h-9",   text: "text-xs",     dot: "w-2.5 h-2.5 bottom-0 right-0" },
  lg: { container: "w-12 h-12", text: "text-sm",     dot: "w-3 h-3 bottom-0.5 right-0.5" },
  xl: { container: "w-16 h-16", text: "text-base",   dot: "w-3.5 h-3.5 bottom-1 right-1" },
};

const statusColors: Record<string, string> = {
  online:     "bg-[#22d3a5] shadow-[0_0_6px_rgba(34,211,165,0.6)]",
  offline:    "bg-[#4a4a6a]",
  error:      "bg-red-500",
  connecting: "bg-[#00b8f5] animate-pulse",
};

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

// Deterministic color from name
const PALETTE = [
  "from-[#00b8f5] to-[#0077a3]",
  "from-[#7c3aed] to-[#5b21b6]",
  "from-[#22d3a5] to-[#0f6e56]",
  "from-[#f59e0b] to-[#b45309]",
  "from-[#ef4444] to-[#991b1b]",
  "from-[#6366f1] to-[#4338ca]",
  "from-[#ec4899] to-[#be185d]",
  "from-[#14b8a6] to-[#0f766e]",
];

function nameToGradient(name: string): string {
  let hash = 0;
  for (const c of name) hash = ((hash << 5) - hash) + c.charCodeAt(0);
  return PALETTE[Math.abs(hash) % PALETTE.length]!;
}

export function Avatar({ src, name = "", size = "md", status, className }: AvatarProps) {
  const s = sizeMap[size];
  const initials = getInitials(name) || "?";
  const gradient = nameToGradient(name);

  return (
    <span className={clsx("relative inline-flex flex-shrink-0", s.container, className)}>
      {src ? (
        <img
          src={src}
          alt={name}
          className="w-full h-full rounded-full object-cover"
        />
      ) : (
        <span
          className={clsx(
            "w-full h-full rounded-full bg-gradient-to-br flex items-center justify-center",
            "font-semibold text-white select-none",
            gradient,
            s.text,
          )}
        >
          {initials}
        </span>
      )}
      {status && (
        <span
          className={clsx(
            "absolute rounded-full border-2 border-[#050510]",
            s.dot,
            statusColors[status] ?? "bg-white/20",
          )}
        />
      )}
    </span>
  );
}
