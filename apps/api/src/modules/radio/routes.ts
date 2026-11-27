/**
 * KojyAI Radio: each bot can have its own internet radio station that a
 * Highrise room plays (Room settings → custom radio URL → the .pls link).
 *
 *   GET  /radio/<bot uuid>.pls          the playlist file Highrise takes
 *   GET  /radio/<bot uuid>/stream.mp3   the live stream itself
 *   GET  /radio/<bot uuid>/now          what's playing and the queue (JSON)
 *   POST /radio/<bot uuid>/request      {query, user} — queue a song (bot only)
 *   POST /radio/<bot uuid>/skip         skip the current song (bot only)
 *   POST /radio/<bot uuid>/clear        empty the queue (bot only)
 *
 * Songs come from Jamendo with the client id in the bot's secrets
 * (JAMENDO_CLIENT_ID). Requests and skips need the bot's radio key
 * (KOJY_RADIO_TOKEN, given to the bot by the runner).
 * OWNERSHIP: apps/api/src/modules/radio
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { checkRadioToken, decryptApiKey } from "@kojyai/shared/crypto";
import { db, schema } from "../../db/client.js";
import { createLogger } from "../../utils/logger.js";
import { popularTracks, searchTracks, strictMatches, styleTracks, type Track } from "./jamendo.js";
import { MAX_QUEUE, Station, streamListener } from "./station.js";

const log = createLogger("radio");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_DOWNLOAD = 25 * 1024 * 1024;

const stations = new Map<string, Station>();
const clientIds = new Map<string, { id: string | null; at: number }>();
const mixes = new Map<string, { tracks: Track[]; at: number }>();
const lastRequest = new Map<string, number>();

/** The bot's Jamendo client id (its secret, else the server's), cached for a minute. */
async function clientIdFor(uuid: string): Promise<string | null> {
  const cached = clientIds.get(uuid);
  if (cached && Date.now() - cached.at < 60_000) return cached.id;
  let id: string | null = null;
  const [project] = await db.select({ id: schema.botProjects.id }).from(schema.botProjects).where(eq(schema.botProjects.uuid, uuid)).limit(1);
  if (project) {
    const [secret] = await db.select().from(schema.projectSecrets)
      .where(and(eq(schema.projectSecrets.projectId, project.id), eq(schema.projectSecrets.key, "JAMENDO_CLIENT_ID"))).limit(1);
    try { id = secret ? decryptApiKey(secret.valueVault).trim() || null : null; } catch { id = null; }
    id ??= process.env.JAMENDO_CLIENT_ID?.trim() || null;
  }
  clientIds.set(uuid, { id, at: Date.now() });
  return id;
}

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_DOWNLOAD) throw new Error("song file too big");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > MAX_DOWNLOAD) throw new Error("song file too big");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function stationFor(uuid: string): Station {
  let s = stations.get(uuid);
  if (!s) {
    s = new Station(uuid, {
      download,
      log: (msg, extra) => log.warn({ station: uuid, ...extra }, msg),
      nextFromMix: async (recent) => {
        const clientId = await clientIdFor(uuid);
        if (!clientId) return null;
        let mix = mixes.get(clientId);
        if (!mix || Date.now() - mix.at > 3600_000) {
          mix = { tracks: await popularTracks(clientId), at: Date.now() };
          mixes.set(clientId, mix);
        }
        const fresh = mix.tracks.filter((t) => !recent.has(t.id));
        const pool = fresh.length ? fresh : mix.tracks;
        return pool.length ? pool[Math.floor(Math.random() * pool.length)]! : null;
      },
    });
    stations.set(uuid, s);
  }
  return s;
}

function publicBase(c: { req: { header(name: string): string | undefined } }): string {
  const configured = process.env.FRONTEND_URL?.trim().replace(/\/$/, "");
  if (configured && /^https?:\/\//.test(configured) && !/localhost/.test(configured)) return configured;
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "localhost";
  const proto = c.req.header("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}

function describe(t: Track | null) {
  return t ? { title: t.title, artist: t.artist, seconds: t.seconds, requestedBy: t.requestedBy } : null;
}

export const radioRoutes = new Hono();

// The playlist file Highrise asks for.
radioRoutes.get("/:file{[0-9a-f-]{36}\\.pls}", async (c) => {
  const uuid = c.req.param("file").slice(0, -4);
  if (!UUID.test(uuid) || !(await clientIdFor(uuid))) return c.text("This radio isn't set up.", 404);
  const stream = `${publicBase(c)}/api/radio/${uuid}/stream.mp3`;
  c.header("Content-Type", "audio/x-scpls");
  c.header("Cache-Control", "no-cache");
  return c.body(`[playlist]\nNumberOfEntries=1\nFile1=${stream}\nTitle1=KojyAI Radio\nLength1=-1\nVersion=2\n`);
});

// The live stream.
radioRoutes.get("/:uuid/stream.mp3", async (c) => {
  const uuid = c.req.param("uuid");
  if (!UUID.test(uuid) || !(await clientIdFor(uuid))) return c.text("This radio isn't set up.", 404);
  const station = stationFor(uuid);
  let listener: ReturnType<typeof streamListener> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      listener = streamListener(controller);
      if (!station.addListener(listener)) { listener.close(); }
    },
    cancel() { if (listener) station.removeListener(listener); },
  }, { highWaterMark: 0 });
  return new Response(body, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-cache, no-store",
      "icy-name": "KojyAI Radio",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

// What's playing (public: Highrise shows nothing, but the bot's !np does).
radioRoutes.get("/:uuid/now", async (c) => {
  const uuid = c.req.param("uuid");
  if (!UUID.test(uuid) || !(await clientIdFor(uuid))) return c.json({ error: "This radio isn't set up." }, 404);
  const s = stations.get(uuid);
  return c.json({
    playing: describe(s?.playing ?? null),
    elapsed: s?.playing ? Math.round((Date.now() - s.playing.startedAt) / 1000) : 0,
    queue: (s?.queue ?? []).map(describe),
    listeners: s?.listenerCount ?? 0,
  });
});

async function authorized(c: { req: { param(n: "uuid"): string; header(n: string): string | undefined } }): Promise<string | null> {
  const uuid = c.req.param("uuid");
  if (!UUID.test(uuid)) return null;
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  return checkRadioToken(uuid, token) ? uuid : null;
}

// Queue a song: the bot passes what someone typed after !play.
radioRoutes.post("/:uuid/request", async (c) => {
  const uuid = await authorized(c);
  if (!uuid) return c.json({ error: "Not allowed." }, 403);
  const clientId = await clientIdFor(uuid);
  if (!clientId) return c.json({ error: "The radio isn't set up: add JAMENDO_CLIENT_ID to the bot's secrets." }, 409);
  const last = lastRequest.get(uuid) ?? 0;
  if (Date.now() - last < 1500) return c.json({ error: "One request at a time — try again in a second." }, 429);
  lastRequest.set(uuid, Date.now());
  const input = await c.req.json().catch(() => ({})) as { query?: unknown; user?: unknown };
  const query = typeof input.query === "string" ? input.query.trim().slice(0, 100) : "";
  if (!query) return c.json({ error: "Say what to play, e.g. !play chill lofi" }, 400);
  let found: Track[];
  try { found = await searchTracks(clientId, query, 10); }
  catch (err) { log.warn({ station: uuid, err: (err as Error).message }, "Jamendo search failed"); return c.json({ error: "The music library didn't answer — try again." }, 502); }
  // Only a real match is queued; otherwise say so (famous songs aren't in the free library).
  let matches = strictMatches(query, found);
  if (!matches.length && /^[\p{L}\p{N} -]{2,40}$/u.test(query)) {
    // Not a song or artist name — maybe a style ("rock", "chill lofi"): a popular song in it.
    const styled = await styleTracks(clientId, query).catch(() => [] as Track[]);
    if (styled.length) matches = [styled[Math.floor(Math.random() * Math.min(styled.length, 10))]!];
  }
  if (!matches.length) {
    const close = found.slice(0, 2).map((t) => `${t.title} — ${t.artist}`);
    return c.json({
      error: `"${query}" isn't in the free music library (it has independent artists, not chart hits).` +
        (close.length ? ` Closest: ${close.join(" / ")}` : ""),
      suggestions: found.slice(0, 2).map(describe),
    }, 404);
  }
  const track = { ...matches[0]!, requestedBy: typeof input.user === "string" ? input.user.slice(0, 40) : null };
  const result = stationFor(uuid).request(track);
  if ("error" in result) return c.json({ error: result.error, track: describe(track) }, 409);
  return c.json({ track: describe(track), position: result.position, max: MAX_QUEUE });
});

radioRoutes.post("/:uuid/skip", async (c) => {
  const uuid = await authorized(c);
  if (!uuid) return c.json({ error: "Not allowed." }, 403);
  const s = stations.get(uuid);
  return c.json({ skipped: !!s?.skip() });
});

radioRoutes.post("/:uuid/clear", async (c) => {
  const uuid = await authorized(c);
  if (!uuid) return c.json({ error: "Not allowed." }, 403);
  return c.json({ removed: stations.get(uuid)?.clear() ?? 0 });
});
