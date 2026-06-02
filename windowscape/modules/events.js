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
}
