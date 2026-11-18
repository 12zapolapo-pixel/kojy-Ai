/** One small stroke icon set for the app (24×24, 1.8px, round caps). */

const PATHS = {
  chat:     "M4 5h16v11H9l-5 4z",
  plus:     "M12 5v14M5 12h14",
  chart:    "M5 19v-8M11 19V5M17 19v-6M3 19h18",
  pulse:    "M3 12h4l2-6 4 12 2-6h6",
  gear:     "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1",
  search:   "M11 17a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM20 20l-4.5-4.5",
  bell:     "M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4",
  signout:  "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10",
  more:     "M6 12h.01M12 12h.01M18 12h.01",
  chevronL: "M15 5l-7 7 7 7",
  chevronR: "M9 5l7 7-7 7",
  chevronD: "M6 9l6 6 6-6",
  bot:      "M12 3v3M7 8h10a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-5a3 3 0 0 1 3-3zM9.5 13h.01M14.5 13h.01",
  spark:    "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z",
  store:    "M4 9l1.5-5h13L20 9M4 9h16v11H4zM9 20v-6h6v6",
  shield:   "M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z",
  check:    "M5 12.5 10 17 19 7",
  close:    "M6 6l12 12M18 6 6 18",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className = "", strokeWidth = 1.8 }: {
  name: IconName; size?: number; className?: string; strokeWidth?: number;
}) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`shrink-0 ${className}`} aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[name]} />
    </svg>
  );
}
