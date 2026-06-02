// Window movement + focus + weight verbs — port of operations.lua.
// Each verb is invoked from a keybind; the focused-window resolution comes
// from sd.windows.focused (which now carries .id thanks to the new SPI).

import { sd } from "sd://runtime/api.js";
import { cfg } from "./config.js";
import {
  state, displayForWindow, activeSpaceOnDisplay, getCurrentSpace, log, warn
} from "./core.js";
import { tileWindows, getWindowWeight, setWindowWeight } from "./tiler.js";

function focusedWinId() {
  const f = sd.windows.focused.peek();
  return f && f.id;
}

function focusedWin() {
  const id = focusedWinId();
  return id ? state.windowsById[id] : null;
}

// Adjust focused-window weight by delta. Clamps to widthMin/widthMax.
function adjustFocusedWidth(delta) {
  const w = focusedWin();
  if (!w) return;
  const current = getWindowWeight(w.id);
  const target = Math.max(cfg.widthMin, Math.min(cfg.widthMax, current + delta));
  setWindowWeight(w.id, target);
  tileWindows();
  log(`width ${delta >= 0 ? "grew" : "shrank"} to ${target.toFixed(2)}`);
}

export function grow()   { adjustFocusedWidth(cfg.widthStep); }
export function shrink() { adjustFocusedWidth(-cfg.widthStep); }

export function cycleWidth() {
  const w = focusedWin();
  if (!w) return;
  setWindowWeight(w.id, cfg.widthDefault);
  tileWindows();
}

export function resetAllWeights() {
  state.windowWeights = Object.create(null);
  tileWindows();
}

export function forceRetile() {
  state.tilingCount = 0;
  tileWindows();
}

// Swap focused window with its neighbor in tiling order. Direction-aware:
// landscape "forward" = right neighbor, portrait "forward" = down neighbor.
export function moveWindowInOrder(direction) {
  const w = focusedWin();
  if (!w) return;
  const d = displayForWindow(w);
  if (!d) return;
  const space = activeSpaceOnDisplay(d.uuid) ?? getCurrentSpace();
  if (space == null) return;
  const order = state.windowOrderBySpace[space] || [];
  const horizontal = d.frame.w > d.frame.h;

  // Filter to non-collapsed windows on this display, sorted by position.
  const sorted = order
    .map((id) => state.windowsById[id])
    .filter((win) => win && win.frame && win.frame.h > cfg.collapsedWindowHeight)
    .filter((win) => {
      const wd = displayForWindow(win);
      return wd && wd.displayID === d.displayID;
    });
  sorted.sort((a, b) => horizontal
    ? (a.frame.x + a.frame.w / 2) - (b.frame.x + b.frame.w / 2)
    : (a.frame.y + a.frame.h / 2) - (b.frame.y + b.frame.h / 2));

  const idx = sorted.findIndex((win) => win.id === w.id);
  if (idx === -1 || sorted.length < 2) return;
  const target = direction === "forward" ? idx + 1 : idx - 1;
  if (target < 0 || target >= sorted.length) return;

  [sorted[idx], sorted[target]] = [sorted[target], sorted[idx]];

  // Splice the new sorted order back into the full per-space order list,
  // keeping off-display + collapsed entries in place. Same as operations.lua.
  const newOrder = [];
  let sIdx = 0;
  for (const id of order) {
    const win = state.windowsById[id];
    if (!win) continue;
    const wd = displayForWindow(win);
    const onDisp = wd && wd.displayID === d.displayID;
    const nonCollapsed = win.frame && win.frame.h > cfg.collapsedWindowHeight;
    if (onDisp && nonCollapsed) {
      newOrder.push(sorted[sIdx++].id);
    } else {
      newOrder.push(id);
    }
  }
  state.windowOrderBySpace[space] = newOrder;
  tileWindows();
  // Keep focus on the same window — its slot moved.
  sd.windows.focus(w.id);
}

// Focus next/previous window in tiling order on the current display.
export function focusAdjacentWindow(direction) {
  const w = focusedWin();
  const d = w ? displayForWindow(w) : null;
  const space = d ? activeSpaceOnDisplay(d.uuid) : getCurrentSpace();
  if (space == null) return;
  const order = state.windowOrderBySpace[space] || [];

  const onScreen = order.filter((id) => {
    const win = state.windowsById[id];
    if (!win || !win.frame) return false;
    if (win.frame.h <= cfg.collapsedWindowHeight) return false;
    if (!d) return true;
    const wd = displayForWindow(win);
    return wd && wd.displayID === d.displayID;
  });
  if (onScreen.length === 0) return;

  const idx = w ? onScreen.indexOf(w.id) : -1;
  const target = direction === "forward" || direction === "next" ? idx + 1 : idx - 1;
  if (target < 0 || target >= onScreen.length) return;
  sd.windows.focus(onScreen[target]);
}

// Move focused window to the previous/next display, preserving relative frame.
export async function moveWindowToAdjacentScreen(direction) {
  const w = focusedWin();
  if (!w) return warn("no focused window for moveScreen");
  const d = displayForWindow(w);
  if (!d) return warn("no display for focused window");
  if (state.displays.length < 2) return warn("only one display, cannot move");

  const idx = state.displays.findIndex((s) => s.displayID === d.displayID);
  if (idx < 0) return;
  const targetIdx = direction === "next"
    ? (idx + 1) % state.displays.length
    : (idx - 1 + state.displays.length) % state.displays.length;
  const target = state.displays[targetIdx];

  const relX = (w.frame.x - d.frame.x) / d.frame.w;
  const relY = (w.frame.y - d.frame.y) / d.frame.h;
  const relW = w.frame.w / d.frame.w;
  const relH = w.frame.h / d.frame.h;

  await sd.windows.setFrame(w.id, {
    x: target.frame.x + relX * target.frame.w,
    y: target.frame.y + relY * target.frame.h,
    w: relW * target.frame.w,
    h: relH * target.frame.h
  });
  setTimeout(() => { tileWindows(); sd.windows.focus(w.id); }, 150);
}
