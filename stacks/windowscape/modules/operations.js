// Window movement + focus + weight verbs — port of operations.lua.
// Each verb is invoked from a keybind; the focused-window resolution comes
// from sd.windows.focused (which now carries .id thanks to the new SPI).

import { sd } from "sd://runtime/api.js";
import { cfg } from "./config.js";
import {
  state, displayForWindow, activeSpaceOnDisplay, getCurrentSpace, log, warn
} from "./core.js";
import { tileWindows } from "./tiler.js";
import { crossDisplayDrop } from "./events.js";
import { captureAndMinimize } from "./snapshots.js";

function focusedWinId() {
  const f = sd.windows.focused.peek();
  return f && f.id;
}

function focusedWin() {
  const id = focusedWinId();
  return id ? state.windowsById[id] : null;
}

// Adjust focused tile's pin by ±deltaPx along its display's major axis.
// If the tile isn't pinned yet, the new pin is computed from its current
// live size + delta. grow/shrink always end with the tile pinned — the
// principle is "user touched this tile's size, lock it." cycleWidth
// removes the pin and resets to flex.
const GROW_STEP_PX = 100;
const PIN_MIN_PX   = 100;
export function adjustFocusedPin(deltaPx) {
  const w = focusedWin();
  if (!w || !w.frame) return;
  const d = w && state.displays.find((s) => {
    const f = s.frame;
    const cx = w.frame.x + w.frame.w / 2, cy = w.frame.y + w.frame.h / 2;
    return cx >= f.x && cx < f.x + f.w && cy >= f.y && cy < f.y + f.h;
  });
  const horizontal = d ? d.frame.w > d.frame.h : true;
  const baseSize = state.pinnedSizes[w.id] ?? (horizontal ? w.frame.w : w.frame.h);
  const newSize = Math.max(PIN_MIN_PX, Math.floor(baseSize + deltaPx));
  state.pinnedSizes[w.id] = newSize;
  if (state.onLayoutChange) state.onLayoutChange();
  tileWindows();
  log(`pin ${deltaPx >= 0 ? "grew" : "shrank"} to ${newSize}px (${horizontal ? "w" : "h"})`);
}

export function grow()   { adjustFocusedPin(GROW_STEP_PX); }
export function shrink() { adjustFocusedPin(-GROW_STEP_PX); }

// Clear the focused tile's pin AND weight — it rejoins the flex pool with
// the default weight. "Cycle" name preserved from the Lua original; the
// effect now is "reset this tile to default flex behavior."
export function cycleWidth() {
  const w = focusedWin();
  if (!w) return;
  delete state.pinnedSizes[w.id];
  delete state.windowWeights[w.id];
  if (state.onLayoutChange) state.onLayoutChange();
  tileWindows();
}

export function resetAllWeights() {
  state.windowWeights = Object.create(null);
  state.pinnedSizes = Object.create(null);
  state.refusalPins = new Set();
  state.appMins = Object.create(null);   // escape hatch: forget learned app mins
  if (state.onLayoutChange) state.onLayoutChange();
  tileWindows();
}

export function forceRetile() {
  state.tilingCount = 0;
  tileWindows();
}

// Minimize the focused window, shifting focus to a sibling first so the
// user doesn't end up with focus on the dock or nothing. Routes through
// the snapshot subsystem — captureAndMinimize grabs the window image,
// AX-minimizes, and the strip's CSS-driven zoom-in animation renders.
//
// Sibling selection mirrors the lua: prefer the most recent entry in
// focusHistory whose window is still alive AND not the one being
// minimized AND not minimized itself; fall back to the next non-collapsed
// window in windowOrderBySpace on the same display.
export async function minimizeFocused() {
  const w = focusedWin();
  if (!w) return;
  const movedId = w.id;
  const d = displayForWindow(w);
  const space = d ? activeSpaceOnDisplay(d.uuid) : getCurrentSpace();
  const order = (space != null && state.windowOrderBySpace[space]) || [];

  const isLive = (id) => {
    if (id === movedId) return false;
    const win = state.windowsById[id];
    if (!win || !win.frame) return false;
    if (win.frame.h <= cfg.collapsedWindowHeight) return false;
    if (!d) return true;
    const wd = displayForWindow(win);
    return wd && wd.displayID === d.displayID;
  };

  let sibling = null;
  for (const id of state.focusHistory) {
    if (isLive(id)) { sibling = id; break; }
  }
  if (sibling == null) {
    for (const id of order) if (isLive(id)) { sibling = id; break; }
  }

  // Snapshot + AX-minimize first, then focus the sibling — focusing
  // before minimize causes the system to immediately re-focus the
  // about-to-minimize window on the minimize call, which defeats the
  // point. captureAndMinimize handles the snapshot grab and renders the
  // tile into the strip.
  await captureAndMinimize(movedId);
  if (sibling != null) sd.windows.focus(sibling);
  // Layout will re-flow on the next windowsAll tick (the minimized
  // window drops out of windowsById since its frame collapses to 0×0
  // off-screen).
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
  // Scoped to the tiler's last-tiled set (same tiledSet pattern as the
  // mouse-drag reorder in events.js): the raw order can carry windows the
  // tiler currently skips — hidden/offscreen entries with stale frames.
  // Without this, a reorder step can swap the focused window with an
  // INVISIBLE neighbor: the list changes, the screen doesn't, and the
  // gesture/hotkey feels dead.
  const tiled = state.lastTiledByDisplay[d.displayID];
  const tiledSet = tiled && tiled.length ? new Set(tiled.map((id) => +id)) : null;
  const sorted = order
    .map((id) => state.windowsById[id])
    .filter((win) => win && win.frame && win.frame.h > cfg.collapsedWindowHeight)
    .filter((win) => !tiledSet || tiledSet.has(+win.id))
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
  // keeping off-display + collapsed + non-tiled entries in place. Same as
  // operations.lua. Slot conditions MUST mirror the `sorted` filters above,
  // or sIdx runs past the end of sorted.
  const newOrder = [];
  let sIdx = 0;
  for (const id of order) {
    const win = state.windowsById[id];
    if (!win) continue;
    const wd = displayForWindow(win);
    const onDisp = wd && wd.displayID === d.displayID;
    const nonCollapsed = win.frame && win.frame.h > cfg.collapsedWindowHeight;
    const inTiledSet = !tiledSet || tiledSet.has(+id);
    if (onDisp && nonCollapsed && inTiledSet) {
      newOrder.push(sorted[sIdx++].id);
    } else {
      newOrder.push(id);
    }
  }
  state.windowOrderBySpace[space] = newOrder;

  // Capture the BEFORE frame and the mouse position so we can drag the
  // cursor along with the window — port-of operations.lua moveMouseWithWindow.
  // Without this the mouse stays in place while the window slides out from
  // under it, which is disorienting during keyboard-driven reorders.
  const oldFrame = { ...w.frame };
  const mousePos = sd.mouse.peek();
  const mouseWasInside = mousePos &&
    mousePos.x >= oldFrame.x && mousePos.x <= oldFrame.x + oldFrame.w &&
    mousePos.y >= oldFrame.y && mousePos.y <= oldFrame.y + oldFrame.h;

  tileWindows();
  sd.windows.focus(w.id);

  if (mouseWasInside) {
    // tileWindows runs the AX setFrame batch synchronously inside sd.windows.batch,
    // but the new frame snapshot lands on the next windowsAll tick. Re-read
    // the moved window's frame after a short delay and translate the mouse.
    setTimeout(() => {
      const updated = state.windowsById[w.id];
      if (!updated || !updated.frame) return;
      const nf = updated.frame;
      const newX = nf.x + (mousePos.x - oldFrame.x);
      const newY = nf.y + (mousePos.y - oldFrame.y);
      sd.mouse.warp(newX, newY);
    }, 50);
  }
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
  const targetId = onScreen[target];
  sd.windows.focus(targetId);
  // Center the mouse on the newly focused window — port-of operations.lua
  // line 170-173. Without this, focus jumps but the cursor stays behind,
  // which makes keyboard-driven focus cycling feel disconnected.
  const targetWin = state.windowsById[targetId];
  if (targetWin && targetWin.frame) {
    const f = targetWin.frame;
    sd.mouse.warp(f.x + f.w / 2, f.y + f.h / 2);
  }
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

  // Same mouse-follow-window pattern as moveWindowInOrder, port-of
  // operations.lua line 247 moveMouseWithWindow(oldFrame, finalFrame).
  const oldFrame = { ...w.frame };
  const mousePos = sd.mouse.peek();
  const mouseWasInside = mousePos &&
    mousePos.x >= oldFrame.x && mousePos.x <= oldFrame.x + oldFrame.w &&
    mousePos.y >= oldFrame.y && mousePos.y <= oldFrame.y + oldFrame.h;

  const newFrame = {
    x: target.frame.x + relX * target.frame.w,
    y: target.frame.y + relY * target.frame.h,
    w: relW * target.frame.w,
    h: relH * target.frame.h
  };
  await sd.windows.setFrame(w.id, newFrame);
  // Eager hydration — the moved bang can trail the setFrame, and the
  // cross-display bookkeeping below derives the destination from the frame.
  if (state.windowsById[w.id]) state.windowsById[w.id].frame = { ...newFrame };
  // Same bookkeeping as a cross-display drag-drop: space-cache refresh,
  // order migration between spaces, pin drop, both displays reflow.
  await crossDisplayDrop(w.id, d.displayID, target);
  setTimeout(() => {
    sd.windows.focus(w.id);
    if (mouseWasInside) {
      const updated = state.windowsById[w.id];
      if (!updated || !updated.frame) return;
      const nf = updated.frame;
      sd.mouse.warp(
        nf.x + (mousePos.x - oldFrame.x),
        nf.y + (mousePos.y - oldFrame.y)
      );
    }
  }, 150);
}
