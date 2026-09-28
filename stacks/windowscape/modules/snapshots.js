// Window snapshot (minimize) system.
//
// Maintains a per-display strip of window thumbnails: a right-side column on
// landscape displays, a bottom row on portrait displays. Capturing a window
// grabs its CGSHWCaptureWindowList image via sd.windows.snapshot(id) and
// AX-minimizes the window; the thumbnail tile sits in the strip until the user
// clicks it to restore (or closeAll/restoreAll/clearAll bulk-acts).
//
// Architecture:
// - Rendering: one interactive sd.overlay.region per display that hosts
//   thumbnails, covering just the thumbnails inside that display's reserved
//   strip band (railRect). Tile geometry is computed analytically
//   (computeStrip) and drives both the overlay HTML and hit-testing, so a
//   click lands where a tile is drawn.
// - Input: the rail takes real clicks, so whatever macOS draws above it (a
//   notification banner) gets its clicks first. Its page posts left-clicks,
//   right-clicks and scrolls back through window.stack.post (onRailMessage).
// - Refresh timer: every 5s each tracked window is re-captured so the
//   preview stays current. Tiles whose display shows a native fullscreen
//   space are skipped (snapgate.js): their strip isn't drawn.
// - Context menu: its own interactive region overlay at the cursor, clamped
//   inside that display.
// - State persistence: sd.settings.set/get. Image dataURLs persist directly.

import { sd } from "sd://runtime/api.js";
import { cfg } from "./config.js";
import { state, log, isManaged } from "./core.js";
import { refreshBlockedByFullscreen } from "./snapgate.js";
import { tooltipLines, tooltipRect } from "./tooltip.js";
import { keepPersistedSnapshot, menuClickAction, clampMenuOrigin, scrolledOffset, railRect, menuHeight } from "./snaprules.js";
import { overlaySlots } from "./sequencing.js";
import { captureForOSMinimize } from "./snapshot_create.js";
import { tileWindows } from "./tiler.js";

// Layout constants.
export const PADDING       = 8;
export const GAP           = 4;
export const COLUMN_WIDTH  = 140;
export const REFRESH_INTERVAL = 5000;     // ms — slow refresh
export const MIN_TILE_HEIGHT = 30;
export const MAX_TILE_HEIGHT = 200;
// Above every app window, below the Dock and Notification Center banners
// (which a right-edge rail would otherwise cover).
const RAIL_LEVEL = "utility";

const ZOOM_IN_MS      = 280;
const RESTORE_FADE_MS = 180;


let refreshTimerHandle = null;
let saveTimerHandle = null;

// ----------------------------------------------------------------------------
// State helpers
// ----------------------------------------------------------------------------

// True if a window is currently snapshotted (kept in our state map).
export function isMinimized(winId) {
  return !!state.snapshotsState.snapshots[winId];
}

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

// Snapshot tile size (fallback).
export function getSnapshotSize() {
  return { w: COLUMN_WIDTH - PADDING * 2, h: 80 };
}

// Set of Space (desktop) IDs currently active across all displays, taken from
// the sd.spaces.all snapshot events.js maintains. The host panel is
// canJoinAllSpaces, so a tile drawn into it is visible on every desktop; we
// gate rendering on this set to confine each tile (and the strip space it
// reserves) to the desktop it was captured on.
function activeSpaceIDSet() {
  const set = new Set();
  for (const uuid of Object.keys(state.spacesByDisplay)) {
    const a = state.spacesByDisplay[uuid] && state.spacesByDisplay[uuid].active;
    if (a != null) set.add(a);
  }
  return set;
}

// A snapshot renders now if its origin Space is active. Untagged (legacy
// persisted) entries and the pre-Spaces-info window both fall through to
// "always show" so nothing silently disappears.
function snapshotVisibleNow(data, activeSet) {
  if (!data) return false;
  if (data.spaceID == null) return true;
  if (!activeSet || activeSet.size === 0) return true;
  return activeSet.has(data.spaceID);
}

// Snapshots on the given display whose origin Space is currently active, in
// insertion order.
function snapshotsOnDisplay(displayID, activeSet) {
  const out = [];
  if (!activeSet) activeSet = activeSpaceIDSet();
  for (const winId of state.snapshotsState.order) {
    const data = state.snapshotsState.snapshots[winId];
    if (!data) continue;
    if (data.displayID !== displayID) continue;
    if (!snapshotVisibleNow(data, activeSet)) continue;
    out.push({ winId, data });
  }
  return out;
}

// Returns the strip rectangle in global screen coords for a given display, or
// null if no snapshots there. Landscape → right-side column (COLUMN_WIDTH wide,
// full height); portrait → bottom row (full width, maxTileH + PADDING*2 tall).
export function getReservedArea(d) {
  if (!d) return null;
  const list = snapshotsOnDisplay(d.displayID);
  if (list.length === 0) return null;
  // Anchor to visibleFrame so the strip sits clear of the menubar / dock /
  // any other system-reserved chrome (matches what adjustedFrameForDisplay
  // below already does for the tiler).
  const vf = d.visibleFrame || d.frame;
  const isLandscape = d.frame.w > d.frame.h;
  if (isLandscape) {
    return {
      x: vf.x + vf.w - COLUMN_WIDTH,
      y: vf.y,
      w: COLUMN_WIDTH,
      h: vf.h
    };
  }
  let maxHeight = 0;
  for (const { data } of list) {
    const snapSize = data.snapSize || getSnapshotSize();
    if (snapSize.h > maxHeight) maxHeight = snapSize.h;
  }
  const rowHeight = maxHeight + PADDING * 2;
  return {
    x: vf.x,
    y: vf.y + vf.h - rowHeight,
    w: vf.w,
    h: rowHeight
  };
}

// visibleFrame minus the reserved strip. Landscape shrinks width (right
// column), portrait shrinks
// height (bottom row). tiler.js calls this so tiles don't draw under the
// strip.
export function adjustedFrameForDisplay(d) {
  if (!d) return null;
  const vf = d.visibleFrame || d.frame;
  const reserved = getReservedArea(d);
  if (!reserved) return null;
  const isLandscape = d.frame.w > d.frame.h;
  if (isLandscape) {
    return {
      x: vf.x,
      y: vf.y,
      w: Math.max(0, vf.w - reserved.w),
      h: vf.h
    };
  }
  return {
    x: vf.x,
    y: vf.y,
    w: vf.w,
    h: Math.max(0, vf.h - reserved.h)
  };
}

// Returns the display whose strip reserved-area contains (x,y), or null.
export function screenForStripAt(x, y) {
  for (const d of state.displays) {
    const r = getReservedArea(d);
    if (!r) continue;
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return d;
  }
  return null;
}

// ----------------------------------------------------------------------------
// Per-display strip rendering — sd.overlay.region
//
// Each display that hosts snapshots gets its own free-region overlay (a
// borderless WebView the daemon places at an absolute GLOBAL rect) on that
// display's reserved strip band, so the rail renders on the SAME display the
// window was minimized from. The overlay covers only the thumbnails
// (railRect), since it takes real clicks and the band's empty rest is where
// desktop icons sit. Tile positions are computed analytically here
// (computeStrip); the SAME geometry drives both the rendered HTML and the
// hit-testing (tileAt), so a click can never land where a tile isn't drawn.
// ----------------------------------------------------------------------------

const OVERLAY_CSS = `
  html,body{margin:0;padding:0;overflow:hidden;background:transparent;-webkit-user-select:none;user-select:none}
  #ws-tiles{position:absolute;inset:0}
  .ws-tile{
    position:absolute; box-sizing:border-box;
    background:rgba(40,40,40,0.85); border-radius:6px;
    border:1px solid rgba(255,255,255,0.08); overflow:hidden;
    box-shadow:0 4px 14px rgba(0,0,0,0.55);
    opacity:0; transform:scale(0.5);
    transition:opacity ${ZOOM_IN_MS}ms ease-out,
               transform ${ZOOM_IN_MS}ms cubic-bezier(0.22,0.61,0.36,1);
  }
  .ws-tile.in{opacity:1; transform:scale(1)}
  .ws-tile.leaving{opacity:0; transform:scale(0.4);
    transition:opacity ${RESTORE_FADE_MS}ms ease-in, transform ${RESTORE_FADE_MS}ms ease-in}
  .ws-tile img{width:100%;height:100%;object-fit:cover;display:block;pointer-events:none}
  .ws-close{position:absolute;top:4px;left:4px;width:12px;height:12px;border-radius:50%;
    background:#ff5f57;border:0.5px solid #e0443e}
`;

// Analytic strip layout for a display: the reserved band plus each tile's
// GLOBAL rect. Mirrors the flexbox the DOM strip used — landscape → a right
// column (tiles right-aligned, stacked top→bottom); portrait → a bottom row
// (tiles bottom-aligned, left→right). Scroll offset is baked into positions
// and clamped here. Returns null when the display has nothing to show.
function computeStrip(d, activeSet) {
  const reserved = getReservedArea(d);
  if (!reserved) return null;
  const list = snapshotsOnDisplay(d.displayID, activeSet);
  if (list.length === 0) return null;
  const isLandscape = d.frame.w > d.frame.h;

  let contentLen = 0;
  for (let i = 0; i < list.length; i++) {
    const ss = list[i].data.snapSize || getSnapshotSize();
    contentLen += isLandscape ? ss.h : ss.w;
    if (i > 0) contentLen += GAP;
  }
  const visibleLen = (isLandscape ? reserved.h : reserved.w) - PADDING * 2;
  const maxOffset = Math.max(0, contentLen - visibleLen);
  const offset = Math.max(0, Math.min(state.snapshotsState.stripScrollOffsets[d.displayID] || 0, maxOffset));
  state.snapshotsState.stripScrollOffsets[d.displayID] = offset;

  const tiles = [];
  if (isLandscape) {
    let cursor = reserved.y + PADDING - offset;
    for (const { winId, data } of list) {
      const ss = data.snapSize || getSnapshotSize();
      tiles.push({ winId, data, gx: reserved.x + reserved.w - PADDING - ss.w, gy: cursor, gw: ss.w, gh: ss.h });
      cursor += ss.h + GAP;
    }
  } else {
    let cursor = reserved.x + PADDING - offset;
    for (const { winId, data } of list) {
      const ss = data.snapSize || getSnapshotSize();
      tiles.push({ winId, data, gx: cursor, gy: reserved.y + reserved.h - PADDING - ss.h, gw: ss.w, gh: ss.h });
      cursor += ss.w + GAP;
    }
  }
  return { displayID: d.displayID, reserved, isLandscape, tiles };
}

function escAttr(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Tiles as absolutely-positioned HTML in the overlay's local space
// (0,0 = `at`, the rail rect's top-left in global coords).
function buildTilesHtml(strip, at) {
  const origin = strip.isLandscape ? "right center" : "center bottom";
  let html = "";
  for (const t of strip.tiles) {
    const lx = t.gx - at.x;
    const ly = t.gy - at.y;
    const img = t.data.image ? `<img src="${escAttr(t.data.image)}">` : "";
    html += `<div class="ws-tile in" style="left:${lx}px;top:${ly}px;width:${t.gw}px;height:${t.gh}px;transform-origin:${origin}" data-win="${t.winId}">${img}<div class="ws-close"></div></div>`;
  }
  return html;
}

// Posts the rail's own clicks, right-clicks (ctrl-click included) and
// scrolls to onRailMessage, in the overlay's local coords. Wheel deltas are
// negated to the eventtap's sign (positive = content toward the start).
const RAIL_SCRIPT = `<script>(function(){
  function post(kind,e,extra){var o={kind:kind,x:e.clientX,y:e.clientY,shift:e.shiftKey};
    for(var k in extra)o[k]=extra[k];window.stack.post(o);}
  document.addEventListener('mousedown',function(e){if(e.button===0&&!e.ctrlKey)post('down',e);},true);
  document.addEventListener('contextmenu',function(e){e.preventDefault();post('right',e);},true);
  document.addEventListener('wheel',function(e){e.preventDefault();
    post('wheel',e,{deltaX:-e.deltaX,deltaY:-e.deltaY});},{capture:true,passive:false});
})();</script>`;

// displayID -> the rail overlay's current global rect, to map its messages'
// local coords back to global.
const railRects = Object.create(null);

// One region overlay per display that hosts snapshots, covering its
// thumbnails. Only a changed rect or changed tile HTML reaches the daemon.
const overlays = overlaySlots({
  create: (strip) => sd.overlay.region({
    rect: railRect(strip, PADDING) || strip.reserved,
    html: `<div id="ws-tiles"></div>${RAIL_SCRIPT}`,
    css: OVERLAY_CSS, level: RAIL_LEVEL, interactive: true,
  }).then((h) => {
    if (h) h.onMessage((m) => onRailMessage(strip.displayID, m));
    return h;
  }),
  paint: paintOverlay,
  dispose: (h) => { h.remove().catch(() => {}); },
});

function paintOverlay(e, strip) {
  const r = railRect(strip, PADDING);
  if (!r) return;
  railRects[strip.displayID] = r;
  if (!e.lastRect || e.lastRect.x !== r.x || e.lastRect.y !== r.y || e.lastRect.w !== r.w || e.lastRect.h !== r.h) {
    e.handle.setFrame(r).catch(() => {});
    e.lastRect = { ...r };
  }
  const html = buildTilesHtml(strip, r);
  if (html !== e.lastHtml) {
    e.lastHtml = html;
    e.handle.eval(`(function(){var el=document.getElementById('ws-tiles');if(el)el.innerHTML=${JSON.stringify(html)};})();`).catch(() => {});
    log(`SNAP-RAIL d${strip.displayID} rect=${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)} ${strip.isLandscape ? "column" : "row"} tiles=${strip.tiles.length}`);
  }
}

// Snapshot of the current strip layout per display — cached for the
// hit-testers (tileAt) so they don't recompute geometry on every mouse event.
let stripsByDisplayCache = Object.create(null);

function reconcileOverlays() {
  const activeSet = activeSpaceIDSet();
  const wanted = Object.create(null);
  for (const d of state.displays) {
    const strip = computeStrip(d, activeSet);
    if (strip) wanted[d.displayID] = strip;
  }
  // Same computeStrip pass feeds the overlays and the hit-test cache, so
  // the two agree.
  stripsByDisplayCache = wanted;
  for (const did of overlays.keys()) {
    if (!wanted[did]) { overlays.remove(did); delete railRects[did]; }
  }
  for (const idStr of Object.keys(wanted)) {
    overlays.sync(+idStr, wanted[idStr]);
  }
}

// Re-render every strip to match snapshotsState.
export function updateLayout() {
  // Re-host snapshots whose ORIGIN display went away so restore still targets a
  // live display, and drop scroll offsets for displays that vanished.
  const validDisplayIds = new Set(state.displays.map((d) => d.displayID));
  for (const did of Object.keys(state.snapshotsState.stripScrollOffsets)) {
    if (!validDisplayIds.has(+did)) delete state.snapshotsState.stripScrollOffsets[did];
  }
  for (const winId of state.snapshotsState.order) {
    const data = state.snapshotsState.snapshots[winId];
    if (!data) continue;
    if (data.displayID && !validDisplayIds.has(data.displayID)) {
      const of = data.frame || {};
      const cx = (of.x || 0) + (of.w || 0) / 2;
      const cy = (of.y || 0) + (of.h || 0) / 2;
      let found = null;
      for (const d of state.displays) {
        const f = d.frame;
        if (cx >= f.x && cx < f.x + f.w && cy >= f.y && cy < f.y + f.h) { found = d; break; }
      }
      data.displayID = (found || state.displays[0]) && (found || state.displays[0]).displayID;
    }
  }

  reconcileOverlays();
}

// ----------------------------------------------------------------------------
// Tooltip — init / show / hide.
// ----------------------------------------------------------------------------

// The tooltip gets its own click-through region overlay beside the tile: the
// strip overlays are only as big as the strip band, and this stack's own page
// is not where the tiles are. Created on first hover, then moved and
// re-filled per tile.
const TIP_CSS = `
  html,body{margin:0;padding:0;overflow:hidden;background:transparent}
  #tip{position:absolute;inset:0;display:flex;box-sizing:border-box;padding:6px}
  #tip.right{justify-content:flex-end;align-items:center}
  #tip.bottom{justify-content:center;align-items:flex-end}
  #b{background:rgba(0,0,0,0.78);color:#fff;padding:6px 10px;border-radius:4px;
     font:13px -apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif;line-height:1.3;
     text-align:center;max-width:320px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.4);
     opacity:0;transition:opacity 120ms ease-out}
  #tip.on #b{opacity:1}
`;
let tipRegion = null;       // Promise<region handle | null>
let tipShownFor = null;     // winId the tooltip currently describes

function tipHandle(rect) {
  if (!tipRegion) {
    tipRegion = sd.overlay.region({ rect, html: `<div id="tip"><div id="b"></div></div>`, css: TIP_CSS, level: RAIL_LEVEL })
      .catch(() => null);
  }
  return tipRegion;
}

async function showTooltipFor(hit) {
  const data = state.snapshotsState.snapshots[hit.winId];
  if (!data) return;
  tipShownFor = hit.winId;
  const d = state.displays.find((x) => x.displayID === hit.displayID);
  const r = tooltipRect(hit, hit.isLandscape, d && d.frame);
  const rect = { x: r.x, y: r.y, w: r.w, h: r.h };
  const h = await tipHandle(rect);
  if (!h || tipShownFor !== hit.winId) return;
  await h.setFrame(rect);
  const lines = JSON.stringify(tooltipLines(data));
  await h.eval(`(() => {
    const t = document.getElementById("tip"), b = document.getElementById("b");
    b.textContent = "";
    ${lines}.forEach((l, i) => { if (i) b.appendChild(document.createElement("br")); b.appendChild(document.createTextNode(l)); });
    t.className = ${JSON.stringify(r.align)} + " on";
  })()`);
}

export function hideTooltip() {
  if (tipShownFor == null) return;
  tipShownFor = null;
  if (!tipRegion) return;
  tipRegion.then((h) => {
    if (h && tipShownFor == null) h.eval(`document.getElementById("tip").classList.remove("on")`).catch(() => {});
  });
}

// ----------------------------------------------------------------------------
// Context menu — its own interactive region overlay.
// ----------------------------------------------------------------------------

// { rows: [fn], rect, handle: Promise<region | null> } — rect in global coords.
let menu = null;

const MENU_W     = 180;
const MENU_ROW_H = 26;
const MENU_SEP_H = 9;
const MENU_PAD   = 4;
const MENU_CSS = `
  html,body{margin:0;padding:0;overflow:hidden;background:transparent;
    -webkit-user-select:none;user-select:none;cursor:default}
  #m{position:absolute;inset:0;box-sizing:border-box;padding:${MENU_PAD}px 0;
    background:rgba(30,30,30,0.95);color:#fff;border:1px solid rgba(255,255,255,0.15);
    border-radius:6px;font:13px -apple-system,BlinkMacSystemFont,sans-serif}
  .r{height:${MENU_ROW_H}px;line-height:${MENU_ROW_H}px;padding:0 16px}
  .r:hover{background:rgba(255,255,255,0.12)}
  .s{height:1px;margin:${(MENU_SEP_H - 1) / 2}px 0;background:rgba(255,255,255,0.12)}
`;
const MENU_SCRIPT = `<script>
  document.addEventListener('click',function(e){var r=e.target.closest('.r');
    if(r)window.stack.post({kind:'row',i:+r.dataset.i});});
  document.addEventListener('contextmenu',function(e){e.preventDefault();});
</script>`;

function inRect(r, x, y) {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

// Global frame of the display containing `p`, for clamping the menu.
function displayFrameAt(p) {
  const d = state.displays.find((d) => d.frame && inRect(d.frame, p.x, p.y));
  return d ? d.frame : (state.displays[0] && state.displays[0].frame);
}

export function showContextMenu(winId, at) {
  hideContextMenu();
  const items = [
    { label: "Restore",     fn: () => restoreFromSnapshot(winId) },
    { label: "Close",       fn: () => closeFromSnapshot(winId) },
    null,
    { label: "Restore All", fn: () => restoreAll() },
    { label: "Close All",   fn: () => closeAll() },
    { label: "Clear All",   fn: () => clearAll() }
  ];
  const p = at || sd.mouse.peek();
  if (!p) return;
  const bounds = displayFrameAt(p);
  if (!bounds) return;
  const size = { w: MENU_W, h: menuHeight(items, { rowH: MENU_ROW_H, sepH: MENU_SEP_H, pad: MENU_PAD }) };
  const o = clampMenuOrigin(p, size, bounds);
  const rows = [];
  let html = `<div id="m">`;
  for (const it of items) {
    if (!it) { html += `<div class="s"></div>`; continue; }
    html += `<div class="r" data-i="${rows.length}">${escAttr(it.label)}</div>`;
    rows.push(it.fn);
  }
  html += `</div>${MENU_SCRIPT}`;
  const entry = { rows, rect: { x: o.x, y: o.y, w: size.w, h: size.h }, handle: null };
  menu = entry;
  entry.handle = sd.overlay.region({ rect: entry.rect, html, css: MENU_CSS, level: "popUpMenu", interactive: true })
    .then((h) => {
      if (h && menu !== entry) { h.remove().catch(() => {}); return null; }
      if (h) h.onMessage((m) => {
        if (menu !== entry || !m || m.kind !== "row") return;
        const fn = rows[m.i];
        hideContextMenu();
        if (fn) fn();
      });
      return h;
    })
    .catch(() => null);
}

function hideContextMenu() {
  if (!menu) return;
  const pending = menu.handle;
  menu = null;
  if (pending) pending.then((h) => { if (h) h.remove().catch(() => {}); });
}

// Routes one view of a leftMouseDown through snaprules.menuClickAction. Menu
// rows act through the menu overlay's own messages, never through here.
function clickAction(tap, x, y) {
  const inMenu = !!menu && inRect(menu.rect, x, y);
  const hit = tileAt(x, y);
  const action = menuClickAction({ tap, menuOpen: !!menu, inMenu, onRow: false, onTile: !!hit });
  return { action, hit };
}

// ----------------------------------------------------------------------------
// Restore / cleanup / bulk verbs
// ----------------------------------------------------------------------------

// Drop a single snapshot's data and order entries.
export function cleanupResources(winId) {
  const data = state.snapshotsState.snapshots[winId];
  if (!data) return;
  // Remove from order
  const idx = state.snapshotsState.order.indexOf(winId);
  if (idx >= 0) state.snapshotsState.order.splice(idx, 1);
  delete state.snapshotsState.snapshots[winId];
  scheduleSnapshotSave();
  if (state.onLayoutChange) state.onLayoutChange();
}

// Restore a snapshot: un-minimize and focus the window, then drop its tile
// after RESTORE_FADE_MS.
//
// Sentinel `restoringIds`: while we drive the deminimize, the deminimized
// bang handler leaves the tile to the delayed cleanup below.
const restoringIds = new Set();
export async function restoreFromSnapshot(winId) {
  const data = state.snapshotsState.snapshots[winId];
  if (!data) return;
  if (restoringIds.has(winId)) return;
  restoringIds.add(winId);
  hideTooltip();
  // AX-deminimize (sd.windows.minimize(id, false)). Then focus.
  try { await sd.windows.minimize(winId, false); } catch (_) {}
  try { await sd.windows.focus(winId); } catch (_) {}
  // Wait for the fade, then drop.
  setTimeout(() => {
    restoringIds.delete(winId);
    cleanupResources(winId);
    updateLayout();
    // Re-tile so the restored window gets reabsorbed into the layout.
    tileWindows();
  }, RESTORE_FADE_MS);
}

// Exposed so the deminimize-bang handler can check "is this our own
// in-flight restore?" before cleaning up.
export function isRestoringInternally(winId) {
  return restoringIds.has(winId);
}

// Close the underlying window via AX, then drop the snapshot.
export async function closeFromSnapshot(winId) {
  try { await sd.windows.close(winId); } catch (_) {}
  cleanupResources(winId);
  updateLayout();
  await tileWindows();
}

// Drop every tile without restoring.
export function clearAll() {
  hideTooltip();
  const ids = [...state.snapshotsState.order];
  for (const id of ids) cleanupResources(id);
  updateLayout();
}

// Un-minimize everything.
// Fire-and-forget each restore in parallel; the per-tile fade + bottom-of-
// queue tiler.tileWindows pass will settle once all the deminimizes land.
export async function restoreAll() {
  const ids = [...state.snapshotsState.order];
  for (const id of ids) {
    restoreFromSnapshot(id).catch(() => {});   // intentionally not awaited
  }
}

// Close every snapshotted window.
export async function closeAll() {
  const ids = [...state.snapshotsState.order];
  for (const id of ids) {
    try { await sd.windows.close(id); } catch (_) {}
    cleanupResources(id);
  }
  updateLayout();
  await tileWindows();
}

// ----------------------------------------------------------------------------
// Refresh timer.
// ----------------------------------------------------------------------------

// Displays whose tiles the refresh is currently skipping, so the pause/resume
// log fires once per transition instead of once per tile per tick.
const refreshPausedDisplays = new Set();

function noteRefreshPause(displayID, blocked) {
  if (blocked === refreshPausedDisplays.has(displayID)) return;
  if (blocked) refreshPausedDisplays.add(displayID);
  else refreshPausedDisplays.delete(displayID);
  log(`SNAP-REFRESH d${displayID} ${blocked ? "paused (fullscreen space)" : "resumed"}`);
}

async function refreshSnapshots() {
  if (state.snapshotsState.isCreating) return;
  const ids = [...state.snapshotsState.order];
  if (ids.length === 0) return;
  let anyChanged = false;
  for (const winId of ids) {
    const data = state.snapshotsState.snapshots[winId];
    if (!data) continue;
    // Per snapshot, not per pass: with two displays the one on a desktop
    // keeps its visible strip fresh while the fullscreen one goes quiet.
    // Read live each iteration, since the awaits below span space flips.
    const blocked = refreshBlockedByFullscreen(data.displayID, state.displays, state.spacesByDisplay);
    noteRefreshPause(data.displayID, blocked);
    if (blocked) continue;
    try {
      const snap = await sd.windows.snapshot(winId, { format: "jpeg", quality: 0.7 });
      if (snap && snap.dataURL && snap.dataURL !== data.image) {
        // Tiles live in the per-display region overlays (buildTilesHtml embeds
        // the dataURL inline in the tile HTML), so a fresh image repaints by
        // re-running the overlay diff — NOT by mutating a DOM <img>.
        // reconcileOverlays() below repaints only overlays whose HTML actually
        // changed (paintOverlay's html !== lastHtml gate), so this is cheap.
        data.image = snap.dataURL;
        anyChanged = true;
      }
    } catch (_) { /* window may be off-screen / unsnapshottable — skip */ }
  }
  if (anyChanged) {
    reconcileOverlays();
    scheduleSnapshotSave();
  }
}

function startRefreshTimer() {
  if (refreshTimerHandle) return;
  refreshTimerHandle = setInterval(refreshSnapshots, REFRESH_INTERVAL);
}

// ----------------------------------------------------------------------------
// Rail input — the rail overlay's own clicks and scrolls (RAIL_SCRIPT).
// ----------------------------------------------------------------------------

function onRailMessage(displayID, m) {
  const r = railRects[displayID];
  if (!r || !m) return;
  const x = r.x + m.x, y = r.y + m.y;
  if (m.kind === "down") onRailClick({ x, y, shift: !!m.shift });
  else if (m.kind === "right") onRailRightClick({ x, y });
  else if (m.kind === "wheel") onRailScroll({ x, y, deltaX: m.deltaX, deltaY: m.deltaY });
}

function onRailScroll(payload) {
  if (state.snapshotsState.order.length === 0) return;
  const { x, y } = payload || {};
  if (x == null || y == null) return;
  const d = screenForStripAt(x, y);
  if (!d) return;
  const offsets = state.snapshotsState.stripScrollOffsets;
  offsets[d.displayID] = scrolledOffset(offsets[d.displayID], payload);
  updateLayout();
}

// Find which snapshot tile (if any) sits under a global (x, y). Walks the
// live per-display strip layout (stripsByDisplayCache, rebuilt on every
// reconcileOverlays pass) whose tiles already carry global-space rects
// (gx/gy/gw/gh) — the coordinate space an OS-level eventtap reports.
function tileAt(x, y) {
  for (const did of Object.keys(stripsByDisplayCache)) {
    const strip = stripsByDisplayCache[did];
    for (const t of strip.tiles) {
      if (x >= t.gx && x < t.gx + t.gw && y >= t.gy && y < t.gy + t.gh) {
        return { winId: t.winId, localX: x - t.gx, localY: y - t.gy, displayID: +did,
                 gx: t.gx, gy: t.gy, gw: t.gw, gh: t.gh, isLandscape: strip.isLandscape };
      }
    }
  }
  return null;
}

// Non-consuming leftMouseDown observer (every click, anywhere). Tile actions
// run in onRailClick and menu rows in the menu overlay; here we only dismiss
// an open context menu on a click elsewhere and report whether the click is a
// snapshot interaction, so main.js skips the drag bracket for it (a tile
// click is never a window drag).
export function onLeftClickEvent(payload) {
  const { x, y } = payload || {};
  if (x == null || y == null) return false;
  const menuWasOpen = !!menu;
  const { action, hit } = clickAction("observe", x, y);
  if (action === "dismiss") hideContextMenu();
  return menuWasOpen || hit != null;
}

// Close-dot hit zone (tile-local px): the red .ws-close dot sits at (4,4) 12×12
// in OVERLAY_CSS; a 20px top-left corner is its deliberate click target.
const CLOSE_HIT_PX = 20;

// A left-click the rail itself received. While the menu is open a tile click
// only dismisses it.
function onRailClick(payload) {
  const { x, y } = payload;
  const { action, hit } = clickAction("direct", x, y);
  if (action === "dismiss") { hideContextMenu(); return; }
  if (action !== "tile") return;
  // Top-left close dot → close the underlying window (destructive; deliberate
  // small target).
  if (hit.localX < CLOSE_HIT_PX && hit.localY < CLOSE_HIT_PX) {
    closeFromSnapshot(hit.winId);
    return;
  }
  // Shift-click drops the snapshot without restoring.
  if (payload.shift) {
    cleanupResources(hit.winId);
    updateLayout();
    return;
  }
  restoreFromSnapshot(hit.winId);
}

// Hover → tooltip, fed by the daemon's sd.mouse channel (subscribed in init).
// A mouseMoved eventtap fired this at the hardware sample rate and starved
// other stacks' pushes; sd.mouse arrives at a steady 30Hz. The reservation-
// area gate runs first so the per-tile walk only happens over a strip, and the
// hovered id is memoized so lingering on one tile does no work.
let lastHoveredId = null;
export function onMouseMoveEvent(payload) {
  if (!payload) return;
  const { x, y } = payload;
  if (x == null || y == null) return;
  if (state.snapshotsState.order.length === 0 || !screenForStripAt(x, y)) {
    if (lastHoveredId != null) { lastHoveredId = null; hideTooltip(); }
    return;
  }
  const hit = tileAt(x, y);
  const id = hit ? hit.winId : null;
  if (id === lastHoveredId) return;
  lastHoveredId = id;
  if (hit) showTooltipFor(hit).catch(() => {}); else hideTooltip();
}

// A right-click (or ctrl-click) the rail itself received: on a tile it opens
// the context menu (Restore / Close / Restore All / Close All / Clear All).
function onRailRightClick({ x, y }) {
  const hit = tileAt(x, y);
  if (hit) showContextMenu(hit.winId, { x, y });
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
      spaceID:    d.spaceID,
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
    // A persisted entry survives reload only while its window is still
    // minimized (snaprules.keepPersistedSnapshot); a thumbnail of a visible
    // window would reserve strip space for nothing.
    const liveOrder = [];
    const liveSnapshots = Object.create(null);
    for (const id of candidateOrder) {
      let axMinimized = false;
      try { axMinimized = await sd.windows.isMinimized(id); } catch (_) {}
      if (keepPersistedSnapshot({ entry: candidateSnapshots[id], live: state.windowsById[id], axMinimized })) {
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
// Init
// ----------------------------------------------------------------------------

// Wires the refresh timer, loads persisted state, paints the initial strips.
export async function init() {
  sd.mouse.subscribe(onMouseMoveEvent);
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
    // already exists — nothing to do. Otherwise the OS minimized the window
    // (yellow dot, Cmd+M, Dock right-click) and we capture the bitmap
    // out-of-band via this lifecycle bang, which fires reliably however the
    // minimize was triggered.
    //
    // Eligibility mirrors what the tiler considers a "real" tile: app
    // included, non-collapsed, isStandard (set before the minimize moved
    // the window out of windowsById — we check the cached entry). Skip
    // anything we shouldn't be putting in the strip.
    chainBang("onBang_sd_window_minimized", (id) => {
      if (isMinimized(id)) return;          // we already captured
      const w = state.windowsById[id];
      if (!w || !w.frame) return;
      if (w.isStandard === false) return;
      if (w.frame.h <= cfg.collapsedWindowHeight) return;
      if (!isManaged(w)) return;
      captureForOSMinimize(id).catch((e) =>
        console.warn(`[WindowScape] captureForOSMinimize ${id}:`, e)
      );
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

// Compose a new handler onto an existing one without dropping the prior
// behavior (events.js already binds onBang_sd_window_destroyed).
function chain(existing, next) {
  if (!existing) return next;
  return (...args) => { try { existing(...args); } catch (_) {} try { next(...args); } catch (_) {} };
}
