import { judgeRun, newRunState, type RunState } from "./runWatch";
import * as sp from "./spotify";
import type { Track } from "./types";

export interface RunHooks {
  onTrack(index: number, track: Track): void;
  onProgress(ms: number, durationMs: number): void;
  onEnd(): void;
  onTrouble(message: string): void; // Spotify didn't start / went away
}

// Plays one songs block: hands Spotify exactly these tracks, then watches until
// Spotify stops by itself after the last one. No playlist, no repeat mode, no
// racing to pause at the right moment — nothing left to spill or repeat.
export class SongRun {
  private state: RunState = newRunState();
  private timer: number | null = null;
  private stopped = false;
  private pausedByUs = false;
  private startedAt = 0;
  private reissued = false;
  private index = -1;
  private uris: string[];
  private startAt = 0; // where in the list Spotify was told to start (after a reorder)
  private replayOnResume = false;

  constructor(private deviceId: string, private tracks: Track[], private hooks: RunHooks) {
    this.uris = tracks.map(t => t.uri);
  }

  async start(): Promise<void> {
    // Order must be exactly ours, and it must not loop.
    await sp.setShuffle(this.deviceId, false);
    await sp.setRepeat(this.deviceId, "off");
    if (!(await sp.playUris(this.deviceId, this.uris))) {
      await sp.transfer(this.deviceId);
      await sp.sleep(400);
      if (!(await sp.playUris(this.deviceId, this.uris))) {
        this.hooks.onTrouble("Spotify didn't start the songs");
      }
    }
    this.startedAt = Date.now();
    this.schedule(700);
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.poll(), ms);
  }

  private async poll() {
    this.timer = null;
    if (this.stopped || this.pausedByUs) return;
    const s = await sp.snapshot();
    if (this.stopped || this.pausedByUs) return;
    const v = judgeRun(this.uris, s, this.state);

    switch (v.kind) {
      case "waiting": {
        const waited = Date.now() - this.startedAt;
        // Spotify sometimes accepts the play command and then doesn't act on it.
        if (waited > 5000 && !this.reissued) {
          this.reissued = true;
          await sp.playUris(this.deviceId, this.uris, this.startAt);
        } else if (waited > 15000) {
          this.hooks.onTrouble("Spotify isn't playing — is the Spotify app open?");
          this.reissued = false;
          this.startedAt = Date.now();
        }
        return this.schedule(1000);
      }
      case "playing":
      case "paused": {
        if (v.index !== this.index) {
          this.index = v.index;
          this.hooks.onTrack(v.index, this.tracks[v.index]);
        }
        this.hooks.onProgress(s.progressMs, s.durationMs);
        const onLast = v.index === this.uris.length - 1;
        const left = s.durationMs - s.progressMs;
        return this.schedule(onLast && left < 6000 ? 350 : 1000);
      }
      case "spilled":
        // Something that isn't ours started (Spotify autoplay, or a loop): stop it now.
        await sp.pauseVerified(this.deviceId);
        return this.finish();
      case "ended":
        return this.finish();
      default:
        return this.schedule(1000);
    }
  }

  private finish() {
    if (this.stopped) return;
    this.stop(false);
    this.hooks.onEnd();
  }

  async skip(): Promise<void> {
    if (this.stopped) return;
    if (this.index >= this.uris.length - 1 || this.index < 0) {
      await sp.pauseVerified(this.deviceId);
      this.finish();
      return;
    }
    await sp.next(this.deviceId);
    this.schedule(400);
  }

  // Jump within the current song (dragging the progress bar). Seeking into the
  // very end of the last song is fine: Spotify just finishes the list and stops.
  async seek(ms: number): Promise<void> {
    if (this.stopped) return;
    await sp.seek(this.deviceId, ms);
    if (!this.pausedByUs) this.schedule(400);
  }

  async pause(): Promise<void> {
    this.pausedByUs = true;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    await sp.pauseVerified(this.deviceId);
  }

  async resume(): Promise<void> {
    this.pausedByUs = false;
    if (this.replayOnResume) {
      this.replayOnResume = false;
      await this.replay();
    } else {
      await sp.resume(this.deviceId);
    }
    this.schedule(700);
  }

  // He reordered the songs mid-show. The songs already played and the one
  // playing stay; the rest of this block's list is swapped for `tracks`. Spotify
  // is handed the new list and carries on with the current song from where it
  // was (a brief hiccup while it catches up).
  async replaceUpcoming(tracks: Track[]): Promise<void> {
    if (this.stopped) return;
    const keep = this.index >= 0 ? this.index + 1 : 0;
    const next = [...this.tracks.slice(0, keep), ...tracks.slice(keep)];
    if (next.map(t => t.uri).join() === this.uris.join()) return;
    this.tracks = next;
    this.uris = next.map(t => t.uri);
    this.state = newRunState();
    this.startAt = Math.max(this.index, 0);
    this.reissued = false;
    this.startedAt = Date.now();
    if (this.pausedByUs) { this.replayOnResume = true; return; }
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    await this.replay();
    this.schedule(700);
  }

  private async replay(): Promise<void> {
    let pos = 0;
    if (this.index >= 0) {
      const s = await sp.snapshot();
      if (s.ok && s.itemUri === this.uris[this.startAt]) pos = s.progressMs;
    }
    await sp.playUris(this.deviceId, this.uris, this.startAt, pos);
  }

  stop(pauseSpotify = true): void {
    this.stopped = true;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (pauseSpotify) void sp.pauseVerified(this.deviceId);
  }
}
