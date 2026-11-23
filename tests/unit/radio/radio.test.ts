/**
 * KojyAI Radio: reading MP3 frames, playing a queue at real speed to every
 * listener, the station's mix when nobody asked, and the bot's radio key.
 */
import { beforeAll, describe, expect, it } from "vitest";

process.env.ENCRYPTION_KEY ??= "c".repeat(64);

let mp3: typeof import("../../../apps/api/src/modules/radio/mp3.js");
let st: typeof import("../../../apps/api/src/modules/radio/station.js");
let crypto: typeof import("../../../packages/shared/src/crypto/index.js");
beforeAll(async () => {
  mp3 = await import("../../../apps/api/src/modules/radio/mp3.js");
  st = await import("../../../apps/api/src/modules/radio/station.js");
  crypto = await import("../../../packages/shared/src/crypto/index.js");
});

/** n MPEG-1 Layer III frames at 128 kbps, 44.1 kHz (417 bytes, 26.12 ms each), behind an ID3v2 tag. */
function fakeMp3(n: number, fill = 0x11): Uint8Array {
  const id3 = [0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 5, 0xff, 0xfb, 0xff, 0xfb, 0x00]; // tag body has fake sync bytes
  const frame = new Uint8Array(417).fill(fill);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  const out = new Uint8Array(id3.length + n * 417);
  out.set(id3);
  for (let i = 0; i < n; i++) out.set(frame, id3.length + i * 417);
  return out;
}

describe("MP3 frames", () => {
  it("finds every frame after the ID3 tag, with its length and duration", () => {
    const frames = mp3.mp3Frames(fakeMp3(10));
    expect(frames).toHaveLength(10);
    expect(frames[0]).toMatchObject({ offset: 15, length: 417 });
    expect(frames[0]!.ms).toBeCloseTo(26.12, 1);
  });
  it("ignores junk that isn't audio", () => {
    expect(mp3.mp3Frames(new Uint8Array(5000).fill(0xff))).toHaveLength(0);
    expect(mp3.mp3Frames(new TextEncoder().encode("<html>not a song</html>"))).toHaveLength(0);
  });
});

/** A station on a fake clock: sleeping just moves time forward. */
function fakeStation(mix: (recent: Set<string>) => string | null) {
  let t = 0;
  const played: string[] = [];
  const station = new st.Station("s1", {
    now: () => t,
    sleep: async (ms) => { t += ms; await new Promise((r) => setImmediate(r)); },
    download: async (url) => { played.push(url); return fakeMp3(40); }, // ~1 s per song
    nextFromMix: async (recent) => { const id = mix(recent); return id ? { id, title: id, artist: "a", audio: `mix:${id}`, seconds: 1, requestedBy: null } : null; },
    log: () => undefined,
  });
  return { station, played, time: () => t };
}

const listener = () => {
  const got: Uint8Array[] = [];
  return { got, l: { send: (b: Uint8Array) => { got.push(b); return true; }, close: () => undefined } };
};

const song = (id: string, by = "amy") => ({ id, title: id, artist: "x", audio: `req:${id}`, seconds: 1, requestedBy: by });

describe("a station", () => {
  it("plays requests in order, then its own mix; listeners get the audio at real speed", async () => {
    const { station, played, time } = fakeStation((recent) => (recent.has("m1") ? "m2" : "m1"));
    expect(station.request(song("a"))).toEqual({ position: 1 });
    expect(station.request(song("b"))).toEqual({ position: 2 });
    expect(station.request(song("a"))).toEqual({ error: "That song is already playing or queued." });
    const { got, l } = listener();
    station.addListener(l);
    for (let i = 0; i < 400 && played.length < 4; i++) await new Promise((r) => setImmediate(r));
    expect(played.slice(0, 3)).toEqual(["req:a", "req:b", "mix:m1"]);
    // Two songs of ~1 s each took about 2 s of (fake) time: not faster than real time.
    expect(time()).toBeGreaterThan(1800);
    const bytes = got.reduce((n, b) => n + b.length, 0);
    expect(bytes).toBeGreaterThanOrEqual(2 * 40 * 417);
    station.removeListener(l);
  });

  it("a new listener hears the last few seconds at once; skip moves on", async () => {
    const { station, played } = fakeStation(() => "m1");
    station.request(song("long"));
    const first = listener();
    station.addListener(first.l);
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    const late = listener();
    station.addListener(late.l);
    expect(late.got.length).toBeGreaterThan(0); // the burst
    expect(station.skip()).toBe(true);
    for (let i = 0; i < 200 && played.length < 2; i++) await new Promise((r) => setImmediate(r));
    expect(played[1]).toBe("mix:m1");
    station.removeListener(first.l);
    station.removeListener(late.l);
  });

  it("stops when nobody has listened for a while, and the queue is capped", async () => {
    const { station } = fakeStation(() => null);
    for (let i = 0; i < st.MAX_QUEUE; i++) station.request(song(`s${i}`));
    expect(station.request(song("one-more"))).toEqual({ error: `The queue is full (${st.MAX_QUEUE} songs).` });
    const { l } = listener();
    station.addListener(l);
    station.removeListener(l);
    for (let i = 0; i < 2000 && station.isRunning; i++) await new Promise((r) => setImmediate(r));
    expect(station.isRunning).toBe(false);
  });
});

describe("the bot's radio key", () => {
  it("is per bot and checked in constant time", () => {
    const a = crypto.radioToken("11111111-1111-4111-8111-111111111111");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(crypto.checkRadioToken("11111111-1111-4111-8111-111111111111", a)).toBe(true);
    expect(crypto.checkRadioToken("22222222-2222-4222-8222-222222222222", a)).toBe(false);
    expect(crypto.checkRadioToken("11111111-1111-4111-8111-111111111111", "nope")).toBe(false);
    expect(crypto.checkRadioToken("11111111-1111-4111-8111-111111111111", undefined)).toBe(false);
  });
});

describe("matching requests", () => {
  it("only queues a song whose title or artist has every word asked for", async () => {
    const { strictMatches } = await import("../../../apps/api/src/modules/radio/jamendo.js");
    const t = (title: string, artist: string) => ({ id: title, title, artist, audio: "x", seconds: 1, requestedBy: null });
    const found = [t("Blinding Destiny", "Revalvers"), t("Blinding Lights", "Speedsound"), t("Shape Of Water", "Luiza_D")];
    expect(strictMatches("blinding lights", found).map((x) => x.artist)).toEqual(["Speedsound"]);
    expect(strictMatches("Blinding Lights by Speedsound", found)).toHaveLength(1);
    expect(strictMatches("shape of you", found)).toEqual([]);
    expect(strictMatches("the weeknd", found)).toEqual([]);
    expect(strictMatches("Café Música", [t("Cafe Musica", "Ana")])).toHaveLength(1);
  });
});
