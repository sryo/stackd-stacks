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
  // Explicit minimize tracking. Populated by the sd.window.minimized bang
  // (events.js), cleared by sd.window.deminimized. Relying on
  // CGWindowIsOnscreen for the same signal flickered: a focused window
  // briefly occluded by a notification / tooltip / popover would drop
  // out of the eligible set and the tile would re-flow to fill its slot,
  // then re-flow back when the occlusion lifted.
  minimizedIds:       new Set(),
  // { [winId]: { frame: {x,y,w,h}, ts: ms } } — the frame the tiler last
  // asked setFrame for plus the wall time of the call. Drag handlers
  // suppress a bang as an echo only when BOTH: (a) within 600ms of the
  // setFrame, AND (b) frame matches within 5px. Pure time-window suppression
  // swallows legitimate user drags right after a tile; pure frame-match
  // (with a tolerance wide enough for app rounding) swallows small drags
  // whose new frame happens to land near the tile target.
  lastTileTarget:     Object.create(null),
  // { [displayID]: [winId, ...] } — the exact set of window IDs the tiler
  // included in its most recent layout pass for each display. The drag
  // handlers (applyResizeIfNeeded, reorderOnDrop) read this so they
  // compute expected positions against the same membership the tiler did.
  // Without this, the handlers iterate the unfiltered windowOrderBySpace
  // and totalWeight diverges → false "user resized!" detections that
  // transfer weight to windows the user didn't touch.
  lastTiledByDisplay: Object.create(null),
  // CGWindowIDs that refused the tiler's setFrame size change (Calculator,
  // System Settings, certain panel-style apps). Detected post-setFrame
  // when live frame's size differs from the request by >50px. We still
  // honor their position but treat them as non-resizable so the drag-
  // handler doesn't misread the size mismatch as a user drag and rebalance
  // weights against them. Cleared when the window disappears.
  fixedSizeIds:       new Set(),
  // Previous tile-pass membership per display (Set<id>). Used by the
  // event-log diff in tiler.js to detect TILE-IN / TILE-OUT transitions.
  // Fires only when membership actually changes, so logging is near-free
  // even with debugLogging off.
  prevTileMembership: Object.create(null),
  // Per-window consecutive AX-probe miss counter. AX's 100ms messaging
  // timeout can drop a query under load (e.g. spotlight indexing, brightness
  // poll racing), causing sd.windows.frame(id) to return null for an id
  // that's perfectly fine. The tiler previously dropped such windows from
  // the rotation immediately → flicker. Now we tolerate up to N consecutive
  // misses before excluding. Reset to 0 on any successful probe.
  axMissCount:        Object.create(null),
  // Wall-clock ms of the most recent successful sd.windows.frame(id) probe.
  // Pairs with axMissCount: a window is considered "really gone" only when
  // it's missed N consecutive probes AND no success has landed within the
  // recent-window. Survives multi-second bursts of AX-timeout flickers.
  lastAxOkAt:         Object.create(null),
  // Source label for the next tileWindows() call — set by the caller
  // (focusedChanged subscribe, handleWindowEvent, onBang_sd_window_minimized,
  // etc.) so the event log can show WHY a tile pass fired.
  tileReason:         "",
  // True while the user is mid-drag — set by handleDragEnd on the first
  // non-echo bang, cleared after the debounce resolves or after a safety
  // timeout (~1.5s of no further bangs). tileWindows() bails when set so
  // focusedChanged / windowsAll / spaces.all subscriptions don't yank the
  // window out from under the cursor mid-drag.
  dragInFlight:       false,
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

/// Always-on event log for tile membership transitions. Unlike `log()`
/// (which floods on every tile pass when debugLogging is true), `evt()`
/// fires only on actual state changes — window enters/leaves tile
/// rotation, fixed-size detected, minimize bang received — and so is
/// safe to leave on in production. Performance: ~1 line per real event,
/// effectively zero at rest.
export function evt(msg) {
  console.log("[ws-evt]", msg);
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
      // Drop minimized windows. We track minimize state explicitly via the
      // sd.window.minimized / deminimized bangs (see events.js) rather than
      // CGWindowIsOnscreen — that flag flickers false when a window is
      // momentarily occluded by a tooltip / notification / another window
      // briefly above, which would drop the visible window from the tile
      // rotation. Explicit bang-driven state survives the flicker.
      if (state.minimizedIds && state.minimizedIds.has(+w.id)) continue;
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
