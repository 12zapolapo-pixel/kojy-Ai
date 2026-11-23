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

/** This week's popular tracks: the station's mix when nobody has asked for anything. */
export function popularTracks(clientId: string, limit = 50): Promise<Track[]> {
  return get({ client_id: clientId, limit: String(limit), order: "popularity_week" });
}
