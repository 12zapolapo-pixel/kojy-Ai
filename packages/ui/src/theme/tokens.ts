/**
 * @kojyai/ui — Cosmic Design System Tokens
 *
 * OWNERSHIP: packages/ui/src/theme
 * CONSUMED BY: All web components via Tailwind CSS variables and direct imports
 *
 * VISUAL DIRECTION:
 * - Deep space dark base (#050510 — near-black with blue undertone)
 * - Layered glass surfaces with subtle luminosity
 * - Cyan/electric-blue primary accent
 * - Amber/gold for warnings and energy
 * - Green for health/online status
 * - Red for errors and critical states
 * - Motion: purposeful, never decorative-only
 *
 * USAGE RULE:
 * - NEVER hardcode colors in component files
 * - Import from this file or use Tailwind CSS vars
 * - Design token changes propagate everywhere automatically
 */

// ─── Color Palette ────────────────────────────────────────────────────────────

export const colors = {
  // ── Base surfaces ──
  bg: {
    void:     "#020209", // Deepest background — page root
    base:     "#050510", // App background
    surface:  "#0a0a1a", // Card / panel surface
    elevated: "#0f0f24", // Elevated panel / modal
    overlay:  "#14142e", // Highest elevation / tooltip
  },

  // ── Glass layers ──
  glass: {
    subtle:   "rgba(255,255,255,0.02)",
    light:    "rgba(255,255,255,0.04)",
    medium:   "rgba(255,255,255,0.07)",
    strong:   "rgba(255,255,255,0.10)",
    bright:   "rgba(255,255,255,0.15)",
  },

  // ── Primary — Cosmic Cyan ──
  primary: {
    50:  "#e0f7ff",
    100: "#b3ecff",
    200: "#80dfff",
    300: "#4dd2ff",
    400: "#1ac8ff",
    500: "#00b8f5", // Main primary
    600: "#0099cc",
    700: "#0077a3",
    800: "#005580",
    900: "#003352",
  },

  // ── Accent — Electric Violet ──
  accent: {
    500: "#7c3aed",
    400: "#8b5cf6",
    300: "#a78bfa",
    glow: "rgba(124,58,237,0.3)",
  },

  // ── Status ──
  status: {
    online:   "#22d3a5", // Bot online / healthy
    offline:  "#4a4a6a", // Bot offline
    error:    "#ef4444", // Error / critical
    warning:  "#f59e0b", // Warning / degraded
    pending:  "#6366f1", // Connecting / loading
    info:     "#0ea5e9", // Informational
  },

  // ── Data visualization ──
  dataviz: [
    "#00b8f5", // cyan
    "#7c3aed", // violet
    "#22d3a5", // teal
    "#f59e0b", // amber
    "#ef4444", // red
    "#10b981", // emerald
    "#f97316", // orange
    "#8b5cf6", // purple
    "#06b6d4", // sky
    "#84cc16", // lime
  ],

  // ── Text ──
  text: {
    primary:   "#f0f0ff",  // High contrast body text
    secondary: "#9191b0",  // Muted / captions
    tertiary:  "#5a5a7a",  // Disabled / placeholder
    inverse:   "#050510",  // On light backgrounds
    link:      "#00b8f5",  // Clickable text
    danger:    "#ef4444",
    success:   "#22d3a5",
    warning:   "#f59e0b",
  },

  // ── Borders ──
  border: {
    subtle:  "rgba(255,255,255,0.05)",
    default: "rgba(255,255,255,0.08)",
    strong:  "rgba(255,255,255,0.15)",
    primary: "rgba(0,184,245,0.3)",
    glow:    "rgba(0,184,245,0.6)",
  },
} as const;

// ─── Glow System ──────────────────────────────────────────────────────────────

export const glows = {
  // Used on focused/active elements and health indicators
  primary: `0 0 20px rgba(0,184,245,0.25), 0 0 40px rgba(0,184,245,0.1)`,
  primaryStrong: `0 0 20px rgba(0,184,245,0.5), 0 0 60px rgba(0,184,245,0.2)`,
  accent: `0 0 20px rgba(124,58,237,0.3), 0 0 40px rgba(124,58,237,0.1)`,
  success: `0 0 15px rgba(34,211,165,0.3)`,
  error: `0 0 15px rgba(239,68,68,0.3)`,
  warning: `0 0 15px rgba(245,158,11,0.25)`,
  // For Mission Control health indicators
  health: (score: 0 | 1 | 2 | 3 | 4 | 5) => {
    const map = [
      "none",
      `0 0 10px rgba(239,68,68,0.4)`,
      `0 0 10px rgba(245,158,11,0.35)`,
      `0 0 12px rgba(245,158,11,0.25)`,
      `0 0 12px rgba(34,211,165,0.2)`,
      `0 0 16px rgba(34,211,165,0.4)`,
    ] as const;
    return map[score];
  },
} as const;

// ─── Typography ───────────────────────────────────────────────────────────────

export const typography = {
  fontFamily: {
    // System stack — fast, no FOUT
    sans:  "'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif",
    mono:  "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
    display: "'Inter', 'DM Sans', system-ui, sans-serif", // For hero text
  },

  fontSize: {
    "2xs": "0.625rem",   // 10px
    xs:    "0.75rem",    // 12px
    sm:    "0.875rem",   // 14px
    base:  "1rem",       // 16px
    lg:    "1.125rem",   // 18px
    xl:    "1.25rem",    // 20px
    "2xl": "1.5rem",     // 24px
    "3xl": "1.875rem",   // 30px
    "4xl": "2.25rem",    // 36px
    "5xl": "3rem",       // 48px
    "6xl": "3.75rem",    // 60px
  },

  fontWeight: {
    normal:   "400",
    medium:   "500",
    semibold: "600",
    bold:     "700",
    extrabold: "800",
  },

  lineHeight: {
    tight:   "1.2",
    snug:    "1.375",
    normal:  "1.5",
    relaxed: "1.625",
    loose:   "2",
  },

  letterSpacing: {
    tight:  "-0.02em",
    normal: "0",
    wide:   "0.05em",
    wider:  "0.1em",
    widest: "0.15em",
  },
} as const;

// ─── Spacing ──────────────────────────────────────────────────────────────────

export const spacing = {
  px:  "1px",
  0:   "0",
  0.5: "0.125rem",  // 2px
  1:   "0.25rem",   // 4px
  1.5: "0.375rem",  // 6px
  2:   "0.5rem",    // 8px
  2.5: "0.625rem",  // 10px
  3:   "0.75rem",   // 12px
  4:   "1rem",      // 16px
  5:   "1.25rem",   // 20px
  6:   "1.5rem",    // 24px
  8:   "2rem",      // 32px
  10:  "2.5rem",    // 40px
  12:  "3rem",      // 48px
  16:  "4rem",      // 64px
  20:  "5rem",      // 80px
  24:  "6rem",      // 96px
} as const;

// ─── Border Radius ────────────────────────────────────────────────────────────

export const radius = {
  none:  "0",
  sm:    "4px",
  base:  "6px",
  md:    "8px",
  lg:    "12px",
  xl:    "16px",
  "2xl": "20px",
  "3xl": "24px",
  full:  "9999px",
} as const;

// ─── Shadows ──────────────────────────────────────────────────────────────────

export const shadows = {
  sm:    "0 1px 2px rgba(0,0,0,0.4)",
  base:  "0 2px 4px rgba(0,0,0,0.5)",
  md:    "0 4px 12px rgba(0,0,0,0.6)",
  lg:    "0 8px 24px rgba(0,0,0,0.7)",
  xl:    "0 16px 40px rgba(0,0,0,0.8)",
  panel: "0 0 0 1px rgba(255,255,255,0.05), 0 4px 20px rgba(0,0,0,0.6)",
  card:  "0 0 0 1px rgba(255,255,255,0.05), 0 2px 8px rgba(0,0,0,0.5)",
  modal: "0 0 0 1px rgba(255,255,255,0.08), 0 24px 64px rgba(0,0,0,0.9)",
} as const;

// ─── Motion ───────────────────────────────────────────────────────────────────

export const motion = {
  // Easing
  easing: {
    default:   "cubic-bezier(0.4, 0, 0.2, 1)", // Material standard
    decelerate: "cubic-bezier(0, 0, 0.2, 1)",  // Elements entering
    accelerate: "cubic-bezier(0.4, 0, 1, 1)",  // Elements leaving
    spring:    "cubic-bezier(0.34, 1.56, 0.64, 1)", // Springy / expressive
    smooth:    "cubic-bezier(0.25, 0.46, 0.45, 0.94)",
  },

  // Duration
  duration: {
    instant:  0,
    fast:     "100ms",
    normal:   "200ms",
    moderate: "300ms",
    slow:     "400ms",
    lazy:     "600ms",
    cinematic: "800ms",
  },

  // Principles:
  // - UI responses (hover, click): fast (100–200ms)
  // - Panel open/close: moderate (300ms)
  // - Page transitions: slow (400ms) with decelerate easing
  // - Mission Control live updates: instant (no animation, just data swap)
  // - Simulation transitions: cinematic (600–800ms)
  // - NEVER animate layout properties — only opacity, transform
  // - Use will-change: transform on GPU-composited elements
} as const;

// ─── Z-Index Hierarchy ────────────────────────────────────────────────────────

export const zIndex = {
  base:        0,
  raised:      10,   // Cards hover state
  dropdown:    100,  // Dropdowns, tooltips
  sidebar:     200,  // App sidebar
  topbar:      300,  // Top navigation bar
  overlay:     400,  // Dim overlays
  modal:       500,  // Modals
  commandPalette: 600, // Command palette (always on top)
  notification: 700,  // Toast notifications
  tooltip:     800,  // Tooltips above modals
  emergency:   900,  // Critical alerts / system banners
} as const;

// ─── Grid ─────────────────────────────────────────────────────────────────────

export const grid = {
  columns: 12,
  gap: spacing[4],
  // Dashboard panels default widths
  panels: {
    sidebar: "240px",
    sidebarCollapsed: "64px",
    inspectorPanel: "360px",
    logPanel: "400px",
    commandPalette: "640px",
  },
} as const;

// ─── Breakpoints ──────────────────────────────────────────────────────────────

export const breakpoints = {
  sm:  "640px",
  md:  "768px",
  lg:  "1024px",
  xl:  "1280px",
  "2xl": "1536px",
} as const;
