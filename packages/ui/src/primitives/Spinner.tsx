/**
 * Spinner — Cosmic loading indicator
 * OWNERSHIP: packages/ui/src/primitives
 */

import clsx from "clsx";

export type SpinnerSize = "xs" | "sm" | "md" | "lg";

interface SpinnerProps {
  size?:      SpinnerSize;
  className?: string;
  label?:     string;
}

const sizeMap: Record<SpinnerSize, string> = {
  xs: "w-3 h-3",
  sm: "w-4 h-4",
  md: "w-6 h-6",
  lg: "w-8 h-8",
};

export function Spinner({ size = "md", className, label = "Loading…" }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      className={clsx("relative inline-flex flex-shrink-0", sizeMap[size], className)}
    >
      {/* Track */}
      <span className="absolute inset-0 rounded-full border-2 border-white/8" />
      {/* Spinner arc */}
      <span
        className="absolute inset-0 rounded-full border-2 border-t-[#00b8f5] border-r-transparent border-b-transparent border-l-transparent animate-spin"
        style={{ animationDuration: "700ms" }}
      />
      {/* Inner reverse arc */}
      <span
        className="absolute inset-[3px] rounded-full border border-t-transparent border-r-transparent border-b-[#7c3aed]/50 border-l-transparent animate-spin"
        style={{ animationDuration: "1100ms", animationDirection: "reverse" }}
      />
    </span>
  );
}
