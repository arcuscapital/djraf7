import { describe, expect, it } from "vitest";
import { assignSongs, autoSongsUsed } from "../src/songs";
import { judgeRun, newRunState, type Snapshot } from "../src/runWatch";
import { findCurrent, rebuildPool, startingAt } from "../src/songs";
import { measure, playbackGain } from "../src/loudness";
import { formatDescription, parseDescription } from "../src/cloudFormat";
import { addOnAir, better, finishShow, nextRecord, normalize, toNext, type Trophies } from "../src/trophies";
import type { Block, Track } from "../src/types";

const t = (n: number): Track => ({ uri: `spotify:track:${n}`, name: `Song ${n}`, artist: "A", durationMs: 180000 });
const pool = [1, 2, 3, 4, 5, 6, 7].map(t);

describe("assignSongs", () => {
  it("fills songs blocks in show order from the playlist", () => {
    const blocks: Block[] = [
      { id: "a", type: "songs", count: 3 },
      { id: "j", type: "jingle", mode: "talk" },
      { id: "b", type: "songs", count: 2 }
    ];
    const m = assignSongs(blocks, pool, 0);
    expect(m.get("a")!.map(x => x.name)).toEqual(["Song 1", "Song 2", "Song 3"]);
    expect(m.get("b")!.map(x => x.name)).toEqual(["Song 4", "Song 5"]);
  });

  it("starts at the offset and wraps around the playlist", () => {
    const m = assignSongs([{ id: "a", type: "songs", count: 3 }], pool, 6);
    expect(m.get("a")!.map(x => x.name)).toEqual(["Song 7", "Song 1", "Song 2"]);
  });

  it("keeps hand-picked songs and never uses a song twice in one show", () => {
    const blocks: Block[] = [
      { id: "a", type: "songs", count: 2, manual: [null, t(1)] },
      { id: "b", type: "songs", count: 2 }
    ];
    const m = assignSongs(blocks, pool, 0);
    expect(m.get("a")!.map(x => x.name)).toEqual(["Song 2", "Song 1"]);
    expect(m.get("b")!.map(x => x.name)).toEqual(["Song 3", "Song 4"]);
  });

  it("gives fewer songs rather than repeating when the playlist is too short", () => {
    const m = assignSongs([{ id: "a", type: "songs", count: 5 }], pool.slice(0, 2), 0);
    expect(m.get("a")!.length).toBe(2);
  });

  it("never picks the talk-over song for a songs block", () => {
    const m = assignSongs([{ id: "a", type: "songs", count: 2 }], pool, 0, [t(1).uri]);
    expect(m.get("a")!.map(x => x.name)).toEqual(["Song 2", "Song 3"]);
  });

  it("counts how many playlist songs a show uses", () => {
    expect(autoSongsUsed([{ id: "a", type: "songs", count: 3, manual: [t(9)] }, { id: "b", type: "songs", count: 2 }])).toBe(4);
  });
});

const snap = (p: Partial<Snapshot>): Snapshot => ({
  ok: true, noContent: false, isPlaying: true, itemUri: null, progressMs: 0, durationMs: 180000, ...p
});

describe("judgeRun", () => {
  const run = ["spotify:track:1", "spotify:track:2", "spotify:track:3"];

  it("waits until our first track is actually playing", () => {
    const st = newRunState();
    expect(judgeRun(run, snap({ itemUri: "spotify:track:99" }), st).kind).toBe("waiting");
    expect(judgeRun(run, snap({ itemUri: run[0], isPlaying: false }), st).kind).toBe("waiting");
    expect(judgeRun(run, snap({ itemUri: run[0] }), st)).toEqual({ kind: "playing", index: 0 });
  });

  it("follows the run through its songs", () => {
    const st = newRunState();
    judgeRun(run, snap({ itemUri: run[0] }), st);
    expect(judgeRun(run, snap({ itemUri: run[1] }), st)).toEqual({ kind: "playing", index: 1 });
    expect(judgeRun(run, snap({ itemUri: run[2] }), st)).toEqual({ kind: "playing", index: 2 });
  });

  it("ends when Spotify stops after the last track", () => {
    for (const end of [snap({ itemUri: run[2], isPlaying: false, progressMs: 0 }), snap({ itemUri: run[2], isPlaying: false, progressMs: 179000 }), snap({ noContent: true, itemUri: null }), snap({ itemUri: run[0], isPlaying: false, progressMs: 0 })]) {
      const st = newRunState();
      judgeRun(run, snap({ itemUri: run[0] }), st);
      judgeRun(run, snap({ itemUri: run[2] }), st);
      expect(judgeRun(run, end, st).kind).toBe("ended");
    }
  });

  it("flags a spill into a song that isn't ours", () => {
    const st = newRunState();
    judgeRun(run, snap({ itemUri: run[2] }), st);
    expect(judgeRun(run, snap({ itemUri: "spotify:track:autoplay" }), st).kind).toBe("spilled");
  });

  it("flags Spotify looping back to the top of the list (the old repeat bug)", () => {
    const st = newRunState();
    judgeRun(run, snap({ itemUri: run[0] }), st);
    judgeRun(run, snap({ itemUri: run[2] }), st);
    expect(judgeRun(run, snap({ itemUri: run[0], isPlaying: true }), st).kind).toBe("spilled");
  });

  it("treats a mid-song pause as paused, not finished", () => {
    const st = newRunState();
    judgeRun(run, snap({ itemUri: run[1] }), st);
    expect(judgeRun(run, snap({ itemUri: run[1], isPlaying: false, progressMs: 60000 }), st)).toEqual({ kind: "paused", index: 1 });
  });

  it("a one-song run ends cleanly and doesn't repeat", () => {
    const one = ["spotify:track:1"];
    const st = newRunState();
    judgeRun(one, snap({ itemUri: one[0], progressMs: 1000 }), st);
    expect(judgeRun(one, snap({ itemUri: one[0], isPlaying: false, progressMs: 0 }), st).kind).toBe("ended");
  });

  it("ignores failed reads", () => {
    expect(judgeRun(run, snap({ ok: false }), newRunState()).kind).toBe("unknown");
  });
});

describe("starting from the song that's currently up", () => {
  const now = (track: Track | null, linkedUri: string | null = null) => ({ track, linkedUri, contextUri: null, contextType: null, progressMs: 0, isPlaying: true });

  it("starts at the current song, not the first or the next one", () => {
    const at = findCurrent(pool, now(t(4)));
    expect(at).toBe(3);
    expect(startingAt(pool, at).map(x => x.name)).toEqual(["Song 4", "Song 5", "Song 6", "Song 7", "Song 1", "Song 2", "Song 3"]);
  });

  it("finds the song even when Spotify reports a relinked id", () => {
    const relinked = { ...t(5), uri: "spotify:track:other-id" };
    expect(findCurrent(pool, now(relinked, t(5).uri))).toBe(4);
  });

  it("falls back to matching by name and artist", () => {
    expect(findCurrent(pool, now({ ...t(6), uri: "spotify:track:x" }))).toBe(5);
  });

  it("starts at the top when the song isn't in the playlist", () => {
    const at = findCurrent(pool, now({ ...t(99), name: "Elsewhere" }));
    expect(at).toBe(-1);
    expect(startingAt(pool, at)[0].name).toBe("Song 1");
  });
});

describe("reordering songs (☰)", () => {
  const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(t);
  const blocks: Block[] = [
    { id: "a", type: "songs", count: 3 },
    { id: "j", type: "jingle", mode: "talk" },
    { id: "b", type: "songs", count: 3 }
  ];
  const names = (m: Map<string, Track[]>, id: string) => m.get(id)!.map(x => x.name);

  it("before the show: the show plays his new order", () => {
    const rows = [ten[4], ...ten.filter((_, i) => i !== 4)]; // Song 5 to the top
    const m = assignSongs(blocks, rebuildPool(ten, rows, new Set(), new Set()), 0);
    expect(names(m, "a")).toEqual(["Song 5", "Song 1", "Song 2"]);
    expect(names(m, "b")).toEqual(["Song 3", "Song 4", "Song 6"]);
  });

  it("mid-show: songs already played stay put; the next song changes", () => {
    const locked = new Set([ten[0].uri, ten[1].uri]); // Song 1 played, Song 2 playing
    const upcoming = ten.slice(2);
    const rows = [upcoming[3], ...upcoming.filter((_, i) => i !== 3)]; // Song 6 up next
    const m = assignSongs(blocks, rebuildPool(ten, rows, locked, new Set()), 0);
    expect(names(m, "a")).toEqual(["Song 1", "Song 2", "Song 6"]);
    expect(names(m, "b")).toEqual(["Song 3", "Song 4", "Song 5"]);
  });

  it("works from a later show's starting point, and keeps songs he picked himself in their slot", () => {
    const picked: Block[] = [{ id: "a", type: "songs", count: 2, manual: [null, ten[9]] }, { id: "b", type: "songs", count: 2 }];
    const rotated = [...ten.slice(3), ...ten.slice(0, 3)]; // next show starts at Song 4
    const manual = new Set([ten[9].uri]);
    const rows = rotated.filter(x => !manual.has(x.uri)).reverse();
    const m = assignSongs(picked, rebuildPool(rotated, rows, new Set(), manual), 0);
    expect(names(m, "a")).toEqual(["Song 3", "Song 10"]);
    expect(names(m, "b")).toEqual(["Song 2", "Song 1"]);
  });
});

describe("bronze, silver and gold records (time on air)", () => {
  const T = (min: number, extra: Partial<Trophies> = {}): Trophies => ({ onAir: min * 60, bronze: 0, silver: 0, gold: 0, ...extra });

  it("works towards bronze, then silver, then gold", () => {
    expect(nextRecord(T(0))).toBe("bronze");
    expect(nextRecord(T(29.9))).toBe("bronze");
    expect(nextRecord(T(30))).toBe("silver");
    expect(nextRecord(T(75))).toBe("gold");
    expect(toNext(T(75))).toBe(15 * 60);
  });

  it("awards the record the moment a 30-minute mark is crossed, then starts a new round after gold", () => {
    let t = T(29.95);
    let r = addOnAir(t, 1); expect(r.earned).toBeNull(); t = r.trophies;
    r = addOnAir(t, 1); expect(r.earned).toBeNull(); t = r.trophies;
    r = addOnAir(t, 1); expect(r.earned).toBe("bronze"); t = r.trophies;
    expect(t.bronze).toBe(1);
    r = addOnAir(t, 1); expect(r.earned).toBeNull();
    const s = addOnAir(T(59.99), 1); expect(s.earned).toBe("silver"); expect(s.trophies.silver).toBe(1);
    const g = addOnAir({ ...T(0, { gold: 4 }), onAir: 5399 }, 1);
    expect(g.earned).toBe("gold");
    expect(g.trophies).toEqual({ onAir: 0, bronze: 0, silver: 0, gold: 5 });
    expect(nextRecord(g.trophies)).toBe("bronze");
  });

  it("a big jump crossing several marks awards them all and keeps the spare minutes", () => {
    const r = addOnAir(T(10), 100 * 60);
    expect(r.earned).toBe("gold");
    expect(r.trophies).toEqual({ onAir: 20 * 60, bronze: 1, silver: 1, gold: 1 });
  });

  it("a finished show celebrates the best record won during it, else a dance party", () => {
    expect(finishShow(T(0.05), null).kind).toBe("party"); // a 3-second show earns nothing
    expect(finishShow(T(31), "bronze").kind).toBe("bronze");
    expect(better(null, "bronze")).toBe("bronze");
    expect(better("bronze", "silver")).toBe("silver");
    expect(better("gold", "bronze")).toBe("gold");
  });

  it("copes with missing or odd saved numbers, and old saves", () => {
    expect(normalize(null)).toEqual({ onAir: 0, bronze: 0, silver: 0, gold: 0 });
    expect(normalize({ onAir: NaN, gold: -3 })).toEqual({ onAir: 0, bronze: 0, silver: 0, gold: 0 });
    expect(normalize({ gold: 2.7, onAir: 5400 + 60 })).toEqual({ onAir: 60, bronze: 0, silver: 0, gold: 2 });
  });
});

describe("voice level on air", () => {
  it("lifts a quiet recording to a normal level", () => {
    expect(playbackGain(0.025, 0.2)).toBeCloseTo(4, 5); // 0.1 / 0.025
  });
  it("never lifts past the point where the loudest moment would distort", () => {
    expect(playbackGain(0.02, 0.5)).toBeCloseTo(1.9, 5); // 0.95 / 0.5, not 5
  });
  it("caps the lift, and leaves a loud recording slightly turned down rather than off", () => {
    expect(playbackGain(0.005, 0.05)).toBe(6);
    expect(playbackGain(0.5, 0.9)).toBe(0.25);
  });
  it("leaves silence alone", () => {
    expect(playbackGain(0, 0)).toBe(1);
  });
  it("measures average and peak level", () => {
    const d = new Float32Array(400);
    for (let i = 0; i < d.length; i++) d[i] = i % 2 ? 0.3 : -0.3;
    d[4] = 0.8;
    const m = measure({ numberOfChannels: 1, getChannelData: () => d });
    expect(m.peak).toBeCloseTo(0.8, 5);
    expect(m.rms).toBeGreaterThan(0.29);
    expect(m.rms).toBeLessThan(0.32);
  });
});

describe("records kept in his Spotify account (playlist description)", () => {
  const t: Trophies = { onAir: 1234, bronze: 3, silver: 1, gold: 18 };
  it("round-trips, and asks not to delete the playlist", () => {
    const d = formatDescription(t);
    expect(d).toContain("don't delete");
    expect(d.length).toBeLessThan(300);
    expect(parseDescription(d)).toEqual(t);
  });
  it("copes with Spotify's HTML escaping and with junk", () => {
    expect(parseDescription("Krom FM keeps Raf&#x27;s records here. {&quot;onAir&quot;:60,&quot;bronze&quot;:1,&quot;silver&quot;:0,&quot;gold&quot;:2}")).toEqual({ onAir: 60, bronze: 1, silver: 0, gold: 2 });
    expect(parseDescription("")).toBeNull();
    expect(parseDescription(null)).toBeNull();
    expect(parseDescription("someone typed over it")).toBeNull();
    expect(parseDescription("{not json")).toBeNull();
  });
  it("merging another phone's time: the cloud total plus what this phone adds", () => {
    const cloud: Trophies = { onAir: 1700, bronze: 0, silver: 0, gold: 0 };
    const r = addOnAir(cloud, 200); // this phone had 200 s pending
    expect(r.earned).toBe("bronze");
    expect(r.trophies).toEqual({ onAir: 1900, bronze: 1, silver: 0, gold: 0 });
  });
});

