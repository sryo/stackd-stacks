// Tiling engine — port of tiler.lua.
// Computes target frames via layouts.tileWeighted and applies them via
// sd.windows.setFrame(id, ...) — the new per-window-id primitive.

import { sd } from "sd://runtime/api.js";
import { cfg } from "./config.js";
import { state, updateWindowOrder, activeSpaceOnDisplay, log } from "./core.js";
import { tileWeighted } from "./layouts.js";
import { animatedSetFrame, cancelAllAnimations } from "./animation.js";
import { adjustedFrameForDisplay } from "./snapshots.js";

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

    // Per-pass eligibility — port of hs.window.visibleWindows() (window.lua:131
    // and isVisible() at window.lua:255: `not parentApp:isHidden() and not
    // self:isMinimized()`). Lua re-queries AX state every pass; mirror that.
    // All N×2 AX queries fire in parallel so the per-pass latency is one
    // AX round-trip (~100ms cap via AXUIElementSetMessagingTimeout in
    // Windows.swift:334), not N×100ms — important for tile passes that
    // run inside focus-change debounce.
    const candidates = [];
    for (const id of ordered) {
      const w = state.windowsById[id];
      if (!w) continue;
      const f = w.frame;
      if (!f) continue;
      const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
      const df = d.frame;
      if (cx < df.x || cx >= df.x + df.w || cy < df.y || cy >= df.y + df.h) continue;
      candidates.push(id);
    }
    const probes = await Promise.all(candidates.map(async (id) => ({
      id,
      live: await sd.windows.frame(id).catch(() => null),
      minimized: await sd.windows.isMinimized(id).catch(() => false)
    })));
    const screenWindows = [];
    for (const p of probes) {
      if (!p.live) continue;
      if (p.minimized) continue;
      screenWindows.push(p.id);
      state.windowLastScreen[p.id] = d.displayID;
    }
    if (screenWindows.length === 0) continue;

    const collapsed = getCollapsedWindows(screenWindows);
    const nonCollapsed = screenWindows.filter((id) => !collapsed.includes(id));

    // Honor snapshot-strip reservation: tiles must not draw under the bottom
    // strip on displays that host snapshotted tiles. adjustedFrameForDisplay
    // returns visibleFrame minus the strip height, or null when no snapshots
    // live on that display (fall back to plain visibleFrame).
    const screenFrame = adjustedFrameForDisplay(d) || { ...d.visibleFrame };
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
      // Direct AX setFrame, no SLSTransaction batch. The batch path
      // routes window-position writes through SLSTransactionSetWindowPosition
      // / SLSTransactionCommit, which is broken on macOS Tahoe (26+):
      // window SIZE lands correctly (AX, synchronous inside the batch)
      // but POSITION silently drops, leaving tiles half-positioned.
      // The non-batched setFrame in Windows.swift uses AX for both,
      // which works reliably across macOS versions.
      for (const t of targets) {
        // Remember the frame we just asked for so events.js's drag-handler
        // can identify tiler-echo bangs by exact frame match (vs the brittle
        // 700ms timer it used before, which suppressed legitimate user drags
        // that happened right after a focus-change retile).
        state.lastTileTarget[+t.winId] = { ...t.frame };
        await sd.windows.setFrame(t.winId, t.frame);
      }
    }
  }
}

let tilingTimer = null;
export async function tileWindows() {
  // Simulated-fullscreen guard — port of tiler.lua's check against
  // fullscreen.isFullscreenActive. Touching frames while one window owns
  // its display's full visibleFrame would shove the others back into view
  // and shrink the fullscreened one. The fullscreen module owns the frame
  // for this window until exit; tiler stays out.
  if (state.fullscreenState && state.fullscreenState.active) {
    log("skip tiling — simulated fullscreen active");
    return;
  }
  // Snapshot guard — captureAndMinimize parks the in-flight window and
  // drives its own retile after the AX-minimize settles. A tile pass
  // racing the capture would fight the off-screen sliver pose.
  if (state.snapshotsState && state.snapshotsState.isCreating) {
    log("skip tiling — snapshot in flight");
    return;
  }
  // Match lua tiler.lua line 133: cancel any in-flight animations before
  // kicking off a new tile pass so two rapid retiles don't fight each other.
  cancelAllAnimations();
  state.tilingCount = 1;
  try {
    await tileWindowsInternal();
  } catch (e) {
    const detail = JSON.stringify({
      message: e?.message,
      name: e?.name,
      str: String(e),
      stack: (e?.stack || "").split("\n").slice(0, 5).join(" | ")
    });
    console.warn("[WindowScape] tile error:", detail);
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
