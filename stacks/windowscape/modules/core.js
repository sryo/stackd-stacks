// Shared state + utilities.
// State is a singleton; modules import and mutate it directly.

import { sd } from "sd://runtime/api.js";
import { cfg } from "./config.js";

export const state = {
  windowOrderBySpace: Object.create(null), // spaceId -> [winId, ...]
  windowWeights:      Object.create(null), // winId -> weight (flex tiles only)
  // winId -> pixel size on the major axis. Presence = "this tile is pinned at
  // this exact size; do NOT include it in the weight-based redistribution."
  // Written by user-resize pairwise transfer (events.js pinFromActualSize —
  // pins both sides of the dragged edge), AX refusal (tiler.js PASS-2), and
  // grow/shrink/cycleWidth verbs. Cleared by cycleWidth (focused only) and
  // resetWeights (all). hy3:base mechanic.
  pinnedSizes:        Object.create(null),
  // Ids whose pinnedSizes entry came from a REFUSAL (PASS-2 / anim sweep /
  // OOB containment) rather than a user resize. Refusal pins encode an
  // app's real minimum — the PIN-CLAMP oversubscription reset must shed
  // user pins first, because dropping a refusal pin just re-triggers the
  // refusal on the next even split (clamp → even split → refuse → pin →
  // clamp, forever). Entries whose pin
  // is gone are harmless — consumers intersect with pinnedSizes.
  refusalPins:        new Set(),
  // The window the user most recently resized (pinFromActualSize). PIN-CLAMP
  // keeps this pin fixed and shrinks the others so a resize sticks. A stale id
  // is harmless — PIN-CLAMP validates it against the live pin set.
  lastPinPairId:      null,
  // Per-app minimum cache: (bundleId||app) -> { h, v } px. Learned from AX
  // refusals and fed to resolveFlex as a floor, so a NEW window of a known-fussy
  // app (Terminal's column grid, System Settings' ~845px) starts at a legal size
  // instead of refusing on its first tile. Runtime-only — NOT persisted, so a
  // stale/false min never survives a restart; resetWeights clears it. (This
  // caching is only fully safe once deterministic-echo lands and false refusals
  // can't poison it — see the phase-4 plan.)
  appMins:            Object.create(null),
  // A tile pass was skipped while a drag bracket was open; endDragBracket
  // (or its safety timeout) runs the deferred pass when the bracket closes.
  tileDeferred:       false,
  // winId -> ts of first consecutive onscreen=false observation (tiler's
  // debounced eviction of hidden windows vs occlusion flicker).
  offscreenSince:     Object.create(null),
  // winIds observed onscreen at least once this session. The tiler's 1.5s
  // offscreen grace exists to ride out occlusion flicker on windows we've
  // been tiling — a window we've NEVER seen onscreen (Cmd+H'd before the
  // stack booted, parked off-space) gets no grace, otherwise every stackd
  // restart tiles a phantom slot for 1.5s and the layout visibly snaps
  // twice.
  everOnscreen:       new Set(),
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
  // (No persistent caches: stickyTileSet, prevTileMembership, axMissCount,
  // lastAxOkAt, windowLastScreen, windowConstraints, fixedSizeIds all
  // deleted. AX min/max are layout-pressure-dependent and the daemon
  // owns AX addressability caching. Per BELIEFS #1, live AX is the source
  // of truth; the tile pass observes actuals each pass via setFrameProbed
  // and converges via PASS-2 weight sync.)
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
  // The id of the window the user is currently dragging — captured from the
  // first moved/resized bang inside a leftMouseDown→leftMouseUp bracket
  // (events.js startDragBracket / endDragBracket). Mid-drag bangs overwrite
  // this with the latest id so the trailing bang wins; the bracket's close
  // handler reads it to decide resize-redistribute vs reorder.
  dragCandidateId:    null,
  // One-shot animation suppression for the NEXT tileWindows() call. The
  // resize-containment paths (out-of-bracket pin, bracket-close pin, the
  // post-animation refusal sweep) set this so their corrective pass SNAPS
  // through the full PASS-1/PASS-2 machinery instead of animating —
  // a resized window should settle instantly, and the snap path's probed
  // actuals are what keep pairwise locality honest. Lifecycle retiles
  // (open/close/minimize/spaces) leave it false and animate.
  snapNextTile:       false,
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
    savedPinnedSizes: null,          // { winId: px } snapshot
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

// ── Per-app minimum cache (see state.appMins) ────────────────────────────────
// Keyed by bundleId (falling back to app name) so windows of the same app share
// the learned floor. Two axes: h = min width on a horizontal display, v = min
// height on a vertical one.
export function appKeyOf(winId) {
  const w = state.windowsById[winId];
  return w ? (w.bundleId || w.app || String(winId)) : String(winId);
}
export function appMinFor(winId, horizontal) {
  const m = state.appMins[appKeyOf(winId)];
  if (!m) return 0;
  return (horizontal ? m.h : m.v) || 0;
}
export function learnAppMin(winId, horizontal, px) {
  if (!(px > 0)) return;
  const k = appKeyOf(winId);
  const m = state.appMins[k] || (state.appMins[k] = { h: 0, v: 0 });
  const axis = horizontal ? "h" : "v";
  if (px > (m[axis] || 0)) m[axis] = px;
}

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

// (No constraint cache. AX min/max are layout-pressure-dependent — apps
// can refuse a tile-driven shrink while accepting a user drag to the same
// size. Per BELIEFS #1: data is live, or it isn't data. The tiler observes
// actuals via setFrameProbed each pass and redistributes leftover space
// on a second sub-pass within the same tile event; the drag handler reads
// live frames as truth when computing expected-vs-actual.)

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

// Identity migration for same-slot window recreation (events.js
// matchRecreationPairs): an app destroyed a window and recreated it at a
// near-identical frame, so the new id should inherit the old id's place in
// the world — order position, tile membership, weight/pin, tile target,
// space cache, minimize state, focus history. `stash` is the destroy-time
// snapshot events.js captured before the destroy handler purged the live
// maps; it can be missing (grace expired), in which case only the
// positional substitutions run.
export function migrateWindowId(oldId, newId, stash) {
  oldId = +oldId; newId = +newId;
  for (const space in state.windowOrderBySpace) {
    const order = state.windowOrderBySpace[space];
    const i = order.findIndex((id) => +id === oldId);
    if (i < 0) continue;
    if (order.some((id) => +id === newId)) order.splice(i, 1);
    else order[i] = newId;
  }
  for (const displayID in state.lastTiledByDisplay) {
    const arr = state.lastTiledByDisplay[displayID];
    if (!Array.isArray(arr)) continue;
    const i = arr.findIndex((id) => +id === oldId);
    if (i < 0) continue;
    if (arr.some((id) => +id === newId)) arr.splice(i, 1);
    else arr[i] = newId;
  }
  if (stash) {
    if (stash.weight != null && state.windowWeights[newId] == null) {
      state.windowWeights[newId] = stash.weight;
    }
    if (stash.pin != null && state.pinnedSizes[newId] == null) {
      state.pinnedSizes[newId] = stash.pin;
    }
    // Keep the stash's ORIGINAL ts: the 600ms echo window is long expired
    // (correct — this was never our setFrame), but the out-of-bracket
    // resize path needs a target so the recreated window sitting at its
    // old tile frame reads dMajor≈0 instead of pinning phantom sizes.
    if (stash.target && !state.lastTileTarget[newId]) {
      state.lastTileTarget[newId] = stash.target;
    }
    // Same frame ⇒ same space; seeding avoids an async round-trip during
    // which the space filter would run on missing data.
    if (stash.spaces && !state.windowSpacesCache[newId]) {
      state.windowSpacesCache[newId] = stash.spaces;
    }
  }
  delete state.windowWeights[oldId];
  delete state.pinnedSizes[oldId];
  delete state.lastTileTarget[oldId];
  delete state.windowSpacesCache[oldId];
  delete state.offscreenSince[oldId];
  const fi = state.focusHistory.indexOf(oldId);
  if (fi >= 0) {
    if (state.focusHistory.includes(newId)) state.focusHistory.splice(fi, 1);
    else state.focusHistory[fi] = newId;
  }
  if (state.minimizedIds.has(oldId)) {
    state.minimizedIds.delete(oldId);
    state.minimizedIds.add(newId);
  }
  if (state.everOnscreen.has(oldId)) {
    state.everOnscreen.delete(oldId);
    state.everOnscreen.add(newId);
  }
  if (state.refusalPins.has(oldId)) {
    state.refusalPins.delete(oldId);
    if (state.pinnedSizes[newId] != null) state.refusalPins.add(newId);
  }
}

// Rebuild windowOrderBySpace for each display's active space, preserving prior
// ordering. Port of core.updateWindowOrder.
export function updateWindowOrder() {
  for (const d of state.displays) {
    const space = activeSpaceOnDisplay(d.uuid);
    if (space == null) continue;

    const eligible = [];
    const eligibleIds = new Set();
    const isRecovery = state.tileReason === "stray-overlap-recovery";
    for (const id in state.windowsById) {
      const w = state.windowsById[id];
      if (!w) { if (isRecovery) evt(`UWO-DROP id=${id} reason=no-w`); continue; }
      if (!isAppIncluded(w)) { if (isRecovery) evt(`UWO-DROP id=${id} (${w.app}) reason=excluded`); continue; }
      if (state.minimizedIds && state.minimizedIds.has(+w.id)) { if (isRecovery) evt(`UWO-DROP id=${id} (${w.app}) reason=minimizedIds`); continue; }
      const wd = displayForWindow(w);
      if (!wd) { if (isRecovery) evt(`UWO-DROP id=${id} (${w.app}) reason=no-display frame=${JSON.stringify(w.frame)}`); continue; }
      if (wd.displayID !== d.displayID) { if (isRecovery) evt(`UWO-DROP id=${id} (${w.app}) reason=other-display d=${wd.displayID}≠${d.displayID}`); continue; }
      // wspaces==undefined → never queried (refreshSpacesCache async-pending)
      // wspaces==[]        → query returned empty (often: window not yet
      //                       enumerable by sd.spaces.windowSpaces during a
      //                       transition). Treat both as "no info yet,
      //                       include optimistically." Only EXCLUDE when
      //                       we have a definite non-empty list that lacks
      //                       this space.
      const wspaces = state.windowSpacesCache[w.id];
      if (wspaces && wspaces.length > 0 && !wspaces.includes(space)) {
        if (isRecovery) evt(`UWO-DROP id=${id} (${w.app}) reason=other-space spaces=${JSON.stringify(wspaces)} active=${space}`);
        continue;
      }
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
