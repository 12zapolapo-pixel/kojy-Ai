/**
 * Bot Store — Zustand
 *
 * OWNERSHIP: apps/web/src/state
 * LAYER: Frontend state — domain store for all bot data
 *
 * DESIGN:
 * - Flat array of bots — no nested object nesting by orgId (keeps selectors simple)
 * - Bot state updated in two paths:
 *   1. Initial load: tRPC query → setBots()
 *   2. Live updates: WS events → updateBotStatus(), updateBotHealth()
 * - Selectors are always derived — never stored as state
 * - All mutations are synchronous and O(1) or O(n) where n = bot count
 *
 * PERFORMANCE CONTRACT:
 * - Components MUST use a selector that picks only what they need
 * - Wrong:  useBotStore()  — entire store, re-renders on any change
 * - Right:  useBotStore(s => s.bots.find(b => b.id === id))
 * - BotCard uses per-bot selector → only re-renders its own bot's changes
 *
 * SIZING:
 * - Supports up to 999 bots (enterprise plan) without performance degradation
 * - Virtualization in the grid ensures DOM count stays manageable
 */

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import type { Bot, BotStatus, BotHealthScore, BotStats } from "@kojyai/shared/types";

// ─── Types ────────────────────────────────────────────────────────────────────

interface BotStore {
  // State
  bots: Bot[];
  selectedBotId: string | null;
  filterStatus: BotStatus | "all";
  filterSearch: string;
  isLoading: boolean;

  // Bulk actions (from tRPC queries)
  setBots: (bots: Bot[]) => void;
  upsertBot: (bot: Bot) => void;
  removeBot: (botId: string) => void;

  // Targeted mutations (from WS events — must be O(1))
  updateBotStatus: (botId: string, status: BotStatus, error: string | null) => void;
  updateBotHealth: (botId: string, score: BotHealthScore) => void;
  updateBotStats:  (botId: string, stats: Partial<BotStats>) => void;
  updateBotRoom:   (botId: string, roomId: string | null) => void;
  updateLastSeen:  (botId: string, ts: string) => void;

  // Selection
  selectBot: (botId: string | null) => void;

  // Filters
  setFilterStatus: (status: BotStatus | "all") => void;
  setFilterSearch: (query: string) => void;

  // Derived (call these in selectors, not as state)
  getFilteredBots: () => Bot[];
  getOnlineBots:   () => Bot[];
  getBotById:      (id: string) => Bot | undefined;
  getStats:        () => { online: number; offline: number; error: number; total: number };
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useBotStore = create<BotStore>()(
  subscribeWithSelector(
    immer((set, get) => ({
      // ── Initial state ──
      bots:          [],
      selectedBotId: null,
      filterStatus:  "all",
      filterSearch:  "",
      isLoading:     false,

      // ── Bulk actions ──

      setBots: (bots) =>
        set((state) => {
          // Ensure every bot has a stats object (bots.list returns raw DB rows
          // without a joined bot_stats row — guard here so BotCard never
          // crashes on bot.stats.totalMessages)
          //
          // FIX-AUDIT: this fallback previously used invented field names
          // (avgResponseTimeMs, errorRate, engagementScore) that don't exist
          // anywhere in the real BotStats type or the bot_stats DB schema
          // (verified against apps/api/src/db/schemas/schema.ts — the actual
          // columns are totalGreetings/totalCommands/returningUsers). Any bot
          // without a joined stats row got an object shaped nothing like real
          // BotStats; reading bot.stats.totalCommands etc. for such a bot
          // would silently return undefined despite the type promising a
          // number. Corrected to match BotStats exactly.
          state.bots = bots.map((b) => ({
            ...b,
            stats: b.stats ?? {
              totalMessages:  0,
              totalGreetings: 0,
              totalCommands:  0,
              uptimeSeconds:  0,
              uniqueUsers:    0,
              returningUsers: 0,
            },
          }));
          state.isLoading = false;
        }),

      upsertBot: (bot) =>
        set((state) => {
          const idx = state.bots.findIndex((b) => b.id === bot.id);
          if (idx >= 0) {
            state.bots[idx] = bot;
          } else {
            state.bots.push(bot);
          }
        }),

      removeBot: (botId) =>
        set((state) => {
          state.bots = state.bots.filter((b) => b.id !== botId);
          if (state.selectedBotId === botId) {
            state.selectedBotId = null;
          }
        }),

      // ── Targeted WS mutations ──
      // These MUST be O(1) index lookups — called on every WS event

      updateBotStatus: (botId, status, error) =>
        set((state) => {
          const bot = state.bots.find((b) => b.id === botId);
          if (bot) {
            bot.status = status;
            // Store error on bot for display in BotCard
            (bot as any).connectionError = error;
          }
        }),

      updateBotHealth: (botId, score) =>
        set((state) => {
          const bot = state.bots.find((b) => b.id === botId);
          if (bot) bot.healthScore = score;
        }),

      updateBotStats: (botId, statsDelta) =>
        set((state) => {
          const bot = state.bots.find((b) => b.id === botId);
          if (bot) {
            // FIX-AUDIT: spreading Partial<BotStats> onto BotStats makes TS
            // infer every merged field as `T | undefined` (a known limitation
            // of spread-type inference over Partial<T> — it can't statically
            // know a key was omitted vs. explicitly set to undefined), which
            // fails against BotStats' required fields under
            // exactOptionalPropertyTypes. The merge is genuinely BotStats-
            // shaped at runtime: statsDelta is a WS delta payload that only
            // ever includes changed fields, never an explicit `undefined`.
            bot.stats = { ...bot.stats, ...statsDelta } as BotStats;
          }
        }),

      updateBotRoom: (botId, roomId) =>
        set((state) => {
          const bot = state.bots.find((b) => b.id === botId);
          if (bot) bot.activeRoomId = roomId;
        }),

      updateLastSeen: (botId, ts) =>
        set((state) => {
          const bot = state.bots.find((b) => b.id === botId);
          if (bot) bot.lastSeen = ts;
        }),

      // ── Selection ──

      selectBot: (botId) =>
        set((state) => {
          state.selectedBotId = botId;
        }),

      // ── Filters ──

      setFilterStatus: (status) =>
        set((state) => {
          state.filterStatus = status;
        }),

      setFilterSearch: (query) =>
        set((state) => {
          state.filterSearch = query;
        }),

      // ── Derived selectors (called inline, not stored) ──

      getFilteredBots: () => {
        const { bots, filterStatus, filterSearch } = get();
        return bots.filter((bot) => {
          if (filterStatus !== "all" && bot.status !== filterStatus) return false;
          if (filterSearch) {
            const q = filterSearch.toLowerCase();
            return (
              bot.name.toLowerCase().includes(q) ||
              bot.tags.some((t) => t.toLowerCase().includes(q)) ||
              bot.id.includes(q)
            );
          }
          return true;
        });
      },

      getOnlineBots: () => get().bots.filter((b) => b.status === "online"),

      getBotById: (id) => get().bots.find((b) => b.id === id),

      getStats: () => {
        const { bots } = get();
        return {
          online:  bots.filter((b) => b.status === "online").length,
          offline: bots.filter((b) => b.status === "offline").length,
          error:   bots.filter((b) => b.status === "error").length,
          total:   bots.length,
        };
      },
    })),
  ),
);
