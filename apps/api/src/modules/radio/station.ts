/**
 * One bot's radio station: a queue of requested songs, the station's own mix
 * when the queue is empty, and one live MP3 stream that every listener hears
 * at the same point (like a real radio). Songs are sent frame by frame at
 * their real speed; a listener who joins gets the last few seconds at once,
 * so playback starts right away.
 *
 * It only plays while someone listens (plus a short grace period), so an
 * empty room costs nothing.
 * OWNERSHIP: apps/api/src/modules/radio
 */

import { mp3Frames } from "./mp3.js";
import type { Track } from "./jamendo.js";

export const MAX_QUEUE = 30;
export const MAX_LISTENERS = 60;
const MAX_TRACK_BYTES = 25 * 1024 * 1024;
const LEAD_MS = 1500;        // how far ahead of real time listeners are fed
const BURST_MS = 3000;       // what a new listener gets at once
const CHUNK_MS = 250;
const IDLE_STOP_MS = 2 * 60_000;
const SLOW_LISTENER_BYTES = 2 * 1024 * 1024; // a listener this far behind is let go

export interface Listener { send(bytes: Uint8Array): boolean; close(): void }

export interface StationDeps {
  /** The station's mix when nobody asked for anything (null: no songs available). */
  nextFromMix(recent: Set<string>): Promise<Track | null>;
  /** The MP3 itself. */
  download(url: string): Promise<Uint8Array>;
  log(msg: string, extra?: Record<string, unknown>): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class Station {
  readonly queue: Track[] = [];
  playing: (Track & { startedAt: number }) | null = null;
  private listeners = new Set<Listener>();
  private recentBytes: { at: number; bytes: Uint8Array }[] = [];
  private recentIds: string[] = [];
  private running = false;
  private skipRequested = false;
  private lastListenerAt = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(readonly key: string, private deps: StationDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get listenerCount(): number { return this.listeners.size; }
  get isRunning(): boolean { return this.running; }

  /** A new listener: hears the last few seconds at once, then the live stream. False when full. */
  addListener(l: Listener): boolean {
    if (this.listeners.size >= MAX_LISTENERS) return false;
    this.listeners.add(l);
    this.lastListenerAt = this.now();
    for (const r of this.recentBytes) l.send(r.bytes);
    if (!this.running) void this.run();
    return true;
  }

  removeListener(l: Listener): void {
    this.listeners.delete(l);
    this.lastListenerAt = this.now();
  }

  /** Adds a requested song. Returns its place in the queue (1 = next), or an error. */
  request(track: Track): { position: number } | { error: string } {
    if (this.queue.some((t) => t.id === track.id) || this.playing?.id === track.id) return { error: "That song is already playing or queued." };
    if (this.queue.length >= MAX_QUEUE) return { error: `The queue is full (${MAX_QUEUE} songs).` };
    this.queue.push(track);
    return { position: this.queue.length };
  }

  /** Empties the queue (the song playing now goes on). Returns how many were removed. */
  clear(): number {
    const n = this.queue.length;
    this.queue.length = 0;
    return n;
  }

  skip(): boolean {
    if (!this.playing) return false;
    this.skipRequested = true;
    return true;
  }

  private broadcast(bytes: Uint8Array): void {
    const at = this.now();
    this.recentBytes.push({ at, bytes });
    while (this.recentBytes.length && at - this.recentBytes[0]!.at > BURST_MS) this.recentBytes.shift();
    for (const l of this.listeners) {
      if (!l.send(bytes)) { this.listeners.delete(l); l.close(); }
    }
  }

  private idleTooLong(): boolean {
    return this.listeners.size === 0 && this.now() - this.lastListenerAt > IDLE_STOP_MS;
  }

  private async nextTrack(): Promise<Track | null> {
    const asked = this.queue.shift();
    if (asked) return asked;
    return this.deps.nextFromMix(new Set(this.recentIds));
  }

  private async run(): Promise<void> {
    this.running = true;
    try {
      while (!this.idleTooLong()) {
        const track = await this.nextTrack().catch((err: Error) => { this.deps.log("Couldn't pick a song", { err: err.message }); return null; });
        if (!track) { await this.sleep(10_000); continue; }
        let bytes: Uint8Array;
        try {
          bytes = await this.deps.download(track.audio);
          if (bytes.length > MAX_TRACK_BYTES) throw new Error("song file too big");
        } catch (err) {
          this.deps.log("Couldn't load a song — skipping it", { track: track.id, err: (err as Error).message });
          await this.sleep(1000);
          continue;
        }
        const frames = mp3Frames(bytes);
        if (!frames.length) { this.deps.log("Not an MP3 — skipping it", { track: track.id }); continue; }
        this.playing = { ...track, startedAt: this.now() };
        this.recentIds = [track.id, ...this.recentIds.filter((id) => id !== track.id)].slice(0, 20);
        this.skipRequested = false;
        await this.play(bytes, frames);
        this.playing = null;
      }
    } finally {
      this.running = false;
      this.playing = null;
      this.recentBytes = [];
    }
  }

  /** Sends one song at its real speed, a little ahead of real time. */
  private async play(bytes: Uint8Array, frames: { offset: number; length: number; ms: number }[]): Promise<void> {
    let clock = this.now();
    let i = 0;
    while (i < frames.length) {
      if (this.skipRequested || this.idleTooLong()) return;
      const ahead = clock - this.now();
      if (ahead > LEAD_MS) { await this.sleep(Math.min(ahead - LEAD_MS + 10, CHUNK_MS)); continue; }
      const start = frames[i]!.offset;
      let ms = 0;
      while (i < frames.length && ms < CHUNK_MS) { ms += frames[i]!.ms; i++; }
      const end = i < frames.length ? frames[i]!.offset : frames[frames.length - 1]!.offset + frames[frames.length - 1]!.length;
      this.broadcast(bytes.subarray(start, end));
      clock += ms;
    }
    // Let the last part play out before the next song starts.
    const rest = clock - this.now();
    if (rest > 0) await this.sleep(rest);
  }
}

/** A listener on a web stream: false when it's gone or too far behind. */
export function streamListener(controller: ReadableStreamDefaultController<Uint8Array>): Listener {
  let open = true;
  return {
    send(bytes) {
      if (!open) return false;
      if ((controller.desiredSize ?? 0) < -SLOW_LISTENER_BYTES) return false;
      try { controller.enqueue(bytes); return true; } catch { open = false; return false; }
    },
    close() {
      if (!open) return;
      open = false;
      try { controller.close(); } catch { /* already closed */ }
    },
  };
}
