// Tiling engine — port of tiler.lua.
// Computes target frames via layouts.tileWeighted and applies them via
// sd.windows.setFrame(id, ...) — the new per-window-id primitive.

import { sd } from "sd://runtime/api.js";
import { cfg } from "./config.js";
import { state, updateWindowOrder, activeSpaceOnDisplay, log, evt } from "./core.js";
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
    const AX_MISS_TOLERANCE = 2; // drop only after N+1 consecutive misses
    for (const p of probes) {
      if (p.live) {
        // Probe succeeded → reset miss counter.
        state.axMissCount[p.id] = 0;
      } else {
        // Probe failed → bump miss counter. Tolerate a brief AX flicker
        // (the 100ms messaging timeout drops under load — spotlight
        // indexing, brightness poll racing the tile pass).
        const n = (state.axMissCount[p.id] || 0) + 1;
        state.axMissCount[p.id] = n;
        if (n > AX_MISS_TOLERANCE) continue;
        // Otherwise keep the id in the rotation using the cached frame.
      }
      if (p.minimized) continue;
      screenWindows.push(p.id);
      state.windowLastScreen[p.id] = d.displayID;
    }
    if (screenWindows.length === 0) continue;

    // Publish the per-display tile membership so applyResizeIfNeeded /
    // reorderOnDrop in events.js can compute the same totalWeight the
    // tiler used. Without this, those handlers iterate the unfiltered
    // windowOrderBySpace (which can include phantom or unaddressable
    // windows the tiler skipped), totalWeight diverges, and the
    // expected-vs-actual math fires false "user resized!" transitions.
    state.lastTiledByDisplay[d.displayID] = [...screenWindows];

    // Event log: membership diff vs previous tile pass on this display.
    // Fires only on transitions so log volume is tied to real changes,
    // not tile-pass rate. Includes WHY a tile pass fired (state.tileReason)
    // so we can correlate "what user action caused this retile".
    const prev = state.prevTileMembership[d.displayID] || new Set();
    const curSet = new Set(screenWindows);
    const added = [...curSet].filter(id => !prev.has(id));
    const removed = [...prev].filter(id => !curSet.has(id));
    if (added.length || removed.length) {
      const reason = state.tileReason || "?";
      for (const id of added) {
        const a = state.windowsById[id]?.app || "?";
        evt(`TILE-IN  d${d.displayID} ${id} (${a.slice(0,18)})  via=${reason}`);
      }
      for (const id of removed) {
        const a = state.windowsById[id]?.app || "?";
        // Reason: figure out why it's gone now.
        let why = "gone";
        if (state.minimizedIds.has(+id)) why = "minimized";
        else if (state.fixedSizeIds.has(+id) && !state.windowsById[id]) why = "fixed-size+gone";
        else if (!state.windowsById[id]) why = "no-windowsById";
        else why = "unaddressable";
        evt(`TILE-OUT d${d.displayID} ${id} (${a.slice(0,18)})  why=${why}  via=${reason}`);
      }
    }
    state.prevTileMembership[d.displayID] = curSet;

    const collapsed = getCollapsedWindows(screenWindows);
    const nonCollapsed = screenWindows.filter((id) => !collapsed.includes(id));

    // Honor snapshot-strip reservation: tiles must not draw under the bottom
    // strip on displays that host snapshotted tiles. adjustedFrameForDisplay
    // returns visibleFrame minus the strip height, or null when no snapshots
    // live on that display (fall back to plain visibleFrame).
    const screenFrame = adjustedFrameForDisplay(d) || { ...d.visibleFrame };
    const horizontal = screenFrame.w > screenFrame.h;

    // Inline user-resize detection. Tile passes fire faster than the
    // TahoeSynthPoll's 250ms tick — by the time the synth poll emits a
    // .moved bang for a user-driven resize, a tile pass has often already
    // snapped the window back to the old target. The drag-handler debounce
    // (300ms) then catches an echo of the snap-back, not the user's intent.
    //
    // Side-step it: at the start of each tile pass, compare each window's
    // LIVE AX frame to lastTileTarget. If they diverge significantly AND
    // the last setFrame was recent (< 5s), assume the user moved it and
    // transfer weight to/from the adjacent tile so the next tile pass
    // honors the new size. Skipping this would mean every tile pass
    // overwrites the user's drag-in-progress.
    let weightsAdjusted = false;
    if (nonCollapsed.length >= 2) {
      const liveById = Object.create(null);
      for (const p of probes) {
        if (p.live) liveById[p.id] = p.live;
      }
      let totalW = 0;
      for (const id of nonCollapsed) totalW += getWindowWeight(id);
      const axisAvail = horizontal ? screenFrame.w : screenFrame.h;
      for (let i = 0; i < nonCollapsed.length; i++) {
        const id = nonCollapsed[i];
        const live = liveById[id];
        const lastTgt = state.lastTileTarget[+id];
        if (!live || !lastTgt || !lastTgt.frame) continue;
        if ((Date.now() - lastTgt.ts) > 5000) continue;
        const liveSize = horizontal ? live.w : live.h;
        const tgtSize  = horizontal ? lastTgt.frame.w : lastTgt.frame.h;
        const delta = liveSize - tgtSize;
        if (Math.abs(delta) < 20) continue;
        // User resized this window. Adjacent tile must give up / absorb
        // the delta. Pick neighbor by which edge moved: if the live x/y
        // shifted, the LEFT/UP neighbor changed; otherwise the RIGHT/DOWN.
        const livePos = horizontal ? live.x : live.y;
        const tgtPos  = horizontal ? lastTgt.frame.x : lastTgt.frame.y;
        const posMoved = Math.abs(livePos - tgtPos) > 10;
        const neighbor = posMoved ? nonCollapsed[i - 1] : nonCollapsed[i + 1];
        if (neighbor == null) continue;
        const myW   = getWindowWeight(id);
        const adjW  = getWindowWeight(neighbor);
        const newMyW = Math.max(0.2, Math.min((liveSize / axisAvail) * totalW, myW + adjW - 0.2));
        const newAdjW = Math.max(0.2, myW + adjW - newMyW);
        setWindowWeight(id, newMyW);
        setWindowWeight(neighbor, newAdjW);
        log(`USER-RESIZE-INLINE id=${id} ${myW.toFixed(2)}→${newMyW.toFixed(2)} adj=${neighbor} ${adjW.toFixed(2)}→${newAdjW.toFixed(2)} delta=${Math.round(delta)}`);
        weightsAdjusted = true;
      }
    }
    const targets = tileWeighted(screenFrame, nonCollapsed, collapsed, horizontal, getWindowWeight);

    log(`TILE n=${screenWindows.length} display=${d.displayID} ${horizontal ? "H" : "V"} weights=${JSON.stringify(screenWindows.map(id => +(state.windowWeights[id] ?? 1).toFixed(2)))} targets=${JSON.stringify(targets.map(t => ({id: t.winId, app: state.windowsById[t.winId]?.app?.slice(0,10), x: t.frame.x, w: t.frame.w})))}`);
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
      const now = Date.now();
      for (const t of targets) {
        // No-op skip: query live AX frame; if it already matches the
        // target (within 5px of app rounding), skip the setFrame call.
        // Cuts redundant setFrame round-trips that periodic display/
        // spaces/windowsAll pushes generate when nothing changed. "User
        // is dragging" is handled separately by state.dragInFlight (see
        // events.js handleDragEnd) — never skip setFrame as a proxy for
        // that, because a weight-transfer retile produces a NEW target
        // that intentionally differs from the user's drag-end frame.
        const live = await sd.windows.frame(t.winId).catch(() => null);
        if (live &&
            Math.abs(live.x - t.frame.x) <= 5 && Math.abs(live.y - t.frame.y) <= 5 &&
            Math.abs(live.w - t.frame.w) <= 5 && Math.abs(live.h - t.frame.h) <= 5) {
          continue;
        }
        state.lastTileTarget[+t.winId] = { frame: { ...t.frame }, ts: now };
        await sd.windows.setFrame(t.winId, t.frame);
        // Fixed-size detection: if the live frame post-setFrame still differs
        // from the requested size by more than 50px on either axis, the app
        // refused the resize (Calculator, System Settings panes, Activity
        // Monitor in "small" mode, etc.). Mark the id so:
        //   - the drag-handler's RESIZE-DETECTED math won't steal weight
        //     from it (see events.js applyResizeIfNeeded)
        //   - future tile passes still position it but don't fight its
        //     natural size
        // Sticky for the session; cleared when the window goes away.
        const after = await sd.windows.frame(t.winId).catch(() => null);
        if (after) {
          const dW = Math.abs(after.w - t.frame.w);
          const dH = Math.abs(after.h - t.frame.h);
          if (dW > 50 || dH > 50) {
            if (!state.fixedSizeIds.has(+t.winId)) {
              state.fixedSizeIds.add(+t.winId);
              log(`FIXED-SIZE-DETECTED id=${t.winId} (${state.windowsById[+t.winId]?.app}) want=${JSON.stringify(t.frame)} got=${JSON.stringify(after)}`);
            }
          }
        }
      }
    }
  }
}

let tilingTimer = null;
export async function tileWindows() {
  // Drag-in-flight guard — port of the lua's "if win:isDragging" check.
  // events.js sets state.dragInFlight while a drag is active so unrelated
  // triggers (focusedChanged, sd.windows.all push, sd.spaces.all push)
  // don't yank the dragged window out from under the cursor. The drag's
  // own debounced handler will tile once at drop time; that's the only
  // tile pass we want during the drag.
  if (state.dragInFlight) {
    log("skip tiling — drag in flight");
    return;
  }
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
