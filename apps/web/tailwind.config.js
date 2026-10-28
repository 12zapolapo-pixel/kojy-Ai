/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}",
  ],

  theme: {
    extend: {
      // ── Cosmic Color Palette ────────────────────────────────────────────────
      colors: {
        // Surface layers
        "void":     "#030712",
        "base":     "#050510",
        "surface":  "#0b1220",
        "elevated": "#121b31",
        "overlay":  "#1b2744",

        // Primary — Cosmic Cyan
        primary: {
          50:  "#e0f7ff",
          100: "#b3ecff",
          200: "#80dfff",
          300: "#4dd2ff",
          400: "#1ac8ff",
          500: "#49dcb5",
          600: "#0099cc",
          700: "#0077a3",
          800: "#005580",
          900: "#003352",
          DEFAULT: "#49dcb5",
        },

        // Accent — Electric Violet
        accent: {
          300: "#a78bfa",
          400: "#8b5cf6",
          500: "#8b5cf6",
          DEFAULT: "#8b5cf6",
        },

        // Status
        "online":   "#34d399",
        "offline":  "#4a4a6a",
        "alert":    "#ef4444",
        "warning":  "#f59e0b",
        "pending":  "#6366f1",

        // Delegation character palette
        "agent-red":    "#ef4444",
        "agent-blue":   "#49dcb5",
        "agent-green":  "#22c55e",
        "agent-yellow": "#f59e0b",
        "agent-pink":   "#ec4899",
        "agent-violet": "#8b5cf6",
      },

      // ── Background images ───────────────────────────────────────────────────
      backgroundImage: {
        "cosmic-gradient":  "radial-gradient(ellipse at top, #0d0d22 0%, #030712 100%)",
        "surface-gradient": "linear-gradient(135deg, #0b1220 0%, #121b31 100%)",
        "primary-glow":     "radial-gradient(circle, rgba(73,220,181,0.16) 0%, transparent 70%)",
        "grid-pattern": `
          linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)
        `,
      },

      // ── Typography ──────────────────────────────────────────────────────────
      fontFamily: {
        sans:  ["Inter", "Segoe UI", "system-ui", "-apple-system", "sans-serif"],
        mono:  ["JetBrains Mono", "Fira Code", "Cascadia Code", "monospace"],
      },

      // ── Box shadows + Glows ─────────────────────────────────────────────────
      boxShadow: {
        "panel":         "0 0 0 1px rgba(255,255,255,0.05), 0 4px 20px rgba(0,0,0,0.6)",
        "card":          "0 0 0 1px rgba(255,255,255,0.05), 0 2px 8px rgba(0,0,0,0.5)",
        "modal":         "0 0 0 1px rgba(255,255,255,0.08), 0 24px 64px rgba(0,0,0,0.9)",
        "glow-primary":  "0 0 20px rgba(73,220,181,0.28), 0 0 40px rgba(73,220,181,0.12)",
        "glow-strong":   "0 0 20px rgba(73,220,181,0.55), 0 0 60px rgba(73,220,181,0.24)",
        "glow-success":  "0 0 15px rgba(34,211,165,0.3)",
        "glow-error":    "0 0 15px rgba(239,68,68,0.3)",
        "glow-accent":   "0 0 20px rgba(139,92,246,0.3), 0 0 40px rgba(139,92,246,0.1)",
      },

      // ── Border radius ───────────────────────────────────────────────────────
      borderRadius: {
        "2xl": "1rem",
        "3xl": "1.5rem",
      },

      // ── Custom animations ───────────────────────────────────────────────────
      animation: {
        "fade-in":       "fadeIn 0.24s ease-out",
        "slide-up":      "slideUp 0.34s cubic-bezier(0.22, 1, 0.36, 1)",
        "slide-right":   "slideRight 0.32s cubic-bezier(0.22, 1, 0.36, 1)",
        "scale-in":      "scaleIn 0.24s cubic-bezier(0.22, 1, 0.36, 1)",
        "pulse-slow":    "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "glow-pulse":    "glowPulse 2s ease-in-out infinite",
        "float":         "float 3s ease-in-out infinite",
      },

      keyframes: {
        fadeIn: {
          "0%":   { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%":   { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        slideRight: {
          "0%":   { opacity: "0", transform: "translateX(-8px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        scaleIn: {
          "0%":   { opacity: "0", transform: "scale(0.95)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        glowPulse: {
          "0%, 100%": { boxShadow: "0 0 10px rgba(73,220,181,0.2)" },
          "50%":       { boxShadow: "0 0 20px rgba(73,220,181,0.5)" },
        },
        float: {
          "0%, 100%": { transform: "translateY(0)" },
          "50%":       { transform: "translateY(-6px)" },
        },
      },

      // ── Transitions ─────────────────────────────────────────────────────────
      transitionTimingFunction: {
        "spring":     "cubic-bezier(0.34, 1.56, 0.64, 1)",
        "smooth":     "cubic-bezier(0.25, 0.46, 0.45, 0.94)",
        "decelerate": "cubic-bezier(0, 0, 0.2, 1)",
      },

      // ── Z-index ─────────────────────────────────────────────────────────────
      zIndex: {
        "sidebar":    "200",
        "topbar":     "300",
        "overlay":    "400",
        "modal":      "500",
        "command":    "600",
        "notif":      "700",
        "tooltip":    "800",
      },
    },
  },

  plugins: [
    // Custom scrollbar utilities
    function({ addUtilities }: any) {
      addUtilities({
        ".scrollbar-thin": {
          "&::-webkit-scrollbar": { width: "4px", height: "4px" },
          "&::-webkit-scrollbar-track": { background: "transparent" },
          "&::-webkit-scrollbar-thumb": { background: "rgba(255,255,255,0.1)", borderRadius: "2px" },
          "&::-webkit-scrollbar-thumb:hover": { background: "rgba(255,255,255,0.2)" },
        },
        ".scrollbar-hidden": {
          "&::-webkit-scrollbar": { display: "none" },
          "scrollbar-width": "none",
          "-ms-overflow-style": "none",
        },
        // Glass morphism helpers
        ".glass-subtle": { background: "rgba(255,255,255,0.02)", backdropFilter: "blur(8px)" },
        ".glass-light":  { background: "rgba(255,255,255,0.04)", backdropFilter: "blur(12px)" },
        ".glass-medium": { background: "rgba(255,255,255,0.07)", backdropFilter: "blur(16px)" },
        // Grid background pattern
        ".bg-grid": {
          backgroundImage: "linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)",
          backgroundSize: "40px 40px",
        },
      });
    },
  ],
};
