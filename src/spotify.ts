import { getToken, refresh } from "./auth";
import type { Snapshot } from "./runWatch";
import type { Track } from "./types";

const API = "https://api.spotify.com/v1";

export class SpotifyError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// Every call goes through here: attaches the token, refreshes it once on 401,
// and retries the transient 429/502/503 answers Spotify gives when a device is
// still busy with the previous command (seen a lot live with the original app).
async function call(path: string, init: RequestInit = {}, retries = 2): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const token = await getToken();
    if (!token) throw new SpotifyError(401, "not logged in");
    let res: Response;
    try {
      res = await fetch(API + path, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers }
      });
    } catch {
      if (attempt < retries) { await sleep(500); continue; }
      throw new SpotifyError(0, "network");
    }
    if (res.status === 401 && attempt === 0 && (await refresh())) continue;
    if ((res.status === 429 || res.status === 502 || res.status === 503) && attempt < retries) {
      const wait = Number(res.headers.get("Retry-After") ?? 0) * 1000 || 500;
      await sleep(Math.min(wait, 3000));
      continue;
    }
    return res;
  }
}

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function json<T>(path: string): Promise<T | null> {
  const res = await call(path);
  if (res.status === 204) return null;
  if (!res.ok) throw new SpotifyError(res.status, `${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function command(path: string, method: "PUT" | "POST", body?: unknown): Promise<boolean> {
  const res = await call(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.ok;
}

// ---------- devices ----------
export interface Device { id: string; name: string; is_active: boolean; type: string; volume_percent: number | null; supports_volume?: boolean }

export async function getDevices(): Promise<Device[]> {
  const d = await json<{ devices: Device[] }>("/me/player/devices");
  return d?.devices ?? [];
}

// ---------- reading what's playing ----------
interface RawTrack { uri: string; name: string; duration_ms: number; artists?: { name: string }[]; type?: string; is_local?: boolean; linked_from?: { uri: string } }
const toTrack = (t: RawTrack): Track => ({ uri: t.uri, name: t.name, artist: t.artists?.[0]?.name ?? "", durationMs: t.duration_ms });
const isPlayable = (t: RawTrack | null | undefined): t is RawTrack => !!t && t.uri?.startsWith("spotify:track:") && !t.is_local;

export interface NowPlaying { track: Track | null; linkedUri: string | null; contextUri: string | null; contextType: string | null; progressMs: number; isPlaying: boolean }

export async function getNowPlaying(): Promise<NowPlaying | null> {
  const d = await json<{ item: RawTrack | null; context: { uri: string; type: string } | null; progress_ms: number; is_playing: boolean }>("/me/player/currently-playing");
  if (!d) return null;
  return {
    track: isPlayable(d.item) ? toTrack(d.item) : null,
    linkedUri: d.item?.linked_from?.uri ?? null,
    contextUri: d.context?.uri ?? null,
    contextType: d.context?.type ?? null,
    progressMs: d.progress_ms ?? 0,
    isPlaying: !!d.is_playing
  };
}

export async function snapshot(): Promise<Snapshot> {
  try {
    const res = await call("/me/player/currently-playing", {}, 1);
    if (res.status === 204) return { ok: true, noContent: true, isPlaying: false, itemUri: null, progressMs: 0, durationMs: 0 };
    if (!res.ok) return { ok: false, noContent: false, isPlaying: false, itemUri: null, progressMs: 0, durationMs: 0 };
    const d = await res.json();
    return {
      ok: true,
      noContent: !d.item,
      isPlaying: !!d.is_playing,
      itemUri: d.item?.uri ?? null,
      progressMs: d.progress_ms ?? 0,
      durationMs: d.item?.duration_ms ?? 0
    };
  } catch {
    return { ok: false, noContent: false, isPlaying: false, itemUri: null, progressMs: 0, durationMs: 0 };
  }
}

// One song by id (e.g. from a pasted link).
export async function getTrack(id: string): Promise<Track | null> {
  const d = await json<RawTrack>(`/tracks/${id}`);
  return d && isPlayable(d) ? toTrack(d) : null;
}

// Spotify's own "up next" list — works for any playlist, including Spotify's.
export async function getQueue(): Promise<Track[]> {
  const d = await json<{ currently_playing: RawTrack | null; queue: RawTrack[] }>("/me/player/queue");
  return (d?.queue ?? []).filter(isPlayable).map(toTrack);
}

export interface PlaylistInfo { id: string; name: string; tracks: number; image: string | null }

export async function getMyPlaylists(): Promise<PlaylistInfo[]> {
  const out: PlaylistInfo[] = [];
  let path: string | null = "/me/playlists?limit=50";
  while (path && out.length < 200) {
    const d: { items: { id: string; name: string; tracks?: { total: number }; items?: { total: number }; images?: { url: string }[] | null }[]; next: string | null } | null = await json(path);
    for (const p of d?.items ?? []) {
      if (p) out.push({ id: p.id, name: p.name, tracks: p.items?.total ?? p.tracks?.total ?? 0, image: p.images?.[0]?.url ?? null });
    }
    path = d?.next ? d.next.replace(API, "") : null;
  }
  return out;
}

export async function getPlaylistName(id: string): Promise<string | null> {
  try {
    const d = await json<{ name: string }>(`/playlists/${id}?fields=name`);
    return d?.name ?? null;
  } catch {
    return null;
  }
}

// Only works for playlists he owns or collaborates on (Spotify's 2026 rules).
export async function getPlaylistTracks(id: string): Promise<Track[]> {
  const out: Track[] = [];
  let path: string | null = `/playlists/${id}/items?limit=100`;
  while (path && out.length < 1000) {
    const d: { items: { item?: RawTrack | null; track?: RawTrack | null }[]; next: string | null } | null = await json(path);
    for (const row of d?.items ?? []) {
      const raw = row.item ?? row.track;
      if (isPlayable(raw)) out.push(toTrack(raw));
    }
    path = d?.next ? d.next.replace(API, "") : null;
  }
  return out;
}

// ---------- controlling playback ----------
export const pause = (deviceId: string) => command(`/me/player/pause?device_id=${deviceId}`, "PUT");

// Spotify sometimes answers "OK" to pause and keeps playing (seen live: the
// talk-over song carried on after the show ended). Check, and ask again.
export async function pauseVerified(deviceId: string): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    await pause(deviceId);
    await sleep(400);
    const s = await snapshot();
    if (s.ok && !s.isPlaying) return true;
  }
  return false;
}
export const resume = (deviceId: string) => command(`/me/player/play?device_id=${deviceId}`, "PUT");
export const next = (deviceId: string) => command(`/me/player/next?device_id=${deviceId}`, "POST");
export const setRepeat = (deviceId: string, state: "off" | "track" | "context") => command(`/me/player/repeat?state=${state}&device_id=${deviceId}`, "PUT");
export const setShuffle = (deviceId: string, on: boolean) => command(`/me/player/shuffle?state=${on}&device_id=${deviceId}`, "PUT");
export const seek = (deviceId: string, ms: number) => command(`/me/player/seek?position_ms=${Math.max(0, Math.round(ms))}&device_id=${deviceId}`, "PUT");
export const setVolume = (deviceId: string, percent: number) => command(`/me/player/volume?volume_percent=${Math.round(percent)}&device_id=${deviceId}`, "PUT");
export const transfer =(deviceId: string) => command(`/me/player`, "PUT", { device_ids: [deviceId], play: false });
// `at`/`positionMs`: start part-way through the list (used when he reorders the
// songs mid-show and the song that's playing carries on where it was).
export const playUris = (deviceId: string, uris: string[], at = 0, positionMs = 0) =>
  command(`/me/player/play?device_id=${deviceId}`, "PUT", at ? { uris, offset: { position: at }, position_ms: positionMs } : { uris, position_ms: positionMs });

// ---------- the "Krom FM data" playlist (his records live in its description) ----------
export async function getPlaylistDescription(id: string): Promise<string | null> {
  const d = await json<{ description: string | null }>(`/playlists/${id}?fields=description`);
  return d?.description ?? "";
}
// (The older /users/{id}/playlists address answers 403 now; /me/playlists works.)
export async function createPrivatePlaylist(name: string, description: string): Promise<string | null> {
  const res = await call("/me/playlists", { method: "POST", body: JSON.stringify({ name, public: false, description }) });
  if (!res.ok) return null;
  const d = (await res.json()) as { id?: string };
  return d.id ?? null;
}
export const setPlaylistDescription = (id: string, description: string) => command(`/playlists/${id}`, "PUT", { description });

