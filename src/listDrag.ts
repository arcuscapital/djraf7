// Drag-to-reorder for a long, scrolling list (the song order sheet).
// Press and hold a row, or grab its ≡ handle straight away, then drag it up or
// down: the rows move as the finger passes them, and the list scrolls by itself
// when the finger nears its top or bottom. A quick swipe still just scrolls.

const HOLD_MS = 320;
const MOVE_CANCEL_PX = 10;
const EDGE_PX = 56;

export interface Reorderable { readonly dragging: boolean }

export function makeReorderable(list: HTMLElement, rowSelector: string, onDrop: (from: number, to: number) => void): Reorderable {
  let hold: number | undefined;
  let startX = 0, startY = 0, lastY = 0;
  let drag: { row: HTMLElement; from: number; pointerId: number } | null = null;
  let scrollTimer: number | null = null;

  const rows = () => Array.from(list.querySelectorAll<HTMLElement>(rowSelector));
  const cancelHold = () => { clearTimeout(hold); hold = undefined; };

  list.addEventListener("pointerdown", e => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(rowSelector);
    if (!row || drag) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    startX = e.clientX;
    startY = e.clientY;
    if ((e.target as HTMLElement).closest(".order-handle")) {
      e.preventDefault();
      begin(row, e.pointerId, e.clientY);
      return;
    }
    hold = window.setTimeout(() => begin(row, e.pointerId, startY), HOLD_MS);
  });
  // Moving before the hold completes means he's scrolling, not dragging.
  list.addEventListener("pointermove", e => {
    if (!drag && hold !== undefined && (Math.abs(e.clientY - startY) > MOVE_CANCEL_PX || Math.abs(e.clientX - startX) > MOVE_CANCEL_PX)) cancelHold();
  });
  list.addEventListener("pointerup", cancelHold);
  list.addEventListener("pointercancel", cancelHold);
  // While dragging, the finger must move the song, not scroll the page.
  list.addEventListener("touchmove", e => { if (drag) e.preventDefault(); }, { passive: false });
  list.addEventListener("contextmenu", e => e.preventDefault()); // Android long-press menu

  function begin(row: HTMLElement, pointerId: number, y: number) {
    hold = undefined;
    drag = { row, from: rows().indexOf(row), pointerId };
    lastY = y;
    row.classList.add("lifting");
    try { row.setPointerCapture(pointerId); } catch { /* ignore */ }
    navigator.vibrate?.(15);
    document.addEventListener("pointermove", onMove, { passive: false });
    document.addEventListener("pointerup", onEnd);
    document.addEventListener("pointercancel", onEnd);
    scrollTimer = window.setInterval(autoScroll, 30);
  }

  function onMove(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.preventDefault();
    lastY = e.clientY;
    place();
  }

  // Put the dragged row just before the first row whose middle is below the finger.
  function place() {
    if (!drag) return;
    const dragged = drag.row;
    const before = rows().find(r => r !== dragged && lastY < r.getBoundingClientRect().top + r.offsetHeight / 2) ?? null;
    if (before) { if (dragged.nextElementSibling !== before) list.insertBefore(dragged, before); }
    else if (list.lastElementChild !== dragged) list.appendChild(dragged);
  }

  function autoScroll() {
    const b = list.getBoundingClientRect();
    const speed = lastY < b.top + EDGE_PX ? -(b.top + EDGE_PX - lastY) : lastY > b.bottom - EDGE_PX ? lastY - (b.bottom - EDGE_PX) : 0;
    if (!speed) return;
    list.scrollTop += Math.max(-24, Math.min(24, speed / 2));
    place();
  }

  function onEnd(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onEnd);
    document.removeEventListener("pointercancel", onEnd);
    if (scrollTimer !== null) { clearInterval(scrollTimer); scrollTimer = null; }
    const { row, from } = drag;
    drag = null;
    row.classList.remove("lifting");
    const to = rows().indexOf(row);
    if (to !== from && to >= 0) onDrop(from, to);
  }

  return { get dragging() { return drag !== null; } };
}
