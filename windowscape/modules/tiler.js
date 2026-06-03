// Tiling engine — port of tiler.lua, slimmed.
// One mental model: distribute by weight → setFrame each → if anyone
// refused, write its weight to its actual size + renormalize siblings up
// → re-apply the flexible windows ONCE. Refusal-driven convergence
// without per-pass observe-and-redistribute loops.

import { sd } from "sd://runtime/api.js";
import { cfg } from "./config.js";
import { state, updateWindowOrder, activeSpaceOnDisplay, log, evt, displayForWindow } from "./core.js";
import { tileWeighted } from "./layouts.js";
import { animatedSetFrame, cancelAllAnimations } from "./animation.js";
import { adjustedFrameForDisplay } from "./snapshots.js";

export function getWindowWeight(winId) {
  if (state.windowWeights[winId] != null) return state.windowWeights[winId];
  // Inherit from a same-app window if one has a stored weight. Two
  // Terminal windows alternating via Cmd+` (one minimized at a time)
  // should share the slot's width — otherwise the new one gets the 1.0
  // default and the tile visibly jumps width each switch.
  const w = state.windowsById[winId];
  const matchKey = w && (w.bundleId || w.app);
  if (matchKey) {
    for (const otherId of Object.keys(state.windowsById)) {
      if (+otherId === +winId) continue;
      const other = state.windowsById[otherId];
      if (!other) continue;
      const otherKey = other.bundleId || other.app;
      if (otherKey === matchKey && state.windowWeights[otherId] != null) {
        state.windowWeights[winId] = state.windowWeights[otherId];
        return state.windowWeights[winId];
      }
    }
  }
  return 1.0;
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
}

async function tileWindowsInternal() {
  updateWindowOrder();
  for (const d of state.displays) {
    const space = activeSpaceOnDisplay(d.uuid);
    if (space == null) continue;
    // Lua tiler.lua line 130: bail on fullscreen. Touching frames inside
    // a fullscreen space pops the app out of fullscreen and is very
    // disruptive.
    const spaceInfo = state.spacesByDisplay[d.uuid];
    if (spaceInfo && spaceInfo.isFullscreen) {
      log(`skip tiling display ${d.displayID} — fullscreen space`);
      continue;
    }
    const ordered = state.windowOrderBySpace[space] || [];

    // Eligibility filter. Daemon enriches each entry with addressable /
    // isStandard / isMinimized / onscreen — we trust those instead of
    // re-probing per-pass.
    const screenWindows = [];
    for (const id of ordered) {
      const w = state.windowsById[id];
      if (!w || !w.frame) continue;
      if (w.onscreen === false) continue;
      if (w.isMinimized === true) continue;
      if (w.addressable === false) continue;
      if (w.isStandard === false) continue;
      // displayForWindow falls back to displays[0] when a window's center
      // is off ALL displays — happens when a tile gets nudged off-screen
      // briefly; we still want to address it on its assigned display.
      const wd = displayForWindow(w);
      if (!wd || wd.displayID !== d.displayID) continue;
      screenWindows.push(id);
    }
    if (screenWindows.length === 0) continue;

    // Membership diff for observability (TILE-IN / TILE-OUT). Computed
    // against the previous pass's lastTiledByDisplay so we don't carry a
    // duplicate prevMembership state field.
    const prevList = state.lastTiledByDisplay[d.displayID] || [];
    const prev = new Set(prevList);
    const cur = new Set(screenWindows);
    const added = [...cur].filter(id => !prev.has(id));
    const removed = [...prev].filter(id => !cur.has(id));
    if (added.length || removed.length) {
      const reason = state.tileReason || "?";
      for (const id of added) {
        const a = state.windowsById[id]?.app || "?";
        evt(`TILE-IN  d${d.displayID} ${id} (${a.slice(0,18)})  via=${reason}`);
      }
      for (const id of removed) {
        const a = state.windowsById[id]?.app || "?";
        let why = "gone";
        if (state.minimizedIds.has(+id)) why = "minimized";
        else if (!state.windowsById[id]) why = "no-windowsById";
        else why = "unaddressable";
        evt(`TILE-OUT d${d.displayID} ${id} (${a.slice(0,18)})  why=${why}  via=${reason}`);
      }
    }
    state.lastTiledByDisplay[d.displayID] = [...screenWindows];

    const collapsed = getCollapsedWindows(screenWindows);
    const nonCollapsed = screenWindows.filter((id) => !collapsed.includes(id));

    // Honor snapshot-strip reservation: tiles must not draw under the
    // bottom strip on displays that host snapshotted tiles.
    const screenFrame = adjustedFrameForDisplay(d) || { ...d.visibleFrame };
    const horizontal = screenFrame.w > screenFrame.h;

    // Collapsed widgets get positioned at their current pixel size — the
    // tiler doesn't force a width (Sticky Notes refuses width writes;
    // forcing them creates an overlap loop). sizeOf returns the live
    // width/height so the position cursor advances by the actual size.
    const sizeOf = (id) => {
      const f = state.windowsById[id]?.frame;
      return f ? { w: f.w, h: f.h } : null;
    };
    const targets = tileWeighted(screenFrame, nonCollapsed, collapsed, horizontal, getWindowWeight, sizeOf);
    log(`TILE n=${screenWindows.length} display=${d.displayID} ${horizontal ? "H" : "V"} weights=${JSON.stringify(screenWindows.map(id => +(state.windowWeights[id] ?? 1).toFixed(2)))} targets=${JSON.stringify(targets.map(t => ({id: t.winId, app: state.windowsById[t.winId]?.app?.slice(0,10), x: t.frame.x, w: t.frame.w})))}`);

    if (cfg.enableAnimations) {
      for (const t of targets) {
        const cur = state.windowsById[t.winId]?.frame;
        animatedSetFrame(t.winId, cur, t.frame);
      }
      continue;
    }

    const now = Date.now();
    const isCollapsed = (id) => {
      const f = state.windowsById[id]?.frame;
      return f && f.h <= cfg.collapsedWindowHeight;
    };
    // PASS-1: apply each target, observe what AX actually accepted.
    const actuals = Object.create(null);
    for (const t of targets) {
      const live = await sd.windows.frame(t.winId).catch(() => null);
      if (isCollapsed(+t.winId)) {
        // Collapsed widget (Sticky Notes, etc.) — pin the rail Y only;
        // app manages width and x. Y-drift > 3px = user dragged it out
        // of the rail; setFrame back, preserving live x and width.
        const yDrift = live ? Math.abs(live.y - t.frame.y) : 0;
        if (!live || yDrift <= 3) {
          actuals[+t.winId] = live || t.frame;
          state.lastTileTarget[+t.winId] = { frame: { ...t.frame }, ts: now };
          continue;
        }
        const correctedFrame = { x: live.x, y: t.frame.y, w: live.w, h: live.h };
        state.lastTileTarget[+t.winId] = { frame: { ...correctedFrame }, ts: now };
        const probed = await sd.windows.setFrameProbed(t.winId, correctedFrame).catch(() => null);
        actuals[+t.winId] = (probed && probed.actual) ? probed.actual : correctedFrame;
        continue;
      }
      // Always record the target so drift-watch / echo-suppression see
      // the CURRENT tile's target, not a stale one from a previous pass.
      state.lastTileTarget[+t.winId] = { frame: { ...t.frame }, ts: now };
      // Already at target within 5px (app rounding) — skip the setFrame
      // call but the target record above is what makes drift go quiet.
      if (live &&
          Math.abs(live.x - t.frame.x) <= 5 && Math.abs(live.y - t.frame.y) <= 5 &&
          Math.abs(live.w - t.frame.w) <= 5 && Math.abs(live.h - t.frame.h) <= 5) {
        actuals[+t.winId] = live;
        continue;
      }
      const probed = await sd.windows.setFrameProbed(t.winId, t.frame).catch(() => null);
      actuals[+t.winId] = (probed && probed.actual) ? probed.actual : t.frame;
    }

    // PASS-2: refusal handling. Any non-collapsed window that ended up
    // > 50px from its target is "refused" (app-imposed min/max). For
    // each refused window:
    //   1. Write weight = actualSize / pxPerWeight (using pre-pass
    //      totalWeight as denominator) so the new weight reflects the
    //      actually-honored pixel share.
    //   2. Renormalize the siblings INVERSELY by the same delta so the
    //      total weight stays constant.
    //   3. Re-apply flexible windows once with new weights — refused
    //      windows are already at their actual size, no re-setFrame.
    const axis = horizontal ? "w" : "h";
    const refused = nonCollapsed.filter((id) => {
      const a = actuals[+id], t = targets.find(t => t.winId === id);
      if (!a || !t) return false;
      const dW = Math.abs(a.w - t.frame.w), dH = Math.abs(a.h - t.frame.h);
      return horizontal ? dW > 50 : dH > 50;
    });
    if (refused.length === 0 || refused.length >= nonCollapsed.length) continue;

    const totalAxis = horizontal ? screenFrame.w : screenFrame.h;
    const avail = totalAxis - cfg.tileGap * Math.max(nonCollapsed.length - 1, 0);
    const oldTotal = nonCollapsed.reduce((s, id) => s + (state.windowWeights[id] ?? 1), 0);
    if (avail <= 0 || oldTotal <= 0) continue;
    const pxPerWeight = avail / oldTotal;

    // Step 1+2: sync refused, renormalize siblings.
    let refusedDelta = 0;
    for (const id of refused) {
      const newW = Math.max(0.2, actuals[+id][axis] / pxPerWeight);
      const oldW = state.windowWeights[id] ?? 1;
      refusedDelta += (newW - oldW);
      state.windowWeights[id] = newW;
    }
    const siblings = nonCollapsed.filter(id => !refused.includes(id));
    const sibOldSum = siblings.reduce((s, id) => s + (state.windowWeights[id] ?? 1), 0);
    const sibNewSum = sibOldSum - refusedDelta;
    const sibFloor  = 0.2 * siblings.length;
    if (sibOldSum > 0 && sibNewSum >= sibFloor) {
      const scale = sibNewSum / sibOldSum;
      for (const id of siblings) {
        state.windowWeights[id] = Math.max(0.2, (state.windowWeights[id] ?? 1) * scale);
      }
    }
    log(`PASS2-WEIGHTS-SYNC refused=${JSON.stringify(refused)} weights=${JSON.stringify(nonCollapsed.map(id => +(state.windowWeights[id] ?? 1).toFixed(2)))}`);

    // Step 3: re-apply flexible windows with their new weights. Refused
    // windows stay at their actual sizes; we thread them through the
    // position cursor without re-setFrame-ing them.
    const consumed = refused.reduce((s, id) => s + actuals[+id][axis], 0);
    const flexAvail = totalAxis - consumed - cfg.tileGap * Math.max(nonCollapsed.length - 1, 0);
    if (flexAvail <= 0) continue;
    const newSibSum = siblings.reduce((s, id) => s + (state.windowWeights[id] ?? 1), 0);
    if (newSibSum <= 0) continue;
    const collapsedH = horizontal && collapsed.length > 0
      ? (cfg.collapsedWindowHeight + cfg.tileGap) : 0;
    let pos = horizontal ? screenFrame.x : screenFrame.y;
    for (const id of nonCollapsed) {
      const isRef = refused.includes(id);
      const size = isRef
        ? actuals[+id][axis]
        : Math.floor(flexAvail * (state.windowWeights[id] ?? 1) / newSibSum);
      if (!isRef) {
        const frame = horizontal
          ? { x: pos, y: screenFrame.y, w: size, h: screenFrame.h - collapsedH }
          : { x: screenFrame.x, y: pos, w: screenFrame.w, h: size };
        state.lastTileTarget[+id] = { frame: { ...frame }, ts: now };
        await sd.windows.setFrameProbed(id, frame).catch(() => null);
      }
      pos += size + cfg.tileGap;
    }
  }
}

// Drift watcher — independent of bangs. Every 500ms, scan all tiled
// windows and compare CG actual to last tile target. Any window with a
// size delta > 20px gets its weight updated and a tile pass fires. This
// is the "live truth" backstop the user asked for: ANY resize (user,
// app-initiated, programmatic) gets re-tiled without needing a focus
// change or other trigger to wake the layout.
let driftWatcherTimer = null;
let driftPaused = false;
async function driftWatch() {
  if (driftPaused || state.dragInFlight) return;
  if (state.fullscreenState?.active) return;
  if (state.snapshotsState?.isCreating) return;
  for (const d of state.displays) {
    const tiled = state.lastTiledByDisplay[d.displayID] || [];
    let drifted = null;
    let maxDrift = 0;
    for (const id of tiled) {
      const live = await sd.windows.frame(id).catch(() => null);
      if (!live) continue;
      if (state.windowsById[id]) state.windowsById[id].frame = live;
      const tgt = state.lastTileTarget?.[id]?.frame;
      if (!tgt) continue;
      const horizontal = d.frame.w > d.frame.h;
      const dSize = Math.abs(horizontal ? live.w - tgt.w : live.h - tgt.h);
      if (dSize > maxDrift) { maxDrift = dSize; drifted = +id; }
    }
    if (drifted != null && maxDrift > 20) {
      log(`DRIFT-WATCH id=${drifted} delta=${Math.round(maxDrift)} → re-weight + tile`);
      // The window's actual size disagrees with its weight-implied size.
      // Treat as a user resize — update its weight to match the live
      // pixel share, scale the pair-neighbor inversely. THEN tile.
      // Imported lazily to break the events.js ↔ tiler.js circular dep.
      const { setWeightFromActualSize } = await import("./events.js");
      setWeightFromActualSize(drifted);
      state.tileReason = `drift(${drifted})`;
      await tileWindows();
      return;
    }
  }
}
export function startDriftWatcher() {
  if (driftWatcherTimer) clearInterval(driftWatcherTimer);
  driftWatcherTimer = setInterval(driftWatch, 500);
}
export function pauseDriftWatcher(paused) { driftPaused = !!paused; }

let tilingTimer = null;
export async function tileWindows() {
  // Drag-in-flight guard — events.js sets this while a drag is active
  // so unrelated triggers (focusedChanged, sd.windows.all push, etc.)
  // don't yank the dragged window out from under the cursor.
  if (state.dragInFlight) {
    log("skip tiling — drag in flight");
    return;
  }
  if (state.fullscreenState && state.fullscreenState.active) {
    log("skip tiling — simulated fullscreen active");
    return;
  }
  if (state.snapshotsState && state.snapshotsState.isCreating) {
    log("skip tiling — snapshot in flight");
    return;
  }
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
  if (tilingTimer) clearTimeout(tilingTimer);
  const cooldown = cfg.enableAnimations
    ? (cfg.animationDuration * 1000 + 100)
    : 150;
  tilingTimer = setTimeout(() => { state.tilingCount = 0; tilingTimer = null; }, cooldown);
}
