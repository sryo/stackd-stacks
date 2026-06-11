// Traffic-light button interception — JS port of fullscreen_ui.lua.
//
// The lua maintains per-window AX-measured rects for close/zoom/minimize and
// installs an eventtap that intercepts clicks on the native dots, routing them
// to WindowScape actions (close → window close, zoom → simulated fullscreen,
// minimize → snapshot). Two of three are handled here; the YELLOW dot is
// intentionally NOT in the consume gate — on Tahoe the WindowServer
// processes traffic-light clicks before user-space taps see the drop, so
// our consume races (and loses, intermittently). Instead, snapshots.js
// uses the `sd.window.minimized` lifecycle bang to snapshot the window
// after the OS finishes the genie. See snapshots.js `onBang_sd_window_minimized`.
//
// Close / zoom keep the consume path because the cost of double-firing is
// low (close is idempotent; zoom into OS native fullscreen is recoverable
// with the same hotkey). Same architecture: rect gate fed via
// sd.events.setTapRects, synchronous consume in the daemon:
//
//   - sd.windows.buttonFrames(id) fetches the three rects for a window.
//   - sd.events.setTapRects(cb, rects) updates the daemon's cursor-rect gate
//     for our consuming leftMouseDown tap, so the OS's native action gets
//     swallowed only when the cursor is over one of our tracked rects.
//
// Refresh cadence: on focus change, after a drag-bracket settles, and when
// the daemon reports a window destroyed. No timer poll — we lean on the
// daemon's existing focus / lifecycle bangs (lua's separate mouseMoved
// refresh was tangled with the canvas hover affordance, which we don't
// reimplement here; the OS still draws the dots themselves).

import { sd } from "sd://runtime/api.js";
import { cfg } from "./config.js";
import { state, isAppIncluded, log } from "./core.js";
import {
  enterSimulatedFullscreen,
  exitSimulatedFullscreen,
  isFullscreenActive
} from "./fullscreen.js";

// Matches the consumer eventtap callback in stack.json.
const CALLBACK = "windowscapeButtonClick";

// CRITICAL: install an empty consume-gate as soon as this module loads.
// Without rects set, the daemon consumer matches its (empty) predicate on
// every leftMouseDown and swallows it — the consumer's job is "consume",
// and absent gating it consumes everything. We push [] synchronously here
// so the gate is empty (= consumer never matches) before the first click
// can arrive, then refresh() populates it on focus change.
sd.events.setTapRects(CALLBACK, []).catch(() => {});

// winId -> { close: rect|null, zoom: rect|null, minimize: rect|null }
const rectsByWinId = new Map();

// refresh() is coalesced — if a second call lands while one is in flight,
// the first completes then loops once more (matches the "latest-wins"
// behavior of the tile-pass driver in tiler.js).
let refreshInFlight = false;
let refreshAgain = false;

function eligibleWindowIds() {
  const out = [];
  for (const id of Object.keys(state.windowsById)) {
    const w = state.windowsById[id];
    if (!w || !w.frame) continue;
    if (w.onscreen === false) continue;
    if (w.isMinimized === true) continue;
    if (w.addressable === false) continue;
    if (w.isStandard === false) continue;
    // Collapsed widgets (Sticky Notes etc.) — let the OS handle their dots.
    // Their AXMinimizeButton isn't meaningfully usable anyway.
    if (w.frame.h <= cfg.collapsedWindowHeight) continue;
    if (!isAppIncluded(w)) continue;
    out.push(+id);
  }
  return out;
}

function flatRects() {
  const out = [];
  for (const rects of rectsByWinId.values()) {
    if (rects.close) out.push(rects.close);
    if (rects.zoom)  out.push(rects.zoom);
    // NOTE: minimize is deliberately NOT in the gate (see file header).
    // The OS handles the click; snapshots.js captures via the lifecycle bang.
  }
  return out;
}

export async function refresh() {
  if (refreshInFlight) { refreshAgain = true; return; }
  refreshInFlight = true;
  try {
    do {
      refreshAgain = false;
      const ids = eligibleWindowIds();
      const liveSet = new Set(ids);
      for (const id of [...rectsByWinId.keys()]) {
        if (!liveSet.has(id)) rectsByWinId.delete(id);
      }
      const results = await Promise.all(ids.map(async (id) => {
        try { return [id, await sd.windows.buttonFrames(id)]; }
        catch (_) { return [id, null]; }
      }));
      for (const [id, frames] of results) {
        if (!frames) { rectsByWinId.delete(id); continue; }
        rectsByWinId.set(id, {
          close:    frames.close    || null,
          zoom:     frames.zoom     || null,
          minimize: frames.minimize || null
        });
      }
      const rects = flatRects();
      try { await sd.events.setTapRects(CALLBACK, rects); }
      catch (e) { log(`buttons: setTapRects failed: ${e}`); }
    } while (refreshAgain);
  } finally {
    refreshInFlight = false;
  }
}

function hitTest(x, y) {
  // Only the gated kinds — minimize is handled out-of-band via the lifecycle
  // bang in snapshots.js, so it must NOT appear in hit-test even though
  // rectsByWinId still tracks its rect for completeness.
  for (const [winId, rects] of rectsByWinId.entries()) {
    for (const kind of ["close", "zoom"]) {
      const r = rects[kind];
      if (!r) continue;
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) {
        return { winId, kind };
      }
    }
  }
  return null;
}

// Fires AFTER the daemon's consume tap already dropped the click. Walks the
// cache to recover which winId + button kind, then dispatches.
export async function onButtonClick(payload) {
  const { x, y } = payload || {};
  if (x == null || y == null) return;
  const hit = hitTest(x, y);
  if (!hit) {
    // Daemon gate fired but our local cache disagrees — likely stale rects
    // (window moved between push and click). Reschedule and bail.
    log(`buttons: consume fired at (${x},${y}) but no hit in cache (n=${rectsByWinId.size})`);
    refresh();
    return;
  }
  const { winId, kind } = hit;
  log(`BUTTON-HIT ${kind} winId=${winId}`);
  switch (kind) {
    case "close":
      try { await sd.windows.close(winId); }
      catch (e) { log(`button-close failed: ${e}`); }
      break;
    case "zoom":
      // Lua semantics: toggle simulated fullscreen. Clicking green on any
      // window enters fullscreen on it; clicking again exits.
      if (isFullscreenActive()) await exitSimulatedFullscreen();
      else await enterSimulatedFullscreen(winId);
      break;
  }
  rectsByWinId.delete(winId);
  refresh();
}

export async function clearAll() {
  rectsByWinId.clear();
  try { await sd.events.setTapRects(CALLBACK, []); } catch (_) {}
}
