import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

/**
 * KOJYAI Web — Vite Configuration
 *
 * BUNDLE STRATEGY:
 * - Three.js → separate "three" chunk (large, rarely changes)
 * - React Flow → separate "reactflow" chunk
 * - recharts → separate "charts" chunk
 * - All feature pages → lazy-loaded via React.lazy (route-level splitting)
 * - Vendor chunk: React, ReactDOM, TanStack Query, Zustand
 *
 * DEV PROXY:
 * - /api/* → localhost:3001 (avoids CORS in development)
 * - /ws → ws://localhost:3001/ws (WebSocket proxy)
 *
 * PRODUCTION:
 * - Source maps uploaded to Sentry (not served to clients)
 * - Assets fingerprinted for long-term caching
 * - CSP-friendly (no eval, no inline scripts)
 */
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
  ],

  resolve: {
    alias: {
      "@":          path.resolve(__dirname, "./src"),
      "@kojyai/ui": path.resolve(__dirname, "../../packages/ui/src"),
      "@kojyai/shared": path.resolve(__dirname, "../../packages/shared/src"),
      "@kojyai/engine":  path.resolve(__dirname, "../../packages/engine/src"),
      "@kojyai/contracts":  path.resolve(__dirname, "../../packages/contracts/src/index.ts"),
    },
  },

  server: {
    port: 5173,
    proxy: {
      "/api": {
        target:      process.env.KOJY_API_URL ?? "http://localhost:3001",
        changeOrigin: true,
        rewrite:     (p) => p.replace(/^\/api/, ""),
      },
      "/ws": {
        target:  (process.env.KOJY_API_URL ?? "http://localhost:3001").replace(/^http/, "ws"),
        ws:      true,
        rewrite: (p) => p.replace(/^\/ws/, "/ws"),
      },
    },
  },

  build: {
    target:          "es2022",
    sourcemap:       mode === "production" ? "hidden" : true,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          // Core React ecosystem
          "vendor-react": ["react", "react-dom", "react-router-dom"],

          // State management
          "vendor-state": ["zustand", "@tanstack/react-query", "@trpc/client", "@trpc/react-query"],

          // Three.js — large, isolated
          "three":        ["three"],

          // React Flow — graph visualizations
          "reactflow":    ["reactflow"],

          // Charts
          "charts":       ["recharts"],

          // Animation
          "motion":       ["framer-motion"],

          // Utilities
          "vendor-utils": ["clsx", "superjson", "zod", "nanoid"],
        },
      },
    },
  },

  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? "1.0.0"),
  },

  css: {
    postcss: "./postcss.config.js",
  },
}));
