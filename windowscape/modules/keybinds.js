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
  sd.bang('overlay-border.inclusion', {
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

// Bind all verbs as window.onHotkey_<name>(). The hotkey bridge looks these up.
export function bind() {
  window.onHotkey_toggleExcluded   = toggleFocusedWindowInList;
  window.onHotkey_movePrev         = () => moveWindowInOrder("backward");
  window.onHotkey_moveNext         = () => moveWindowInOrder("forward");
  window.onHotkey_moveScreenPrev   = () => moveWindowToAdjacentScreen("previous");
  window.onHotkey_moveScreenNext   = () => moveWindowToAdjacentScreen("next");
  window.onHotkey_resetWeights     = resetAllWeights;
  window.onHotkey_grow             = grow;
  window.onHotkey_shrink           = shrink;
  window.onHotkey_cycleWidth       = cycleWidth;
  window.onHotkey_toggleFullscreen = toggleSimulatedFullscreen;
  window.onHotkey_forceRetile      = forceRetile;
  window.onHotkey_toggleDebug      = toggleDebug;
  window.onHotkey_focusNext        = () => focusAdjacentWindow("forward");
  window.onHotkey_focusPrev        = () => focusAdjacentWindow("backward");
  window.onHotkey_minimize         = minimizeFocused;
  // Snapshot bulk verbs — port of snapshots.lua's context-menu Restore All /
  // Close All / Clear All. Each operates on every tile in the strip.
  window.onHotkey_snapshotsRestoreAll = snapshotsRestoreAll;
  window.onHotkey_snapshotsCloseAll   = snapshotsCloseAll;
  window.onHotkey_snapshotsClearAll   = snapshotsClearAll;
}
