// Tiling engine — port of tiler.lua.
// Computes target frames via layouts.tileWeighted and applies them via
// sd.windows.setFrame(id, ...) — the new per-window-id primitive.

import { sd } from "sd://runtime/api.js";
import { cfg } from "./config.js";
import { state, updateWindowOrder, activeSpaceOnDisplay, log } from "./core.js";
import { tileWeighted } from "./layouts.js";
import { animatedSetFrame, cancelAllAnimations } from "./animation.js";

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
    // Lua tiler.lua line 130: bail on fullscreen. Native fullscreen apps
    // get their own space and shouldn't be tiled — touching their frames
    // pops them out of fullscreen and is very disruptive. Detect via the
    // spaces channel's isFullscreen flag on this display's active space.
    const spaceInfo = state.spacesByDisplay[d.uuid];
    if (spaceInfo && spaceInfo.isFullscreen) {
      log(`skip tiling display ${d.displayID} — fullscreen space`);
      continue;
    }
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
    if (cfg.enableAnimations) {
      // Animation module ticks its own batch per frame; here we just
      // kick off all the per-window interpolations. animatedSetFrame is
      // fire-and-forget, returns immediately.
      for (const t of targets) {
        const cur = state.windowsById[t.winId]?.frame;
        animatedSetFrame(t.winId, cur, t.frame);
      }
    } else {
      // Original snap path — one SLSTransaction commits every origin
      // move on the same compositor flip.
      await sd.windows.batch(async () => {
        for (const t of targets) {
          await sd.windows.setFrame(t.winId, t.frame);
        }
      });
    }
  }
}

let tilingTimer = null;
export async function tileWindows() {
  // Snapshot/fullscreen guards stubbed out (those subsystems are deferred).
  // Match lua tiler.lua line 133: cancel any in-flight animations before
  // kicking off a new tile pass so two rapid retiles don't fight each other.
  cancelAllAnimations();
  state.tilingCount = 1;
  try {
    await tileWindowsInternal();
  } catch (e) {
    console.warn("[WindowScape] tile error:", e);
  }
  // Hold tilingCount past the animation duration so the events module's
  // tilingCount > 0 guard suppresses re-entrant tile triggered by the
  // intermediate setFrame events the animation loop emits.
  if (tilingTimer) clearTimeout(tilingTimer);
  const cooldown = cfg.enableAnimations
    ? (cfg.animationDuration * 1000 + 100)
    : 150;
  tilingTimer = setTimeout(() => { state.tilingCount = 0; tilingTimer = null; }, cooldown);
}
