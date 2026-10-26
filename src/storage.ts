import { normalize, type Trophies } from "./trophies";
import type { Block, SongSource } from "./types";

// This app shares a web address (arcuscapital.github.io) with the original
// Krom FM and with /djraf/ … /djraf4/, so browser storage is shared too. The show,
// playlist and recordings use their own "djraf7" names so the apps can be
// compared side by side without touching each other. (The Spotify login is
// deliberately shared with /djraf/ — see auth.ts.)

const KEYS = { blocks: "djraf7_blocks", source: "djraf7_source", loop: "djraf7_loop" };

export function defaultBlocks(): Block[] {
  return [
    { id: "b1", type: "jingle", mode: "talk" },
    { id: "b2", type: "songs", count: 3 },
    { id: "b3", type: "talk", mode: "talk" },
    { id: "b4", type: "songs", count: 3 },
    { id: "b5", type: "bed", mode: "talk" },
    { id: "b6", type: "commercial", mode: "talk" },
    { id: "b7", type: "songs", count: 2 },
    { id: "b8", type: "jingle", mode: "talk" }
  ];
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* full or blocked */ }
}

export const loadBlocks = () => read<Block[]>(KEYS.blocks, defaultBlocks());
export const saveBlocks = (b: Block[]) => write(KEYS.blocks, b);
export const loadSource = () => read<SongSource | null>(KEYS.source, null);
export const saveSource = (s: SongSource | null) => write(KEYS.source, s);
export const loadLoop = () => read<boolean>(KEYS.loop, false);
export const saveLoop = (v: boolean) => write(KEYS.loop, v);
// Dance parties and gold records won (the end-of-show celebration).
// Records won (time on air). Older saves are carried across: this version's
// first rule counted stars and gold records; /djraf4/ counted gold records.
export function loadTrophies(): Trophies {
  const mine = read<Partial<Trophies> | null>("djraf7_trophies", null) ?? read<Partial<Trophies> | null>("djraf6_trophies", null);
  if (mine) return normalize(mine);
  const v6 = read<(Partial<Trophies> & { golds?: number }) | null>("djraf5_trophies", null);
  if (v6) return normalize({ ...v6, gold: v6.gold ?? v6.golds });
  const older = read<{ golds?: number } | null>("djraf4_trophies", null);
  return normalize({ gold: older?.golds ?? 0 });
}
export const saveTrophies = (t: Trophies) => write("djraf7_trophies", t);
// Seconds on air this phone hasn't yet added to the totals in his Spotify account.
export const loadPending = () => Math.max(0, Math.floor(read<number>("djraf7_pending", 0)) || 0);
export const savePending = (s: number) => write("djraf7_pending", s);

// ---------- recordings (IndexedDB) ----------
const DB = "djraf7-db";
const STORE = "recordings";
let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req.result as T);
    t.onerror = () => reject(t.error);
  });
}

export const saveRecording = (id: string, blob: Blob) => tx<void>("readwrite", s => s.put(blob, id));
export const loadRecording = (id: string) => tx<Blob | undefined>("readonly", s => s.get(id)).then(b => b ?? null);
export const deleteRecording = (id: string) => tx<void>("readwrite", s => s.delete(id));
