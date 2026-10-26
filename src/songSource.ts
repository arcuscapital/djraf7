import * as sp from "./spotify";
import { dedupe, findCurrent, startingAt } from "./songs";
import type { SongSource } from "./types";

// Where the show's songs come from. Default: whatever is playing on Spotify
// right now (open Spotify, start any playlist) — no links, no settings.
//
// The show always starts from the song that's currently up in the playlist,
// from the beginning of that song — not from the playlist's first song, and not
// from the song after it.

export type SourceResult = { ok: true; source: SongSource } | { ok: false; message: string };

async function nowPlaying(): Promise<sp.NowPlaying | null> {
  try { return await sp.getNowPlaying(); } catch { return null; }
}

export async function fromNowPlaying(previous: SongSource | null = null): Promise<SourceResult> {
  const now = await nowPlaying();
  if (!now || (!now.track && !now.contextUri)) {
    return { ok: false, message: "Nothing is playing on Spotify. Open Spotify, play any playlist, then tap “Use what's playing”." };
  }

  const playlistId = now.contextType === "playlist" && now.contextUri ? now.contextUri.split(":").pop()! : null;

  // Best: his own playlist's full track list, starting at the current song.
  if (playlistId) {
    const name = (await sp.getPlaylistName(playlistId)) || "Spotify";
    try {
      const all = await sp.getPlaylistTracks(playlistId);
      if (all.length) return { ok: true, source: { name, playlistId, pool: startingAt(all, findCurrent(all, now)), offset: 0, mode: "nowPlaying" } };
    } catch { /* not his playlist (Spotify only lets apps read your own) — fall back to the queue */ }
    // Spotify's own "up next" list, with the current song first.
    try {
      const queue = dedupe([...(now.track ? [now.track] : []), ...(await sp.getQueue())]);
      if (queue.length) return { ok: true, source: { name, playlistId: null, pool: queue, offset: 0, mode: "nowPlaying" } };
    } catch { /* fall through */ }
  }

  // No playlist loaded. After one of our own shows Spotify sits *paused* on a
  // song we already played — never re-anchor on that (it would replay it). Only
  // follow a song he's actually playing right now.
  if (!now.isPlaying) {
    return { ok: false, message: "Play a playlist in Spotify first, then tap “Use what's playing”." };
  }
  // If the song he's playing is in the playlist we were already using, carry on
  // from it there.
  if (previous?.pool.length) {
    const at = findCurrent(previous.pool, now);
    if (at >= 0) return { ok: true, source: { ...previous, pool: startingAt(previous.pool, at), offset: 0 } };
  }

  try {
    const queue = dedupe([...(now.track ? [now.track] : []), ...(await sp.getQueue())]);
    if (queue.length > 1) return { ok: true, source: { name: now.track ? `From “${now.track.name}”` : "Spotify", playlistId: null, pool: queue, offset: 0, mode: "nowPlaying" } };
  } catch { /* fall through */ }

  return { ok: false, message: "Couldn't read the songs coming up. Play a playlist in Spotify, or try “Choose playlist”." };
}
