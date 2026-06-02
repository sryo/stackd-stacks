// Snapshot capture helpers — JS port of WindowScape/snapshot_create.lua.
//
// Two entry points:
//   captureAndMinimize(winId)    — grab snapshot, AX-minimize the window,
//                                  tile reabsorbs the space, tile renders.
//                                  Used by operations.minimizeFocused.
//   captureWithoutMinimize(winId)— grab snapshot, leave window in place.
//                                  Used by right-click eventtap.
//
// Zoom-in animation: lua used hs.canvas:frame timer interpolation from the
// window's original frame down to the strip slot. In JS, the tile element
// is created with `transform: scale(0.5); opacity: 0` and the .in class
// flips both to identity via a CSS transition (driven by snapshots.js's
// updateLayout). The CSS animation duration matches lua's
// ANIMATION_INTERVAL × ANIMATION_STEPS roughly.
//
// Ambient blur (snapshot_create.lua's appendElements blur layer): not
// directly portable to a CSS transform on a single tile. We approximate
// with a box-shadow + border that gives the tile a "frosted" presence.

import { sd } from "sd://runtime/api.js";
import { state, displayForWindow, log } from "./core.js";
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

  const data = {
    app:        w.app || "",
    bundleId:   w.bundleId || null,
    title:      w.title || "",
    frame,
    image:      snap ? snap.dataURL : null,
    displayID,
    snapSize,
    capturedAt: Date.now()
  };
  state.snapshotsState.snapshots[winId] = data;
  state.snapshotsState.order.push(winId);
  return data;
}

// Port of snapshot_create.lua createSnapshot (default path, no restoreData).
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

  // Retile after a short delay so the just-minimized window has time to
  // drop out of windowsById (lifecycle bang fires async). Lua used a
  // 200ms timer for the same race.
  setTimeout(async () => {
    const tiler = await getTiler();
    await tiler.tileWindows();
  }, 200);
}

// Port of snapshot_create.lua's right-click path (createSnapshot called
// without driving the minimize). Window stays in place; tile is added to
// the strip with the current snapshot.
export async function captureWithoutMinimize(winId) {
  if (state.snapshotsState.isCreating) return;
  state.snapshotsState.isCreating = true;
  state.snapshotsState.isCreatingStart = Date.now();
  try {
    const data = await captureCore(winId);
    if (!data) return;
    updateLayout();
    // Tiler may want to reserve strip space — kick a re-tile.
    setTimeout(async () => {
      const tiler = await getTiler();
      await tiler.tileWindows();
    }, 100);
  } finally {
    state.snapshotsState.isCreating = false;
  }
}
