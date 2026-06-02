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
  await tileWindows();
  // Refresh the focused window's inclusion verdict — overlay-border owns
  // the border render now, we just push the policy.
  const fid = sd.windows.focused.peek()?.id;
  if (fid != null) emitInclusionBang(state.windowsById[fid]);
}

export function start() {
  // Snapshot of all windows → state.windowsById rebuilt each tick.
  sd.windows.all.subscribe(async (list) => {
    if (!Array.isArray(list)) return;
    const next = Object.create(null);
    for (const w of list) next[w.id] = w;
    state.windowsById = next;
    // Prune minimizedIds of IDs that are gone — keeps the set from growing
    // unbounded and lets a re-created window (same app, new CGWindowID)
    // get a fresh tile slot.
    for (const id of state.minimizedIds) {
      if (!next[id]) state.minimizedIds.delete(id);
    }
    debouncedHandleWindowEvent();
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
    tileWindows();
  });

  // Display geometry changes. macOS posts NSApplication.didChangeScreen­Parameters­
  // (which sd.display.all rides) BEFORE NSScreen metrics settle — reading
  // visibleFrame inside this callback often returns the OLD frame. Lua
  // events.lua line 705 debounces 250ms before re-tiling for this exact reason,
  // and resets tilingCount + clears any in-flight cooldowns so the post-debounce
  // tile pass isn't blocked. Port the same shape.
  let displayDebounce = null;
  sd.display.all && sd.display.all.subscribe && sd.display.all.subscribe((d) => {
    if (!Array.isArray(d)) return;
    state.displays = d;
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
      tileWindows();
    }, 250);
  });

  // Lifecycle bangs — invalidate space cache for destroyed windows.
  window.onBang_sd_window_destroyed = (detail) => {
    if (detail && detail.id) {
      delete state.windowSpacesCache[detail.id];
      // If the destroyed window was the simulated-fullscreen target, exit
      // so the parked peers come back into view. No-op otherwise.
      fullscreenOnDestroyed(detail.id);
    }
    pruneStaleWeights();
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
    debouncedHandleWindowEvent();
  };
  window.onBang_sd_window_deminimized = (detail) => {
    if (!detail || detail.id == null) return;
    state.minimizedIds.delete(+detail.id);
    debouncedHandleWindowEvent();
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
  let moveDebounceTimer = null;
  let lastMovedId = null;
  const handleDragEnd = (detail) => {
    if (!detail || !detail.id) return;
    // Distinguish user-driven moves from the tiler's own setFrame echoes.
    // The TahoeSynthPoll fires .moved/.resized bangs ~250ms after the CG
    // frame changes — well past tileWindows()'s 150ms cooldown timer, so
    // state.tilingCount=0 by the time the bang arrives. Lua side-steps this
    // because AX windowMoved fires synchronously inside the setFrame call
    // (no poll latency); we don't have that path on Tahoe.
    //
    // Track when the tiler last issued setFrame for an id, and skip any
    // bang that arrives within ~700ms (covers synth-poll latency +
    // debounce). state.recentlyTiledAt is populated by tiler.js.
    const tiledAt = state.recentlyTiledAt && state.recentlyTiledAt[+detail.id];
    if (tiledAt != null && (Date.now() - tiledAt) < 700) return;

    // Hydrate state.windowsById with the live frame from the bang. The
    // sd.windows.all channel is throttled (fires on focus/title change only),
    // so by the time the debounce resolves, state.windowsById[id].frame is
    // pre-drag — applyResizeIfNeeded's actualSize/actualPos math then compares
    // pre-drag geometry against expected and returns "no change" → no weight
    // transfer. Lua reads win:frame() live every pass; we splice the live
    // frame in here so the rest of the code path stays unchanged.
    if (detail.frame && state.windowsById[detail.id]) {
      state.windowsById[detail.id].frame = detail.frame;
    }
    lastMovedId = detail.id;
    if (moveDebounceTimer) clearTimeout(moveDebounceTimer);
    moveDebounceTimer = setTimeout(async () => {
      moveDebounceTimer = null;
      const movedId = lastMovedId;
      lastMovedId = null;
      // Re-check the recently-tiled guard after the debounce — a tile pass
      // that started DURING the debounce window would still be too fresh.
      const t = state.recentlyTiledAt && state.recentlyTiledAt[+movedId];
      if (t != null && (Date.now() - t) < 700) return;
      // Belt-and-suspenders live read — the synth poll can lose intermediate
      // frames if the user drags faster than 4Hz; query AX one more time so
      // the final values are guaranteed-fresh (mirrors lua's win:frame()).
      const live = await sd.windows.frame(movedId).catch(() => null);
      if (live && state.windowsById[movedId]) {
        state.windowsById[movedId].frame = live;
      }
      // Lua handleWindowMoved checks size FIRST (lines 456-516): if the
      // drag was a resize (a tile-edge drag), redistribute weight between
      // the window and its adjacent tile and bail before reorder. Only
      // pure moves fall through to spatial reorder.
      const resized = await applyResizeIfNeeded(movedId);
      if (resized) return;
      reorderOnDrop(movedId);
    }, 300);
  };
  window.onBang_sd_window_moved = handleDragEnd;
  window.onBang_sd_window_resized = handleDragEnd;
}

// Port of events.lua handleWindowMoved lines 456-516. Detect the case
// where a tile-edge drag changed a window's size: compare the actual
// dimension on the screen's primary axis to the expected dimension from
// its weight share. If the size diverges by > 20px we treat it as a
// resize; pick the adjacent tile that gave up the space (left/up neighbor
// if the window's edge moved, right/down neighbor otherwise), then split
// the combined weight between the two so the next tile preserves the
// user's new size ratio.
async function applyResizeIfNeeded(movedId) {
  const moved = state.windowsById[movedId];
  if (!moved || !moved.frame) return false;
  if (!isAppIncluded(moved)) return false;
  const d = displayForWindow(moved);
  if (!d) return false;
  const space = state.spacesByDisplay[d.uuid]?.active;
  if (space == null) return false;
  const order = state.windowOrderBySpace[space] || [];

  // Non-collapsed peers on the same display+space, in current spatial
  // order. Excluding the moved window's collapsed check pattern matches
  // the lua's getScreenWindows(..., includeCollapsed=false).
  const screenWindows = [];
  for (const id of order) {
    const w = state.windowsById[id];
    if (!w || !w.frame) continue;
    if (w.frame.h <= cfg.collapsedWindowHeight) continue;
    const wd = displayForWindow(w);
    if (!wd || wd.displayID !== d.displayID) continue;
    screenWindows.push(w);
  }
  if (screenWindows.length < 2) return false;

  const winIndex = screenWindows.findIndex(w => w.id === movedId);
  if (winIndex < 0) return false;

  // tileWeighted dispatches by display orientation. Match it: horizontal
  // displays distribute width, vertical distribute height. Collapsed-row
  // height is subtracted from availableSpace on vertical displays only
  // (matches tiler.lua's mainH calculation).
  const horizontal = d.frame.w > d.frame.h;
  const screenFrame = { ...d.visibleFrame };

  let totalWeight = 0;
  for (const w of screenWindows) {
    totalWeight += (state.windowWeights[w.id] ?? 1.0);
  }
  if (totalWeight <= 0) return false;

  const totalGaps = Math.max(screenWindows.length - 1, 0) * cfg.tileGap;
  let collapsedAreaSize = 0;
  if (!horizontal) {
    let numCollapsed = 0;
    for (const id of order) {
      const w = state.windowsById[id];
      if (!w || !w.frame) continue;
      if (w.frame.h > cfg.collapsedWindowHeight) continue;
      const wd = displayForWindow(w);
      if (!wd || wd.displayID !== d.displayID) continue;
      numCollapsed++;
    }
    if (numCollapsed > 0) {
      collapsedAreaSize = (cfg.collapsedWindowHeight + cfg.tileGap) * numCollapsed - cfg.tileGap;
    }
  }
  const availableSpace = horizontal
    ? screenFrame.w - totalGaps
    : screenFrame.h - totalGaps - collapsedAreaSize;
  if (availableSpace <= 0) return false;

  const myWeight = state.windowWeights[movedId] ?? 1.0;
  const expectedSize = availableSpace * myWeight / totalWeight;
  const actualSize = horizontal ? moved.frame.w : moved.frame.h;
  if (Math.abs(actualSize - expectedSize) <= 20) return false;

  // Position-vs-expected-position: did the window's leading edge move?
  // If yes, the LEFT/UP neighbor gave up space. If no, the RIGHT/DOWN
  // neighbor did.
  let expectedPos = horizontal ? screenFrame.x : screenFrame.y;
  for (let i = 0; i < winIndex; i++) {
    const w = screenWindows[i];
    const wWeight = state.windowWeights[w.id] ?? 1.0;
    const wSize = Math.floor(availableSpace * wWeight / totalWeight);
    expectedPos += wSize + cfg.tileGap;
  }
  const actualPos = horizontal ? moved.frame.x : moved.frame.y;
  const positionMoved = Math.abs(actualPos - expectedPos) > 10;

  let adjacent = null;
  if (positionMoved) {
    if (winIndex > 0) adjacent = screenWindows[winIndex - 1];
  } else {
    if (winIndex < screenWindows.length - 1) adjacent = screenWindows[winIndex + 1];
  }
  if (!adjacent) return false;

  const adjWeight = state.windowWeights[adjacent.id] ?? 1.0;
  const combined = myWeight + adjWeight;
  // Clamp to [0.2, combined-0.2] so neither side can collapse the other
  // to nothing in a single resize (the lua uses the same floor).
  let newWeight = (actualSize / availableSpace) * totalWeight;
  newWeight = Math.max(0.2, Math.min(newWeight, combined - 0.2));
  const adjNewWeight = Math.max(0.2, combined - newWeight);

  state.windowWeights[movedId]    = newWeight;
  state.windowWeights[adjacent.id] = adjNewWeight;
  if (state.onLayoutChange) state.onLayoutChange();
  await tileWindows();
  return true;
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
  const peers = [];
  for (const id of order) {
    if (id === movedId) continue;
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
