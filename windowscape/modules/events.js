// Event plumbing — port of events.lua (slimmed: no AXObserver per-app yet,
// no right-click eventtap for snapshots, no watchdog). The 1Hz lifecycle
// poll + the windowsAll / focused signals drive everything here.

import { sd } from "sd://runtime/api.js";
import { cfg } from "./config.js";
import {
  state, log, updateWindowOrder, isAppIncluded, displayForWindow
} from "./core.js";
import { tileWindows, pruneStaleWeights } from "./tiler.js";
import { drawOutlineForFocused, hideOutline } from "./outline.js";

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

  await refreshSpacesCache(newIds);
  for (const id of removedIds) delete state.windowSpacesCache[id];

  log(`event: +${newIds.length} -${removedIds.length}`);
  updateWindowOrder();
  await tileWindows();
  drawOutlineForFocused();
}

export function start() {
  // Snapshot of all windows → state.windowsById rebuilt each tick.
  sd.windows.all.subscribe(async (list) => {
    if (!Array.isArray(list)) return;
    const next = Object.create(null);
    for (const w of list) next[w.id] = w;
    state.windowsById = next;
    debouncedHandleWindowEvent();
  });

  // Post-R1b: subscribe to the granular focusedChanged channel, not the legacy
  // sd.windows.focused union. The union also fires on titleChanged, which we
  // don't want — every title-only flicker (Slack, Code, Chrome tabs) would
  // detach + reattach the overlay and shove the same id back onto focusHistory.
  sd.windows.focusedChanged.subscribe((w) => {
    if (!w || !w.id) { hideOutline(); return; }
    // Update focusHistory.
    const id = w.id;
    const i = state.focusHistory.indexOf(id);
    if (i >= 0) state.focusHistory.splice(i, 1);
    state.focusHistory.unshift(id);
    if (state.focusHistory.length > state.focusHistoryMax) {
      state.focusHistory.length = state.focusHistoryMax;
    }
    drawOutlineForFocused();
  });

  sd.spaces.all.subscribe((info) => {
    if (!info) return;
    state.spacesByDisplay = info;
    // Active space changed — rebuild order + retile.
    updateWindowOrder();
    tileWindows();
  });

  sd.display.all && sd.display.all.subscribe && sd.display.all.subscribe((d) => {
    if (!Array.isArray(d)) return;
    // Arrangement / connect / disconnect — retile against the new geometry,
    // not the stale one we had before. (Previously this only updated the
    // snapshot, so tiler.js would size windows against a vanished display
    // until the next windowsAll tick.)
    state.displays = d;
    updateWindowOrder();
    tileWindows();
  });

  // Lifecycle bangs — invalidate space cache for destroyed windows.
  window.onBang_sd_window_destroyed = (detail) => {
    if (detail && detail.id) delete state.windowSpacesCache[detail.id];
    pruneStaleWeights();
  };
  window.onBang_sd_window_created = (detail) => {
    debouncedHandleWindowEvent();
  };

  // Spatial reorder on window-moved — port-of events.lua handleWindowMoved
  // line 521+. Without this, dragging a window leftmost doesn't promote it
  // to order[1] and the next retile snaps it back to its old slot.
  // Debounced 300ms (matches lua's pendingReposition timer) so the final
  // event after the drag-drop is what reorders, not every intra-drag tick.
  let moveDebounceTimer = null;
  let lastMovedId = null;
  window.onBang_sd_window_moved = (detail) => {
    if (!detail || !detail.id) return;
    lastMovedId = detail.id;
    if (moveDebounceTimer) clearTimeout(moveDebounceTimer);
    moveDebounceTimer = setTimeout(() => {
      moveDebounceTimer = null;
      const movedId = lastMovedId;
      lastMovedId = null;
      reorderOnDrop(movedId);
    }, 300);
  };
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
