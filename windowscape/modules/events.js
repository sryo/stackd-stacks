// Event plumbing — port of events.lua (slimmed: no AXObserver per-app yet,
// no right-click eventtap for snapshots, no watchdog). The 1Hz lifecycle
// poll + the windowsAll / focused signals drive everything here.

import { sd } from "sd://runtime/api.js";
import { cfg } from "./config.js";
import {
  state, log, updateWindowOrder, isAppIncluded, displayForWindow
} from "./core.js";
import { tileWindows, pruneStaleWeights } from "./tiler.js";
import { onWindowDestroyed as fullscreenOnDestroyed } from "./fullscreen.js";

// Push an inclusion verdict to the overlay-border stack so it can paint the
// focused window's border in the included vs excluded palette. The bang is
// user-defined (bare name, no `sd.` prefix); overlay-border caches per-id so
// re-focus is free.
function emitInclusionBang(w) {
  if (!w || !w.id) return;
  sd.bang('overlay-border.inclusion', { winId: w.id, included: isAppIncluded(w) });
}

// Spatial drop-position calculator — port of operations.lua calculateDropPosition.
// Returns the 0-based insertion index for a window dropped at `dropFrame`
// among `screenWindows` (already filtered to same-display, non-collapsed).
// Horizontal displays compare centers on x, vertical on y. This is what
// makes "drag window2 to the left of window1" actually reorder them.
function calculateDropPosition(dropFrame, screenWindows, horizontal) {
  if (!dropFrame) return 0;
  const dcx = dropFrame.x + dropFrame.w / 2;
  const dcy = dropFrame.y + dropFrame.h / 2;
  let insertIdx = 0;
  for (let i = 0; i < screenWindows.length; i++) {
    const f = screenWindows[i].frame;
    if (!f) continue;
    const cx = f.x + f.w / 2;
    const cy = f.y + f.h / 2;
    if (horizontal ? dcx > cx : dcy > cy) insertIdx = i + 1;
  }
  return insertIdx;
}

let eventDebounceTimer = null;
let lastKnownIds = new Set();
let lastKnownFrames = Object.create(null); // id -> { app, frame }

// Refresh windowSpaces cache for ids we haven't seen before, so the tiler
// has a current spaces list when it next runs.
async function refreshSpacesCache(ids) {
  for (const id of ids) {
    if (state.windowSpacesCache[id]) continue;
    state.windowSpacesCache[id] = await sd.spaces.windowSpaces(id);
  }
}

// True if the lifecycle delta looks like a tab switch: same-app windows with
// near-identical frames. Port of events.lua isTabSwitch.
function isTabSwitch(newIds, removedIds, currentData) {
  if (newIds.length === 0 || removedIds.length === 0) return false;
  for (const nid of newIds) {
    const nd = currentData[nid];
    if (!nd) continue;
    for (const oid of removedIds) {
      const od = lastKnownFrames[oid];
      if (!od) continue;
      if (od.app !== nd.app) continue;
      const f1 = od.frame, f2 = nd.frame;
      const diff = Math.abs(f1.x - f2.x) + Math.abs(f1.y - f2.y) +
                   Math.abs(f1.w - f2.w) + Math.abs(f1.h - f2.h);
      if (diff < 50) return true;
    }
  }
  return false;
}

function debouncedHandleWindowEvent() {
  if (eventDebounceTimer) clearTimeout(eventDebounceTimer);
  eventDebounceTimer = setTimeout(() => {
    eventDebounceTimer = null;
    handleWindowEvent();
  }, cfg.eventDebounceSeconds * 1000);
}

async function handleWindowEvent() {
  if (state.tilingCount > 0) {
    setTimeout(handleWindowEvent, 200);
    return;
  }

  const currentIds = new Set();
  const currentData = Object.create(null);
  for (const id in state.windowsById) {
    const w = state.windowsById[id];
    if (!isAppIncluded(w)) continue;
    const d = displayForWindow(w);
    if (!d) continue;
    currentIds.add(+id);
    currentData[id] = { app: w.app, frame: { ...w.frame } };
  }

  const newIds = [...currentIds].filter((id) => !lastKnownIds.has(id));
  const removedIds = [...lastKnownIds].filter((id) => !currentIds.has(id));

  const tabSwitch = isTabSwitch(newIds, removedIds, currentData);

  lastKnownIds = currentIds;
  lastKnownFrames = currentData;

  if (tabSwitch) return;
  if (newIds.length === 0 && removedIds.length === 0) return;

  // Refresh cache for newcomers AND for any currently-eligible window
  // whose cache entry is missing. The strict "only newIds" approach
  // lost cache entries permanently whenever a window briefly dropped
  // out of currentIds (e.g. transient displayForWindow=null while
  // state.displays was still empty during boot, or a toggleExcluded
  // round-trip): the removed-path purged the cache, but the rejoin-
  // path only refreshes IDs that are "new since last tick" — windows
  // present on both ticks but cache-missing fell through forever.
  const cacheMissing = [...currentIds].filter((id) => !state.windowSpacesCache[id]);
  await refreshSpacesCache(cacheMissing);
  for (const id of removedIds) delete state.windowSpacesCache[id];

  log(`event: +${newIds.length} -${removedIds.length}`);
  updateWindowOrder();
  state.tileReason = `lifecycle +${newIds.length}-${removedIds.length}`;
  await tileWindows();
  // Refresh the focused window's inclusion verdict — overlay-border owns
  // the border render now, we just push the policy.
  const fid = sd.windows.focused.peek()?.id;
  if (fid != null) emitInclusionBang(state.windowsById[fid]);
}

export function start() {
  // Snapshot of all windows → state.windowsById rebuilt each tick. We use
  // this channel ONLY to keep windowsById fresh (frame/title/app props for
  // the windows already in the rotation). We deliberately do NOT trigger
  // tile passes here — the daemon's sd.windows.all push refires on every
  // focused-window title change (e.g. Terminal spinner), which used to
  // produce 75+ no-op tile passes per second. Tile triggers now come from
  // the lifecycle bangs below (created / destroyed / minimized /
  // deminimized) which only fire on actual layout-relevant transitions.
  sd.windows.all.subscribe(async (list) => {
    if (!Array.isArray(list)) return;
    const next = Object.create(null);
    for (const w of list) next[w.id] = w;
    state.windowsById = next;
    // Prune minimizedIds of IDs that are gone — keeps the set bounded
    // and lets a re-created window (same app, new CGWindowID) get a
    // fresh tile slot.
    for (const id of state.minimizedIds) {
      if (!next[id]) state.minimizedIds.delete(id);
    }
  });

  // Post-R1b: subscribe to the granular focusedChanged channel, not the legacy
  // sd.windows.focused union. The union also fires on titleChanged, which we
  // don't want — every title-only flicker (Slack, Code, Chrome tabs) would
  // detach + reattach the overlay and shove the same id back onto focusHistory.
  sd.windows.focusedChanged.subscribe((w) => {
    if (!w || !w.id) return;
    // Update focusHistory.
    const id = w.id;
    const i = state.focusHistory.indexOf(id);
    if (i >= 0) state.focusHistory.splice(i, 1);
    state.focusHistory.unshift(id);
    if (state.focusHistory.length > state.focusHistoryMax) {
      state.focusHistory.length = state.focusHistoryMax;
    }
    // Push inclusion verdict so overlay-border can paint the right palette.
    // The overlay attach itself is driven by overlay-border's own
    // focusedChanged subscription.
    emitInclusionBang(state.windowsById[id] || w);
  });

  sd.spaces.all.subscribe((info) => {
    if (!info) return;
    state.spacesByDisplay = info;
    // Active space changed — rebuild order + retile.
    updateWindowOrder();
    state.tileReason = "spaces";
    tileWindows();
  });

  // Display geometry changes. macOS posts NSApplication.didChangeScreen­Parameters­
  // (which sd.display.all rides) BEFORE NSScreen metrics settle — reading
  // visibleFrame inside this callback often returns the OLD frame. Lua
  // events.lua line 705 debounces 250ms before re-tiling for this exact reason,
  // and resets tilingCount + clears any in-flight cooldowns so the post-debounce
  // tile pass isn't blocked. Port the same shape.
  let displayDebounce = null;
  // Cache the geometry signature so we can skip retiles when the only
  // thing that changed was brightness (sd.display.all re-pushes on every
  // 2s brightness poll). Without this, every brightness sample triggers
  // a tile pass — which races with the per-pass AX probe and produces
  // spurious "Terminal dropped from rotation" events when AX is briefly
  // slow under load.
  let lastDisplayGeoSig = "";
  sd.display.all && sd.display.all.subscribe && sd.display.all.subscribe((d) => {
    if (!Array.isArray(d)) return;
    state.displays = d;
    const sig = d.map(s => {
      const f = s.frame || {}, vf = s.visibleFrame || {};
      return `${s.displayID}|${f.x},${f.y},${f.w},${f.h}|${vf.x},${vf.y},${vf.w},${vf.h}`;
    }).join("/");
    if (sig === lastDisplayGeoSig) return; // brightness-only push, ignore
    lastDisplayGeoSig = sig;
    if (displayDebounce) clearTimeout(displayDebounce);
    displayDebounce = setTimeout(() => {
      displayDebounce = null;
      // Pull a fresh displays snapshot after the settle delay so screenFrame
      // math uses the now-current visibleFrame instead of the stale value
      // that fired this callback.
      const settled = sd.display.all.peek?.();
      if (Array.isArray(settled)) state.displays = settled;
      // Clear stale tile cooldown so the retile actually runs.
      state.tilingCount = 0;
      updateWindowOrder();
      state.tileReason = "display-change";
      tileWindows();
    }, 250);
  });

  // Lifecycle bangs — invalidate space cache for destroyed windows AND
  // retile (closed window leaves a gap the remaining tiles should fill).
  window.onBang_sd_window_destroyed = (detail) => {
    if (detail && detail.id) {
      delete state.windowSpacesCache[detail.id];
      // If the destroyed window was the simulated-fullscreen target, exit
      // so the parked peers come back into view. No-op otherwise.
      fullscreenOnDestroyed(detail.id);
    }
    pruneStaleWeights();
    debouncedHandleWindowEvent();
  };
  window.onBang_sd_window_created = (detail) => {
    debouncedHandleWindowEvent();
  };
  // Explicit minimize tracking — drives the tile-eligibility filter in
  // core.updateWindowOrder (state.minimizedIds). Using these bangs
  // instead of CGWindowIsOnscreen because that flag flickers false when
  // the window is momentarily occluded.
  window.onBang_sd_window_minimized = (detail) => {
    if (!detail || detail.id == null) return;
    state.minimizedIds.add(+detail.id);
    // Skip handleWindowEvent — it bails when newIds/removedIds are empty
    // (a minimize doesn't add/remove from windowsById, it just flips an
    // eligibility flag). Tile directly so the freed slot collapses and
    // remaining tiles absorb the space.
    updateWindowOrder();
    state.tileReason = `minimize(${detail.id})`;
    tileWindows();
  };
  window.onBang_sd_window_deminimized = (detail) => {
    if (!detail || detail.id == null) return;
    state.minimizedIds.delete(+detail.id);
    updateWindowOrder();
    state.tileReason = `deminimize(${detail.id})`;
    tileWindows();
  };

  // Spatial reorder on window-moved — port of events.lua handleWindowMoved.
  // The daemon fires sd.window.moved for origin changes AND sd.window.resized
  // for size changes as SEPARATE bangs (Windows.swift:1199+). A pure
  // right/bottom-edge resize changes size only → only `resized` fires; a
  // top/left-edge resize changes both. Hammerspoon's window_filter coalesces
  // these into one `windowMoved`; we have to subscribe to both and dedupe.
  //
  // Debounced 300ms (matches lua's pendingReposition timer) so the final
  // event after a drag-drop wins, not every intra-drag tick.
  // Drag-bracket model: leftMouseDown opens the bracket (sets dragInFlight),
  // leftMouseUp closes it (after a 100ms grace for trailing synth-poll bangs).
  // Mid-bracket bangs hydrate state and record the candidate moved id; the
  // decision (resize-redistribute vs reorder vs no-op) fires ONCE at bracket
  // close. Without the bracket the drag-train would fire reorder on each
  // intermediate bang and the window would jump back under the cursor.
  // Bangs OUTSIDE any bracket (AX-driven changes from scripts/shortcuts) are
  // handled by the drift watcher in tiler.js.
  const handleDragEnd = (detail) => {
    if (!detail || !detail.id) return;
    // ALWAYS hydrate state.windowsById from the bang. sd.windows.all is
    // throttled (fires on focus/title change only), so peer frames otherwise
    // drift stale.
    if (detail.frame && state.windowsById[+detail.id]) {
      state.windowsById[+detail.id].frame = detail.frame;
    }
    // Collapsed-window heuristic: a moved/resized bang for a collapsed
    // widget is usually the APP shuffling itself in the rail (Sticky Notes'
    // internal x-arrangement), NOT a user drag. Short-circuit those — but
    // still hydrated above so the strip math sees current x.
    const cw = state.windowsById[+detail.id];
    if (cw && cw.frame && cw.frame.h <= cfg.collapsedWindowHeight) {
      const tgt = state.lastTileTarget?.[+detail.id]?.frame;
      const yDrift = tgt ? Math.abs(cw.frame.y - tgt.y) : 0;
      if (yDrift <= cfg.collapsedWindowHeight) return;
    }
    // Filter to windows windowscape actually tiles. The synth poll fires
    // moved/resized bangs for every CGWindowList entry — including AppKit
    // service windows like CursorUIViewService autocomplete renderers,
    // tiny popup floats, etc. — that we never tile. Letting those bangs
    // through sets dragInFlight (blocking real tiles), and worse: if a
    // service-window bang fires AFTER the user's real drag bang, it
    // overwrites lastMovedId → debounce runs against the WRONG id →
    // user's resize/reorder is silently dropped.
    //
    // Accept the bang if either: (a) we've actually tiled this id on some
    // display (post-first-pass), OR (b) it's a window we WOULD tile —
    // isAppIncluded + has a frame + lives on a known display. The second
    // path covers the boot race: after a hot-reload, lastTiledByDisplay
    // is empty until the first tile pass finishes; a user drag in that
    // window would otherwise get DRAG-SKIP'd and lost.
    const w = state.windowsById[+detail.id];
    const wasTiled = Object.values(state.lastTiledByDisplay || {})
      .some(arr => Array.isArray(arr) && arr.includes(+detail.id));
    const eligible = w && w.frame && isAppIncluded(w) && displayForWindow(w);
    if (!wasTiled && !eligible) {
      log(`DRAG-SKIP non-tiled id=${detail.id} (${w?.app?.slice(0,12)}) lastTiled=${JSON.stringify(state.lastTiledByDisplay)}`);
      return;
    }
    const app = state.windowsById[detail.id]?.app?.slice(0, 12);
    const tgt = state.lastTileTarget && state.lastTileTarget[+detail.id];
    if (tgt && tgt.frame && tgt.ts != null && detail.frame) {
      const f = detail.frame;
      const ageMs = Date.now() - tgt.ts;
      if (ageMs <= 600 &&
          Math.abs(f.x - tgt.frame.x) <= 5 && Math.abs(f.y - tgt.frame.y) <= 5 &&
          Math.abs(f.w - tgt.frame.w) <= 5 && Math.abs(f.h - tgt.frame.h) <= 5) {
        log(`DRAG-IGNORED echo id=${detail.id} (${app}) age=${ageMs}ms`);
        return;
      }
    }

    // If a drag bracket is open (between leftMouseDown and leftMouseUp), record
    // the moved id as the candidate and bail. The decision runs at bracket
    // close — see endDragBracket below. The LATEST mid-bracket bang wins as
    // the candidate (drag-train's final position is what matters).
    if (state.dragInFlight) {
      state.dragCandidateId = +detail.id;
      log(`DRAG-MID id=${detail.id} (${app}) bracket-open, recording candidate`);
      return;
    }
    // Outside any bracket → AX-driven change (script/shortcut). Drift watcher
    // (tiler.js, 500ms) catches it and re-weights. Don't react here.
    log(`DRAG-ACCEPTED-OUTSIDE-BRACKET id=${detail.id} (${app}) — leaving to drift watcher`);
  };
  window.onBang_sd_window_moved = handleDragEnd;
  window.onBang_sd_window_resized = handleDragEnd;
}

// Drag-bracket — opened on leftMouseDown, closed on leftMouseUp. While open,
// tile passes are blocked (state.dragInFlight) and bang-triggered actions are
// deferred to bracket close. The candidate moved id is captured from mid-drag
// bangs; at close, we run ONE decision based on the final frame.
let dragSafetyTimer = null;
let dragCloseTimer = null;
export function startDragBracket() {
  // Reset bracket state. If a previous bracket is still pending close (e.g.
  // user click-drag-click in rapid succession), cancel the pending close so
  // we don't run the prior decision on the new mouse-down.
  if (dragCloseTimer) { clearTimeout(dragCloseTimer); dragCloseTimer = null; }
  if (dragSafetyTimer) { clearTimeout(dragSafetyTimer); dragSafetyTimer = null; }
  state.dragInFlight = true;
  state.dragCandidateId = null;
  // Safety: drop the gate after 5s of no mouseUp. Shouldn't happen (every
  // mouseDown gets a mouseUp), but if the eventtap drops one we don't want
  // tile passes blocked forever.
  dragSafetyTimer = setTimeout(() => {
    log("DRAG-BRACKET safety timeout — clearing dragInFlight");
    state.dragInFlight = false;
    state.dragCandidateId = null;
    dragSafetyTimer = null;
  }, 5000);
}

export function endDragBracket() {
  if (dragSafetyTimer) { clearTimeout(dragSafetyTimer); dragSafetyTimer = null; }
  if (dragCloseTimer) { clearTimeout(dragCloseTimer); dragCloseTimer = null; }
  // 100ms grace for the trailing synth-poll bang to land — the OS posts
  // the final moved/resized bang after mouseUp (CGS-side observation), so
  // we wait so dragCandidateId reflects the FINAL position, not the
  // mid-drag one.
  dragCloseTimer = setTimeout(async () => {
    dragCloseTimer = null;
    const movedId = state.dragCandidateId;
    state.dragCandidateId = null;
    state.dragInFlight = false;
    if (movedId == null) {
      // No bang fired between mouseDown and mouseUp+100ms → just a click,
      // not a drag. Nothing to do.
      return;
    }
    const tgt = state.lastTileTarget?.[movedId]?.frame;
    const liveFrame = state.windowsById[movedId]?.frame;
    if (tgt && liveFrame) {
      const dW = Math.abs(liveFrame.w - tgt.w);
      const dH = Math.abs(liveFrame.h - tgt.h);
      if (dW > 20 || dH > 20) {
        log(`DRAG-CLOSE id=${movedId} resize dW=${Math.round(dW)} dH=${Math.round(dH)}`);
        setWeightFromActualSize(movedId);
        await tileWindows();
        return;
      }
    }
    log(`DRAG-CLOSE id=${movedId} position-only → reorder`);
    reorderOnDrop(movedId);
  }, 100);
}

// User-drag resize. Whichever window's bang fired (the OS routes drag
// gestures to whichever side is frontmost or owns the click pixel), we
// detect WHICH EDGE moved by comparing the post-drag frame to the tile
// target: if the leading edge moved, the LEFT neighbor absorbs; else
// the RIGHT neighbor. Only those TWO windows' weights change. Others
// stay put. This way "drag boundary between Finder and Arc" produces
// the same visual outcome regardless of which side's bang the OS fired
// (focused-Finder bang vs unfocused-Arc bang both shift the boundary).
export function setWeightFromActualSize(movedId) {
  const w = state.windowsById[movedId];
  if (!w || !w.frame) return;
  const d = displayForWindow(w);
  if (!d) return;
  const tiled = state.lastTiledByDisplay[d.displayID];
  if (!tiled || tiled.length === 0) return;
  const ids = [];
  for (const id of tiled) {
    const ww = state.windowsById[id];
    if (!ww || !ww.frame) continue;
    if (ww.frame.h <= cfg.collapsedWindowHeight) continue;
    ids.push(+id);
  }
  const myIdx = ids.indexOf(+movedId);
  if (myIdx < 0 || ids.length < 2) return;

  const horizontal = d.frame.w > d.frame.h;
  const tgt = state.lastTileTarget?.[+movedId]?.frame;
  if (!tgt) return;

  const actualSize = horizontal ? w.frame.w : w.frame.h;
  const tgtSize    = horizontal ? tgt.w     : tgt.h;
  const sizeDelta  = actualSize - tgtSize;
  if (Math.abs(sizeDelta) < 20) return;

  // Which edge moved? If the leading (left/top) edge changed position,
  // the boundary to the LEFT of moved was dragged → left neighbor pairs.
  // Else the trailing (right/bottom) edge changed → right neighbor pairs.
  // The canonical pair-of-windows is the same regardless of WHICH side
  // fired the bang (focused-Finder vs unfocused-Arc both shift the same
  // boundary), so unfocused-edge drags converge to the same outcome.
  const actualPos = horizontal ? w.frame.x : w.frame.y;
  const tgtPos    = horizontal ? tgt.x     : tgt.y;
  const leadingEdgeMoved = Math.abs(actualPos - tgtPos) > 10;
  const direction = leadingEdgeMoved ? -1 : +1;
  const neighborIdx = myIdx + direction;
  // No-neighbor edge case: dragging the leftmost tile's left edge or
  // the rightmost's right edge — nothing to give pixels to / take from.
  // Return without mutating weights. The next tile pass setFrames moved
  // back to its weight-implied target → window snaps back. Matches the
  // Lua original; the user-asked behavior of "outer edge: snap back".
  if (neighborIdx < 0 || neighborIdx >= ids.length) {
    log(`USER-RESIZE id=${movedId} outer-edge no-neighbor (dir=${direction}) → snap-back`);
    return;
  }
  const neighborId = ids[neighborIdx];

  // Pairwise pixel transfer: the moved window's new size IS the user's
  // drag; the neighbor swallows the inverse delta. Compute their NEW
  // weights to preserve the (moved+neighbor) weight sum so other tiles
  // are untouched.
  const totalAxis  = horizontal ? d.visibleFrame.w : d.visibleFrame.h;
  const avail      = totalAxis - cfg.tileGap * (ids.length - 1);
  const totalWeight = ids.reduce((s, id) => s + (state.windowWeights[id] ?? 1.0), 0);
  const pxPerWeight = avail / totalWeight;
  const movedW    = state.windowWeights[+movedId]  ?? 1.0;
  const neighborW = state.windowWeights[neighborId] ?? 1.0;
  const pairW     = movedW + neighborW;
  const pairPx    = pairW * pxPerWeight;
  const newMovedPx = Math.max(50, Math.min(pairPx - 50, actualSize));
  const newNeighborPx = pairPx - newMovedPx;
  const newMovedW    = pairW * (newMovedPx    / pairPx);
  const newNeighborW = pairW * (newNeighborPx / pairPx);
  state.windowWeights[+movedId]   = newMovedW;
  state.windowWeights[+neighborId] = newNeighborW;

  log(`USER-RESIZE id=${movedId} ${horizontal ? "→" : "↓"}${Math.round(sizeDelta)}px neighbor=${neighborId} (${direction > 0 ? "right" : "left"}) ${movedW.toFixed(2)}→${newMovedW.toFixed(2)} | ${neighborW.toFixed(2)}→${newNeighborW.toFixed(2)}`);
}

async function reorderOnDrop(movedId) {
  const moved = state.windowsById[movedId];
  if (!moved || !moved.frame) return;
  if (!isAppIncluded(moved)) return;
  const d = displayForWindow(moved);
  if (!d) return;
  const space = state.spacesByDisplay[d.uuid]?.active;
  if (space == null) return;
  const order = state.windowOrderBySpace[space] || [];

  // Same-display, non-collapsed peers (excluding the moved window itself).
  // Filter by lastTiledByDisplay so we only reorder among windows the tiler
  // actually placed — phantom CGWindowList entries don't get a slot.
  const tiled = state.lastTiledByDisplay[d.displayID];
  const tiledSet = tiled && tiled.length ? new Set(tiled.map(id => +id)) : null;
  const peers = [];
  for (const id of order) {
    if (id === movedId) continue;
    if (tiledSet && !tiledSet.has(+id)) continue;
    const w = state.windowsById[id];
    if (!w || !w.frame) continue;
    if (w.frame.h <= cfg.collapsedWindowHeight) continue;
    const wd = displayForWindow(w);
    if (!wd || wd.displayID !== d.displayID) continue;
    peers.push(w);
  }
  if (peers.length === 0) { await tileWindows(); return; }

  const horizontal = d.frame.w > d.frame.h;
  const newIdx = calculateDropPosition(moved.frame, peers, horizontal);

  // Splice moved into peers at newIdx; rebuild order keeping off-display
  // and on-display-collapsed entries in place.
  peers.splice(newIdx, 0, moved);
  const peerById = new Map(peers.map(w => [w.id, w]));
  const collapsedOnScreen = [];
  for (const id of order) {
    const w = state.windowsById[id];
    if (!w || !w.frame) continue;
    if (w.frame.h <= cfg.collapsedWindowHeight) {
      const wd = displayForWindow(w);
      if (wd && wd.displayID === d.displayID) collapsedOnScreen.push(id);
    }
  }
  const newOrder = [];
  for (const id of order) {
    const w = state.windowsById[id];
    if (!w) continue;
    const wd = displayForWindow(w);
    const onOther = !wd || wd.displayID !== d.displayID;
    if (onOther) newOrder.push(id);
  }
  for (const w of peers) newOrder.push(w.id);
  for (const id of collapsedOnScreen) newOrder.push(id);

  state.windowOrderBySpace[space] = newOrder;
  await tileWindows();
}
