// Hotkey verb dispatch — port of keybinds.lua.
// Hotkeys are declared in stack.json; we hang named callbacks off the window
// global so the bridge can invoke them.

import { sd } from "sd://runtime/api.js";
import { cfg } from "./config.js";
import { state, saveList, updateWindowOrder, log } from "./core.js";
import {
  grow, shrink, cycleWidth, resetAllWeights, forceRetile,
  moveWindowInOrder, focusAdjacentWindow, moveWindowToAdjacentScreen
} from "./operations.js";
import { tileWindows } from "./tiler.js";
import { drawOutlineForFocused } from "./outline.js";

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
  drawOutlineForFocused();
}

// Simulated fullscreen — uses AX kAXFullScreen via sd.windows.fullscreen.
// (Custom hide-others fullscreen from the Lua is stubbed: we just toggle
// the real fullscreen attribute. FIXME: port simulated fullscreen overlays.)
let lastFullscreenId = null;
async function toggleFullscreen() {
  const f = sd.windows.focused.peek();
  if (!f || !f.id) return;
  if (lastFullscreenId === f.id) {
    await sd.windows.fullscreen(f.id, false);
    lastFullscreenId = null;
  } else {
    await sd.windows.fullscreen(f.id, true);
    lastFullscreenId = f.id;
  }
}

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
  window.onHotkey_toggleFullscreen = toggleFullscreen;
  window.onHotkey_forceRetile      = forceRetile;
  window.onHotkey_toggleDebug      = toggleDebug;
  window.onHotkey_focusNext        = () => focusAdjacentWindow("forward");
  window.onHotkey_focusPrev        = () => focusAdjacentWindow("backward");
}
