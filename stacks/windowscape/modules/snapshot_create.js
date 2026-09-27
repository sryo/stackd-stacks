// Snapshot capture helpers.
//
// Entry points:
//   captureAndMinimize(winId)    — grab snapshot, AX-minimize the window,
//                                  tile reabsorbs the space, tile renders.
//                                  Used by operations.minimizeFocused.
//   captureForOSMinimize(winId)  — the OS already minimized the window
//                                  (user clicked the yellow dot, Cmd+M, etc.);
//                                  grab the bitmap and add the tile without
//                                  driving another minimize. The window is
//                                  already AX-minimized, so CGSHWCaptureWindowList
//                                  works against its WindowServer-cached
//                                  bitmap. Used by snapshots.js
//                                  onBang_sd_window_minimized.
//
// Both run through one queue: a capture that arrives while another is in
// flight (minimize-all fires one bang per window) waits its turn instead of
// being dropped.

import { sd } from "sd://runtime/api.js";
import { state, displayForWindow, activeSpaceOnDisplay, getCurrentSpace, log } from "./core.js";
import {
  getSnapshotSizeForWindow,
  updateLayout,
  adjustedFrameForDisplay
} from "./snapshots.js";
import { areaChanged } from "./layouts.js";
import { serialQueue } from "./sequencing.js";
import { tileWindows } from "./tiler.js";

const enqueue = serialQueue((job) => job());

// Capture the window into the persistable state map. Common helper used by
// both flows. Returns the snapshot data dict on success, null on failure.
async function captureCore(winId) {
  const w = state.windowsById[winId];
  if (!w) {
    log(`captureCore: no window ${winId}`);
    return null;
  }
  if (state.snapshotsState.snapshots[winId]) {
    log(`captureCore: ${winId} already snapshotted`);
    return null;
  }

  // Grab the bitmap via CGSHWCaptureWindowList. Works for hidden / minimized
  // windows so we can call this AFTER minimize too, but we run it BEFORE so
  // the image is freshest.
  let snap = null;
  try {
    snap = await sd.windows.snapshot(winId, { format: "jpeg", quality: 0.8 });
  } catch (e) {
    console.warn(`[WindowScape] snapshot ${winId} failed:`, e);
  }
  if (!snap || !snap.dataURL) {
    // Best-effort: tile still gets created without an image; the refresh
    // timer will fill it on the next pass.
    snap = null;
  }

  const d = displayForWindow(w);
  const displayID = d ? d.displayID : (state.displays[0] && state.displays[0].displayID);
  const frame = { ...w.frame };
  const snapSize = getSnapshotSizeForWindow(frame);

  // The Space (desktop) the window lived on at minimize time. A minimized
  // window is on its display's active Space by definition, so the active
  // Space of the window's display is the one the tile belongs to. snapshots.js
  // renders a tile only while this Space is active — without it the tile would
  // appear on every desktop, since the host panel is canJoinAllSpaces.
  const spaceID = (d && activeSpaceOnDisplay(d.uuid)) || getCurrentSpace();

  const data = {
    app:        w.app || "",
    bundleId:   w.bundleId || null,
    title:      w.title || "",
    frame,
    image:      snap ? snap.dataURL : null,
    displayID,
    spaceID,
    snapSize,
    capturedAt: Date.now()
  };
  state.snapshotsState.snapshots[winId] = data;
  state.snapshotsState.order.push(winId);
  return data;
}

// Grabs the snapshot, AX-minimizes, retiles.
export function captureAndMinimize(winId) {
  return enqueue(() => captureAndMinimizeNow(winId));
}

async function captureAndMinimizeNow(winId) {
  state.snapshotsState.isCreating = true;
  try {
    const data = await captureCore(winId);
    if (!data) return;

    // AX-minimize.
    try { await sd.windows.minimize(winId, true); } catch (e) {
      // If AX-minimize fails (system dialog, transient app, etc.), back out.
      console.warn(`[WindowScape] minimize ${winId} failed:`, e);
      delete state.snapshotsState.snapshots[winId];
      const idx = state.snapshotsState.order.indexOf(winId);
      if (idx >= 0) state.snapshotsState.order.splice(idx, 1);
      return;
    }

    // Render the new tile and reflow strips.
    updateLayout();
  } finally {
    state.snapshotsState.isCreating = false;
  }

  // Retile after a 200ms delay so the minimized bang (async) has marked
  // the window minimized first.
  setTimeout(() => tileWindows(), 200);
}

// Capture a window that JUST minimized via the OS (yellow dot click, Cmd+M,
// Dock right-click, etc.). The lifecycle bang `sd.window.minimized` fires
// after WindowServer finishes the genie; by then the window is no longer
// onscreen, so its frame/app/title come from windowsById (the window list
// keeps minimized windows). CGSHWCaptureWindowList still returns a clean bitmap of the minimized window's pre-genie contents.
//
// No second minimize call; no focus shift (the OS already shifted focus to
// whichever window inherited it). Just bitmap + tile + retile to reserve
// strip space.
export function captureForOSMinimize(winId) {
  return enqueue(() => captureForOSMinimizeNow(winId));
}

async function captureForOSMinimizeNow(winId) {
  if (state.snapshotsState.snapshots[winId]) return; // already tracked
  state.snapshotsState.isCreating = true;
  let data = null;
  try {
    data = await captureCore(winId);
    if (!data) return;
    updateLayout();
  } finally {
    state.snapshotsState.isCreating = false;
  }
  // The minimize bang already ran a tile pass (events.js). When the capture
  // finished before that pass measured its area, the pass laid the row out
  // around the new rail and a second pass would only restart the same
  // animations; retile only when the rail changed the area after it.
  setTimeout(() => {
    const d = state.displays.find((x) => x.displayID === data.displayID);
    const area = d && (adjustedFrameForDisplay(d) || d.visibleFrame);
    if (d && !areaChanged(state.lastTileAreaByDisplay[d.displayID], area)) {
      log(`SNAP-RETILE-SKIP d${d.displayID} — last pass already used the rail`);
      return;
    }
    tileWindows();
  }, 200);
}
