// The reward rule: time on air earns records — bronze, then silver, then gold.
//
// Every 30 minutes on air (songs, jingles, news, recordings — anything playing,
// not paused) earns the next record in the round: 30 min → bronze, another 30
// → silver, another 30 → gold, then a new round starts at bronze. Minutes
// aren't lost when a show stops early; a 3-second show earns nothing.

export const RECORD_MINUTES = 30;
export const RECORDS = ["bronze", "silver", "gold"] as const;
export type Medal = (typeof RECORDS)[number];
const RECORD_SECONDS = RECORD_MINUTES * 60;
const ROUND_SECONDS = RECORDS.length * RECORD_SECONDS;

export interface Trophies {
  onAir: number; // seconds into the current bronze → silver → gold round
  bronze: number;
  silver: number;
  gold: number;
}

export type Celebration = { kind: "party" | Medal; trophies: Trophies };

const count = (v: unknown) => Math.max(0, Math.floor(Number(v)) || 0);
export function normalize(t: Partial<Trophies> | null | undefined): Trophies {
  return { onAir: count(t?.onAir) % ROUND_SECONDS, bronze: count(t?.bronze), silver: count(t?.silver), gold: count(t?.gold) };
}

// Which record he's working towards right now.
export function nextRecord(t: Trophies): Medal {
  return RECORDS[Math.min(RECORDS.length - 1, Math.floor(t.onAir / RECORD_SECONDS))];
}

// Seconds until that record.
export function toNext(t: Trophies): number {
  return (Math.floor(t.onAir / RECORD_SECONDS) + 1) * RECORD_SECONDS - t.onAir;
}

// More seconds on air. `earned` is the record won the moment a 30-minute mark
// is crossed (the last one, if a big jump crosses several).
export function addOnAir(t: Trophies, seconds: number): { trophies: Trophies; earned: Medal | null } {
  let onAir = t.onAir + Math.max(0, seconds);
  const out = { ...t };
  let earned: Medal | null = null;
  let stage = Math.floor(t.onAir / RECORD_SECONDS);
  while (onAir >= (stage + 1) * RECORD_SECONDS) {
    earned = RECORDS[stage];
    out[earned]++;
    stage++;
    if (stage === RECORDS.length) { onAir -= ROUND_SECONDS; stage = 0; }
  }
  return { trophies: { ...out, onAir }, earned };
}

// The show finished: the best record won during it, or a dance party.
export function finishShow(t: Trophies, bestThisShow: Medal | null): Celebration {
  return { kind: bestThisShow ?? "party", trophies: t };
}

export const better = (a: Medal | null, b: Medal): Medal => (a && RECORDS.indexOf(a) > RECORDS.indexOf(b) ? a : b);

export const MEDAL_NAME: Record<Medal, string> = { bronze: "Bronze", silver: "Silver", gold: "Gold" };
