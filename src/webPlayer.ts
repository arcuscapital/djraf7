import { getToken } from "./auth";

// Spotify's Web Playback SDK: plays a song *in the browser* instead of in the
// Spotify app. Only used for "record over the next song", because that needs
// the song turned down under his voice and Spotify won't let the app change
// the Spotify app's volume on his phone. Here the volume is ours.
//
// Phones only allow this after a tap, so prepare() is called when he taps
// Start Show. The player shows up in Spotify as a speaker called "Krom FM".

export const PLAYER_NAME = "Krom FM";

/* eslint-disable @typescript-eslint/no-explicit-any */
type SdkState = {
  paused: boolean;
  position: number;
  duration: number;
  track_window: { current_track: { uri: string; name: string } | null; previous_tracks: { uri: string }[] };
};
type SdkPlayer = {
  connect(): Promise<boolean>;
  disconnect(): void;
  activateElement(): Promise<void>;
  addListener(event: string, cb: (x: any) => void): void;
  getCurrentState(): Promise<SdkState | null>;
  setVolume(v: number): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
};
declare global {
  interface Window { Spotify?: { Player: new (opts: any) => SdkPlayer }; onSpotifyWebPlaybackSDKReady?: () => void }
}

let sdkLoading: Promise<void> | null = null;
function loadSdk(): Promise<void> {
  if (window.Spotify) return Promise.resolve();
  sdkLoading ??= new Promise<void>((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = () => resolve();
    const s = document.createElement("script");
    s.src = "https://sdk.scdn.co/spotify-player.js";
    s.onerror = () => reject(new Error("sdk"));
    document.head.appendChild(s);
    setTimeout(() => reject(new Error("sdk timeout")), 15000);
  });
  return sdkLoading;
}

let player: SdkPlayer | null = null;
let deviceId: string | null = null;
let readyWait: Promise<string | null> | null = null;
const stateListeners = new Set<(s: SdkState | null) => void>();

// Create and connect the player (call from a tap). Resolves with the device id,
// or null if the browser can't play Spotify (no DRM, no Premium, offline…).
export function prepare(): Promise<string | null> {
  if (deviceId) return Promise.resolve(deviceId);
  readyWait ??= (async () => {
    try {
      await loadSdk();
      const p = new window.Spotify!.Player({
        name: PLAYER_NAME,
        getOAuthToken: (cb: (t: string) => void) => { void getToken().then(t => { if (t) cb(t); }); },
        volume: 1
      });
      player = p;
      const ready = new Promise<string | null>(resolve => {
        p.addListener("ready", (e: { device_id: string }) => resolve(e.device_id));
        p.addListener("not_ready", () => { deviceId = null; });
        for (const ev of ["initialization_error", "authentication_error", "account_error", "playback_error"]) {
          p.addListener(ev, (e: { message?: string }) => { console.warn("web player", ev, e?.message); if (ev !== "playback_error") resolve(null); });
        }
        p.addListener("player_state_changed", (s: SdkState | null) => stateListeners.forEach(cb => cb(s)));
        setTimeout(() => resolve(null), 12000);
      });
      try { await p.activateElement(); } catch { /* not needed on desktop */ }
      if (!(await p.connect())) return null;
      deviceId = await ready;
      return deviceId;
    } catch {
      return null;
    } finally {
      if (!deviceId) readyWait = null; // so a later tap can try again
    }
  })();
  return readyWait;
}

export const isReady = () => deviceId !== null;
export const device = () => deviceId;

export function onState(cb: (s: SdkState | null) => void): () => void {
  stateListeners.add(cb);
  return () => stateListeners.delete(cb);
}
export const getState = () => player?.getCurrentState() ?? Promise.resolve(null);
export const setVolume = (v: number) => player?.setVolume(Math.max(0, Math.min(1, v))) ?? Promise.resolve();
export const pause = () => player?.pause() ?? Promise.resolve();
export const resume = () => player?.resume() ?? Promise.resolve();

// Smoothly from one volume to another (the song coming up after his voice).
export async function ramp(from: number, to: number, ms: number): Promise<void> {
  const steps = 15;
  for (let i = 1; i <= steps; i++) {
    await setVolume(from + ((to - from) * i) / steps);
    await new Promise(r => setTimeout(r, ms / steps));
  }
}
