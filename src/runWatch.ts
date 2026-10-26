// Decides, from one snapshot of Spotify's player state, where a "song run"
// (the exact list of tracks one songs block handed to Spotify) is at.
//
// This is the heart of the fix for repeated songs. The old app played a whole
// playlist and had to pause it at exactly the right moment; if it was late,
// Spotify carried on (or looped). Here Spotify is given only this block's
// tracks and stops by itself after the last one, so all we do is notice.

export interface Snapshot {
  ok: boolean; // request succeeded
  noContent: boolean; // Spotify says nothing is loaded
  isPlaying: boolean;
  itemUri: string | null;
  progressMs: number;
  durationMs: number;
}

export interface RunState {
  started: boolean; // we've seen one of our tracks actually playing
  maxIndex: number; // furthest track we've seen
}

export type Verdict =
  | { kind: "waiting" } // our first track hasn't started yet
  | { kind: "playing"; index: number }
  | { kind: "paused"; index: number } // paused mid-song (e.g. in the Spotify app)
  | { kind: "ended" } // stopped after our last track
  | { kind: "spilled" } // something that isn't ours is playing — stop it now
  | { kind: "unknown" }; // couldn't read state this time

const END_TOLERANCE_MS = 2500;

export function newRunState(): RunState {
  return { started: false, maxIndex: -1 };
}

export function judgeRun(run: string[], s: Snapshot, st: RunState): Verdict {
  if (!s.ok) return { kind: "unknown" };
  if (s.noContent || !s.itemUri) return st.started ? { kind: "ended" } : { kind: "waiting" };

  const idx = run.indexOf(s.itemUri);
  if (idx === -1) return st.started ? { kind: "spilled" } : { kind: "waiting" };

  if (s.isPlaying) {
    // Going backwards means Spotify looped the list — the "repeat" we never want.
    if (st.started && idx < st.maxIndex) return { kind: "spilled" };
    st.started = true;
    st.maxIndex = Math.max(st.maxIndex, idx);
    return { kind: "playing", index: idx };
  }

  if (!st.started) return { kind: "waiting" };
  if (idx < st.maxIndex) return { kind: "ended" }; // reset to the top of the list after finishing
  const last = run.length - 1;
  const atEdge = s.progressMs === 0 || s.progressMs >= s.durationMs - END_TOLERANCE_MS;
  if (idx === last && atEdge) return { kind: "ended" };
  return { kind: "paused", index: idx };
}
