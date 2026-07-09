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
// Zoom-in animation: the tile element is created with `transform:
// scale(0.5); opacity: 0` and the .in class flips both to identity via a
// CSS transition (driven by snapshots.js's updateLayout). The CSS
// animation duration roughly matches the original ANIMATION_INTERVAL ×
// ANIMATION_STEPS.
//
// Ambient blur: not directly portable to a CSS transform on a single
// tile. We approximate with a box-shadow + border that gives the tile a
// "frosted" presence.

import { sd } from "sd://runtime/api.js";
import { state, displayForWindow, activeSpaceOnDisplay, getCurrentSpace, log } from "./core.js";
import {
  getSnapshotSizeForWindow,
  updateLayout
} from "./snapshots.js";

// Lazy-import tiler so we don't create an eval-time cycle (snapshots.js ←→
// tiler.js via reserved-frame adjustment).
async function getTiler() {
  return await import("./tiler.js");
}

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

// Default capture path (no restoreData).
// Grabs the snapshot, AX-minimizes, retiles. The CSS-driven zoom-in is
// applied by snapshots.js updateLayout (tile is created with scale(0.5);
// .in flips it to scale(1) via transition).
export async function captureAndMinimize(winId) {
  if (state.snapshotsState.isCreating) return;
  state.snapshotsState.isCreating = true;
  state.snapshotsState.isCreatingStart = Date.now();
  try {
    const data = await captureCore(winId);
    if (!data) return;

    // AX-minimize. The window's frame collapses; lifecycle tick will drop
    // it from windowsById on the next windowsAll push.
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

  // Retile after a 200ms delay so the just-minimized window has time to
  // drop out of windowsById (lifecycle bang fires async).
  setTimeout(async () => {
    const tiler = await getTiler();
    await tiler.tileWindows();
  }, 200);
}

// Capture a window that JUST minimized via the OS (yellow dot click, Cmd+M,
// Dock right-click, etc.). The lifecycle bang `sd.window.minimized` fires
// after WindowServer finishes the genie; by then the window is no longer
// onscreen, so we read its last-known frame/app/title from windowsById
// before the next windowsAll push evicts it. CGSHWCaptureWindowList still
// returns a clean bitmap of the minimized window's pre-genie contents.
//
// No second minimize call; no focus shift (the OS already shifted focus to
// whichever window inherited it). Just bitmap + tile + retile to reserve
// strip space.
export async function captureForOSMinimize(winId) {
  if (state.snapshotsState.isCreating) return;
  if (state.snapshotsState.snapshots[winId]) return; // already tracked
  state.snapshotsState.isCreating = true;
  state.snapshotsState.isCreatingStart = Date.now();
  try {
    const data = await captureCore(winId);
    if (!data) return;
    updateLayout();
  } finally {
    state.snapshotsState.isCreating = false;
  }
  setTimeout(async () => {
    const tiler = await getTiler();
    await tiler.tileWindows();
  }, 200);
}
