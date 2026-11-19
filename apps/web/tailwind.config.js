/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}",
  ],

  theme: {
    extend: {
      // ── Open Room palette (light, one cobalt accent) ──────────────────────
      colors: {
        // Ink: text and quiet fills
        ink: { DEFAULT: "#0F1222", 2: "#4B5065", 3: "#6B7085" },
        // Cobalt: the one accent — primary actions, selection, running
        co: { DEFAULT: "#3B5BFD", press: "#2F4EF0", ink: "#2A44D6", deep: "#1F35B0", tint: "#E9EDFF" },
        // Hairlines
        line: { DEFAULT: "#E2E4EA", strong: "#D9DCE4" },
        // Grounds
        canvas: "#F7F8FB",
        ground: "#F5F6F8",
        // Success (kept apart from the accent)
        ok: { DEFAULT: "#0E7A4F", dot: "#1F9D57" },

        // Legacy names, re-pointed so older classes stay on-palette
        "void":     "#F5F6F8",
        "base":     "#F5F6F8",
        "surface":  "#FFFFFF",
        "elevated": "#FFFFFF",
        "overlay":  "#FFFFFF",
        primary: {
          50:  "#F3F5FF", 100: "#E9EDFF", 200: "#C9D3FF", 300: "#96A8FF", 400: "#5F7BFE",
          500: "#3B5BFD", 600: "#2F4EF0", 700: "#2A44D6", 800: "#1F35B0", 900: "#17288A",
          DEFAULT: "#3B5BFD",
        },
        accent: { 300: "#96A8FF", 400: "#5F7BFE", 500: "#3B5BFD", DEFAULT: "#3B5BFD" },
        "online":   "#1F9D57",
        "offline":  "#B4BACB",
        "alert":    "#D93F3F",
        "warning":  "#D98A00",
        "pending":  "#3B5BFD",
        "agent-red":    "#D93F3F",
        "agent-blue":   "#3B5BFD",
        "agent-green":  "#1F9D57",
        "agent-yellow": "#D98A00",
        "agent-pink":   "#D6457E",
        "agent-violet": "#6250D6",
      },

      backgroundImage: {
        "cosmic-gradient":  "none",
        "surface-gradient": "none",
        "primary-glow":     "none",
        "grid-pattern":     "none",
      },

      // ── Typography ──────────────────────────────────────────────────────────
      fontFamily: {
        sans:  ["Hanken Grotesk", "Segoe UI", "system-ui", "-apple-system", "sans-serif"],
        display: ["Gabarito", "Hanken Grotesk", "system-ui", "sans-serif"],
        mono:  ["JetBrains Mono", "Fira Code", "Cascadia Code", "monospace"],
      },

      // ── Box shadows + Glows ─────────────────────────────────────────────────
      boxShadow: {
        "panel":         "0 1px 2px rgba(15,18,34,0.06), 0 8px 24px -16px rgba(15,18,34,0.25)",
        "card":          "0 1px 2px rgba(15,18,34,0.06), 0 4px 12px -8px rgba(15,18,34,0.2)",
        "modal":         "0 2px 6px rgba(15,18,34,0.08), 0 24px 64px -24px rgba(15,18,34,0.45)",
        "glow-primary":  "0 1px 2px rgba(15,18,34,0.12), 0 6px 14px -8px rgba(59,91,253,0.6)",
        "glow-strong":   "0 1px 2px rgba(15,18,34,0.12), 0 8px 18px -8px rgba(59,91,253,0.7)",
        "glow-success":  "0 4px 12px -6px rgba(31,157,87,0.5)",
        "glow-error":    "0 4px 12px -6px rgba(217,63,63,0.5)",
        "glow-accent":   "0 1px 2px rgba(15,18,34,0.12), 0 6px 14px -8px rgba(59,91,253,0.6)",
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
          "0%, 100%": { boxShadow: "0 0 0 0 rgba(59,91,253,0.35)" },
          "50%":       { boxShadow: "0 0 0 6px rgba(59,91,253,0)" },
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
          "&::-webkit-scrollbar-thumb": { background: "rgba(15,18,34,0.18)", borderRadius: "4px" },
          "&::-webkit-scrollbar-thumb:hover": { background: "rgba(15,18,34,0.3)" },
        },
        ".scrollbar-hidden": {
          "&::-webkit-scrollbar": { display: "none" },
          "scrollbar-width": "none",
          "-ms-overflow-style": "none",
        },
        // Glass morphism helpers
        // "Glass" names kept for older markup; in the light theme they are plain white surfaces.
        ".glass-subtle": { background: "#FFFFFF" },
        ".glass-light":  { background: "#FFFFFF" },
        ".glass-medium": { background: "#FFFFFF" },
        // Grid background pattern
        ".bg-grid": { backgroundImage: "none" },
      });
    },
  ],
};
