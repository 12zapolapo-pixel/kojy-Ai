/**
 * Simulation Store — Zustand
 *
 * OWNERSHIP: apps/web/src/state
 * LAYER: Frontend state — simulation runtime data
 *
 * KEY PATTERN:
 * The Three.js SimulationScene subscribes to this store IMPERATIVELY
 * using useSimulationStore.subscribe() — NOT inside React components.
 * This means agent position updates never trigger React re-renders.
 * Only the control panel (speed, status) triggers React re-renders.
 */

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import type { SimulationStatus } from "@kojyai/shared/types";
import type { SimAgentState } from "@kojyai/shared/events";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SimulationStore {
  // Active simulation identity
  activeSimulationId: string | null;
  status:             SimulationStatus;
  progress:           number; // 0–100

  // Playback controls (React-reactive — used in PlaybackOverlay)
  speed:          number; // 1 | 2 | 5 | 10
  currentSecond:  number;
  totalSeconds:   number;
  isPaused:       boolean;

  // Agent states (updated 20x/sec via batched WS — NOT React-reactive for 3D)
  // Three.js reads this via store.subscribe(), not useSimulationStore()
  agents: Record<string, SimAgentState>;

  // Decision log entries
  decisionLog: DecisionLogEntry[];

  // Actions
  setActiveSimulation:  (id: string, totalSeconds: number) => void;
  setSimulationStatus:  (id: string, status: SimulationStatus, progress: number) => void;
  applyTick:            (simId: string, second: number, agents: SimAgentState[]) => void;
  setSpeed:             (speed: number) => void;
  setPaused:            (paused: boolean) => void;
  pushDecisionEntry:    (entry: DecisionLogEntry) => void;
  clearSimulation:      () => void;
}

export interface DecisionLogEntry {
  id:        string;
  second:    number;
  agentId:   string;
  action:    string;
  reasoning: string;
  outcome:   "success" | "failure" | "pending";
  ts:        number;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useSimulationStore = create<SimulationStore>()(
  subscribeWithSelector(
    immer((set, get) => ({
      activeSimulationId: null,
      status:             "draft",
      progress:           0,
      speed:              1,
      currentSecond:      0,
      totalSeconds:       0,
      isPaused:           false,
      agents:             {},
      decisionLog:        [],

      setActiveSimulation: (id, totalSeconds) =>
        set((state) => {
          state.activeSimulationId = id;
          state.totalSeconds = totalSeconds;
          state.currentSecond = 0;
          state.agents = {};
          state.decisionLog = [];
          state.status = "draft";
          state.progress = 0;
        }),

      setSimulationStatus: (id, status, progress) =>
        set((state) => {
          if (state.activeSimulationId !== id) return;
          state.status = status;
          state.progress = progress;
        }),

      // Called by wsStore after 50ms SimTick batch — NOT called per-tick from React
      applyTick: (simId, second, agents) =>
        set((state) => {
          if (state.activeSimulationId !== simId) return;
          state.currentSecond = second;
          // Update each agent's state
          for (const agentState of agents) {
            state.agents[agentState.agentId] = agentState;
          }
        }),

      setSpeed: (speed) =>
        set((state) => {
          state.speed = speed;
        }),

      setPaused: (paused) =>
        set((state) => {
          state.isPaused = paused;
        }),

      pushDecisionEntry: (entry) =>
        set((state) => {
          state.decisionLog.unshift(entry);
          // Cap at 500 entries
          if (state.decisionLog.length > 500) {
            state.decisionLog.length = 500;
          }
        }),

      clearSimulation: () =>
        set((state) => {
          state.activeSimulationId = null;
          state.agents = {};
          state.decisionLog = [];
          state.currentSecond = 0;
          state.status = "draft";
          state.progress = 0;
        }),
    })),
  ),
);
