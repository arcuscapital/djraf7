import { isLoggedIn } from "./auth";
import { PartySong, playFanfare, preloadPartySong } from "./audio";
import rafArm from "./assets/raf/raf-arm.webp";
import rafArm2Fore from "./assets/raf/raf-arm2-fore.webp";
import rafArm2Upper from "./assets/raf/raf-arm2-upper.webp";
import rafBody from "./assets/raf/raf-body.webp";
import rafDeck from "./assets/raf/raf-deck.webp";
import rafFore from "./assets/raf/raf-forearm.webp";
import rafHead from "./assets/raf/raf-head.webp";
import rafSleeve from "./assets/raf/raf-sleeve.webp";
import { cloudLoad, cloudSave } from "./cloud";
import { loadPending, loadTrophies, savePending, saveTrophies } from "./storage";
import { addOnAir, better, finishShow, MEDAL_NAME, RECORDS, type Celebration, type Medal, type Trophies } from "./trophies";

// Records for time on air (see trophies.ts for the rule), kept in his Spotify
// account (cloud.ts) so every phone adds to the same total, and the fun bit
// when a show finishes: a dance party, or the record he won during the show.
// A record shows for 40 seconds (the parent's choice); the dance party is a
// story that ends by itself. The ✕ ends either straight away.

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const root = $("celebrate");
const SHOW_MS = { party: 23400, bronze: 40000, silver: 40000, gold: 40000 }; // the party story ends by itself
const RAF: Record<string, string> = { "raf-arm": rafArm, "raf-body": rafBody, "raf-head": rafHead, "raf-deck": rafDeck, "raf-fore": rafFore, "raf-sleeve": rafSleeve, "raf-arm2u": rafArm2Upper, "raf-arm2f": rafArm2Fore };
let timer: number | null = null;

export const MEDAL_COLOR: Record<Medal, string> = { bronze: "#9C5A2A", silver: "#C9CED6", gold: "#E8B62C" };
const RIBBON: Record<Medal, string> = { bronze: "Nice one, DJ!", silver: "Super DJ!", gold: "Best DJ ever!" };

let base: Trophies = loadTrophies(); // the totals as last agreed with his Spotify account
let pending = loadPending(); // seconds on air this phone hasn't added to those yet
let trophies: Trophies = addOnAir(base, pending).trophies; // what this phone shows: base + pending
let bestThisShow: Medal | null = null; // the record to celebrate when this show finishes
let syncing: Promise<Medal[]> | null = null;

export function showStarted(): void {
  bestThisShow = null;
}

function saveLocal() {
  saveTrophies(base);
  savePending(pending);
}
export const saveNow = saveLocal;

// Called once a second while the show is playing (not paused). Returns the
// record won at that moment, if any.
export function onAirSecond(): Medal | null {
  const r = addOnAir(trophies, 1);
  trophies = r.trophies;
  pending++;
  if (r.earned) bestThisShow = better(bestThisShow, r.earned);
  if (pending % 10 === 0 || r.earned) saveLocal();
  return r.earned;
}

// Add this phone's time to the totals in his Spotify account and take the
// totals back. Returns any records that time from his other phones pushed him
// past, so they can pop up here too. Best effort: offline, nothing changes and
// the seconds stay pending for next time.
export function sync(): Promise<Medal[]> {
  if (!isLoggedIn()) return Promise.resolve([]);
  if (syncing) return syncing;
  syncing = (async () => {
    const mine = pending;
    const before = trophies;
    const cloud = await cloudLoad(base); // a brand-new playlist starts from this phone's agreed totals
    if (!cloud) return [];
    // A playlist that's still empty while this phone has records (from before
    // this version): the phone's records become the starting total.
    const empty = (t: Trophies) => t.onAir === 0 && t.bronze === 0 && t.silver === 0 && t.gold === 0;
    base = addOnAir(empty(cloud) && !empty(base) ? base : cloud, mine).trophies;
    pending -= mine; // seconds that arrived while we waited stay pending
    trophies = addOnAir(base, pending).trophies;
    const extras = RECORDS.filter(m => trophies[m] > before[m]);
    for (const m of extras) bestThisShow = better(bestThisShow, m);
    await cloudSave(base);
    saveLocal();
    return extras;
  })().finally(() => { syncing = null; });
  return syncing;
}

export async function celebrateShowEnd(): Promise<void> {
  await sync().catch(() => []); // so the right record is celebrated
  const c = finishShow(trophies, bestThisShow);
  bestThisShow = null;
  saveLocal();
  showCelebration(c, true);
}

// Add ?demo=party, ?demo=bronze, ?demo=silver or ?demo=gold to the address to
// watch one without playing a show. Nothing is counted; it plays until the ✕.
export function previewCelebration(kind: "party" | Medal): void {
  const c: Celebration = kind === "party" ? { kind, trophies } : { kind, trophies: { ...trophies, [kind]: trophies[kind] + 1 } };
  showCelebration(c, false);
}

// Raf's dance party, as a little story (times in ms from the start): ten
// seconds DJing with his hands in the air, then the big red button — the
// lights go out and the dancers walk out of the door. style.css has the moves.
const STORY: [number, string, boolean][] = [
  [1600, "hands-up", true], [3800, "hands-up", false],
  [5200, "hands-up", true], [7200, "hands-up", false],
  [8000, "hands-up", true], [10000, "hands-up", false],
  [10000, "ph-button", true], [11000, "ph-lift", true], [11500, "ph-press", true],
  [11650, "ph-flicker", true], [12300, "ph-off", true], [12700, "ph-huh", true],
  [13800, "ph-leave", true], [20300, "ph-bye", true], [21300, "ph-iris", true]
];
const PRESS_AT = 11500;
let story: number[] = [];
let song: PartySong | null = null;

for (const [id, url] of Object.entries(RAF)) $(id).setAttribute("href", url);
// The party only starts once his picture and his song are here, so he never
// appears a piece at a time (at most a few seconds' wait on a slow connection).
const partyReady = Promise.all([
  ...Object.values(RAF).map(url => { const img = new Image(); img.src = url; return img.decode().catch(() => {}); }),
  preloadPartySong()
]);
let showing = 0; // a newer show (or a close) cancels one that's still waiting

function stopStory(): void {
  for (const t of story) clearTimeout(t);
  story = [];
  song?.stop();
  song = null;
}

function playStory(): void {
  stopStory();
  const scene = $("scene-party");
  scene.className = "cele-scene";
  root.classList.remove("lights-off", "iris-dark");
  void scene.getBoundingClientRect(); // so the animations start again from the beginning
  for (const [at, cls, on] of STORY) story.push(window.setTimeout(() => scene.classList.toggle(cls, on), at));
  story.push(window.setTimeout(() => root.classList.add("lights-off"), 12300));
  story.push(window.setTimeout(() => root.classList.add("iris-dark"), 21300));
  song = new PartySong();
  story.push(window.setTimeout(() => { song?.switchOff(); song = null; }, PRESS_AT));
}

function showCelebration(c: Celebration, autoClose: boolean): void {
  stopStory();
  const mine = ++showing;
  if (c.kind === "party") {
    void Promise.race([partyReady, new Promise(r => setTimeout(r, 5000))]).then(() => { if (mine === showing) reveal(c, autoClose); });
  } else reveal(c, autoClose);
}

function reveal(c: Celebration, autoClose: boolean): void {
  $("scene-party").classList.toggle("hidden", c.kind !== "party");
  const rec = $("scene-record");
  rec.classList.toggle("hidden", c.kind === "party");
  if (c.kind !== "party") {
    const m = c.kind;
    rec.className = `cele-scene medal-${m}`;
    $("record-title").textContent = `${MEDAL_NAME[m]} record!`;
    $("record-ribbon").textContent = RIBBON[m];
  }
  // Showing it again restarts all the animations from the beginning.
  root.classList.remove("closing", "lights-off", "iris-dark");
  root.classList.remove("hidden");
  if (c.kind === "party") playStory();
  else void playFanfare(c.kind).catch(() => {});
  if (timer !== null) clearTimeout(timer);
  timer = autoClose ? window.setTimeout(() => closeCelebration(), SHOW_MS[c.kind]) : null;
}

export function closeCelebration(immediately = false): void {
  if (timer !== null) { clearTimeout(timer); timer = null; }
  showing++;
  stopStory();
  if (root.classList.contains("hidden")) return;
  if (immediately) { root.classList.add("hidden"); return; }
  root.classList.add("closing");
  window.setTimeout(() => { if (root.classList.contains("closing")) root.classList.add("hidden"); }, 400);
}

$("celebrate-close").addEventListener("click", () => closeCelebration());
