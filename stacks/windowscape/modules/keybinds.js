// Hotkey verb dispatch — port of keybinds.lua.
// Hotkeys are declared in stack.json; we hang named callbacks off the window
// global so the bridge can invoke them.

import { sd } from "sd://runtime/api.js";
import { cfg } from "./config.js";
import { state, saveList, updateWindowOrder, isAppIncluded, log } from "./core.js";
import {
  grow, shrink, cycleWidth, resetAllWeights, forceRetile,
  moveWindowInOrder, focusAdjacentWindow, moveWindowToAdjacentScreen,
  minimizeFocused
} from "./operations.js";
import { tileWindows } from "./tiler.js";
import { toggleSimulatedFullscreen } from "./fullscreen.js";
import {
  clearAll as snapshotsClearAll,
  restoreAll as snapshotsRestoreAll,
  closeAll as snapshotsCloseAll
} from "./snapshots.js";

async function toggleFocusedWindowInList() {
  const f = sd.windows.focused.peek();
  if (!f) return;
  const bundleId = f.bundleId;
  const name = f.app;
  const listed = (bundleId && state.listedApps[bundleId]) ||
                 (name && state.listedApps[name]);
  if (listed) {
    if (bundleId) delete state.listedApps[bundleId];
    if (name) delete state.listedApps[name];
  } else {
    if (bundleId) state.listedApps[bundleId] = true;
    else if (name) state.listedApps[name] = true;
  }
  await saveList();
  updateWindowOrder();
  await tileWindows();
  // Toggling exclusion flips the inclusion verdict for the focused window;
  // push the new verdict so overlay-border re-skins immediately. Use
  // isAppIncluded against the freshly-mutated state.listedApps rather than
  // inverting the local `listed` variable — the inverse depends on
  // cfg.exclusionMode and isAppIncluded already encapsulates that.
  sd.bang.declare('overlay-border.inclusion').emit({
    winId: f.id,
    included: isAppIncluded(state.windowsById[f.id] || f)
  });
}

// Simulated fullscreen — expands the focused window to its display's
// visibleFrame and parks the other tiles off-screen. Distinct from native
// kAXFullScreen (which moves the window to its own Space). The implementation
// lives in modules/fullscreen.js and is toggled by the same hotkey.

function toggleDebug() {
  cfg.debugLogging = !cfg.debugLogging;
  console.log("[WindowScape] debug:", cfg.debugLogging ? "ON" : "OFF");
}

// Bind all verbs through sd.hotkey.on. The daemon dispatches via the same
// onHotkey_<name> slot the per-kind sugar installs into, so manifest hotkey
// callbacks resolve identically — but we avoid global mutation and gain
// disposers (unused here; stack-lifetime cleanup is automatic via reload).
export function bind() {
  sd.hotkey.on("toggleExcluded",   toggleFocusedWindowInList);
  sd.hotkey.on("movePrev",         () => moveWindowInOrder("backward"));
  sd.hotkey.on("moveNext",         () => moveWindowInOrder("forward"));
  sd.hotkey.on("moveScreenPrev",   () => moveWindowToAdjacentScreen("previous"));
  sd.hotkey.on("moveScreenNext",   () => moveWindowToAdjacentScreen("next"));
  sd.hotkey.on("resetWeights",     resetAllWeights);
  sd.hotkey.on("grow",             grow);
  sd.hotkey.on("shrink",           shrink);
  sd.hotkey.on("cycleWidth",       cycleWidth);
  sd.hotkey.on("toggleFullscreen", toggleSimulatedFullscreen);
  sd.hotkey.on("forceRetile",      forceRetile);
  sd.hotkey.on("toggleDebug",      toggleDebug);
  sd.hotkey.on("focusNext",        () => focusAdjacentWindow("forward"));
  sd.hotkey.on("focusPrev",        () => focusAdjacentWindow("backward"));
  sd.hotkey.on("minimize",         minimizeFocused);
  // Snapshot bulk verbs — port of snapshots.lua's context-menu Restore All /
  // Close All / Clear All. Each operates on every tile in the strip.
  sd.hotkey.on("snapshotsRestoreAll", snapshotsRestoreAll);
  sd.hotkey.on("snapshotsCloseAll",   snapshotsCloseAll);
  sd.hotkey.on("snapshotsClearAll",   snapshotsClearAll);
}
