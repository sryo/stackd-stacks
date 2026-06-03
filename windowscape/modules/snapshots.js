// Window snapshot (minimize) system — JS port of WindowScape/snapshots.lua.
//
// Maintains a per-display strip of window thumbnails at the bottom of the
// screen. Capturing a window grabs its CGSHWCaptureWindowList image via
// sd.windows.snapshot(id) and AX-minimizes the window; the thumbnail tile
// sits in the strip until the user clicks it to restore (or closeAll/
// restoreAll/clearAll bulk-acts).
//
// Architecture vs lua:
// - Rendering: lua used hs.canvas (one canvas per tile + one tooltip canvas).
//   Here we render into the stack's own fullscreen WebView via DOM nodes. The
//   stack's manifest stays display:"primary" — the strip + tiles render only
//   on the primary display's WebView surface. Snapshots originating on other
//   displays are still tracked, restored, and reserved-frame-adjusted, but
//   their tiles appear in the primary strip. (Primitive gap: sd.overlay
//   attaches to windows, not free regions, so per-display strip canvases
//   would need either a window-target hack or display:"all" — both have
//   compromises documented in the port report.)
// - Zoom-in animation: lua used hs.canvas:frame timer interpolation. Here a
//   CSS transition on transform/opacity inside the tile <div> does the same.
// - Scroll eventtap: registered via stack.json `eventtap` manifest entry
//   (scrollWheel). The Bridge currently doesn't propagate scrollWheel delta
//   fields (mouseEventDeltaX/Y is only attached to drag/move events), so we
//   fall back to a per-tick discrete scroll step keyed off the modifier
//   flags + x/y location. Documented as a primitive gap.
// - Refresh timer: setInterval polls sd.windows.snapshot(id) every 5s for
//   each tracked window, replacing the cached image so the preview stays
//   current as the underlying window changes off-screen.
// - Right-click manual snapshot: registered via stack.json `eventtap`
//   (rightMouseDown). On match, look up the window under the cursor and
//   call captureWithoutMinimize.
// - State persistence: sd.settings.set/get. Image dataURLs persist directly.

import { sd } from "sd://runtime/api.js";
import { state, log } from "./core.js";

// Layout constants — same as snapshots.lua.
export const PADDING       = 8;
export const GAP           = 4;
export const COLUMN_WIDTH  = 140;
export const REFRESH_INTERVAL = 5000;     // ms — slow refresh (lua used 0.5s w/ skip)
export const MIN_TILE_HEIGHT = 30;
export const MAX_TILE_HEIGHT = 200;

// Animation constants for zoom-in (CSS-driven).
const ZOOM_IN_MS  = 280;
const ZOOM_HOVER_SCALE = 1.15;
const ZOOM_HOVER_MS    = 120;
const RESTORE_FADE_MS  = 180;

// Strip auto-resolution: only the display matching __sd_screen actually
// renders DOM nodes. Recorded once during init().
let myScreenInfo = null;     // { displayID, frame, ... }

// DOM container hosting the strips (one per display).
let stripsRoot = null;
let stripsByDisplay = Object.create(null);    // displayID -> { container, tiles: Map<winId, el> }
let tooltipEl = null;

let refreshTimerHandle = null;
let saveTimerHandle = null;

// Hot-import to avoid circular dep at module-eval time. operations.js calls
// captureAndMinimize → snapshots.js, and snapshots.js eventually calls
// tileWindows on restore. We require() tiler lazily.
async function getTiler() {
  return await import("./tiler.js");
}

// ----------------------------------------------------------------------------
// State helpers
// ----------------------------------------------------------------------------

// True if a window is currently snapshotted (kept in our state map).
// Port of snapshots.lua isMinimized().
export function isMinimized(winId) {
  return !!state.snapshotsState.snapshots[winId];
}

// Port of snapshots.lua getState().
export function getState() {
  return state.snapshotsState;
}

function truncateMiddle(input, maxLength) {
  if (!input) return "";
  if (input.length <= maxLength) return input;
  const partLen = Math.floor(maxLength / 2);
  return input.slice(0, partLen - 2) + "..." + input.slice(-partLen);
}

// Port of snapshots.lua getSnapshotSizeForWindow.
export function getSnapshotSizeForWindow(winFrame) {
  const w = COLUMN_WIDTH - PADDING * 2;
  if (!winFrame || winFrame.w <= 0 || winFrame.h <= 0) {
    return { w, h: Math.floor(w * 0.66) };
  }
  const aspectRatio = winFrame.w / winFrame.h;
  let h = Math.floor(w / aspectRatio);
  h = Math.max(MIN_TILE_HEIGHT, Math.min(MAX_TILE_HEIGHT, h));
  return { w, h };
}

// Port of snapshots.lua getSnapshotSize (fallback).
export function getSnapshotSize() {
  return { w: COLUMN_WIDTH - PADDING * 2, h: 80 };
}

// Snapshots on the given display, in insertion order.
function snapshotsOnDisplay(displayID) {
  const out = [];
  for (const winId of state.snapshotsState.order) {
    const data = state.snapshotsState.snapshots[winId];
    if (!data) continue;
    if (data.displayID !== displayID) continue;
    out.push({ winId, data });
  }
  return out;
}

// Port of snapshots.lua getReservedArea — returns the strip rectangle in
// global screen coords for a given display, or null if no snapshots there.
export function getReservedArea(d) {
  if (!d) return null;
  const list = snapshotsOnDisplay(d.displayID);
  if (list.length === 0) return null;
  let maxHeight = 0;
  for (const { data } of list) {
    const snapSize = data.snapSize || getSnapshotSize();
    if (snapSize.h > maxHeight) maxHeight = snapSize.h;
  }
  const frame = d.frame;
  const isLandscape = frame.w > frame.h;
  if (isLandscape) {
    // Bottom strip (deviating from lua's right-column landscape; bar-style
    // bottom anchor matches the user's visual spec in the port brief).
    const rowHeight = maxHeight + PADDING * 2;
    return {
      x: frame.x,
      y: frame.y + frame.h - rowHeight,
      w: frame.w,
      h: rowHeight
    };
  }
  // Portrait — bottom strip still.
  const rowHeight = maxHeight + PADDING * 2;
  return {
    x: frame.x,
    y: frame.y + frame.h - rowHeight,
    w: frame.w,
    h: rowHeight
  };
}

// Port of snapshots.lua getAdjustedScreenFrame — visibleFrame minus the
// reserved strip height. tiler.js calls this so tiles don't draw under the
// strip.
export function adjustedFrameForDisplay(d) {
  if (!d) return null;
  const vf = d.visibleFrame || d.frame;
  const reserved = getReservedArea(d);
  if (!reserved) return null;
  return {
    x: vf.x,
    y: vf.y,
    w: vf.w,
    h: Math.max(0, vf.h - reserved.h)
  };
}

// Returns the display whose strip reserved-area contains (x,y), or null.
// Port of snapshots.lua screenForStripAt.
export function screenForStripAt(x, y) {
  for (const d of state.displays) {
    const r = getReservedArea(d);
    if (!r) continue;
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return d;
  }
  return null;
}

// ----------------------------------------------------------------------------
// DOM rendering
// ----------------------------------------------------------------------------

function ensureStripsRoot() {
  if (stripsRoot) return stripsRoot;
  stripsRoot = document.createElement("div");
  stripsRoot.id = "ws-strips-root";
  Object.assign(stripsRoot.style, {
    position: "fixed",
    inset: "0",
    pointerEvents: "none",
    zIndex: "1"
  });
  document.body.appendChild(stripsRoot);

  // Stylesheet — injected once.
  if (!document.getElementById("ws-strips-style")) {
    const style = document.createElement("style");
    style.id = "ws-strips-style";
    style.textContent = STRIP_CSS;
    document.head.appendChild(style);
  }
  return stripsRoot;
}

const STRIP_CSS = `
  #ws-strips-root .ws-strip {
    position: absolute;
    display: flex;
    flex-direction: row;
    align-items: flex-end;
    gap: ${GAP}px;
    padding: ${PADDING}px;
    overflow: hidden;
    pointer-events: auto;
    box-sizing: border-box;
  }
  #ws-strips-root .ws-strip-inner {
    display: flex;
    flex-direction: row;
    align-items: flex-end;
    gap: ${GAP}px;
    transition: transform 80ms linear;
  }
  #ws-strips-root .ws-tile {
    position: relative;
    background: rgba(40, 40, 40, 0.85);
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    overflow: hidden;
    cursor: pointer;
    flex-shrink: 0;
    opacity: 0;
    transform: scale(0.5);
    transition: transform ${ZOOM_IN_MS}ms cubic-bezier(0.22, 0.61, 0.36, 1),
                opacity   ${ZOOM_IN_MS}ms ease-out,
                left      ${ZOOM_IN_MS}ms cubic-bezier(0.22, 0.61, 0.36, 1),
                top       ${ZOOM_IN_MS}ms cubic-bezier(0.22, 0.61, 0.36, 1);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.55);
    transform-origin: center bottom;
  }
  #ws-strips-root .ws-tile.in {
    opacity: 1;
    transform: scale(1);
  }
  #ws-strips-root .ws-tile.hover {
    transform: scale(${ZOOM_HOVER_SCALE});
    transition: transform ${ZOOM_HOVER_MS}ms ease-out;
    z-index: 10;
  }
  #ws-strips-root .ws-tile.leaving {
    opacity: 0;
    transform: scale(0.4);
    transition: transform ${RESTORE_FADE_MS}ms ease-in,
                opacity   ${RESTORE_FADE_MS}ms ease-in;
  }
  #ws-strips-root .ws-tile img.ws-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  #ws-strips-root .ws-tile .ws-close {
    position: absolute;
    top: 4px;
    left: 4px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: rgba(204, 51, 51, 0.85);
    border: 1px solid rgba(0, 0, 0, 0.3);
    display: none;
  }
  #ws-strips-root .ws-tile.hover .ws-close { display: block; }
  #ws-tooltip {
    position: absolute;
    background: rgba(0, 0, 0, 0.78);
    color: white;
    padding: 6px 10px;
    border-radius: 4px;
    font: 13px -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
    pointer-events: none;
    opacity: 0;
    transition: opacity 120ms ease-out;
    z-index: 100;
    max-width: 320px;
    text-align: center;
    line-height: 1.3;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
  }
  #ws-tooltip.visible { opacity: 1; }
`;

// Map a global screen rect to local WebView coords. The WebView frame is set
// to screen.frame (via region:"fullscreen") on a single display; if a target
// rect falls outside that display, the result is off-screen which is fine
// (we just won't see those tiles — see "primitive gap" above).
function globalToLocal(rect) {
  const my = myScreenInfo && myScreenInfo.frame;
  if (!my) return rect;
  return {
    x: rect.x - my.x,
    y: rect.y - my.y,
    w: rect.w,
    h: rect.h
  };
}

// Create/update the strip container for the given display.
function ensureStripContainer(d) {
  ensureStripsRoot();
  let entry = stripsByDisplay[d.displayID];
  if (!entry) {
    const container = document.createElement("div");
    container.className = "ws-strip";
    container.dataset.displayId = String(d.displayID);
    const inner = document.createElement("div");
    inner.className = "ws-strip-inner";
    container.appendChild(inner);
    stripsRoot.appendChild(container);
    entry = { container, inner, tiles: new Map() };
    stripsByDisplay[d.displayID] = entry;
  }
  return entry;
}

function removeStripContainer(displayID) {
  const entry = stripsByDisplay[displayID];
  if (!entry) return;
  entry.container.remove();
  delete stripsByDisplay[displayID];
}

// Render / re-render every tile to match snapshotsState. Port of
// snapshots.lua updateLayout.
export function updateLayout() {
  // Strip containers + tiles only render in the primary WebView (the JS
  // module is loaded once per stack instance). For multi-display visual
  // rendering see the primitive-gap note at the top.
  if (!stripsRoot) ensureStripsRoot();

  // Reassign screenId for snapshots whose display went away.
  const validDisplayIds = new Set(state.displays.map((d) => d.displayID));
  for (const did of Object.keys(state.snapshotsState.stripScrollOffsets)) {
    if (!validDisplayIds.has(+did)) {
      delete state.snapshotsState.stripScrollOffsets[did];
    }
  }
  for (const winId of state.snapshotsState.order) {
    const data = state.snapshotsState.snapshots[winId];
    if (!data) continue;
    if (data.displayID && !validDisplayIds.has(data.displayID)) {
      // Re-host this snapshot onto whichever display contains the original
      // frame center, falling back to the primary display.
      const of = data.frame || {};
      const cx = (of.x || 0) + (of.w || 0) / 2;
      const cy = (of.y || 0) + (of.h || 0) / 2;
      let found = null;
      for (const d of state.displays) {
        const f = d.frame;
        if (cx >= f.x && cx < f.x + f.w && cy >= f.y && cy < f.y + f.h) {
          found = d; break;
        }
      }
      data.displayID = (found || state.displays[0]) && (found || state.displays[0]).displayID;
    }
  }

  // Group snapshots by display.
  const byDisplay = Object.create(null);
  for (const winId of state.snapshotsState.order) {
    const data = state.snapshotsState.snapshots[winId];
    if (!data || !data.displayID) continue;
    if (!byDisplay[data.displayID]) byDisplay[data.displayID] = [];
    byDisplay[data.displayID].push({ winId, data });
  }

  // Remove strip containers for displays that no longer have snapshots.
  for (const dStr of Object.keys(stripsByDisplay)) {
    const did = +dStr;
    if (!byDisplay[did]) removeStripContainer(did);
  }

  // Render each strip.
  for (const d of state.displays) {
    const list = byDisplay[d.displayID];
    if (!list || list.length === 0) continue;

    const entry = ensureStripContainer(d);
    const reserved = getReservedArea(d);
    if (!reserved) continue;

    // Position the strip container in local WebView coords.
    const local = globalToLocal(reserved);
    Object.assign(entry.container.style, {
      left:   `${local.x}px`,
      top:    `${local.y}px`,
      width:  `${local.w}px`,
      height: `${local.h}px`
    });

    // Total inner content width (for scroll clamp).
    let contentW = 0;
    for (let i = 0; i < list.length; i++) {
      const snapSize = list[i].data.snapSize || getSnapshotSize();
      contentW += snapSize.w;
      if (i > 0) contentW += GAP;
    }
    const visibleW = local.w - PADDING * 2;
    const maxOffset = Math.max(0, contentW - visibleW);
    const cur = state.snapshotsState.stripScrollOffsets[d.displayID] || 0;
    const clamped = Math.max(0, Math.min(cur, maxOffset));
    state.snapshotsState.stripScrollOffsets[d.displayID] = clamped;
    entry.inner.style.transform = `translateX(${-clamped}px)`;

    // Drop tiles whose snapshots are gone.
    const liveIds = new Set(list.map((x) => x.winId));
    for (const [winId, el] of [...entry.tiles.entries()]) {
      if (!liveIds.has(winId)) {
        el.remove();
        entry.tiles.delete(winId);
      }
    }

    // Render tiles in order.
    for (const { winId, data } of list) {
      let tile = entry.tiles.get(winId);
      if (!tile) {
        tile = makeTile(winId, data);
        entry.tiles.set(winId, tile);
        entry.inner.appendChild(tile);
        // Trigger zoom-in animation on next frame.
        requestAnimationFrame(() => requestAnimationFrame(() => tile.classList.add("in")));
      } else {
        // Update size + image if changed.
        const snapSize = data.snapSize || getSnapshotSize();
        tile.style.width  = `${snapSize.w}px`;
        tile.style.height = `${snapSize.h}px`;
        const img = tile.querySelector("img.ws-img");
        if (img && data.image && img.src !== data.image) img.src = data.image;
      }
    }

    // Reorder DOM children to match list order (insertion order).
    let prev = null;
    for (const { winId } of list) {
      const el = entry.tiles.get(winId);
      if (!el) continue;
      if (prev) {
        if (prev.nextSibling !== el) entry.inner.insertBefore(el, prev.nextSibling);
      } else {
        if (entry.inner.firstChild !== el) entry.inner.insertBefore(el, entry.inner.firstChild);
      }
      prev = el;
    }
  }
}

function makeTile(winId, data) {
  const snapSize = data.snapSize || getSnapshotSize();
  const el = document.createElement("div");
  el.className = "ws-tile";
  el.style.width  = `${snapSize.w}px`;
  el.style.height = `${snapSize.h}px`;
  el.dataset.winId = String(winId);

  if (data.image) {
    const img = document.createElement("img");
    img.className = "ws-img";
    img.src = data.image;
    el.appendChild(img);
  }

  const closeDot = document.createElement("div");
  closeDot.className = "ws-close";
  el.appendChild(closeDot);

  // Note: the stack panel is clickThrough:true (so it doesn't block clicks
  // on underlying tiled windows), which means DOM events here never fire.
  // Hover + click + right-click are routed through eventtap callbacks below
  // (onMouseMoveEvent / onLeftClickEvent / onRightClickEvent).
  return el;
}

// ----------------------------------------------------------------------------
// Tooltip — port of snapshots.lua initTooltip/showTooltip/hideTooltip.
// ----------------------------------------------------------------------------

function ensureTooltip() {
  if (tooltipEl) return tooltipEl;
  tooltipEl = document.createElement("div");
  tooltipEl.id = "ws-tooltip";
  document.body.appendChild(tooltipEl);
  return tooltipEl;
}

export function showTooltip(winId, tileEl) {
  const data = state.snapshotsState.snapshots[winId];
  if (!data) return;
  const tt = ensureTooltip();

  const appName = data.app || "";
  const title = data.title || "";
  let msg;
  if (appName && title && appName !== title) msg = `${appName}\n${title}`;
  else if (appName) msg = appName;
  else msg = title || "Untitled";

  const lines = msg.split("\n").map((l) => truncateMiddle(l, 60));
  tt.textContent = "";
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) tt.appendChild(document.createElement("br"));
    tt.appendChild(document.createTextNode(lines[i]));
  }

  // Position above the tile (mirrors lua's "anchor above center" idea —
  // lua used left-of-tile for landscape; bottom-strip variant places it
  // above so it doesn't clip into the bottom-of-screen edge).
  const r = tileEl.getBoundingClientRect();
  tt.style.visibility = "hidden";
  tt.classList.add("visible");
  const tr = tt.getBoundingClientRect();
  let x = r.left + r.width / 2 - tr.width / 2;
  let y = r.top - tr.height - 8;
  // Clamp to viewport
  if (x < 4) x = 4;
  if (x + tr.width > window.innerWidth - 4) x = window.innerWidth - tr.width - 4;
  if (y < 4) y = r.bottom + 8;
  tt.style.left = `${x}px`;
  tt.style.top  = `${y}px`;
  tt.style.visibility = "";
}

export function hideTooltip() {
  if (!tooltipEl) return;
  tooltipEl.classList.remove("visible");
}

// ----------------------------------------------------------------------------
// Context menu — DOM-only fallback (lua used hs.menubar.popupMenu).
// ----------------------------------------------------------------------------

let menuEl = null;
let menuRows = [];

export function showContextMenu(winId, data) {
  hideContextMenu();
  const m = document.createElement("div");
  m.dataset.kind = "ws-menu";
  Object.assign(m.style, {
    position: "fixed",
    background: "rgba(30,30,30,0.95)",
    color: "white",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: "6px",
    padding: "4px 0",
    font: "13px -apple-system, BlinkMacSystemFont, sans-serif",
    zIndex: "1000",
    minWidth: "160px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.4)"
  });
  const items = [
    { label: "Restore",     fn: () => restoreFromSnapshot(winId) },
    { label: "Close",       fn: () => closeFromSnapshot(winId) },
    { label: "—",           fn: null },
    { label: "Restore All", fn: () => restoreAll() },
    { label: "Close All",   fn: () => closeAll() },
    { label: "Clear All",   fn: () => clearAll() }
  ];
  // Build rows. Click handling can't use DOM events on a clickThrough panel,
  // so each row records its local rect (set after append) and the eventtap-
  // routed onLeftClickEvent dispatches against it.
  menuRows.length = 0;
  for (const it of items) {
    if (it.label === "—") {
      const sep = document.createElement("div");
      Object.assign(sep.style, {
        height: "1px",
        margin: "4px 0",
        background: "rgba(255,255,255,0.12)"
      });
      m.appendChild(sep);
      continue;
    }
    const row = document.createElement("div");
    row.textContent = it.label;
    row.dataset.menuRow = "1";
    Object.assign(row.style, {
      padding: "6px 16px",
      userSelect: "none"
    });
    m.appendChild(row);
    menuRows.push({ el: row, fn: it.fn });
  }
  document.body.appendChild(m);
  menuEl = m;
  // Position at cursor.
  const p = sd.mouse.peek() || { x: 100, y: 100 };
  const local = globalToLocal({ x: p.x, y: p.y, w: 0, h: 0 });
  // Clamp into viewport.
  const mw = m.offsetWidth || 160, mh = m.offsetHeight || 200;
  let lx = local.x, ly = local.y;
  if (lx + mw > window.innerWidth - 4)  lx = window.innerWidth - mw - 4;
  if (ly + mh > window.innerHeight - 4) ly = window.innerHeight - mh - 4;
  m.style.left = `${lx}px`;
  m.style.top  = `${ly}px`;
}

// onLeftClickEvent delegates here when a menu is open. Returns true if the
// click was handled (consumed by a menu row, dismissed, or eaten as noise).
function tryMenuClickAt(x, y) {
  if (!menuEl) return false;
  const myX = (myScreenInfo && myScreenInfo.frame && myScreenInfo.frame.x) || 0;
  const myY = (myScreenInfo && myScreenInfo.frame && myScreenInfo.frame.y) || 0;
  for (const r of menuRows) {
    const rect = r.el.getBoundingClientRect();
    const gx = rect.left + myX, gy = rect.top + myY;
    if (x >= gx && x < gx + rect.width && y >= gy && y < gy + rect.height) {
      const fn = r.fn;
      hideContextMenu();
      if (fn) fn();
      return true;
    }
  }
  // Click outside the menu → dismiss without action.
  hideContextMenu();
  return true;
}

function hideContextMenu() {
  if (!menuEl) return;
  menuEl.remove();
  menuEl = null;
}

// ----------------------------------------------------------------------------
// Capture flows — see snapshot_create.js for the heavy lifting.
// ----------------------------------------------------------------------------

import {
  captureAndMinimize as _captureAndMinimize,
  captureWithoutMinimize as _captureWithoutMinimize
} from "./snapshot_create.js";

export const captureAndMinimize    = _captureAndMinimize;
export const captureWithoutMinimize = _captureWithoutMinimize;

// ----------------------------------------------------------------------------
// Restore / cleanup / bulk verbs
// ----------------------------------------------------------------------------

// Drop a single snapshot's resources (DOM tile, data entry, order entry).
// Port of snapshots.lua cleanupResources.
export function cleanupResources(winId) {
  const data = state.snapshotsState.snapshots[winId];
  if (!data) return;
  // Remove from order
  const idx = state.snapshotsState.order.indexOf(winId);
  if (idx >= 0) state.snapshotsState.order.splice(idx, 1);
  delete state.snapshotsState.snapshots[winId];
  // Remove the DOM tile if present.
  for (const did of Object.keys(stripsByDisplay)) {
    const entry = stripsByDisplay[did];
    const el = entry.tiles.get(winId);
    if (el) {
      el.remove();
      entry.tiles.delete(winId);
    }
  }
  scheduleSnapshotSave();
  if (state.onLayoutChange) state.onLayoutChange();
}

// Restore a snapshot: un-minimize, focus, drop tile. Port of
// snapshots.lua restoreFromSnapshot (sans the canvas zoom-out anim — CSS
// transition on the leaving tile does the equivalent).
//
// Sentinel `restoringIds`: keeps the deminimize bang handler from snapping
// the tile out of the DOM mid-fade. When WE drive the deminimize, we want
// the CSS fade-out to play; the setTimeout below does the final cleanup.
const restoringIds = new Set();
export async function restoreFromSnapshot(winId) {
  const data = state.snapshotsState.snapshots[winId];
  if (!data) return;
  if (restoringIds.has(winId)) return;
  restoringIds.add(winId);
  hideTooltip();
  // Mark tile "leaving" so the CSS transition fades it out.
  for (const did of Object.keys(stripsByDisplay)) {
    const entry = stripsByDisplay[did];
    const el = entry.tiles.get(winId);
    if (el) el.classList.add("leaving");
  }
  // AX-deminimize (sd.windows.minimize(id, false)). Then focus.
  try { await sd.windows.minimize(winId, false); } catch (_) {}
  try { await sd.windows.focus(winId); } catch (_) {}
  // Wait for the fade, then drop.
  setTimeout(async () => {
    restoringIds.delete(winId);
    cleanupResources(winId);
    updateLayout();
    // Re-tile so the restored window gets reabsorbed into the layout.
    const tiler = await getTiler();
    await tiler.tileWindows();
  }, RESTORE_FADE_MS);
}

// Exposed so the deminimize-bang handler can check "is this our own
// in-flight restore?" before cleaning up.
export function isRestoringInternally(winId) {
  return restoringIds.has(winId);
}

// Close the underlying window via AX, then drop the snapshot. Port of
// snapshots.lua showContextMenu's "Close" item.
export async function closeFromSnapshot(winId) {
  try { await sd.windows.close(winId); } catch (_) {}
  cleanupResources(winId);
  updateLayout();
  const tiler = await getTiler();
  await tiler.tileWindows();
}

// Port of snapshots.lua clearAll — drop every tile without restoring.
export function clearAll() {
  hideTooltip();
  const ids = [...state.snapshotsState.order];
  for (const id of ids) cleanupResources(id);
  updateLayout();
}

// Port of snapshots.lua restoreAll — un-minimize everything.
// Fire-and-forget each restore in parallel; the per-tile fade + bottom-of-
// queue tiler.tileWindows pass will settle once all the deminimizes land.
export async function restoreAll() {
  const ids = [...state.snapshotsState.order];
  for (const id of ids) {
    restoreFromSnapshot(id);   // intentionally not awaited
  }
}

// Port of snapshots.lua closeAll — close every snapshotted window.
export async function closeAll() {
  const ids = [...state.snapshotsState.order];
  for (const id of ids) {
    try { await sd.windows.close(id); } catch (_) {}
    cleanupResources(id);
  }
  updateLayout();
  const tiler = await getTiler();
  await tiler.tileWindows();
}

// ----------------------------------------------------------------------------
// Refresh timer — port of snapshots.lua startRefreshTimer / refreshSnapshots.
// ----------------------------------------------------------------------------

async function refreshSnapshots() {
  if (state.snapshotsState.isCreating) return;
  const ids = [...state.snapshotsState.order];
  if (ids.length === 0) return;
  for (const winId of ids) {
    const data = state.snapshotsState.snapshots[winId];
    if (!data) continue;
    try {
      const snap = await sd.windows.snapshot(winId, { format: "jpeg", quality: 0.7 });
      if (snap && snap.dataURL) {
        data.image = snap.dataURL;
        // Update the live <img> if present.
        for (const did of Object.keys(stripsByDisplay)) {
          const el = stripsByDisplay[did].tiles.get(winId);
          if (!el) continue;
          const img = el.querySelector("img.ws-img");
          if (img) img.src = data.image;
        }
      }
    } catch (_) { /* window may be off-screen / unsnapshottable — skip */ }
  }
  scheduleSnapshotSave();
}

function startRefreshTimer() {
  if (refreshTimerHandle) return;
  refreshTimerHandle = setInterval(refreshSnapshots, REFRESH_INTERVAL);
}

function stopRefreshTimer() {
  if (refreshTimerHandle) { clearInterval(refreshTimerHandle); refreshTimerHandle = null; }
}

// ----------------------------------------------------------------------------
// Scroll handling — port of snapshots.lua startScrollEventtap.
// Registered as `eventtap` in stack.json; the callback is wired by main.js.
// ----------------------------------------------------------------------------

// Discrete per-event scroll step (px). The Bridge currently doesn't surface
// scrollWheel deltas (see Bridge.swift fireEventTap), so each scrollWheel
// event nudges by SCROLL_STEP and we rely on the user's scroll-wheel cadence
// driving event rate. Documented in the port report as a primitive gap.
const SCROLL_STEP = 30;

export function onScrollWheelEvent(payload) {
  if (state.snapshotsState.order.length === 0) return;
  const { x, y } = payload || {};
  if (x == null || y == null) return;
  const d = screenForStripAt(x, y);
  if (!d) return;
  // Without a delta field we step in one direction. Detect modifier from
  // flags: shift-scroll → reverse. (Default rightward scroll exposes later
  // snapshots when the strip overflows.)
  const flags = payload.flags || 0;
  const SHIFT_MASK = 1 << 17;
  const dir = (flags & SHIFT_MASK) ? -1 : 1;
  const cur = state.snapshotsState.stripScrollOffsets[d.displayID] || 0;
  state.snapshotsState.stripScrollOffsets[d.displayID] = cur + dir * SCROLL_STEP;
  updateLayout();
}

// Find which snapshot tile (if any) sits under a global (x, y). Walks the
// per-display strips, projects local tile rects back to global coords via
// the strip's getBoundingClientRect + myScreenInfo offset.
function tileAt(x, y) {
  for (const did of Object.keys(stripsByDisplay)) {
    const entry = stripsByDisplay[did];
    for (const [winId, el] of entry.tiles.entries()) {
      const r = el.getBoundingClientRect();
      // Convert local DOM rect → global by adding myScreenInfo offset.
      const myX = (myScreenInfo && myScreenInfo.frame && myScreenInfo.frame.x) || 0;
      const myY = (myScreenInfo && myScreenInfo.frame && myScreenInfo.frame.y) || 0;
      const gx = r.left + myX, gy = r.top + myY;
      if (x >= gx && x < gx + r.width && y >= gy && y < gy + r.height) {
        return { winId, el, localX: x - gx, localY: y - gy, displayID: +did };
      }
    }
  }
  return null;
}

// Left-click eventtap — DOM clicks don't reach clickThrough panels, so the
// strip's click handling is routed through here. Mirrors the lua
// mouseCallback "mouseDown" branch (sans drag, which lua had via a separate
// leftMouseDragged tap — drag-to-reposition between displays is deferred
// since the JS strip is a single fullscreen panel).
export function onLeftClickEvent(payload) {
  const { x, y } = payload || {};
  if (x == null || y == null) return;
  // Menu has priority — a left-click anywhere closes it (and triggers a
  // row if the click hits one).
  if (menuEl && tryMenuClickAt(x, y)) return;
  if (state.snapshotsState.order.length === 0) return;
  const hit = tileAt(x, y);
  if (!hit) return;
  const { winId, localX, localY } = hit;
  // Close-dot zone (top-left 14×14 px) — matches lua SNAPSHOT_CLOSE_SIZE.
  if (localX < 14 && localY < 14) {
    closeFromSnapshot(winId);
    return;
  }
  // Shift-click → drop snapshot without restoring (matches lua's modifier
  // branch). flags bit 17 = NSEvent shift.
  const flags = payload.flags || 0;
  const SHIFT_MASK = 1 << 17;
  if (flags & SHIFT_MASK) {
    cleanupResources(winId);
    updateLayout();
    return;
  }
  restoreFromSnapshot(winId);
}

// Mouse-moved eventtap — drives hover state on tiles. The CGEventTap fires
// at the host's mouse-move sample rate (high), so we do a cheap reservation-
// area gate FIRST and only walk per-tile rects when the cursor is inside a
// strip. Hovered id is memoized so the per-tile rect walk doesn't run while
// the cursor lingers on the same tile.
let lastHoveredId = null;
let mouseMoveTickPending = false;
let lastMouseEvent = null;
export function onMouseMoveEvent(payload) {
  lastMouseEvent = payload;
  if (mouseMoveTickPending) return;
  mouseMoveTickPending = true;
  // rAF-coalesce so we never re-render hover state more than once per frame
  // even under high mouseMoved cadence.
  requestAnimationFrame(() => {
    mouseMoveTickPending = false;
    const ev = lastMouseEvent;
    if (!ev) return;
    if (state.snapshotsState.order.length === 0) {
      if (lastHoveredId != null) { clearHover(); lastHoveredId = null; }
      return;
    }
    const { x, y } = ev;
    if (x == null || y == null) return;
    // Cheap gate: cursor must be inside a strip's reserved area.
    if (!screenForStripAt(x, y)) {
      if (lastHoveredId != null) { clearHover(); lastHoveredId = null; }
      return;
    }
    const hit = tileAt(x, y);
    const id = hit ? hit.winId : null;
    if (id === lastHoveredId) return;
    if (lastHoveredId != null) {
      const el = findTileEl(lastHoveredId);
      if (el) el.classList.remove("hover");
    }
    lastHoveredId = id;
    if (id != null && hit) {
      hit.el.classList.add("hover");
      showTooltip(id, hit.el);
    } else {
      hideTooltip();
    }
  });
}

function clearHover() {
  for (const did of Object.keys(stripsByDisplay)) {
    for (const el of stripsByDisplay[did].tiles.values()) {
      el.classList.remove("hover");
    }
  }
  hideTooltip();
}

function findTileEl(winId) {
  for (const did of Object.keys(stripsByDisplay)) {
    const el = stripsByDisplay[did].tiles.get(winId);
    if (el) return el;
  }
  return null;
}

// Right-click eventtap — two branches:
//   1. Right-click ON a tile     → show context menu (Restore / Close /
//                                   Restore All / Close All / Clear All).
//                                   Port of snapshot_create.lua's
//                                   mouseCallback "right" branch.
//   2. Right-click on a window   → capture-without-minimize that window.
//                                   Port of events.lua rightClickTap.
export async function onRightClickEvent(payload) {
  const { x, y } = payload || {};
  if (x == null || y == null) return;
  const hit = tileAt(x, y);
  if (hit) {
    const data = state.snapshotsState.snapshots[hit.winId];
    showContextMenu(hit.winId, data);
    return;
  }
  // Find the topmost window at (x, y).
  const win = pickWindowAt(x, y);
  if (!win) return;
  await captureWithoutMinimize(win.id);
}

function pickWindowAt(x, y) {
  // Sort by focus history first so the most-recently-focused window wins
  // when frames overlap. windowsById has no z-order, so this is a heuristic.
  const candidates = [];
  for (const id in state.windowsById) {
    const w = state.windowsById[id];
    if (!w || !w.frame) continue;
    const f = w.frame;
    if (x >= f.x && x < f.x + f.w && y >= f.y && y < f.y + f.h) {
      candidates.push(w);
    }
  }
  if (candidates.length === 0) return null;
  // Prefer focused window in focus history order.
  for (const fid of state.focusHistory) {
    const m = candidates.find((w) => w.id === fid);
    if (m) return m;
  }
  return candidates[0];
}

// ----------------------------------------------------------------------------
// State persistence — sd.settings.get/set "snapshots".
// ----------------------------------------------------------------------------

function snapshotsForSave() {
  // Serialize only the persistent fields; image dataURLs persist directly.
  const out = { order: [...state.snapshotsState.order], snapshots: {} };
  for (const id of state.snapshotsState.order) {
    const d = state.snapshotsState.snapshots[id];
    if (!d) continue;
    out.snapshots[id] = {
      app:        d.app,
      bundleId:   d.bundleId,
      title:      d.title,
      frame:      d.frame,
      image:      d.image,
      displayID:  d.displayID,
      snapSize:   d.snapSize,
      capturedAt: d.capturedAt
    };
  }
  return out;
}

function scheduleSnapshotSave() {
  if (saveTimerHandle) clearTimeout(saveTimerHandle);
  saveTimerHandle = setTimeout(async () => {
    saveTimerHandle = null;
    try { await sd.settings.set("snapshots", snapshotsForSave()); } catch (_) {}
  }, 400);
}

async function loadPersistedSnapshots() {
  try {
    const saved = await sd.settings.get("snapshots");
    if (!saved || !saved.snapshots) return;
    const candidateSnapshots = saved.snapshots;
    const candidateOrder = Array.isArray(saved.order) ? saved.order : Object.keys(saved.snapshots).map(Number);
    // A persisted entry survives reload ONLY if AX still reports the
    // window as minimized. A live entry in windowsById means the window
    // is NOT minimized (minimized windows drop out of windowsById), so a
    // live `w` MUST disqualify the persisted snapshot — otherwise the
    // tiler would reserve strip space for windows the user can actually
    // see, the strip would render thumbnails of visible windows, and the
    // outline would land on shrunk-down tiled frames. Was the source of
    // the "windows mis-tiled + outline mis-aligned" regression on reload.
    const liveOrder = [];
    const liveSnapshots = Object.create(null);
    for (const id of candidateOrder) {
      const w = state.windowsById[id];
      let stillMinimized = false;
      try { stillMinimized = await sd.windows.isMinimized(id); } catch (_) {}
      if (!w && stillMinimized && candidateSnapshots[id]) {
        liveOrder.push(id);
        liveSnapshots[id] = candidateSnapshots[id];
      }
    }
    state.snapshotsState.snapshots = liveSnapshots;
    state.snapshotsState.order = liveOrder;
    log(`snapshots restored: ${liveOrder.length}/${candidateOrder.length}`);
    // Re-save the filtered set so any stale persisted entries (windows that
    // were minimized in a prior session but no longer exist) get evicted
    // from sd.settings. Without this the same stale CGWindowIDs get re-
    // evaluated every reload and may collide with new live windows.
    if (liveOrder.length !== candidateOrder.length) scheduleSnapshotSave();
  } catch (e) {
    console.warn("[WindowScape] loadPersistedSnapshots:", e);
  }
}

// ----------------------------------------------------------------------------
// Init / cleanup
// ----------------------------------------------------------------------------

// Port of snapshots.lua init(). Wires the refresh timer, loads persisted
// state, paints the initial strips.
export async function init() {
  myScreenInfo = (typeof window !== "undefined" && window.__sd_screen) || null;
  ensureStripsRoot();
  // sd.window.{minimized,deminimized,destroyed} fire when the OS changes a
  // window from outside our control (user clicked the yellow dot, Alt-Tab
  // restore, Dock click, etc.). Track those so the tiler doesn't see a
  // phantom collapsed window.
  //
  // CHAIN, do not overwrite — events.js installs the canonical handlers
  // (state.minimizedIds bookkeeping + retile). Plain assignment here would
  // silently win the load-order race and break tiling for any OS-driven
  // change that doesn't involve a snapshot.
  if (typeof window !== "undefined") {
    function chainBang(name, fn) {
      window[name] = chain(window[name], (detail) => {
        if (!detail || !detail.id) return;
        fn(detail.id);
      });
    }
    // Minimized: if WE drove it via captureAndMinimize, the snapshot entry
    // already exists — nothing to do. OS-minimized windows aren't auto-
    // captured; the user expected the native genie animation. Stack reload
    // picks them up via the AX read in loadPersistedSnapshots.
    chainBang("onBang_sd_window_minimized", (id) => {
      if (isMinimized(id)) return;
    });
    // Deminimized: if WE drove this via restoreFromSnapshot, let its fade
    // animation play to completion; that path handles the cleanup itself.
    // OS-driven deminimize → drop our shadow snapshot so the strip stays
    // in sync.
    chainBang("onBang_sd_window_deminimized", (id) => {
      if (!isMinimized(id)) return;
      if (isRestoringInternally(id)) return;
      cleanupResources(id);
      updateLayout();
    });
    chainBang("onBang_sd_window_destroyed", (id) => {
      if (!isMinimized(id)) return;
      cleanupResources(id);
      updateLayout();
    });
  }

  await loadPersistedSnapshots();
  startRefreshTimer();
  updateLayout();
}

export function cleanup() {
  stopRefreshTimer();
  if (saveTimerHandle) { clearTimeout(saveTimerHandle); saveTimerHandle = null; }
  hideTooltip();
  hideContextMenu();
  clearAll();
}

// Compose a new handler onto an existing one without dropping the prior
// behavior (events.js already binds onBang_sd_window_destroyed).
function chain(existing, next) {
  if (!existing) return next;
  return (...args) => { try { existing(...args); } catch (_) {} try { next(...args); } catch (_) {} };
}
