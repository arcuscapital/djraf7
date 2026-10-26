import "./style.css";
import { Recorder, preloadMusic, resumeAll, unlockAudio } from "./audio";
import { handleRedirect, isLoggedIn, login } from "./auth";
import { celebrateShowEnd, closeCelebration, MEDAL_COLOR, onAirSecond, previewCelebration, saveNow, showStarted, sync } from "./celebrate";
import * as wp from "./webPlayer";
import { makeReorderable } from "./listDrag";
import { Show, TYPE_LABELS } from "./show";
import { assignSongs, autoSongsUsed, rebuildPool } from "./songs";
import { fromNowPlaying } from "./songSource";
import * as sp from "./spotify";
import * as store from "./storage";
import type { Block, BlockType, SongSource, Track } from "./types";
import type { Medal } from "./trophies";
import { BUILD_ID, watchForUpdates } from "./update";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const show = (el: HTMLElement, on: boolean) => el.classList.toggle("hidden", !on);

// ====================== STATE ======================
let blocks: Block[] = store.loadBlocks();
let source: SongSource | null = store.loadSource();
let loopEnabled = store.loadLoop();
let deviceId: string | null = null;
let current: Show | null = null;
let resumeFrom: number | null = null; // set when a show was stopped part-way and can be resumed
let resumeTracks: Map<string, Track[]> | null = null;
let nextId = Date.now();
const makeId = () => "b" + nextId++;

const computeTracks = () => assignSongs(blocks, source?.pool ?? [], source?.offset ?? 0);
function save() { store.saveBlocks(blocks); }

const MODE_LABELS = { talk: "🎤 Talk", record: "🎙️ Recorded" };
const TYPE_ICONS: Record<BlockType, string> = { songs: "🎵", jingle: "🎤", talk: "🗣️", bed: "🎶", commercial: "📢" };
const SHORT_LABELS: Record<BlockType, string> = { songs: "Songs", jingle: "Jingle", talk: "News", bed: "DJ Talk", commercial: "Ad Break" };

// ====================== DOM ======================
const splashScreen = $("splash-screen");
const builderScreen = $("builder-screen");
const liveScreen = $("live-screen");
const endScreen = $("end-screen");
const blocksList = $("blocks-list");
const addModal = $("add-modal");
const modeModal = $("mode-modal");
const recorderModal = $("recorder-modal");
const songsModal = $("songs-modal");
const pickModal = $("pick-modal");
const orderModal = $("order-modal");
const allModals = [addModal, modeModal, recorderModal, songsModal, pickModal, orderModal];

const VERSION_TAG = "v7 · " + BUILD_ID;
$("app-version-tag").textContent = VERSION_TAG;

// ====================== BLOCK LIST ======================
function renderBlocks() {
  const tracks = computeTracks();
  blocksList.innerHTML = "";
  blocks.forEach((block, index) => {
    const card = document.createElement("div");
    card.className = `block-card ${block.type}`;
    let left: string;
    let right: string;
    if (block.type === "songs") {
      const names = (tracks.get(block.id) ?? []).map(t => t.name).join(" · ");
      left = `<span class="block-icon">🎵</span><span class="block-text">Play <span class="song-count">${block.count}</span> ${block.count === 1 ? "Song" : "Songs"}<span class="song-names">${names ? escapeHtml(names) : "Push the red button ↑"}</span></span>`;
      right = `<button class="num-btn" data-action="minus">−</button><button class="num-btn" data-action="plus">+</button><button class="delete-btn" data-action="delete">×</button>`;
    } else {
      const mode = (block.mode === "record" ? MODE_LABELS.record : MODE_LABELS.talk) + (block.mode === "record" && block.music ? " + 🎶" : "") + (block.mode === "record" && block.over ? " over next song" : "");
      left = `<span class="block-icon">${TYPE_ICONS[block.type]}</span><span class="block-text">${TYPE_LABELS[block.type]} <span class="block-mode-badge">${mode}</span></span>`;
      right = `<button class="edit-btn" data-action="edit">✎</button><button class="delete-btn" data-action="delete">×</button>`;
    }
    card.innerHTML = `<div class="block-left">${left}</div><div class="block-controls">${right}</div>`;
    card.querySelectorAll<HTMLButtonElement>("[data-action]").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const action = btn.dataset.action;
        if (action === "plus") setCount(block, (block.count ?? 1) + 1);
        else if (action === "minus") setCount(block, (block.count ?? 1) - 1);
        else if (action === "delete") {
          if (block.mode === "record" && !confirm("Delete your recording?")) return;
          if (block.mode === "record") void store.deleteRecording(block.id);
          blocks.splice(index, 1);
          invalidateResume();
          save();
          renderBlocks();
        } else if (action === "edit") openModeModal(block, false);
      });
    });
    if (block.type === "songs") card.addEventListener("click", () => openSongsSheet(block));
    attachCardDrag(card);
    blocksList.appendChild(card);
  });
}

function setCount(block: Block, n: number) {
  block.count = Math.min(12, Math.max(1, n));
  if (block.manual) block.manual = block.manual.slice(0, block.count);
  invalidateResume();
  save();
  renderBlocks();
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ====================== PRESS-AND-HOLD DRAG TO REORDER (same as the original app) ======================
const LONG_PRESS_MS = 320;
const DRAG_CANCEL_PX = 10;
let dragCtx: { card: HTMLElement; pointerId: number; startClientY: number; index: number; targetIndex: number; cardHeight: number; tops: number[] } | null = null;

function attachCardDrag(card: HTMLElement) {
  let longPressTimer: number | undefined;
  let startX = 0, startY = 0, lastScrollY = 0;

  const cancelPre = () => {
    clearTimeout(longPressTimer);
    card.removeEventListener("pointermove", onPreMove);
    card.removeEventListener("pointerup", cancelPre);
    card.removeEventListener("pointercancel", cancelPre);
  };
  // The card has touch-action: none (needed for long-press drag on phones), so
  // if the finger moves before the long press fires, scroll the page ourselves.
  function onPreMove(e: PointerEvent) {
    if (Math.abs(e.clientY - startY) > DRAG_CANCEL_PX || Math.abs(e.clientX - startX) > DRAG_CANCEL_PX) {
      cancelPre();
      lastScrollY = e.clientY;
      card.addEventListener("pointermove", onScrollMove);
      card.addEventListener("pointerup", endScroll);
      card.addEventListener("pointercancel", endScroll);
      window.scrollBy(0, startY - e.clientY);
    }
  }
  function onScrollMove(e: PointerEvent) {
    window.scrollBy(0, lastScrollY - e.clientY);
    lastScrollY = e.clientY;
  }
  function endScroll() {
    card.removeEventListener("pointermove", onScrollMove);
    card.removeEventListener("pointerup", endScroll);
    card.removeEventListener("pointercancel", endScroll);
  }
  card.addEventListener("pointerdown", e => {
    if ((e.target as HTMLElement).closest("button")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    startX = e.clientX;
    startY = e.clientY;
    card.addEventListener("pointermove", onPreMove);
    card.addEventListener("pointerup", cancelPre);
    card.addEventListener("pointercancel", cancelPre);
    longPressTimer = window.setTimeout(() => {
      cancelPre();
      beginDrag(card, e.pointerId, e.clientY);
    }, LONG_PRESS_MS);
  });
}

function beginDrag(card: HTMLElement, pointerId: number, clientY: number) {
  const siblings = Array.from(blocksList.children) as HTMLElement[];
  const index = siblings.indexOf(card);
  const listTop = blocksList.getBoundingClientRect().top;
  dragCtx = {
    card, pointerId, startClientY: clientY, index, targetIndex: index,
    cardHeight: card.getBoundingClientRect().height,
    tops: siblings.map(el => el.getBoundingClientRect().top - listTop)
  };
  try { card.setPointerCapture(pointerId); } catch { /* ignore */ }
  card.classList.add("dragging");
  document.addEventListener("pointermove", onDragMove);
  document.addEventListener("pointerup", onDragEnd);
  document.addEventListener("pointercancel", onDragEnd);
  navigator.vibrate?.(15);
}

function onDragMove(e: PointerEvent) {
  if (!dragCtx || e.pointerId !== dragCtx.pointerId) return;
  e.preventDefault();
  const d = dragCtx;
  const deltaY = e.clientY - d.startClientY;
  d.card.style.transform = `translateY(${deltaY}px)`;
  const siblings = Array.from(blocksList.children) as HTMLElement[];
  const center = d.tops[d.index] + d.cardHeight / 2 + deltaY;
  let pos = 0;
  siblings.forEach((el, i) => {
    if (i !== d.index && center > d.tops[i] + el.getBoundingClientRect().height / 2) pos++;
  });
  const target = Math.min(Math.max(pos, 0), siblings.length - 1);
  if (target !== d.targetIndex) {
    d.targetIndex = target;
    siblings.forEach((el, i) => {
      if (i === d.index) return;
      let shift = 0;
      if (target > d.index && i > d.index && i <= target) shift = -(d.cardHeight + 12);
      else if (target < d.index && i < d.index && i >= target) shift = d.cardHeight + 12;
      el.style.transform = shift ? `translateY(${shift}px)` : "";
    });
  }
}

function onDragEnd(e: PointerEvent) {
  if (!dragCtx || e.pointerId !== dragCtx.pointerId) return;
  const { index, targetIndex } = dragCtx;
  document.removeEventListener("pointermove", onDragMove);
  document.removeEventListener("pointerup", onDragEnd);
  document.removeEventListener("pointercancel", onDragEnd);
  dragCtx = null;
  if (targetIndex !== index) {
    const [moved] = blocks.splice(index, 1);
    blocks.splice(targetIndex, 0, moved);
    invalidateResume();
    save();
  }
  renderBlocks();
}

// ====================== MODALS + PHONE BACK BUTTON ======================
let modalHistoryPushed = false;
function openModal(m: HTMLElement) {
  allModals.forEach(x => show(x, x === m));
  if (!modalHistoryPushed) {
    modalHistoryPushed = true;
    history.pushState({ djrafModal: true }, "");
  }
}
function hideModalsInternal() {
  keepTakeIfAny();
  allModals.forEach(x => show(x, false));
  cancelRecording();
}
function closeAllModals() {
  hideModalsInternal();
  if (modalHistoryPushed) {
    modalHistoryPushed = false;
    goBack();
  }
}

let showHistoryPushed = false;
// history.back() is answered a moment later by a popstate event. If a new
// pop-up opened in that moment, that late event looked like the phone's back
// button and closed it (caught in live testing). So count the backs we trigger
// ourselves and ignore their popstate events.
let ownBacks = 0;
function goBack() {
  ownBacks++;
  history.back();
}

window.addEventListener("popstate", () => {
  if (ownBacks > 0) { ownBacks--; return; }
  if (modalHistoryPushed) {
    modalHistoryPushed = false;
    hideModalsInternal();
    return;
  }
  if (showHistoryPushed && current?.running) {
    // The phone's back button/edge swipe mid-show pauses rather than stopping it.
    history.pushState({ djrafShow: true }, "");
    if (!current.paused) void current.togglePause().then(() => { pauseBtn.textContent = "Resume"; });
    return;
  }
  if (showHistoryPushed) {
    showHistoryPushed = false;
    exitToBuilderInternal();
  }
});

// ---------- add block ----------
$("add-block-btn").addEventListener("click", () => openModal(addModal));
$("close-modal").addEventListener("click", closeAllModals);
document.querySelectorAll<HTMLButtonElement>(".block-type-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const type = btn.dataset.type as BlockType;
    if (type === "songs") {
      blocks.push({ id: makeId(), type, count: 3 });
      invalidateResume();
      save();
      renderBlocks();
      closeAllModals();
      return;
    }
    openModeModal({ id: makeId(), type, mode: "talk" }, true);
  });
});

// ---------- how should it work: Talk (live) or Record ----------
let target: Block | null = null;
let targetIsNew = false;
function openModeModal(block: Block, isNew: boolean) {
  target = block;
  targetIsNew = isNew;
  $("mode-modal-title").textContent = `How should "${TYPE_LABELS[block.type]}" work?`;
  openModal(modeModal);
}
$("close-mode-modal").addEventListener("click", closeAllModals);
document.querySelectorAll<HTMLButtonElement>(".mode-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    if (!target) return;
    if (btn.dataset.mode === "talk") {
      if (target.mode === "record") {
        if (!confirm("This will delete your recording. OK?")) return;
        void store.deleteRecording(target.id);
      }
      target.mode = "talk";
      target.music = undefined;
      finalize();
    } else {
      openRecorder();
    }
  });
});

function finalize() {
  if (!target) return;
  if (targetIsNew) blocks.push(target);
  invalidateResume();
  save();
  renderBlocks();
  closeAllModals();
}

// ---------- recorder ----------
// No time limit: he starts and stops it. The background music button is off
// until he taps it. With it on, nothing plays while he records (the phone's
// speaker sits next to its mic, so anything played would end up in the take);
// the song is added under his voice on air instead.
const recorder = new Recorder();
const recMain = $<HTMLButtonElement>("recorder-main-btn");
const recMusicBtn = $<HTMLButtonElement>("recorder-music-btn");
const recTimer = $("recorder-timer");
const recPreview = $<HTMLAudioElement>("recorder-preview");
const recSave = $("recorder-save-btn");
const recRetry = $("recorder-retry-btn");
let recBlob: Blob | null = null;
let recMusicUsed = false; // the music was on at some point during this take
let recSeconds = 0;
let recInterval: number | null = null;

function drawMusicButton(btn: HTMLElement, on: boolean) {
  btn.classList.toggle("on", on);
  btn.textContent = on ? "🎶 Background music: ON" : "🎶 Background music: OFF";
}
let recMusicOn = false;
function setRecordMusic(on: boolean) {
  recMusicOn = on;
  drawMusicButton(recMusicBtn, on);
}

// The third option: his recording plays over the start of a song, which then
// carries on. One tap: the song is the first one of the next Songs block (for a
// new block, the show's first Songs block), named under the button; the block
// is placed just before that Songs block when the take is kept. 30 s at most.
const OVER_LIMIT_S = 30;
const recOverBtn = $<HTMLButtonElement>("recorder-over-btn");
const recOverSong = $("recorder-over-song");
const recListenBtn = $<HTMLButtonElement>("recorder-listen-btn");
let recOverBlockId: string | null = null;
let listening = false;
let listenTimer: number | null = null;
function overTrack(): Track | null {
  return recOverBlockId ? computeTracks().get(recOverBlockId)?.[0] ?? null : null;
}
function drawOver() {
  const t = overTrack();
  if (recOverBlockId && !t) recOverBlockId = null;
  const on = !!recOverBlockId;
  recOverBtn.classList.toggle("on", on);
  recOverBtn.textContent = on ? "🎤 Over the next song: ON" : "🎤 Over the next song: OFF";
  show(recOverSong, on);
  recOverSong.textContent = t ? `🔊 ${t.name} – ${t.artist}` : "";
  show(recListenBtn, on);
  if (on) { setRecordMusic(false); recMusicBtn.disabled = true; }
  else if (!recorder.recording) recMusicBtn.disabled = false;
}
function nextSongsBlock(): string | null {
  const tracks = computeTracks();
  const has = (b: Block) => b.type === "songs" && !!tracks.get(b.id)?.length;
  const pos = target ? blocks.indexOf(target) : -1;
  return (blocks.find((b, i) => i > pos && has(b)) ?? blocks.find(has))?.id ?? null;
}
recOverBtn.addEventListener("click", () => {
  if (recorder.recording || micStarting) return;
  if (recOverBlockId) { recOverBlockId = null; drawOver(); return; }
  recOverBlockId = nextSongsBlock();
  if (!recOverBlockId) { alert("Add a Songs block with songs first — the recording plays over its first song."); return; }
  drawOver();
});
// Tap the song's name and the phone reads it out (big words for a small DJ).
function sayOverSong() {
  const t = overTrack();
  if (!t || recorder.recording || micStarting || !("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(`${t.name}, by ${t.artist}`);
  u.lang = "en-GB";
  u.rate = 0.9;
  speechSynthesis.speak(u);
}
recOverSong.addEventListener("click", sayOverSong);

// Hear the song's opening on the phone while he thinks about what to say.
async function stopListening() {
  if (listenTimer !== null) { clearTimeout(listenTimer); listenTimer = null; }
  if (!listening) return;
  listening = false;
  recListenBtn.textContent = "▶ Listen to the start";
  if (deviceId) await sp.pauseVerified(deviceId);
}
recListenBtn.addEventListener("click", async () => {
  if (listening) { void stopListening(); return; }
  const t = overTrack();
  if (!t) return;
  if (!deviceId && !(await ensureDevice())) { alert("Open the Spotify app on this phone, then try again."); return; }
  listening = true;
  recListenBtn.textContent = "⏹ Stop";
  await sp.setRepeat(deviceId!, "off");
  await sp.playUris(deviceId!, [t.uri]);
  listenTimer = window.setTimeout(() => void stopListening(), 20000);
});
// The choice is made before he presses record (the button is locked while
// recording), so a take is either with music or without — never half and half.
recMusicBtn.addEventListener("click", () => { if (!recorder.recording && !micStarting) setRecordMusic(!recMusicOn); });

function resetRecorderUI() {
  show(recMain, true);
  recMain.textContent = "⏺ Start Recording";
  setRecordMusic(false);
  recMusicBtn.disabled = false;
  show(recMusicBtn, true);
  recOverBlockId = null;
  void stopListening();
  drawOver();
  show(recOverBtn, true);
  show(recTimer, false);
  recTimer.textContent = "0:00";
  show(recPreview, false);
  recPreview.removeAttribute("src");
  show(recSave, false);
  show(recRetry, false);
  recBlob = null;
  recMusicUsed = false;
  $("close-recorder-modal").textContent = "Cancel";
}
function openRecorder() {
  resetRecorderUI();
  $("recorder-hint").textContent = "Pick one first: 🎶 Background music plays under your voice on air (you won't hear it while recording), or 🎤 Over the next song puts your voice over the start of a song. Then tap the button, say your bit, and tap stop.";
  openModal(recorderModal);
}
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

// The first time, the phone asks permission to use the mic. Until he answers,
// say so on the button (it used to just sit there) and ignore extra taps, which
// would otherwise start a second recorder.
let micStarting = false;
recMain.addEventListener("click", async () => {
  if (recorder.recording) { void finishRecording(); return; }
  if (micStarting) return;
  micStarting = true;
  recMain.textContent = "🎤 Tap “Allow” to use the microphone…";
  void unlockAudio(); // recording itself doesn't need the sound engine
  try {
    await recorder.start();
  } catch {
    recMain.textContent = "⏺ Start Recording";
    alert("Couldn't use the microphone. Please allow microphone access and try again.");
    return;
  } finally {
    micStarting = false;
  }
  if (recorderModal.classList.contains("hidden")) { void recorder.stop(); return; } // closed while waiting
  void stopListening();
  if ("speechSynthesis" in window) speechSynthesis.cancel(); // not into the take
  recMusicUsed = recMusicOn;
  recMusicBtn.disabled = true;
  recOverBtn.disabled = true;
  void keepAwake(); // a dark screen can mute the mic part-way through a take
  recSeconds = 0;
  recTimer.textContent = "0:00";
  show(recTimer, true);
  recMain.textContent = "⏹ Stop Recording";
  recInterval = window.setInterval(() => {
    recSeconds++;
    recTimer.textContent = recOverBlockId ? `${fmt(recSeconds)} / ${fmt(OVER_LIMIT_S)}` : fmt(recSeconds);
    if (recOverBlockId && recSeconds >= OVER_LIMIT_S) void finishRecording(); // over a song: 30 s at most
  }, 1000);
});

async function finishRecording() {
  if (recInterval !== null) { clearInterval(recInterval); recInterval = null; }
  if (!current?.running) releaseWakeLock();
  const blob = await recorder.stop();
  setRecordMusic(false);
  show(recMusicBtn, false);
  show(recOverBtn, false);
  show(recListenBtn, false);
  recOverBtn.disabled = false;
  if (!blob) return;
  recBlob = blob;
  recPreview.src = URL.createObjectURL(blob);
  show(recPreview, true);
  show(recMain, false);
  show(recSave, true);
  show(recRetry, true);
  $("close-recorder-modal").textContent = "🗑 Throw it away";
}
// Closing the recorder any way other than "Throw it away" keeps a finished take.
function keepTakeIfAny() {
  if (recBlob && target && !recorderModal.classList.contains("hidden")) void keepTake();
}
async function keepTake() {
  if (!target || !recBlob) return;
  const blob = recBlob;
  recBlob = null;
  await store.saveRecording(target.id, blob);
  target.mode = "record";
  target.over = recOverBlockId ? true : undefined;
  target.music = recOverBlockId ? undefined : recMusicUsed || undefined;
  const at = recOverBlockId ? blocks.findIndex(b => b.id === recOverBlockId) : -1;
  if (at >= 0) {
    // Goes just before the Songs block he picked (moving it there if it already exists).
    const was = blocks.indexOf(target);
    if (was >= 0) blocks.splice(was, 1);
    blocks.splice(blocks.findIndex(b => b.id === recOverBlockId), 0, target);
  } else if (targetIsNew) blocks.push(target);
  targetIsNew = false;
  invalidateResume();
  save();
  renderBlocks();
}
function cancelRecording() {
  if (recInterval !== null) { clearInterval(recInterval); recInterval = null; }
  if (recorder.recording) { void recorder.stop(); if (!current?.running) releaseWakeLock(); }
  setRecordMusic(false);
  void stopListening();
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  recPreview.pause();
}
recRetry.addEventListener("click", resetRecorderUI);
$("close-recorder-modal").addEventListener("click", () => { recBlob = null; closeAllModals(); });
recSave.addEventListener("click", async () => {
  await keepTake();
  closeAllModals();
});

// ---------- songs block sheet ----------
let sheetBlock: Block | null = null;
function openSongsSheet(block: Block) {
  sheetBlock = block;
  renderSongsSheet();
  openModal(songsModal);
}
function renderSongsSheet() {
  const b = sheetBlock;
  if (!b) return;
  $("songs-count").textContent = String(b.count ?? 1);
  $("songs-modal-title").textContent = source ? `Songs from ${source.name}` : "Songs";
  const list = computeTracks().get(b.id) ?? [];
  const el = $("songs-list");
  el.innerHTML = "";
  if (!source) {
    el.innerHTML = `<p class="recorder-hint">Play a playlist on Spotify, then push the red button at the top.</p>`;
    return;
  }
  list.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "pick-row";
    row.innerHTML = `<span>${i + 1}. ${escapeHtml(t.name)}<small>${escapeHtml(t.artist)}${b.manual?.[i] ? " · your pick" : ""}</small></span><button class="swap" aria-label="Swap song">🔁</button>`;
    row.querySelector("button")!.addEventListener("click", () => openSwap(b, i));
    el.appendChild(row);
  });
  $("songs-hint").textContent = list.length < (b.count ?? 1) ? "Not enough songs in this playlist — pick another one." : "Tap 🔁 to swap a song.";
}
$("songs-minus").addEventListener("click", () => { if (sheetBlock) { setCount(sheetBlock, (sheetBlock.count ?? 1) - 1); renderSongsSheet(); } });
$("songs-plus").addEventListener("click", () => { if (sheetBlock) { setCount(sheetBlock, (sheetBlock.count ?? 1) + 1); renderSongsSheet(); } });
$("songs-done").addEventListener("click", closeAllModals);

function openSwap(b: Block, slot: number) {
  const used = new Set([...computeTracks().values()].flat().map(t => t.uri));
  const rows: PickRow[] = [{ title: "🎲 Let the app choose", onPick: () => setManual(b, slot, null) }];
  for (const t of source?.pool ?? []) {
    if (used.has(t.uri)) continue;
    rows.push({ title: t.name, sub: t.artist, onPick: () => setManual(b, slot, t) });
  }
  openPicker("Pick a song", rows, () => openModal(songsModal));
}
function setManual(b: Block, slot: number, t: Track | null) {
  const manual = (b.manual ?? []).slice(0, b.count ?? 1);
  while (manual.length < (b.count ?? 1)) manual.push(null);
  manual[slot] = t;
  b.manual = manual.some(Boolean) ? manual : undefined;
  invalidateResume();
  save();
  renderBlocks();
  renderSongsSheet();
  openModal(songsModal);
}

// ---------- generic picker ----------
interface PickRow { title: string; sub?: string; onPick: () => void }
let pickBack: (() => void) | null = null;
function openPicker(title: string, rows: PickRow[], back: (() => void) | null = null) {
  pickBack = back;
  $("pick-title").textContent = title;
  const el = $("pick-list");
  el.innerHTML = "";
  for (const r of rows) {
    const b = document.createElement("button");
    b.className = "pick-row";
    b.innerHTML = `<span>${escapeHtml(r.title)}${r.sub ? `<small>${escapeHtml(r.sub)}</small>` : ""}</span>`;
    b.addEventListener("click", r.onPick);
    el.appendChild(b);
  }
  openModal(pickModal);
}
$("close-pick-modal").addEventListener("click", () => (pickBack ? pickBack() : closeAllModals()));

// ====================== WHERE SONGS COME FROM ======================
const usePlayingBtn = $<HTMLButtonElement>("use-playing-btn");
let loadingSource = false;
function renderSource(message?: string) {
  $("source-name").textContent = source ? source.name : "Nothing loaded yet";
  $("source-hint").textContent = message ?? (source ? `${source.pool.length} songs ready. Changed playlist? Push the button again.` : "");
  // Red until songs are loaded, then green.
  usePlayingBtn.classList.toggle("loaded", !!source && !loadingSource);
  usePlayingBtn.textContent = loadingSource ? "⏳ Loading songs…" : source ? "✅ Songs loaded" : "▶ Use what's playing";
  show($("order-btn"), !!source);
}
function setSource(s: SongSource) {
  source = s;
  store.saveSource(s);
  invalidateResume();
  renderSource();
  renderBlocks();
}
async function needLogin(): Promise<boolean> {
  if (isLoggedIn()) return false;
  alert("Please connect Spotify first!");
  return true;
}
usePlayingBtn.addEventListener("click", async () => {
  if (loadingSource || (await needLogin())) return;
  loadingSource = true;
  renderSource("Checking Spotify…");
  const r = await fromNowPlaying(source);
  loadingSource = false;
  if (r.ok) setSource(r.source);
  else renderSource(r.message);
});
// ====================== SONG ORDER (☰) ======================
// The show plays the playlist in order (from where the last show stopped), so
// changing the order means reordering that list. Mid-show, songs already
// played and the one playing are locked; everything after can move, and the
// show picks up the new order straight away.
let orderLive = false; // opened from the live show
let orderRows: Track[] = []; // the songs the sheet shows, in order
const orderList = $("order-list");

// The playlist starting from the next show's first song.
function rotatedPool(): Track[] {
  if (!source?.pool.length) return [];
  const n = source.pool.length;
  const o = ((source.offset % n) + n) % n;
  return [...source.pool.slice(o), ...source.pool.slice(0, o)];
}
// Songs he picked himself for a slot stay in that slot, so they aren't in the list.
const manualUris = () => new Set(blocks.flatMap(b => b.manual ?? []).filter((t): t is Track => !!t).map(t => t.uri));
const lockedUris = () => new Set(orderLive && current?.running ? current.playedSongs().map(t => t.uri) : []);

function openOrder(live: boolean) {
  if (!source) return;
  orderLive = live;
  $("order-title").textContent = live ? "Songs coming up" : "Song order";
  renderOrder();
  openModal(orderModal);
}
function renderOrder() {
  const locked = lockedUris();
  const manual = manualUris();
  orderRows = rotatedPool().filter(t => !locked.has(t.uri) && !manual.has(t.uri));
  const inShow = new Set([...computeTracks().values()].flat().map(t => t.uri));
  // Mid-show, this block's songs so far sit at the top, locked: they can't be
  // dragged, and nothing can be dropped above them.
  const fixed = orderLive && current?.running ? current.blockSoFar() : [];
  $("order-hint").textContent = (fixed.length ? "🔒 Songs already playing can't move. " : "") + "Press and hold a song, then drag it up or down." + (inShow.size ? " Blue numbers are in your show." : "");
  orderList.innerHTML =
    fixed.map((t, i) =>
      `<li class="order-locked"><span class="order-num">${i === fixed.length - 1 ? "▶" : "✓"}</span><span class="order-title">${escapeHtml(t.name)}<small>${i === fixed.length - 1 ? "Playing now" : "Played"}</small></span><span class="order-lock" aria-hidden="true">🔒</span></li>`
    ).join("") +
    orderRows.map((t, i) =>
      `<li class="order-row${inShow.has(t.uri) && !locked.has(t.uri) ? " in-show" : ""}"><span class="order-num">${fixed.length + i + 1}</span><span class="order-title">${escapeHtml(t.name)}<small>${escapeHtml(t.artist)}</small></span><span class="order-handle" aria-hidden="true">≡</span></li>`
    ).join("");
}
const orderDrag = makeReorderable(orderList, ".order-row", (from, to) => {
  if (!source) return;
  const rows = orderRows.slice();
  const [moved] = rows.splice(from, 1);
  rows.splice(to, 0, moved);
  const locked = lockedUris();
  const manual = manualUris();
  const rot = rotatedPool();
  const pool = rebuildPool(rot, rows, locked, manual);
  setSource({ ...source, pool, offset: 0 });
  if (orderLive && current?.running) current.updateTracks(computeTracks());
  renderOrder();
});
$("order-btn").addEventListener("click", () => openOrder(false));
$("live-order-btn").addEventListener("click", () => openOrder(true));
$("order-done").addEventListener("click", closeAllModals);
// A song finished while the sheet is open: refresh what's locked (not mid-drag).
function refreshOrderIfOpen() {
  if (orderLive && !orderModal.classList.contains("hidden") && !orderDrag.dragging) renderOrder();
}

// ====================== LOOP ======================
const loopToggle = $<HTMLInputElement>("loop-toggle");
loopToggle.checked = loopEnabled;
loopToggle.addEventListener("change", () => { loopEnabled = loopToggle.checked; store.saveLoop(loopEnabled); });

// ====================== SPOTIFY CONNECTION ======================
function showLoggedOut() {
  show($("source-login-btn"), true);
  show($("source-actions"), false);
  show($("login-btn"), true);
  show($("spotify-connected"), false);
  show($("device-hint"), false);
}
function showConnected() {
  show($("source-login-btn"), false);
  show($("source-actions"), true);
  show($("login-btn"), false);
  show($("device-hint"), false);
  show($("spotify-connected"), true);
}
function showNeedsDevice(msg?: string) {
  show($("source-login-btn"), false);
  show($("source-actions"), true);
  show($("login-btn"), false);
  show($("spotify-connected"), false);
  show($("device-hint"), true);
  $("device-hint-text").textContent = msg ?? "Open the Spotify app on this phone (so it shows up as a speaker), then tap Refresh.";
}

async function ensureDevice(): Promise<boolean> {
  if (!isLoggedIn()) { showLoggedOut(); return false; }
  let devices: sp.Device[];
  try {
    devices = await sp.getDevices();
  } catch (e) {
    if (e instanceof sp.SpotifyError && e.status === 401) { showLoggedOut(); return false; }
    deviceId = null;
    showNeedsDevice("Couldn't reach Spotify — check the internet, then tap Refresh.");
    return false;
  }
  devices = devices.filter(x => x.name !== wp.PLAYER_NAME); // our own browser player isn't the phone
  const d = devices.find(x => x.is_active) ?? devices.find(x => x.type === "Smartphone") ?? devices[0];
  if (!d) { deviceId = null; showNeedsDevice(); return false; }
  deviceId = d.id;
  showConnected();
  return true;
}
$("login-btn").addEventListener("click", () => void login());
$("source-login-btn").addEventListener("click", () => void login());
// Coming back from the Spotify app: look for the phone as a speaker again, so
// he rarely has to tap Refresh.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !isLoggedIn() || current?.running || starting) return;
  void ensureDevice();
  void followWhatsUp();
});

// He picked "Use what's playing", went to Spotify and started a playlist (or
// moved on in it), and came back: start from the song that's up there now.
// Only when Spotify actually has a playlist on, so our own finished shows
// (which play exact song lists) never pull it back to a song already played.
async function followWhatsUp() {
  if (!source || resumeFrom !== null) return;
  let now: sp.NowPlaying | null = null;
  try { now = await sp.getNowPlaying(); } catch { return; }
  if (!now?.track || now.contextType !== "playlist") return;
  if (source.pool[source.offset % source.pool.length]?.uri === now.track.uri) return; // already there
  const r = await fromNowPlaying(source);
  if (r.ok && !current?.running) setSource(r.source);
}
$("refresh-device-btn").addEventListener("click", () => void ensureDevice());

// ====================== LIVE SHOW ======================
const statusLabel = $("status-label");
const statusMain = $("status-main");
const statusSub = $("status-sub");
const progressFill = $("progress-fill");
const timeElapsed = $("time-elapsed");
const timeRemaining = $("time-remaining");
const skipBtn = $("skip-song-btn");
const finishedBtn = $("finished-talking-btn");
const pauseBtn = $("pause-btn");
const trouble = $("trouble");
const musicBtn = $("music-btn");

let noticeUntil = 0;

// ---------- drag the progress bar to jump within a song (songs only) ----------
let scrubbing = false;
let scrubDuration = 0;
const barHit = $("progress-bar-hit");
const bar = $("progress-bar");
function scrubFraction(e: PointerEvent) {
  const r = bar.getBoundingClientRect();
  return r.width > 0 ? Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1) : 0;
}
function drawScrub(e: PointerEvent) {
  const sec = scrubFraction(e) * scrubDuration;
  progressFill.style.width = scrubFraction(e) * 100 + "%";
  timeElapsed.textContent = clock(sec);
  timeRemaining.textContent = "-" + clock(scrubDuration - sec);
}
barHit.addEventListener("pointerdown", e => {
  if (!current?.canSeek || !scrubDuration) return;
  scrubbing = true;
  bar.classList.add("scrubbing");
  try { barHit.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  drawScrub(e);
});
barHit.addEventListener("pointermove", e => { if (scrubbing) drawScrub(e); });
barHit.addEventListener("pointerup", e => {
  if (!scrubbing) return;
  scrubbing = false;
  bar.classList.remove("scrubbing");
  current?.seekSong(scrubFraction(e) * scrubDuration * 1000);
});
barHit.addEventListener("pointercancel", () => { scrubbing = false; bar.classList.remove("scrubbing"); });
const clock = (s: number) => { const t = Math.max(0, Math.round(s)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };

const ui = {
  status(label: string, main: string, sub: string) {
    statusLabel.textContent = label;
    statusMain.textContent = main;
    statusSub.textContent = sub;
  },
  progress(elapsed: number, duration: number | null) {
    scrubDuration = duration && isFinite(duration) ? duration : 0;
    if (scrubbing) return; // don't fight his finger while he's dragging
    if (duration && duration > 0 && isFinite(duration)) {
      progressFill.style.width = Math.min(100, Math.max(0, (elapsed / duration) * 100)) + "%";
      timeElapsed.textContent = clock(elapsed);
      timeRemaining.textContent = "-" + clock(duration - elapsed);
    } else {
      progressFill.style.width = "100%";
      timeElapsed.textContent = clock(elapsed);
      timeRemaining.textContent = "";
    }
  },
  buttons(kind: "songs" | "talk" | "clip") {
    show(skipBtn, kind === "songs");
    show(finishedBtn, kind !== "songs");
    finishedBtn.textContent = kind === "clip" ? "Skip recording → Next" : "I'm finished talking → Next";
  },
  music(state: boolean | null) {
    show(musicBtn, state !== null);
    if (state !== null) drawMusicButton(musicBtn, state);
  },
  current(i: number) {
    const nb = blocks[i + 1];
    $("next-up").textContent = "Next up: " + (nb ? (nb.type === "songs" ? `Play ${nb.count} ${nb.count === 1 ? "Song" : "Songs"}` : TYPE_LABELS[nb.type]) : loopEnabled ? "Loop → start again" : "End of show");
    renderTimetable(i);
  },
  songList(tracks: Track[] | null, playing: number) {
    refreshOrderIfOpen();
    const el = $("run-list");
    show(el, !!tracks && tracks.length > 1);
    if (!tracks) return;
    el.innerHTML = tracks.map((t, i) => {
      const state = i < playing ? "played" : i === playing ? "now" : "";
      const mark = i < playing ? "✓" : i === playing ? "▶" : String(i + 1);
      return `<li class="${state}"><span class="run-mark">${mark}</span><span class="run-title">${escapeHtml(t.name)}<small>${escapeHtml(t.artist)}</small></span></li>`;
    }).join("");
  },
  notice(msg: string) {
    noticeUntil = Date.now() + 8000;
    show(trouble, true);
    trouble.textContent = msg;
    setTimeout(() => { if (Date.now() >= noticeUntil && trouble.textContent === msg) show(trouble, false); }, 8100);
  },
  trouble(msg: string | null) {
    if (!msg && Date.now() < noticeUntil) return; // let a reminder finish showing
    show(trouble, !!msg);
    trouble.textContent = msg ? `🔌 ${msg}` : "";
  },
  finished() {
    releaseWakeLock();
    finishShow();
  }
};

function renderTimetable(currentIndex: number) {
  const el = $("timetable");
  el.innerHTML = "";
  blocks.forEach((b, i) => {
    const chip = document.createElement("div");
    chip.className = `timetable-chip ${b.type}`;
    if (i < currentIndex) chip.classList.add("played");
    if (i === currentIndex) chip.classList.add("current");
    chip.innerHTML = `<span class="tt-icon">${TYPE_ICONS[b.type]}</span><span class="tt-label">${b.type === "songs" ? `${b.count} ${b.count === 1 ? "Song" : "Songs"}` : SHORT_LABELS[b.type]}</span>`;
    el.appendChild(chip);
  });
  (el.children[currentIndex] as HTMLElement | undefined)?.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
}

// The screen stays on while a show plays or a take is recording. The phone
// drops the wake lock whenever the app goes out of view (e.g. a hop into
// Spotify), so it's taken again when the app comes back — otherwise the screen
// could time out mid-show and the phone would mute the app's sound (and the
// mic) until he touched it again: the "goes quiet for 20 seconds" problem.
let wakeLock: { release(): Promise<void> } | null = null;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (current?.running || recorder.recording) void keepAwake();
  if (current?.running && !current.paused) void resumeAll(); // the sound engine, if the phone paused it
});
async function keepAwake() {
  try { wakeLock = await (navigator as unknown as { wakeLock: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock.request("screen"); } catch { /* not supported */ }
}
function releaseWakeLock() { void wakeLock?.release().catch(() => {}); wakeLock = null; }

async function startShow(from: number, tracks: Map<string, Track[]>) {
  if (!blocks.length) { alert("Add at least one block!"); return; }
  await unlockAudio();
  if (blocks.some(b => b.mode === "record" && b.over)) void wp.prepare();
  current?.stop();
  showStarted();
  current = new Show(blocks, tracks, deviceId, ui, () => {
    if (!loopEnabled) return null;
    advanceSource();
    return computeTracks();
  });
  resumeFrom = null;
  resumeTracks = null;
  pauseBtn.textContent = "Pause everything";
  // Don't flash the last show's leftovers while the first block gets going.
  ui.status("Krom FM", "Getting ready…", "");
  ui.progress(0, null);
  ui.songList(null, 0);
  show($("live-order-btn"), !!source);
  show(builderScreen, false);
  show(endScreen, false);
  show(liveScreen, true);
  if (!showHistoryPushed) { showHistoryPushed = true; history.pushState({ djrafShow: true }, ""); }
  void keepAwake();
  updateStartLabel();
  await current.start(from);
}

let starting = false;
async function prepareAndStart(from: number) {
  starting = true;
  try { await prepareAndStartInner(from); } finally { starting = false; }
}
async function prepareAndStartInner(from: number) {
  if (!isLoggedIn()) { alert("Please connect Spotify first!"); return; }
  const hasSongs = blocks.some(b => b.type === "songs");
  if (hasSongs && !(await ensureDevice())) {
    alert("Open the Spotify app on this phone, then try again.");
    return;
  }
  if (hasSongs && !source) {
    const r = await fromNowPlaying(source);
    if (!r.ok) { alert(r.message); return; }
    setSource(r.source);
  }
  await startShow(from, from > 0 && resumeTracks ? resumeTracks : computeTracks());
}

// The next show carries on through the playlist instead of repeating these songs.
function advanceSource() {
  if (!source) return;
  source = { ...source, offset: source.offset + autoSongsUsed(blocks) };
  store.saveSource(source);
}

function finishShow() {
  current = null;
  advanceSource();
  renderBlocks();
  show(liveScreen, false);
  show(endScreen, true);
  updateStartLabel();
  void celebrateShowEnd();
}

function invalidateResume() { resumeFrom = null; resumeTracks = null; updateStartLabel(); }

function updateStartLabel() {
  const canResume = resumeFrom !== null;
  $("start-show-btn").textContent = canResume ? "▶ Resume Show" : "▶ Start Show";
  show($("restart-show-link"), canResume);
}

function exitToBuilderInternal() {
  closeCelebration(true);
  saveNow(); // minutes on air so far are kept even if the show stops early
  void sync().then(popMedals);
  if (current?.running) {
    resumeFrom = current.index;
    resumeTracks = computeTracks();
    current.stop();
    if (deviceId) void sp.pauseVerified(deviceId);
  }
  current = null;
  releaseWakeLock();
  show(liveScreen, false);
  show(endScreen, false);
  show(builderScreen, true);
  updateStartLabel();
}
function exitToBuilder() {
  exitToBuilderInternal();
  if (showHistoryPushed) { showHistoryPushed = false; goBack(); }
}

$("start-show-btn").addEventListener("click", () => void prepareAndStart(resumeFrom ?? 0));
$("restart-show-link").addEventListener("click", () => { invalidateResume(); void prepareAndStart(0); });
skipBtn.addEventListener("click", () => current?.skipSong());
finishedBtn.addEventListener("click", () => current?.finishedTalking());
musicBtn.addEventListener("click", () => { void unlockAudio(); current?.toggleMusic(); });
pauseBtn.addEventListener("click", async () => {
  if (!current) return;
  await current.togglePause();
  pauseBtn.textContent = current.paused ? "Resume" : "Pause everything";
});
$("stop-show-btn").addEventListener("click", exitToBuilder);
$("play-again-btn").addEventListener("click", () => void prepareAndStart(0));
$("back-to-builder-btn").addEventListener("click", exitToBuilder);

// ====================== PHONE CHECK (tap the version number) ======================
// For the parent: checks, on this actual phone, the things that behave
// differently on a phone than on a computer.
let checking = false;
$("app-version-tag").addEventListener("click", async () => {
  if (checking || current?.running) return;
  if (!isLoggedIn()) { alert("Connect Spotify first, then tap the version number again."); return; }
  if (!(await ensureDevice()) || !deviceId) { alert("Open the Spotify app on this phone first, then tap the version number again."); return; }
  checking = true;
  $("app-version-tag").textContent = "Checking this phone…";
  const lines: string[] = [];
  try {
    const d = (await sp.getDevices()).find(x => x.id === deviceId);
    lines.push(`Spotify speaker: ${d?.name ?? "?"} (${d?.type ?? "?"})`);
    try {
      const q = await sp.getQueue();
      lines.push(q.length ? "✅ “Use what's playing” can read the songs coming up." : "ℹ️ Play a playlist in Spotify so “Use what's playing” has songs to read.");
    } catch { lines.push("⚠️ Couldn't read Spotify's up-next list. Try again in a moment."); }
    try {
      const mic = await navigator.permissions.query({ name: "microphone" as PermissionName });
      lines.push(mic.state === "granted" ? "✅ Microphone allowed." : "ℹ️ Microphone: the phone will ask the first time he records — tap Allow.");
    } catch { /* not supported */ }
  } finally {
    checking = false;
    $("app-version-tag").textContent = VERSION_TAG;
  }
  alert(lines.join("\n\n"));
});

// ====================== SPLASH (same as the original app) ======================
const SPLASH_DURATION_MS = 4200;
const SPLASH_TAP_HINT_DELAY_MS = 1900;
const SPLASH_PHRASES = ["Warming up the mic", "Tuning the antenna", "Cueing up the tunes", "Dusting off the turntable"];

function runSplash() {
  if (new URLSearchParams(location.search).has("code")) {
    show(splashScreen, false);
    show(builderScreen, true);
    return;
  }
  let i = 0;
  const phrase = $("splash-phrase");
  const interval = setInterval(() => { i = (i + 1) % SPLASH_PHRASES.length; phrase.textContent = SPLASH_PHRASES[i]; }, 900);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearInterval(interval);
    void unlockAudio();
    splashScreen.classList.add("splash-fade-out");
    setTimeout(() => {
      show(splashScreen, false);
      // Only reveal the builder if nothing else took over during the fade.
      if (liveScreen.classList.contains("hidden") && endScreen.classList.contains("hidden")) show(builderScreen, true);
    }, 400);
  };
  setTimeout(finish, SPLASH_DURATION_MS);
  setTimeout(() => show($("splash-tap-hint"), true), SPLASH_TAP_HINT_DELAY_MS);
  splashScreen.addEventListener("click", finish, { once: true });
}

// ====================== INIT ======================
async function init() {
  renderBlocks();
  renderSource();
  updateStartLabel();
  preloadMusic();
  await handleRedirect();
  if (isLoggedIn()) await ensureDevice();
  else showLoggedOut();
  void sync().then(popMedals); // his totals from the other phones
}

// ====================== TIME ON AIR → RECORDS ======================
// Once a second while the show is playing (not paused): another second on air.
// A record earned mid-show pops up for a moment (no sound — the phone's own
// sounds can make the Spotify app pause a song). There's deliberately no
// countdown anywhere: the record just arrives.
const starPop = $("star-pop");
let starPopTimer: number | null = null;
function popMedal(m: Medal) {
  if (!current?.running) return;
  $("star-pop-text").textContent = `You earned a ${m} record!`;
  $("star-pop-icon").style.color = MEDAL_COLOR[m];
  show(starPop, true);
  starPop.classList.remove("star-pop-go");
  void starPop.offsetWidth; // restart the pop animation
  starPop.classList.add("star-pop-go");
  navigator.vibrate?.([30, 40, 30]);
  if (starPopTimer !== null) clearTimeout(starPopTimer);
  starPopTimer = window.setTimeout(() => show(starPop, false), 3500);
}
function popMedals(ms: Medal[]) { for (const m of ms) popMedal(m); }
let onAirTicks = 0;
window.setInterval(() => {
  if (!current?.running || current.paused) return;
  const earned = onAirSecond();
  if (earned) popMedal(earned);
  if (++onAirTicks % 60 === 0) void sync().then(popMedals); // keep the shared total up to date
}, 1000);

// ?demo=party / bronze / silver / gold shows the end-of-show celebration straight away.
const demo = new URLSearchParams(location.search).get("demo");
if (demo === "party" || demo === "bronze" || demo === "silver" || demo === "gold") previewCelebration(demo);

watchForUpdates(() => starting || !!current?.running || recorder.recording || !recorderModal.classList.contains("hidden"));
runSplash();
void init();

// Handy for testing from the browser console.
(window as unknown as { djraf: unknown }).djraf = { get show() { return current; }, get source() { return source; }, blocks: () => blocks };
