import { measure, playbackGain } from "./loudness";
import musicUrl from "./assets/raf-music.mp4";
import partySongUrl from "./assets/party-music.mp4";

// All of the app's own sound — jingle chime, background music, recorded
// voice — goes through one AudioContext. Spotify is always paused while any of
// this plays, and the context is suspended again afterwards so Android hands
// audio back to Spotify cleanly when the next song block starts.

let ctx: AudioContext | null = null;
let master: GainNode;

export function audioCtx(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
  }
  return ctx;
}

// Waking the sound engine can stay pending indefinitely (seen live in Brave),
// so never wait on it for more than a moment — a stuck wake-up must not freeze
// the recorder or the show.
function wake(c: AudioContext): Promise<void> {
  if (c.state === "running") return Promise.resolve();
  return Promise.race([c.resume().catch(() => {}), new Promise<void>(r => setTimeout(r, 800))]);
}

// Call from a tap so the browser allows sound later in the show.
export async function unlockAudio(): Promise<void> {
  await wake(audioCtx());
}

let busy = 0;
async function acquire(): Promise<AudioContext> {
  busy++;
  const c = audioCtx();
  await wake(c);
  return c;
}
function release() {
  busy = Math.max(0, busy - 1);
  setTimeout(() => { if (busy === 0 && ctx?.state === "running" && !pausedByUser) ctx.suspend().catch(() => {}); }, 400);
}

let pausedByUser = false;
export async function pauseAll() { pausedByUser = true; await ctx?.suspend().catch(() => {}); }
export async function resumeAll() { pausedByUser = false; if (busy > 0 && ctx) await wake(ctx); }

// ---------- jingle chime (same three notes as the original app) ----------
export async function playChime(): Promise<void> {
  const c = await acquire();
  const notes: [number, number, number][] = [[523, 0, 0.2], [659, 0.2, 0.2], [784, 0.4, 0.4]];
  const t0 = c.currentTime + 0.05;
  for (const [f, at, len] of notes) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.frequency.value = f;
    g.gain.setValueAtTime(0.3, t0 + at);
    g.gain.exponentialRampToValueAtTime(0.01, t0 + at + len);
    o.connect(g).connect(master);
    o.start(t0 + at);
    o.stop(t0 + at + len + 0.05);
  }
  setTimeout(release, 1000);
}

// ---------- end-of-show fanfare ----------
// A happy run up the scale for a dance party; a bigger one for a gold record.
// A happy run up the scale: a little one for a dance party, longer for bronze,
// silver and gold.
const FANFARES: Record<string, [number, number, number][]> = {
  party: [[523, 0, 0.12], [659, 0.12, 0.12], [784, 0.24, 0.12], [1047, 0.36, 0.4]],
  bronze: [[523, 0, 0.14], [659, 0.14, 0.14], [784, 0.28, 0.5]],
  silver: [[523, 0, 0.14], [659, 0.14, 0.14], [784, 0.28, 0.14], [1047, 0.42, 0.55]],
  gold: [[523, 0, 0.14], [659, 0.14, 0.14], [784, 0.28, 0.14], [1047, 0.42, 0.3], [784, 0.75, 0.12], [1047, 0.9, 0.6]]
};
export async function playFanfare(kind: "party" | "bronze" | "silver" | "gold"): Promise<void> {
  const c = await acquire();
  const notes = FANFARES[kind];
  const t0 = c.currentTime + 0.05;
  for (const [f, at, len] of notes) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = "triangle";
    o.frequency.value = f;
    g.gain.setValueAtTime(0.25, t0 + at);
    g.gain.exponentialRampToValueAtTime(0.01, t0 + at + len);
    o.connect(g).connect(master);
    o.start(t0 + at);
    o.stop(t0 + at + len + 0.05);
  }
  setTimeout(release, 2000);
}

// ---------- Raf's dance party: his party song, then the big red button ----------
// The song plays while he DJs; the button stops it like a record being
// switched off (it slows right down). Fetched when the app opens so it's ready.
let partyBytes: Promise<ArrayBuffer | null> | null = null;
export function preloadPartySong(): void {
  partyBytes ??= fetch(partySongUrl).then(r => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
}
let partyBuf: AudioBuffer | null = null;
let partyGain = 1;

export class PartySong {
  private src: AudioBufferSourceNode | null = null;
  private out: GainNode | null = null;
  private live = true; // false once stopped, even if the song is still loading

  constructor() { void this.begin(); }

  private async begin(): Promise<void> {
    const c = await acquire();
    if (!partyBuf) {
      preloadPartySong();
      const bytes = await partyBytes;
      try {
        partyBuf = bytes ? await c.decodeAudioData(bytes.slice(0)) : null;
        if (partyBuf) { const { rms, peak } = measure(partyBuf); partyGain = playbackGain(rms, peak); }
      } catch { partyBuf = null; }
    }
    if (!partyBuf || !this.live) { release(); return; }
    const out = c.createGain();
    out.gain.setValueAtTime(0.0001, c.currentTime);
    out.gain.linearRampToValueAtTime(partyGain, c.currentTime + 0.15);
    out.connect(master);
    const src = c.createBufferSource();
    src.buffer = partyBuf;
    src.loop = true;
    src.connect(out);
    src.start();
    this.src = src;
    this.out = out;
  }

  // The button: a click, and the song winds down to nothing.
  switchOff(): void {
    const c = audioCtx();
    const t = c.currentTime + 0.01;
    const click = c.createOscillator(), cg = c.createGain();
    click.type = "square";
    click.frequency.value = 1400;
    cg.gain.setValueAtTime(0.2, t);
    cg.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    click.connect(cg).connect(master);
    click.start(t); click.stop(t + 0.06);
    if (this.src && this.out) {
      this.src.playbackRate.setValueAtTime(1, t);
      this.src.playbackRate.exponentialRampToValueAtTime(0.06, t + 1.1);
      this.out.gain.setValueAtTime(this.out.gain.value, t + 0.4);
      this.out.gain.linearRampToValueAtTime(0.0001, t + 1.2);
    }
    this.stop(1300);
  }

  stop(afterMs = 300): void {
    if (!this.live) return;
    this.live = false;
    const src = this.src, out = this.out;
    this.src = this.out = null;
    if (!src || !out) return;
    if (afterMs <= 300 && ctx) out.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + afterMs / 1000);
    setTimeout(() => { try { src.stop(); } catch { /* already stopped */ } out.disconnect(); release(); }, afterMs + 50);
  }
}

// ---------- the background music (Raf's song, bundled with the app) ----------
// Played by the app itself, so it's always at the same quiet level (Spotify
// won't let apps change the volume on Raf's phone) and loops seamlessly for
// however long he talks or records.
export const MUSIC_VOLUME = 0.2; // 80% quieter than the song file itself

// Download the song as soon as the app opens, so the first tap plays at once.
let musicBytes: Promise<ArrayBuffer | null> | null = null;
export function preloadMusic(): void {
  musicBytes ??= fetch(musicUrl).then(r => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
}
let musicBuf: AudioBuffer | null = null;
async function musicBuffer(c: AudioContext): Promise<AudioBuffer | null> {
  if (musicBuf) return musicBuf;
  preloadMusic();
  let bytes = await musicBytes;
  if (!bytes) { musicBytes = null; preloadMusic(); bytes = await musicBytes; } // one retry (was offline)
  if (!bytes) return null;
  try { musicBuf = await c.decodeAudioData(bytes.slice(0)); } catch { return null; }
  return musicBuf;
}

export class MusicPlayer {
  private src: AudioBufferSourceNode | null = null;
  private out: GainNode | null = null;
  private gen = 0; // a stop() while the song is still loading cancels that start()
  wanted = false;

  async start(volume = MUSIC_VOLUME): Promise<boolean> {
    this.stop(0);
    const gen = ++this.gen;
    this.wanted = true;
    const c = await acquire();
    const buf = await musicBuffer(c);
    if (!buf || gen !== this.gen) { release(); return false; }
    const out = c.createGain();
    out.gain.setValueAtTime(0.0001, c.currentTime);
    out.gain.linearRampToValueAtTime(volume, c.currentTime + 0.6);
    out.connect(master);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(out);
    src.start();
    this.src = src;
    this.out = out;
    return true;
  }

  stop(fadeMs = 1200): void {
    this.gen++;
    this.wanted = false;
    const src = this.src;
    const out = this.out;
    this.src = null;
    this.out = null;
    if (!src || !out || !ctx) return;
    const c = ctx;
    out.gain.cancelScheduledValues(c.currentTime);
    out.gain.setValueAtTime(out.gain.value, c.currentTime);
    out.gain.linearRampToValueAtTime(0.0001, c.currentTime + Math.max(0.01, fadeMs / 1000));
    setTimeout(() => { try { src.stop(); } catch { /* already stopped */ } out.disconnect(); release(); }, fadeMs + 100);
  }

  get playing(): boolean { return this.src !== null; }
}

// ---------- recorded voice playback ----------
// Decoded into memory rather than an <audio> element: exact length (recorder
// WebM files often report an unknown duration), and pausing is just suspending
// the context.
export class ClipPlayer {
  private src: AudioBufferSourceNode | null = null;
  private startedAt = 0;
  duration = 0;

  async play(blob: Blob, onEnded: () => void): Promise<boolean> {
    const c = await acquire();
    let buf: AudioBuffer;
    try {
      buf = await c.decodeAudioData(await blob.arrayBuffer());
    } catch {
      release();
      return false;
    }
    this.duration = buf.duration;
    // His voice comes out at a steady, normal level whatever distance he spoke from.
    const { rms, peak } = measure(buf);
    const lift = c.createGain();
    lift.gain.value = playbackGain(rms, peak);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(lift).connect(master);
    src.onended = () => {
      if (this.src !== src) return;
      this.src = null;
      release();
      onEnded();
    };
    this.src = src;
    this.startedAt = c.currentTime;
    src.start();
    return true;
  }

  get position(): number {
    return this.src && ctx ? Math.min(this.duration, ctx.currentTime - this.startedAt) : 0;
  }

  stop(): void {
    const s = this.src;
    this.src = null;
    if (s) { try { s.stop(); } catch { /* already stopped */ } release(); }
  }
}

// ---------- microphone recording ----------
export class Recorder {
  private rec: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];

  // All of the browser's call-style voice processing stays OFF. Each of echo
  // cancellation, noise suppression and auto gain can decide a moment of sound
  // is "not voice" and mute the mic — that was the "silent gap" in the original
  // app, and echo cancellation did it again on Raf's phone when the song was
  // playing (it took the music for echo and blanked his voice with it).
  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream);
    this.rec.ondataavailable = e => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start(1000);
  }

  stop(): Promise<Blob | null> {
    return new Promise(resolve => {
      const rec = this.rec;
      if (!rec || rec.state === "inactive") { this.cleanup(); resolve(null); return; }
      rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: rec.mimeType || "audio/webm" });
        this.cleanup();
        resolve(blob);
      };
      rec.stop();
    });
  }

  get recording(): boolean { return this.rec?.state === "recording"; }

  private cleanup() {
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.rec = null;
  }
}
