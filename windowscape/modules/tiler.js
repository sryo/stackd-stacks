// Tiling engine — port of tiler.lua.
// Computes target frames via layouts.tileWeighted and applies them via
// sd.windows.setFrame(id, ...) — the new per-window-id primitive.

import { sd } from "sd://runtime/api.js";
import { cfg } from "./config.js";
import { state, updateWindowOrder, activeSpaceOnDisplay, log } from "./core.js";
import { tileWeighted } from "./layouts.js";

export function getWindowWeight(winId) {
  return state.windowWeights[winId] ?? 1.0;
}

export function setWindowWeight(winId, weight) {
  if (!winId) return;
  const clamped = Math.max(0.1, weight);
  if (state.windowWeights[winId] === clamped) return;
  state.windowWeights[winId] = clamped;
  if (state.onLayoutChange) state.onLayoutChange();
}

export function getCollapsedWindows(winIds) {
  return winIds.filter((id) => {
    const w = state.windowsById[id];
    return w && w.frame && w.frame.h <= cfg.collapsedWindowHeight;
  });
}

export function pruneStaleWeights() {
  const live = new Set(Object.keys(state.windowsById).map(Number));
  for (const k of Object.keys(state.windowWeights)) {
    if (!live.has(+k)) delete state.windowWeights[k];
  }
  for (let i = state.focusHistory.length - 1; i >= 0; i--) {
    if (!live.has(state.focusHistory[i])) state.focusHistory.splice(i, 1);
  }
  for (const k of Object.keys(state.windowLastScreen)) {
    if (!live.has(+k)) delete state.windowLastScreen[k];
  }
}

async function tileWindowsInternal() {
  updateWindowOrder();
  for (const d of state.displays) {
    const space = activeSpaceOnDisplay(d.uuid);
    if (space == null) continue;
    const ordered = state.windowOrderBySpace[space] || [];

    const screenWindows = [];
    for (const id of ordered) {
      const w = state.windowsById[id];
      if (!w) continue;
      // Verify still on this display.
      const f = w.frame;
      if (!f) continue;
      const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
      const df = d.frame;
      if (cx < df.x || cx >= df.x + df.w || cy < df.y || cy >= df.y + df.h) continue;
      screenWindows.push(id);
      state.windowLastScreen[id] = d.displayID;
    }
    if (screenWindows.length === 0) continue;

    const collapsed = getCollapsedWindows(screenWindows);
    const nonCollapsed = screenWindows.filter((id) => !collapsed.includes(id));

    const screenFrame = { ...d.visibleFrame };
    const horizontal = screenFrame.w > screenFrame.h;
    const targets = tileWeighted(screenFrame, nonCollapsed, collapsed, horizontal, getWindowWeight);

    log(`tile ${screenWindows.length} on display ${d.displayID} (${horizontal ? "H" : "V"})`);
    // Commit all setFrame calls atomically. The daemon-side batch coalesces
    // origin moves onto a single compositor flip, removing the per-window
    // cascade that previously made tiles snap one-by-one. Sizes still go
    // through AX per-window (no SLS size symbol), so a brief size cascade
    // can still show, but origins land together.
    await sd.windows.batch(async () => {
      for (const t of targets) {
        await sd.windows.setFrame(t.winId, t.frame);
      }
    });
  }
}

let tilingTimer = null;
export async function tileWindows() {
  // Snapshot/fullscreen guards stubbed out (those subsystems are deferred).
  state.tilingCount = 1;
  try {
    await tileWindowsInternal();
  } catch (e) {
    console.warn("[WindowScape] tile error:", e);
  }
  if (tilingTimer) clearTimeout(tilingTimer);
  tilingTimer = setTimeout(() => { state.tilingCount = 0; tilingTimer = null; }, 150);
}
