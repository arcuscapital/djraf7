import { formatDescription, parseDescription, PLAYLIST_NAME } from "./cloudFormat";
import * as sp from "./spotify";
import type { Trophies } from "./trophies";

// His records, kept in his Spotify account so every phone adds to the same
// total: a private playlist called "Krom FM data" whose description holds the
// numbers. No server, no account to make — it's wherever he's logged into
// Spotify. (The playlist shows up in his library; the text asks not to delete it.)

const CACHE_KEY = "djraf6_cloud_playlist";
let playlistId: string | null = localStorage.getItem(CACHE_KEY);

async function findOrCreate(seed: Trophies): Promise<string | null> {
  if (playlistId) return playlistId;
  const lists = await sp.getMyPlaylists();
  const found = lists.find(p => p.name === PLAYLIST_NAME);
  let id = found?.id ?? null;
  if (!id) id = await sp.createPrivatePlaylist(PLAYLIST_NAME, formatDescription(seed));
  if (id) { playlistId = id; localStorage.setItem(CACHE_KEY, id); }
  return id;
}

// The totals in his Spotify account. `seed` is what a brand-new playlist starts
// with (his records from before this version). Null when Spotify can't be reached.
export async function cloudLoad(seed: Trophies): Promise<Trophies | null> {
  try {
    const id = await findOrCreate(seed);
    if (!id) return null;
    const desc = await sp.getPlaylistDescription(id);
    const t = parseDescription(desc);
    if (t) return t;
    // Playlist exists but the description was wiped or edited: start it again from the seed.
    await sp.setPlaylistDescription(id, formatDescription(seed));
    return seed;
  } catch {
    return null;
  }
}

export async function cloudSave(t: Trophies): Promise<boolean> {
  try {
    const id = await findOrCreate(t);
    if (!id) return false;
    return await sp.setPlaylistDescription(id, formatDescription(t));
  } catch {
    return false;
  }
}
