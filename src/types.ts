export type BlockType = "songs" | "jingle" | "talk" | "bed" | "commercial";
// talk: he talks live (background music is a button on the live screen, off
// until he taps it). record: plays his recording.
export type Mode = "talk" | "record";

export interface Track {
  uri: string;
  name: string;
  artist: string;
  durationMs: number;
}

export interface Block {
  id: string;
  type: BlockType;
  // songs blocks
  count?: number;
  // per-slot songs he picked himself; null/missing slots are filled from the playlist
  manual?: (Track | null)[];
  // everything else
  mode?: Mode;
  music?: boolean; // record mode: he had the background music on while recording, so it plays under it on air
  over?: boolean; // record mode: plays over the start of the next song (which then carries on in the foreground)
}

export interface SongSource {
  name: string;
  playlistId: string | null;
  pool: Track[];
  offset: number; // where the next show starts in the pool, so shows don't reuse songs
  mode?: "nowPlaying" | "playlist"; // how it was picked
}
