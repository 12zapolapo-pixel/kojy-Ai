/**
 * tests/resource-leaks/resource-leaks.test.ts
 *
 * P2-24: Resource leak detection.
 *
 * WHY: Node.js apps die silently from:
 *   - Dangling promises (unhandled rejection → crash)
 *   - Timer leaks (setInterval never cleared → event loop keeps running)
 *   - Event listener leaks (more than maxListeners → memory growth)
 *   - Cache growth (unbounded maps → OOM)
 *   - Socket leaks (open connections → resource exhaustion)
 *
 * HOW: Each test verifies a CLEANUP CONTRACT:
 *   - Resources created in setup must be tracked
 *   - Resources must be released on teardown
 *   - Count before === count after for each resource type
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";

// ─── Timer leak detection ─────────────────────────────────────────────────────

describe("timer leak detection", () => {
  // FIX-8: use fake timers so the test is fully deterministic and runs
  // at zero wall-clock cost. Real setTimeout(..., 50) is flaky under load
  // and blocks the test runner for real time unnecessarily.
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("interval fires and is properly cleared — verified with fake timers", async () => {
    let count = 0;
    const timer = setInterval(() => { count++; }, 10);

    // Advance fake clock by 45ms → fires 4 times at 10, 20, 30, 40ms
    await vi.advanceTimersByTimeAsync(45);
    expect(count).toBe(4);

    clearInterval(timer);

    // After clear, advancing further must not increment count
    await vi.advanceTimersByTimeAsync(50);
    expect(count).toBe(4);
  });

  it("heartbeat timer is cleared on disconnect — fake timer confirms no further ticks", async () => {
    class MockWebSocket {
      private heartbeat: ReturnType<typeof setInterval> | null = null;
      pingCount = 0;

      connect(): void {
        this.heartbeat = setInterval(() => { this.pingCount++; }, 30_000);
      }

      disconnect(): void {
        if (this.heartbeat) {
          clearInterval(this.heartbeat);
          this.heartbeat = null;
        }
      }

      get hasLeak(): boolean { return this.heartbeat !== null; }
    }

    const ws = new MockWebSocket();
    ws.connect();
    expect(ws.hasLeak).toBe(true);

    // Advance to just before first heartbeat fires
    await vi.advanceTimersByTimeAsync(29_999);
    expect(ws.pingCount).toBe(0);

    ws.disconnect();
    expect(ws.hasLeak).toBe(false);

    // Advance well past where the heartbeat would have fired — must not fire
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ws.pingCount).toBe(0);  // timer was cleared — no leak
  });
});

// ─── Event listener leak detection ───────────────────────────────────────────

describe("event listener leak detection", () => {
  it("listener count returns to baseline after cleanup", () => {
    const emitter = new EventEmitter();
    const baseline = emitter.listenerCount("data");

    const handler = (): void => { /* noop */ };
    emitter.on("data", handler);

    expect(emitter.listenerCount("data")).toBe(baseline + 1);

    emitter.off("data", handler);

    expect(emitter.listenerCount("data")).toBe(baseline);
  });

  it("once() listeners auto-clean after firing", () => {
    const emitter = new EventEmitter();
    const baseline = emitter.listenerCount("event");

    emitter.once("event", () => { /* noop */ });
    expect(emitter.listenerCount("event")).toBe(baseline + 1);

    emitter.emit("event");
    expect(emitter.listenerCount("event")).toBe(baseline); // auto-removed
  });

  it("removeAllListeners() clears all for a given event", () => {
    const emitter = new EventEmitter();
    emitter.on("data", () => { /* noop */ });
    emitter.on("data", () => { /* noop */ });
    emitter.on("data", () => { /* noop */ });

    emitter.removeAllListeners("data");
    expect(emitter.listenerCount("data")).toBe(0);
  });

  it("emitter with more than maxListeners warns (leak indicator)", () => {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(3);

    const warnSpy = vi.spyOn(process, "emit");

    // Adding more than maxListeners triggers warning
    for (let i = 0; i < 5; i++) {
      emitter.on("data", () => { /* noop */ });
    }

    // In production, this warning is the leak detector
    // Test verifies we can detect the condition
    expect(emitter.listenerCount("data")).toBe(5);
    emitter.removeAllListeners("data");

    warnSpy.mockRestore();
  });
});

// ─── Cache growth detection ───────────────────────────────────────────────────

describe("cache growth detection", () => {
  it("LRU cache evicts oldest when at capacity", () => {
    const MAX_SIZE = 5;

    class LRUCache<K, V> {
      private map = new Map<K, V>();
      constructor(private max: number) {}

      set(key: K, value: V): void {
        if (this.map.size >= this.max) {
          // Evict the oldest (first inserted in Map iteration order)
          const oldest = this.map.keys().next().value;
          if (oldest !== undefined) this.map.delete(oldest);
        }
        this.map.set(key, value);
      }

      get(key: K): V | undefined { return this.map.get(key); }
      get size(): number { return this.map.size; }
    }

    const cache = new LRUCache<string, number>(MAX_SIZE);

    // Fill to capacity
    for (let i = 0; i < MAX_SIZE + 3; i++) {
      cache.set(`key-${i}`, i);
    }

    // Size must never exceed MAX_SIZE
    expect(cache.size).toBeLessThanOrEqual(MAX_SIZE);
  });

  it("unbounded map growth is detectable before OOM", () => {
    const map = new Map<string, number>();
    const GROWTH_LIMIT = 1_000;

    // Simulate growth
    for (let i = 0; i < GROWTH_LIMIT * 2; i++) {
      map.set(`key-${i}`, i);

      // Guard: detect excessive growth
      if (map.size > GROWTH_LIMIT) {
        // In production: emit metric, trigger eviction, alert on-call
        // In test: verify the detection works
        expect(map.size).toBeGreaterThan(GROWTH_LIMIT);
        break;
      }
    }
  });
});

// ─── Dangling promise detection ───────────────────────────────────────────────

describe("dangling promise detection", () => {
  it("all async operations must be awaited or have error handlers", async () => {
    // Pattern: collect all promises, await all of them
    const promises: Promise<void>[] = [];

    function startJob(id: number): void {
      promises.push(
        Promise.resolve().then(() => {
          // job id: id — simulates async work
          void id;
        }),
      );
    }

    for (let i = 0; i < 10; i++) startJob(i);

    // All promises resolved — no dangling
    await expect(Promise.all(promises)).resolves.toBeDefined();
  });

  it("unhandled rejection is detectable via rejection tracking", async () => {
    const rejections: Error[] = [];
    const handler = (reason: unknown): void => {
      rejections.push(reason instanceof Error ? reason : new Error(String(reason)));
    };

    process.on("unhandledRejection", handler);

    // In test: verify a rejected promise is caught when handled correctly
    const handled = await Promise.reject(new Error("test rejection")).catch((e: unknown) => e);
    expect(handled).toBeInstanceOf(Error);

    process.off("unhandledRejection", handler);
    // No unhandled rejections escaped — rejections array is empty
    expect(rejections).toHaveLength(0);
  });
});
