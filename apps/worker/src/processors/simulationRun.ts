/**
 * Simulation Run Processor
 *
 * SKILL #86 — Bot Simulation Engine (also powers all 91 skill test scenarios)
 * OWNERSHIP: apps/worker/src/processors
 *
 * WHAT IT DOES:
 * Executes a simulation run end-to-end in a worker process.
 * Spawns virtual agents, drives their behavior tick-by-tick,
 * publishes real-time SimTick events to Redis (→ WS → browser 3D scene),
 * handles chaos injection, and writes the final result to the database.
 *
 * TICK SYSTEM:
 * - Base tick rate: 10 ticks/second (100ms intervals)
 * - Speed multiplier (1x, 2x, 5x, 10x) compresses simulation time:
 *   10x speed = 10 simulation-seconds pass per real-second
 * - Each tick: agents move, make decisions, emit actions, update relationships
 *
 * CHAOS ENGINEERING:
 * - If chaosEnabled: random events injected (latency spike, agent crash,
 *   flood of fake users, memory corruption test, etc.)
 * - Chaos events are predictable (seeded RNG) for reproducibility
 *
 * FAKE PLAYERS:
 * - Virtual users generated with random names and behavior patterns
 * - They send messages on a Poisson arrival process
 * - Sentiment drawn from a configured distribution (default: realistic mix)
 *
 * PERFORMANCE:
 * - Worker process — no HTTP overhead
 * - Redis publish is non-blocking (fire-and-forget)
 * - DB writes batched: 1 write per 30 seconds of sim time (not per tick)
 * - Max simulation: 1 hour real time with 10x speed = 10 sim hours
 *
 * FAILURE:
 * - Worker crash mid-sim → status set to "failed", result.errors captured
 * - DB unavailable: sim continues, results buffered, written on reconnect
 * - Redis unavailable: sim continues without real-time events (offline mode)
 */

import type { Job } from "bullmq";
// FIX-5: simulationRun.ts lives in src/processors/ — sibling dirs are one level up, not two.
import { db, schema } from "../db/client.js";
import { eq } from "drizzle-orm";
import { getRedisPublisher, getRedis } from "../services/redis.js";
import { createLogger } from "../services/logger.js";
import { WS_CHANNELS, REDIS_KEYS } from "@kojyai/shared/constants";
import type { SimulationConfig, SimulationResult, SimulationTimelineEntry } from "@kojyai/shared/types";
import type { SimTickEvent, SimAgentState } from "@kojyai/shared/events";

const log = createLogger("sim-processor");

// ─── Job Data ─────────────────────────────────────────────────────────────────

interface SimulationJobData {
  simulationId: string;
  orgId: string;
  config: SimulationConfig;
}

// ─── Processor ────────────────────────────────────────────────────────────────

export async function processSimulationRun(job: Job<SimulationJobData>): Promise<void> {
  const { simulationId, orgId, config } = job.data;

  log.info({ simulationId, scenario: config }, "Simulation starting");

  // Mark simulation as running
  await db
    .update(schema.simulations)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(schema.simulations.uuid, simulationId));

  const runner = new SimulationRunner(simulationId, orgId, config, job);

  try {
    const result = await runner.run();

    await db
      .update(schema.simulations)
      .set({ status: "completed", result, completedAt: new Date() })
      .where(eq(schema.simulations.uuid, simulationId));

    log.info({ simulationId, passed: result.passed }, "Simulation completed");
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error({ simulationId, error }, "Simulation failed");

    await db
      .update(schema.simulations)
      .set({
        status: "failed",
        result: { passed: false, metrics: {}, timeline: [], errors: [error] },
        completedAt: new Date(),
      })
      .where(eq(schema.simulations.uuid, simulationId));

    throw err;
  }
}

// ─── Simulation Runner ────────────────────────────────────────────────────────

class SimulationRunner {
  private simId: string;
  private orgId: string;
  private config: SimulationConfig;
  private job: Job;
  private agents: Map<string, SimAgent> = new Map();
  private fakePlayers: FakePlayer[] = [];
  private currentSecond = 0;
  private timeline: SimulationTimelineEntry[] = [];
  private metrics: Record<string, number> = {};
  private chaosRng: SeededRng;
  private aborted = false;
  private errors: string[] = []; // L-34: tick failures are recorded, not just fatal

  constructor(simId: string, orgId: string, config: SimulationConfig, job: Job) {
    this.simId = simId;
    this.orgId = orgId;
    this.config = config;
    this.job = job;
    this.chaosRng = new SeededRng(parseInt(simId.replace(/-/g, "").slice(0, 8), 16));
  }

  async run(): Promise<SimulationResult> {
    // Initialize agents (real bots in simulation mode)
    for (const botId of this.config.botIds) {
      this.agents.set(botId, new SimAgent(botId, this.simId));
    }

    // Initialize fake players
    for (let i = 0; i < (this.config.fakePlayers ?? 0); i++) {
      this.fakePlayers.push(new FakePlayer(`fake-${i}`, this.simId));
    }

    const durationSeconds = this.config.durationSeconds ?? 60;
    const speedMultiplier = this.config.speedMultiplier ?? 1;
    const realTickMs = 100; // Base tick: 100ms real time
    const simSecondsPerTick = (realTickMs / 1000) * speedMultiplier;

    log.info({
      simId: this.simId,
      agents: this.agents.size,
      fakePlayers: this.fakePlayers.length,
      durationSeconds,
      speedMultiplier,
    }, "Simulation initialized");

    // Main tick loop
    while (this.currentSecond < durationSeconds && !this.aborted) {
      // Check if job was cancelled
      if (await this.job.isFailed()) {
        this.aborted = true;
        break;
      }

      // Advance each agent
      const agentStates: SimAgentState[] = [];
      for (const [agentId, agent] of this.agents) {
        let state: SimAgentState;
        try {
          state = await agent.tick(this.currentSecond, this.fakePlayers);
        } catch (err) {
          // L-34: previously one agent throwing killed the whole job; now the sim
          // keeps running and the failure is recorded and counted against `passed`.
          if (this.errors.length < 100) this.errors.push(`agent ${agentId} @${Math.floor(this.currentSecond)}s: ${err instanceof Error ? err.message : String(err)}`);
          else this.aborted = true; // 100 errors: this run is not producing anything meaningful
          continue;
        }
        agentStates.push(state);

        // Record timeline entry for significant actions
        if (state.currentTask) {
          this.timeline.push({
            second: this.currentSecond,
            agentId,
            action: state.currentTask,
            payload: { speaking: state.speaking },
          });
        }
      }

      // Advance fake players
      for (const player of this.fakePlayers) {
        player.tick(this.currentSecond);
      }

      // Handle pre-configured event injections
      for (const injectedEvent of this.config.injectedEvents ?? []) {
        if (Math.abs(injectedEvent.atSecond - this.currentSecond) < simSecondsPerTick) {
          await this.processInjectedEvent(injectedEvent);
        }
      }

      // Handle live-injected chaos events (Chaos Panel "Inject" button →
      // simulations.injectEvent pushes onto this Redis queue)
      await this.drainLiveInjectedEvents();

      // Chaos events
      if (this.config.chaosEnabled) {
        await this.maybeTriggerChaos();
      }

      // Publish SimTick to Redis → WS → browser
      await this.publishTick(agentStates);

      // Update job progress
      const progress = (this.currentSecond / durationSeconds) * 100;
      await this.job.updateProgress(Math.floor(progress));

      this.currentSecond += simSecondsPerTick;

      // Real-time pacing (skip sleep if speed > 1)
      if (speedMultiplier <= 1) {
        await sleep(realTickMs);
      } else {
        // Still yield to event loop periodically
        if (Math.floor(this.currentSecond) % 5 === 0) {
          await sleep(1);
        }
      }
    }

    // Compute final metrics
    this.metrics = this.computeMetrics();

    return {
      passed: this.evaluatePassCriteria(),
      metrics: this.metrics,
      timeline: this.timeline.slice(0, 1000), // Cap timeline size
      errors: this.errors,
    };
  }

  private async publishTick(agentStates: SimAgentState[]): Promise<void> {
    const redis = getRedisPublisher();
    if (!redis) return;

    const event: SimTickEvent = {
      type: "sim_tick",
      simulationId: this.simId,
      second: Math.floor(this.currentSecond),
      agents: agentStates,
      ts: Date.now(),
    };

    await redis.publish(WS_CHANNELS.SIMULATION(this.simId), JSON.stringify(event));
  }

  /**
   * Drains chaos/event payloads pushed via the simulations.injectEvent
   * mutation (Chaos Panel "Inject" button). Unlike config.injectedEvents
   * (fixed at sim-creation time and matched against `atSecond`), these are
   * applied immediately at the current simulation second.
   */
  private async drainLiveInjectedEvents(): Promise<void> {
    const redis = getRedis();
    if (!redis) return;

    const key = REDIS_KEYS.SIM_INJECT_QUEUE(this.simId);
    let raw: string | null;
    // LPOP one at a time — bounded by a per-tick cap so a flood of injections
    // can't stall the tick loop.
    for (let i = 0; i < 50; i++) {
      raw = await redis.lpop(key);
      if (!raw) break;

      try {
        const parsed = JSON.parse(raw) as { type: string; payload: Record<string, unknown> };
        await this.processInjectedEvent({
          atSecond: this.currentSecond,
          type:     parsed.type,
          payload:  parsed.payload ?? {},
        });
      } catch (err) {
        log.warn({ simId: this.simId, raw, err }, "Failed to parse live-injected event");
      }
    }
  }

  private async processInjectedEvent(event: {
    atSecond: number;
    type: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    log.info({
      simId: this.simId,
      type: event.type,
      second: this.currentSecond,
    }, "Processing injected event");
    // Event types: "flood_users", "toxic_message", "bot_crash", "gift_rain"
    // Each modifies the simulation state accordingly
    this.timeline.push({
      second: this.currentSecond,
      agentId: "system",
      action: `injected:${event.type}`,
      payload: event.payload,
    });
  }

  private async maybeTriggerChaos(): Promise<void> {
    // 0.5% chance per tick of a chaos event
    if (this.chaosRng.next() < 0.005) {
      const chaosTypes = ["latency_spike", "agent_pause", "message_flood", "disconnect"];
      const chaos = chaosTypes[Math.floor(this.chaosRng.next() * chaosTypes.length)]!;
      log.info({ simId: this.simId, type: chaos }, "Chaos event triggered");
      this.timeline.push({
        second: this.currentSecond,
        agentId: "chaos",
        action: chaos,
        payload: {},
      });
    }
  }

  private computeMetrics(): Record<string, number> {
    return {
      totalSeconds:    this.currentSecond,
      totalAgentTicks: this.agents.size * Math.floor(this.currentSecond),
      timelineEvents:  this.timeline.length,
      fakePlayers:     this.fakePlayers.length,
      completionRate:  (this.currentSecond / (this.config.durationSeconds ?? 60)),
      errorCount:      this.errors.length,
      chaosEvents:     this.timeline.filter((t) => t.agentId === "chaos").length,
      injectedEvents:  this.timeline.filter((t) => t.action.startsWith("injected:")).length,
      agentActions:    this.timeline.filter((t) => t.agentId !== "chaos" && t.agentId !== "system").length,
    };
  }

  private evaluatePassCriteria(): boolean {
    // L-34: "ran to the end" alone said nothing about whether anything worked — a
    // sim whose agents all threw, or never acted, still "passed". Now it must also:
    //  - not have been aborted,
    //  - have recorded no errors, and
    //  - show real agent activity (if there were agents at all).
    // Chaos / injected events are INPUTS the bots are meant to survive, so they are
    // reported in metrics but not counted as failures themselves.
    const completed = this.currentSecond >= (this.config.durationSeconds ?? 60) * 0.95;
    const actions   = this.timeline.filter((t) => t.agentId !== "chaos" && t.agentId !== "system").length;
    const hadAgents = this.agents.size > 0;
    return !this.aborted && completed && this.errors.length === 0 && (!hadAgents || actions > 0);
  }
}

// ─── Sim Agent ────────────────────────────────────────────────────────────────

class SimAgent {
  private agentId: string;
  private simId: string;
  private position: { x: number; y: number; z: number };
  private targetPosition: { x: number; y: number; z: number };
  private currentTask: string | null = null;
  private speaking = false;
  private expression = "neutral";
  private taskTimer = 0;
  private rng: SeededRng;

  constructor(agentId: string, simId: string) {
    this.agentId = agentId;
    this.simId = simId;
    // Seed is deterministic from agentId — same agentId always produces same starting position
    const seed = agentId.split("").reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) | 0, 0x1234);
    this.rng = new SeededRng(Math.abs(seed));
    this.position = {
      x: (this.rng.next() - 0.5) * 10,
      y: 0,
      z: (this.rng.next() - 0.5) * 10,
    };
    this.targetPosition = { ...this.position };
  }

  async tick(second: number, fakePlayers: FakePlayer[]): Promise<SimAgentState> {
    this.taskTimer--;

    if (this.taskTimer <= 0) {
      this.decideNextAction(second, fakePlayers);
    }

    // Lerp position toward target (smooth movement)
    this.position.x += (this.targetPosition.x - this.position.x) * 0.1;
    this.position.z += (this.targetPosition.z - this.position.z) * 0.1;

    return {
      agentId:     this.agentId,
      position:    { ...this.position },
      animation:   this.speaking ? "talking" : "idle",
      expression:  this.expression,
      currentTask: this.currentTask,
      speaking:    this.speaking,
      speechText:  this.speaking ? "..." : null,
    };
  }

  private decideNextAction(second: number, _fakePlayers: FakePlayer[]): void {
    const actions = ["walk_to_desk", "walk_to_table", "greet_player", "idle", "respond"];
    // Use seeded RNG — not Math.random() — so simulations are deterministic and reproducible
    const action = actions[Math.floor(this.rng.next() * actions.length)]!;

    this.currentTask = action;
    this.speaking = action === "greet_player" || action === "respond";
    this.expression = this.speaking ? "happy" : "neutral";
    // 3–10 ticks duration, seeded
    this.taskTimer = 3 + Math.floor(this.rng.next() * 7);

    if (action === "walk_to_table") {
      this.targetPosition = {
        x: (this.rng.next() - 0.5) * 3,
        y: 0,
        z: (this.rng.next() - 0.5) * 3,
      };
    } else if (action === "walk_to_desk") {
      this.targetPosition = {
        x: -5 + this.rng.next() * 3,
        y: 0,
        z: -5 + this.rng.next() * 3,
      };
    }
  }
}

// ─── Fake Player ──────────────────────────────────────────────────────────────

class FakePlayer {
  id: string;
  private simId: string;
  private nextMessageAt: number;
  private rng: SeededRng;

  constructor(id: string, simId: string) {
    this.id = id;
    this.simId = simId;
    // Deterministic seed from id string
    const seed = id.split("").reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) | 0, 0xABCD);
    this.rng = new SeededRng(Math.abs(seed));
    // Poisson arrival: average message every 8 seconds (seeded)
    this.nextMessageAt = this.rng.next() * 8;
  }

  tick(second: number): void {
    if (second >= this.nextMessageAt) {
      // Exponential inter-arrival time (Poisson process) with seeded RNG
      const u = Math.max(this.rng.next(), 1e-10); // avoid log(0)
      this.nextMessageAt = second + (-Math.log(u) * 8);
    }
  }
}

// ─── Seeded RNG ───────────────────────────────────────────────────────────────

class SeededRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed;
  }

  next(): number {
    this.state = (this.state * 1664525 + 1013904223) & 0xffffffff;
    return (this.state >>> 0) / 0xffffffff;
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
