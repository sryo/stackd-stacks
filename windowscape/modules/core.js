// Shared state + utilities — port of core.lua.
// State is a singleton; modules import and mutate it directly (mirrors the
// way the Lua modules read core.windowOrderBySpace as a live ref).

import { sd } from "sd://runtime/api.js";
import { cfg } from "./config.js";

export const state = {
  windowOrderBySpace: Object.create(null), // spaceId -> [winId, ...]
  windowWeights:      Object.create(null), // winId -> weight
  windowLastScreen:   Object.create(null), // winId -> displayID
  focusHistory:       [],
  focusHistoryMax:    10,
  listedApps:         Object.create(null), // bundleId/name -> true
  // Live windows index, rebuilt from sd.windows.all on each push.
  // win = { id, pid, app, title, frame, screen, space }
  windowsById:        Object.create(null),
  displays:           [],      // sd.display.all snapshot
  spacesByDisplay:    {},      // sd.spaces.all snapshot
  windowSpacesCache:  Object.create(null), // winId -> [spaceId,...]
  tilingCount:        0,
  onLayoutChange:     null,
  // Simulated-fullscreen state — see modules/fullscreen.js.
  // active flips true while one window owns its display's full visibleFrame
  // and the other windows on the same display are parked off-screen. The
  // tiler reads .active to bail out (touching frames would un-fullscreen).
  fullscreenState: {
    active:        false,
    windowId:      null,             // id of the fullscreened window
    displayID:     null,             // display the fullscreen is anchored to
    savedFrames:   Object.create(null), // winId -> pre-enter frame snapshot
    savedOrder:    null,             // [winId, ...] for the affected space
    savedWeights:  null,             // { winId: weight } snapshot
    spaceId:       null              // space the fullscreen owns
  },
  // Snapshot subsystem state — see modules/snapshots.js.
  // snapshots: { [winId]: { app, bundleId, title, frame, image, screenId,
  //                         displayID, snapSize, capturedAt } }
  // isCreating flips true during the capture-animation so the tiler's guard
  // suppresses retile passes that would race with the in-flight setFrame
  // calls. stripScrollOffsets: { [displayID]: pixels } — accumulated scroll
  // applied as CSS transform: translateX on each strip's tile container.
  snapshotsState: {
    snapshots:          Object.create(null),
    order:              [],            // insertion order across all displays
    isCreating:         false,
    isCreatingStart:    0,
    stripScrollOffsets: Object.create(null)
  }
};

export function log(msg) {
  if (cfg.debugLogging) console.log("[WindowScape]", msg);
}

export function warn(msg) {
  console.warn("[WindowScape]", msg);
}

// Active space on a given display, or null if Spaces info isn't yet populated.
export function activeSpaceOnDisplay(uuid) {
  const info = state.spacesByDisplay[uuid];
  return info ? info.active : null;
}

// First display's active space — the "currently focused" space fallback.
// Used as the "current space" when a window's display isn't determinable.
export function getCurrentSpace() {
  for (const uuid of Object.keys(state.spacesByDisplay)) {
    const info = state.spacesByDisplay[uuid];
    if (info && info.active) return info.active;
  }
  return null;
}

// Display whose frame contains the window's center, or null.
export function displayForWindow(win) {
  if (!win || !win.frame) return null;
  const cx = win.frame.x + win.frame.w / 2;
  const cy = win.frame.y + win.frame.h / 2;
  for (const d of state.displays) {
    const f = d.frame;
    if (cx >= f.x && cx < f.x + f.w && cy >= f.y && cy < f.y + f.h) return d;
  }
  return state.displays[0] || null;
}

// Adjusted screen frame for tiling = full frame minus the menu bar (visibleFrame).
export function tileFrameForDisplay(d) {
  if (!d) return null;
  return { ...d.visibleFrame };
}

export function isAppIncluded(win) {
  if (!win) return false;
  // Snapshotted/minimized windows aren't tiled.
  // (Snapshot system stubbed in this port — see modules/snapshots.js.)
  const bundleId = win.bundleId;
  const appName  = win.app;
  const listed = (bundleId && state.listedApps[bundleId]) ||
                 (appName  && state.listedApps[appName]);
  if (cfg.exclusionMode) return !listed;
  return !!listed;
}

// Rebuild windowOrderBySpace for each display's active space, preserving prior
// ordering. Port of core.updateWindowOrder.
export function updateWindowOrder() {
  for (const d of state.displays) {
    const space = activeSpaceOnDisplay(d.uuid);
    if (space == null) continue;

    const eligible = [];
    const eligibleIds = new Set();
    for (const id in state.windowsById) {
      const w = state.windowsById[id];
      if (!w) continue;
      if (!isAppIncluded(w)) continue;
      const wd = displayForWindow(w);
      if (!wd || wd.displayID !== d.displayID) continue;
      const wspaces = state.windowSpacesCache[w.id] || [];
      if (!wspaces.includes(space)) continue;
      eligible.push(w);
      eligibleIds.add(w.id);
    }

    const prev = state.windowOrderBySpace[space] || [];
    const seen = new Set();
    const next = [];
    for (const id of prev) {
      if (eligibleIds.has(id) && !seen.has(id)) {
        next.push(id); seen.add(id);
      }
    }
    for (const w of eligible) {
      if (!seen.has(w.id)) { next.push(w.id); seen.add(w.id); }
    }
    state.windowOrderBySpace[space] = next;
  }
  if (state.onLayoutChange) state.onLayoutChange();
}

export async function loadList() {
  const saved = await sd.settings.get("listedApps");
  if (saved && typeof saved === "object") {
    state.listedApps = { ...saved };
  } else {
    // Default deny list — exclude stackd itself + common dialogs.
    state.listedApps = { "com.apple.loginwindow": true };
    await sd.settings.set("listedApps", state.listedApps);
  }
}

export async function saveList() {
  await sd.settings.set("listedApps", state.listedApps);
}
