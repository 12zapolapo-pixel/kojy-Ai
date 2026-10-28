/**
 * Motion — Reusable animation configs
 * OWNERSHIP: packages/ui/src/motion
 *
 * These are plain CSS-in-JS style objects and keyframe helpers.
 * No Framer Motion dependency — pure CSS transitions via inline styles + className.
 */

export const easings = {
  spring:    "cubic-bezier(0.34, 1.56, 0.64, 1)",
  smooth:    "cubic-bezier(0.25, 0.46, 0.45, 0.94)",
  default:   "cubic-bezier(0.4, 0, 0.2, 1)",
  in:        "cubic-bezier(0.4, 0, 1, 1)",
  out:       "cubic-bezier(0, 0, 0.2, 1)",
} as const;

export const durations = {
  instant:   0,
  fast:      100,
  normal:    200,
  moderate:  300,
  slow:      400,
  lazy:      600,
  cinematic: 800,
} as const;

/** Build a CSS transition shorthand */
export function transition(
  props: string | string[],
  duration: number = durations.normal,
  easing: string = easings.default,
  delay?: number,
): string {
  const propsArr = Array.isArray(props) ? props : [props];
  return propsArr
    .map((p) => `${p} ${duration}ms ${easing}${delay ? ` ${delay}ms` : ""}`)
    .join(", ");
}

/** Stagger delay for list items */
export function staggerDelay(index: number, baseDelayMs = 40): string {
  return `${index * baseDelayMs}ms`;
}

/** Fade + slide up initial style (use with animate-slide-up class) */
export const fadeSlideUpInitial = {
  opacity: 0,
  transform: "translateY(8px)",
} as const;

export const fadeSlideUpFinal = {
  opacity: 1,
  transform: "translateY(0)",
} as const;
