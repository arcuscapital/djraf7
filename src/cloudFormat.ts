import { normalize, type Trophies } from "./trophies";

// How his records are written into (and read back from) the description of
// the "Krom FM data" playlist. Pure, so it can be tested without a browser.

export const PLAYLIST_NAME = "Krom FM data";
const NOTE = "Krom FM keeps Raf's records here. Please don't delete this playlist!";

export function formatDescription(t: Trophies): string {
  return `${NOTE} ${JSON.stringify({ onAir: t.onAir, bronze: t.bronze, silver: t.silver, gold: t.gold })}`;
}

// Spotify hands descriptions back with HTML escaping (quotes become &quot;).
export function parseDescription(desc: string | null | undefined): Trophies | null {
  if (!desc) return null;
  const text = desc.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&");
  const m = text.match(/\{[^{}]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Partial<Trophies>;
    if (typeof o !== "object" || o === null || !("onAir" in o)) return null;
    return normalize(o);
  } catch {
    return null;
  }
}
