/**
 * Songs for KojyAI Radio from Jamendo: free, Creative Commons music with a
 * public API (a free client id from devportal.jamendo.com). MP3s at 96 kbps
 * ("mp31"), which keeps each listener at about 43 MB an hour.
 * OWNERSHIP: apps/api/src/modules/radio
 */

export interface Track {
  id: string;
  title: string;
  artist: string;
  /** The MP3 to stream. */
  audio: string;
  seconds: number;
  /** Who asked for it in the room (null: the station's own mix). */
  requestedBy: string | null;
}

const API = "https://api.jamendo.com/v3.0/tracks/";

interface JamendoTrack { id?: unknown; name?: unknown; artist_name?: unknown; audio?: unknown; duration?: unknown }

function toTracks(body: unknown): Track[] {
  const results = (body as { results?: JamendoTrack[] } | null)?.results;
  if (!Array.isArray(results)) return [];
  return results
    .filter((t) => typeof t.audio === "string" && /^https:\/\//.test(t.audio) && t.id != null)
    .map((t) => ({
      id: String(t.id),
      title: String(t.name ?? "Untitled").slice(0, 100),
      artist: String(t.artist_name ?? "Unknown artist").slice(0, 80),
      audio: t.audio as string,
      seconds: Number(t.duration) || 0,
      requestedBy: null,
    }));
}

async function get(params: Record<string, string>): Promise<Track[]> {
  const url = `${API}?${new URLSearchParams({ format: "json", audioformat: "mp31", ...params })}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const body = await res.json().catch(() => null) as { headers?: { status?: string; error_message?: string } } | null;
  if (!res.ok || body?.headers?.status === "failed") {
    throw new Error(`Jamendo said no: ${body?.headers?.error_message || `HTTP ${res.status}`}`);
  }
  return toTracks(body);
}

/** The best matches for what someone typed ("lofi", "artist - song"). */
export function searchTracks(clientId: string, query: string, limit = 5): Promise<Track[]> {
  return get({ client_id: clientId, search: query.slice(0, 100), limit: String(limit), order: "relevance" });
}

/** Popular tracks with every one of these style tags ("rock", "chill lofi"); none when they aren't styles. */
export function styleTracks(clientId: string, query: string, limit = 10): Promise<Track[]> {
  return get({ client_id: clientId, tags: query.toLowerCase().slice(0, 60), limit: String(limit), order: "popularity_month" });
}

/** This week's popular tracks: the station's mix when nobody has asked for anything. */
export function popularTracks(clientId: string, limit = 50): Promise<Track[]> {
  return get({ client_id: clientId, limit: String(limit), order: "popularity_week" });
}

const STOP = new Set(["the", "a", "an", "by", "of", "and", "feat", "ft", "song", "music", "by"]);
const words = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);

/**
 * The tracks that really match what someone asked for: every word they
 * typed (beyond little ones like "the") is in the title or the artist.
 * Jamendo's search always answers with something, and for a famous song
 * that something is a different song with a similar name.
 */
export function strictMatches(query: string, tracks: Track[]): Track[] {
  const wanted = words(query).filter((w) => !STOP.has(w));
  if (!wanted.length) return [];
  return tracks.filter((t) => {
    const have = new Set(words(`${t.title} ${t.artist}`));
    return wanted.every((w) => have.has(w));
  });
}
