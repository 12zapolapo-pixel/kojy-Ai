/**
 * HealthBar — 5-segment bot health indicator
 * OWNERSHIP: packages/ui/src/components
 *
 * Health score: 0–100
 * Segments fill left→right, color shifts teal→amber→red
 */

import clsx from "clsx";

interface HealthBarProps {
  score:      number;  // 0–100
  segments?:  number;  // default 5
  className?: string;
  showLabel?: boolean;
}

function scoreToColor(score: number): string {
  if (score >= 80) return "bg-[#22d3a5] shadow-[0_0_6px_rgba(34,211,165,0.5)]";
  if (score >= 60) return "bg-[#84cc16]";
  if (score >= 40) return "bg-[#f59e0b] shadow-[0_0_6px_rgba(245,158,11,0.4)]";
  if (score >= 20) return "bg-[#f97316]";
  return "bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]";
}

export function HealthBar({ score, segments = 5, className, showLabel = false }: HealthBarProps) {
  const filled = Math.round((score / 100) * segments);
  const color  = scoreToColor(score);

  return (
    <div className={clsx("flex items-center gap-1.5", className)}>
      <div className="flex gap-[3px]">
        {Array.from({ length: segments }, (_, i) => (
          <span
            key={i}
            className={clsx(
              "h-1.5 w-4 rounded-full transition-all duration-300",
              i < filled ? color : "bg-white/8",
            )}
          />
        ))}
      </div>
      {showLabel && (
        <span className="text-[10px] font-mono text-white/30">{score}</span>
      )}
    </div>
  );
}

/** Circular health ring for bot detail views */
export function HealthRing({
  score,
  size = 48,
  strokeWidth = 3,
}: {
  score: number;
  size?: number;
  strokeWidth?: number;
}) {
  const radius      = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset       = circumference * (1 - score / 100);

  const ringColor =
    score >= 80 ? "#22d3a5"
    : score >= 60 ? "#84cc16"
    : score >= 40 ? "#f59e0b"
    : score >= 20 ? "#f97316"
    : "#ef4444";

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
      {/* Track */}
      <circle
        cx={size / 2} cy={size / 2} r={radius}
        fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={strokeWidth}
      />
      {/* Fill */}
      <circle
        cx={size / 2} cy={size / 2} r={radius}
        fill="none"
        stroke={ringColor}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        style={{ transition: "stroke-dashoffset 0.6s cubic-bezier(0.4,0,0.2,1), stroke 0.4s" }}
        filter={`drop-shadow(0 0 4px ${ringColor}80)`}
      />
    </svg>
  );
}
