import type { NowPlaying } from "./spotify";
import type { Block, Track } from "./types";

export function dedupe(tracks: Track[]): Track[] {
  const seen = new Set<string>();
  return tracks.filter(t => (seen.has(t.uri) ? false : (seen.add(t.uri), true)));
}

// Finds the song that's currently up in a playlist. Spotify sometimes reports a
// different id for the same song than the one stored in the playlist
// ("relinking" for the listener's country), so fall back to the linked id, then
// to name + artist.
export function findCurrent(list: Track[], now: NowPlaying | null): number {
  const t = now?.track;
  if (!t) return -1;
  let i = list.findIndex(x => x.uri === t.uri || (now!.linkedUri !== null && x.uri === now!.linkedUri));
  if (i === -1) i = list.findIndex(x => x.name === t.name && x.artist === t.artist);
  return i;
}

// The playlist, rotated so the current song comes first (played from its start).
export function startingAt(list: Track[], at: number): Track[] {
  if (at <= 0) return dedupe(list);
  return dedupe([...list.slice(at), ...list.slice(0, at)]);
}

// Works out exactly which songs every songs block will play, in show order.
// Songs he picked himself stay put; every other slot takes the next song from
// the playlist, never repeating a song already used earlier in the same show,
// and never a song listed in `exclude` (e.g. the song he talks over).
export function assignSongs(blocks: Block[], pool: Track[], offset: number, exclude: string[] = []): Map<string, Track[]> {
  const result = new Map<string, Track[]>();
  const used = new Set<string>(exclude);
  for (const b of blocks) {
    if (b.type !== "songs") continue;
    for (const t of b.manual ?? []) if (t) used.add(t.uri);
  }

  let cursor = pool.length ? ((offset % pool.length) + pool.length) % pool.length : 0;
  let scanned = 0;
  const nextFromPool = (): Track | null => {
    while (pool.length && scanned < pool.length) {
      const t = pool[cursor];
      cursor = (cursor + 1) % pool.length;
      scanned++;
      if (!used.has(t.uri)) {
        used.add(t.uri);
        return t;
      }
    }
    return null;
  };

  for (const b of blocks) {
    if (b.type !== "songs") continue;
    const count = Math.max(1, b.count ?? 1);
    const list: Track[] = [];
    for (let i = 0; i < count; i++) {
      const picked = b.manual?.[i] ?? null;
      const t = picked ?? nextFromPool();
      if (t) list.push(t);
    }
    result.set(b.id, list);
  }
  return result;
}

// How many songs from the pool a show consumes, so the next show can start after them.
export function autoSongsUsed(blocks: Block[]): number {
  let n = 0;
  for (const b of blocks) {
    if (b.type !== "songs") continue;
    const count = Math.max(1, b.count ?? 1);
    for (let i = 0; i < count; i++) if (!b.manual?.[i]) n++;
  }
  return n;
}

// The playlist after he dragged songs into a new order (☰). `rotated` is the
// playlist from the show's first song; `rows` is his new order for the songs he
// could move. Songs already played (`locked`) go first, in their played order,
// and songs he picked for a slot himself go last — so, used with offset 0,
// assignSongs gives the same songs so far and his new order from here on.
export function rebuildPool(rotated: Track[], rows: Track[], locked: Set<string>, manual: Set<string>): Track[] {
  return dedupe([...rotated.filter(t => locked.has(t.uri) && !manual.has(t.uri)), ...rows, ...rotated.filter(t => manual.has(t.uri))]);
}
