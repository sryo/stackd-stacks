// Tiling engine — port of tiler.lua, slimmed.
// One mental model: distribute by weight → setFrame each → if anyone
// refused, write its weight to its actual size + renormalize siblings up
// → re-apply the flexible windows ONCE. Refusal-driven convergence
// without per-pass observe-and-redistribute loops.

import { sd } from "sd://runtime/api.js";
import { cfg } from "./config.js";
import { state, updateWindowOrder, activeSpaceOnDisplay, log, evt, displayForWindow, appMinFor, learnAppMin } from "./core.js";
import { tileWeighted, specFromState } from "./layouts.js";
import { animatedSetFrame, cancelAllAnimations, isAnimating } from "./animation.js";
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
  for (const k of Object.keys(state.pinnedSizes)) {
    if (!live.has(+k)) delete state.pinnedSizes[k];
  }
  for (const k of state.refusalPins) {
    if (!live.has(+k)) state.refusalPins.delete(k);
  }
  for (const k of Object.keys(state.offscreenSince)) {
    if (!live.has(+k)) delete state.offscreenSince[k];
  }
  for (let i = state.focusHistory.length - 1; i >= 0; i--) {
    if (!live.has(state.focusHistory[i])) state.focusHistory.splice(i, 1);
  }
}

// One-shot re-pass at offscreen-grace expiry. A pass that tiles a window
// under the 1.5s grace may be the LAST pass any event triggers for minutes
// — native fullscreen is the canonical case: the window moves to its own
// space, the space-switch pass runs during grace and reserves its slot,
// and the user stares at a hole where the app was. The re-pass runs just
// after the earliest grace deadline so the layout heals on its own.
let graceRepassTimer = null;
function scheduleGraceRepass(deadline) {
  if (graceRepassTimer) return;
  const delay = Math.max(50, deadline - Date.now() + 100);
  graceRepassTimer = setTimeout(() => {
    graceRepassTimer = null;
    // tileWindows() bails at its drag / simulated-fullscreen / snapshot
    // guards without re-arming us. If the re-pass fires mid-guard it would be
    // lost, and the reserved slot never evicts — native-fullscreen idle
    // produces no further events to re-trigger a pass, which is the exact
    // hole this re-pass exists to heal. Re-arm until the guard clears.
    if (state.dragInFlight
        || (state.fullscreenState && state.fullscreenState.active)
        || (state.snapshotsState && state.snapshotsState.isCreating)) {
      scheduleGraceRepass(Date.now() + 200);
      return;
    }
    state.tileReason = "grace-expiry";
    tileWindows();
  }, delay);
}

async function tileWindowsInternal(snap) {
  let graceDeadline = Infinity;
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
      // Debounced onscreen check. kCGWindowIsOnscreen flickers false when
      // a window is momentarily OCCLUDED (e.g. a new sibling spawns on top
      // of it) — an instant check dropped freshly-tiled windows for one
      // pass and let the newcomer steal their slot. But ignoring the flag
      // entirely kept HIDDEN (Cmd+H) windows in the rotation forever,
      // reserving a phantom slot. 1.5s of persistent offscreen-ness
      // separates the two: flicker recovers within a pass, hiding doesn't.
      if (w.onscreen === false) {
        // The grace below rides out occlusion flicker on windows we've been
        // tiling. A window never yet seen onscreen (Cmd+H'd before boot,
        // parked off-space) isn't flickering — it's absent; tiling it for
        // 1.5s after a stackd restart reserved a phantom slot and made the
        // layout snap twice.
        if (!state.everOnscreen.has(+id)) continue;
        if (state.offscreenSince[id] == null) state.offscreenSince[id] = Date.now();
        if (Date.now() - state.offscreenSince[id] > 1500) continue;
        graceDeadline = Math.min(graceDeadline, state.offscreenSince[id] + 1500);
      } else {
        delete state.offscreenSince[id];
      }
      if (w.isMinimized === true) continue;
      if (w.addressable === false) continue;
      // Positive confirmation required, not just "not known-bad": a
      // created-bang stub (events.js onBang_sd_window_created) carries no
      // isStandard field, and at daemon boot the 10s poll bursts creates
      // for every window AX missed — tiling those stubs reserved phantom
      // slots for other-space/helper windows until the next all-push
      // evicted them, visibly resizing everything twice. The all-push
      // subscription re-triggers a pass when it upgrades a stub, so a
      // slow-AX window still tiles as soon as windows.all confirms it.
      if (w.isStandard !== true) continue;
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

    // Enforce single-display membership: purge these ids from every other
    // display's list. An emptied display early-returns above without rewriting
    // its frozen list, so a migrated window would otherwise linger there and
    // make sourceDisplayIdFor report a stale source display — misclassifying an
    // in-place resize as a cross-display drop.
    const claimed = new Set(screenWindows.map((id) => +id));
    for (const otherID in state.lastTiledByDisplay) {
      if (+otherID === +d.displayID) continue;
      const arr = state.lastTiledByDisplay[otherID];
      if (!arr || arr.length === 0) continue;
      const pruned = arr.filter((id) => !claimed.has(+id));
      if (pruned.length !== arr.length) state.lastTiledByDisplay[otherID] = pruned;
    }

    const collapsed = getCollapsedWindows(screenWindows);
    const nonCollapsed = screenWindows.filter((id) => !collapsed.includes(id));

    // Solo tile → drop its pin. A pin represents the user's preferred
    // share when sharing space with siblings; alone, it's stale state
    // that breaks the next 50/50 split when a second window opens.
    // Without this, resizing window A while peers exist, then closing
    // peers, then opening a new window B, leaves A at its pinned px and
    // B with the leftover instead of an even split.
    if (nonCollapsed.length === 1) {
      delete state.pinnedSizes[nonCollapsed[0]];
    }

    // Honor snapshot-strip reservation: tiles must not draw under the
    // bottom strip on displays that host snapshotted tiles.
    const screenFrame = adjustedFrameForDisplay(d) || { ...d.visibleFrame };
    const horizontal = screenFrame.w > screenFrame.h;

    // Collapsed widgets get positioned at their current pixel size — the tiler
    // doesn't force a width (Sticky Notes refuses width writes; forcing them
    // creates an overlap loop). sizeOf returns the live size so the position
    // cursor advances by the actual size.
    const sizeOf = (id) => {
      const f = state.windowsById[id]?.frame;
      return f ? { w: f.w, h: f.h } : null;
    };
    // One resolveFlex call (inside tileWeighted) replaces the old PIN-CLAMP /
    // PIN-FILL / weighted-split trio: a user pin → basis, an AX-refusal pin →
    // min (the app's floor), else a flex weight; the last-grabbed pin is held
    // under overflow. resolveFlex is pure — it never mutates the pin state.
    const specOf = specFromState({
      pins: state.pinnedSizes,
      refusalSet: state.refusalPins,
      weightOf: getWindowWeight,
      lastId: state.lastPinPairId,
      appMinOf: (id) => appMinFor(id, horizontal),
    });
    const targets = tileWeighted(screenFrame, nonCollapsed, collapsed, horizontal, sizeOf, specOf);
    log(`TILE n=${screenWindows.length} display=${d.displayID} ${horizontal ? "H" : "V"} weights=${JSON.stringify(screenWindows.map(id => +(state.windowWeights[id] ?? 1).toFixed(2)))} pins=${JSON.stringify(screenWindows.filter(id => state.pinnedSizes[id] != null).map(id => ({id, px: state.pinnedSizes[id]})))} targets=${JSON.stringify(targets.map(t => ({id: t.winId, app: state.windowsById[t.winId]?.app?.slice(0,10), x: t.frame.x, w: t.frame.w})))}`);

    if (cfg.enableAnimations && !snap) {
      for (const t of targets) {
        const cur = state.windowsById[t.winId]?.frame;
        animatedSetFrame(t.winId, cur, t.frame);
      }
      schedulePostAnimationRefusalSweep(d.displayID, nonCollapsed, horizontal);
      continue;
    }

    const now = Date.now();
    const isCollapsed = (id) => {
      const f = state.windowsById[id]?.frame;
      return f && f.h <= cfg.collapsedWindowHeight;
    };
    // PASS-1: apply each target, observe what AX actually accepted.
    // Live frames are read in PARALLEL up front (halves the per-pass
    // round-trips vs a serial read-then-apply loop).
    const actuals = Object.create(null);
    const lives = Object.create(null);
    await Promise.all(targets.map(async (t) => {
      lives[+t.winId] = await sd.windows.frame(t.winId).catch(() => null);
    }));
    const pending = [];
    for (const t of targets) {
      const live = lives[+t.winId];
      if (isCollapsed(+t.winId)) {
        // Collapsed widget (Sticky Notes, etc.) — pin rail Y AND the
        // justify-distributed X (layouts.tileWeighted spaces widgets
        // evenly across the rail width). Width is still
        // app-managed — Sticky Notes refuses width writes and forcing
        // them creates an overlap loop.
        const yDrift = live ? Math.abs(live.y - t.frame.y) : 0;
        const xDrift = live ? Math.abs(live.x - t.frame.x) : 0;
        if (!live || (yDrift <= 3 && xDrift <= 3)) {
          actuals[+t.winId] = live || t.frame;
          state.lastTileTarget[+t.winId] = { frame: { ...t.frame }, ts: now };
          continue;
        }
        const correctedFrame = { x: t.frame.x, y: t.frame.y, w: live.w, h: live.h };
        state.lastTileTarget[+t.winId] = { frame: { ...correctedFrame }, ts: now };
        const probed = await sd.windows.setFrameProbed(t.winId, correctedFrame).catch(() => null);
        // actual:null = daemon couldn't confirm the landing (see the pending
        // loop below for the two null sources). Don't record correctedFrame
        // as though it stuck — fall back to the pre-write `live` frame we
        // already read, the last size we actually observed. (Collapsed
        // widgets are exempt from PASS-2 refusal detection, so this only
        // keeps the bookkeeping honest; `live` is guaranteed non-null here.)
        actuals[+t.winId] = (probed && probed.actual) ? probed.actual : live;
        continue;
      }
      // Always record the target so echo-suppression sees
      // the CURRENT tile's target, not a stale one from a previous pass.
      state.lastTileTarget[+t.winId] = { frame: { ...t.frame }, ts: now };
      // Already at target within 5px (app rounding) — skip the setFrame
      // call but the target record above is what keeps echo-suppression current.
      if (live &&
          Math.abs(live.x - t.frame.x) <= 5 && Math.abs(live.y - t.frame.y) <= 5 &&
          Math.abs(live.w - t.frame.w) <= 5 && Math.abs(live.h - t.frame.h) <= 5) {
        actuals[+t.winId] = live;
        continue;
      }
      pending.push(t);
    }
    // Serial AX setFrameProbed per window. Batching writes (sd.windows.batch
    // + parallel read-back) lands windows at wrong positions / offscreen —
    // the SLS-transaction position path needs a daemon-side coordinate audit
    // before the tiler can use it.
    for (const t of pending) {
      const probed = await sd.windows.setFrameProbed(t.winId, t.frame).catch(() => null);
      // actual:null means the daemon could NOT confirm where the window
      // landed — the write was superseded (BridgeWindows setFrameProbed's
      // .animated(false) branch) or cgBounds couldn't read the window back
      // during settleProbe's 60ms wait (Windows.settleProbe). It does NOT
      // mean "reached target": recording t.frame as the actual makes PASS-2
      // compare target-against-target (dMajor = 0) and silently pass a
      // refuser — System Settings pinned at its ~845px min width keeps
      // overlapping and never gets pinned. Re-read the live frame so PASS-2
      // still sees the refusal; if that read also fails we genuinely don't
      // know, so leave actuals[id] unset (PASS-2's `!a` guard skips it) and
      // let the next pass re-probe rather than pin a phantom.
      let actual = probed && probed.actual;
      if (!actual) {
        actual = await sd.windows.frame(t.winId).catch(() => null);
        // This path is otherwise silent — log it so the null case is
        // observable; a reprobe far from target is a refuser PASS-2 is about
        // to pin (a PASS2-PIN-REFUSED should follow).
        log(`PASS1-UNCONFIRMED id=${t.winId} reprobe=${actual ? `${actual.w}x${actual.h}` : "failed"} target=${t.frame.w}x${t.frame.h}`);
      }
      if (actual) actuals[+t.winId] = actual;
    }

    // PASS-2: refusal handling. Any flex window that ended up more than
    // REFUSAL_PX from its target is "refused" (app-imposed min/max).
    // Under the pin model we treat refusal exactly like a user resize:
    // write the actual size to state.pinnedSizes. The next layout pass
    // will respect it; flex siblings absorb the freed space naturally
    // via resolveFlex.
    //
    // REFUSAL_PX must equal the settled-echo cutoff in events.js
    // (dMajor <= 20): a deviation the echo filter won't swallow MUST be
    // contained here as a refusal pin, or it leaks to the out-of-bracket
    // resize path as a phantom user resize and ripples junk pins across
    // the row. A higher threshold (e.g. 50px) leaves a 20-50px dead zone —
    // Terminal's min width refusing a 268px flex target by ~28px sits as
    // a permanent overlap (under 50 → never pinned) AND feeds the resize
    // machinery (over 20 → not an echo).
    // The floor stays above grid-snap noise (Terminal rounds width to
    // character cells, ≤ ~7px) and PASS-1's 5px skip tolerance.
    const REFUSAL_PX = 20;
    const axis = horizontal ? "w" : "h";
    const refused = nonCollapsed.filter((id) => {
      // Pinned windows can refuse their pin too (pairwise transfer can ask
      // for less than the app's minimum — TextEdit won't go below ~115px).
      // If we skip them here, the refusal leaks out as a resized bang and
      // the out-of-bracket path re-pins the NEXT neighbor as if the user
      // resized — a phantom ripple across the row. Correcting the pin to
      // the actual size here keeps the refusal contained.
      const a = actuals[+id], t = targets.find(t => t.winId === id);
      if (!a || !t) return false;
      const dW = Math.abs(a.w - t.frame.w), dH = Math.abs(a.h - t.frame.h);
      return horizontal ? dW > REFUSAL_PX : dH > REFUSAL_PX;
    });
    if (refused.length === 0 || refused.length >= nonCollapsed.length) continue;

    for (const id of refused) {
      state.pinnedSizes[id] = Math.max(50, actuals[+id][axis]);
      state.refusalPins.add(+id);
      learnAppMin(id, horizontal, actuals[+id][axis]);
      // Update the recorded target to what the app actually accepted.
      // Leaving the PASS-1 target in place makes the out-of-bracket resize
      // path compare the live frame against a target the app already
      // refused — >20px apart forever — so it re-runs PIN-PAIR as if the
      // USER had resized, squeezing the innocent neighbor.
      state.lastTileTarget[+id] = { frame: { ...actuals[+id] }, ts: now };
    }
    log(`PASS2-PIN-REFUSED refused=${JSON.stringify(refused.map(id => ({id, px: state.pinnedSizes[id]})))}`);

    // Re-flow with refused windows now pinned. Refused tiles are already at
    // their actual size from the PASS-1 setFrame; only flex tiles need a
    // second setFrame. resolveFlex will compute the new flex shares.
    const targets2 = tileWeighted(screenFrame, nonCollapsed, collapsed, horizontal, sizeOf, specOf);
    const flexFixes = [];
    for (const t of targets2) {
      if (refused.includes(t.winId)) continue; // already at actual
      if (collapsed.includes(t.winId)) continue; // collapsed branch handled in PASS-1
      const cur = state.lastTileTarget[+t.winId]?.frame;
      if (cur &&
          Math.abs(cur.x - t.frame.x) <= 2 && Math.abs(cur.y - t.frame.y) <= 2 &&
          Math.abs(cur.w - t.frame.w) <= 2 && Math.abs(cur.h - t.frame.h) <= 2) {
        continue; // PASS-1 target unchanged → no setFrame needed
      }
      state.lastTileTarget[+t.winId] = { frame: { ...t.frame }, ts: now };
      flexFixes.push(t);
    }
    // Contain re-flow refusals in the SAME pass. The probe already reads
    // back the actual frame — discarding it lets a flex window that refused
    // its shrunken PASS-2 share (even split < its app minimum after a new
    // window joined) leak the mismatch to the out-of-bracket path, which
    // pins it as a phantom user resize and cascades junk pins until windows
    // overlap the snapshots rail. No further re-flow here — the next pass
    // absorbs the containment pin.
    for (const t of flexFixes) {
      const probed = await sd.windows.setFrameProbed(t.winId, t.frame).catch(() => null);
      const a = probed && probed.actual;
      if (!a) continue;
      const dMajor2 = Math.abs(horizontal ? a.w - t.frame.w : a.h - t.frame.h);
      if (dMajor2 > REFUSAL_PX) {
        state.pinnedSizes[+t.winId] = Math.max(50, a[axis]);
        state.refusalPins.add(+t.winId);
        learnAppMin(t.winId, horizontal, a[axis]);
        state.lastTileTarget[+t.winId] = { frame: { ...a }, ts: now };
        log(`PASS2-FLEX-REFUSED id=${t.winId} pinned=${state.pinnedSizes[+t.winId]}px`);
      }
    }
  }
  if (graceDeadline < Infinity) scheduleGraceRepass(graceDeadline);
}

// Post-animation refusal sweep — the animated branch's stand-in for PASS-2.
// The animated branch can't observe refusals at apply time (frames land
// asynchronously over cfg.animationDuration), and a silent refuser gives the
// out-of-bracket resize path nothing to wake on: an app that accepts the
// position but refuses the size (System Settings pinned at its ~845px min
// width) emits only `moved` bangs, which events.js ignores
// outside brackets — the overlap never self-corrected. So after the
// animation window we do ONE live read per tile and pin anything still
// >REFUSAL_PX off its current target, exactly like PASS-2, then re-tile
// once so flex siblings absorb the containment.
//
// Single timer slot per display: rapid passes supersede the previous sweep
// (each new pass re-animates and schedules its own). Sweeping against
// state.lastTileTarget (not captured targets) keeps a late sweep correct
// even if it fires after a newer pass updated the targets.
const animSweepTimers = Object.create(null); // displayID -> timer
function schedulePostAnimationRefusalSweep(displayID, nonCollapsed, horizontal) {
  if (animSweepTimers[displayID]) clearTimeout(animSweepTimers[displayID]);
  const delay = (cfg.animationDuration || 0.18) * 1000 + 150;
  animSweepTimers[displayID] = setTimeout(async () => {
    delete animSweepTimers[displayID];
    // A drag or a newer pass owns the frames right now — that newer pass
    // scheduled its own sweep.
    if (state.dragInFlight || state.tilingCount > 0) return;
    // Frames still in transit (final ticks land late under load): probing
    // now would read mid-flight positions as refusals. Re-arm once more.
    if (nonCollapsed.some((id) => isAnimating(id))) {
      schedulePostAnimationRefusalSweep(displayID, nonCollapsed, horizontal);
      return;
    }
    const REFUSAL_PX = 20; // keep equal to PASS-2 / the settled-echo cutoff
    const refused = [];
    for (const id of nonCollapsed) {
      const tgt = state.lastTileTarget?.[+id]?.frame;
      if (!tgt) continue;
      const live = await sd.windows.frame(id).catch(() => null);
      if (!live) continue;
      const dMajor = Math.abs(horizontal ? live.w - tgt.w : live.h - tgt.h);
      if (dMajor > REFUSAL_PX) refused.push([+id, live]);
    }
    if (refused.length === 0 || refused.length >= nonCollapsed.length) return;
    const now = Date.now();
    for (const [id, live] of refused) {
      state.pinnedSizes[id] = Math.max(50, horizontal ? live.w : live.h);
      state.refusalPins.add(+id);
      learnAppMin(id, horizontal, horizontal ? live.w : live.h);
      // Same containment trick as PASS-2: record what the app actually
      // accepted so the resize machinery sees a settled target, not a
      // permanently-refused one.
      state.lastTileTarget[id] = { frame: { ...live }, ts: now };
    }
    log(`ANIM-PASS2-PIN refused=${JSON.stringify(refused.map(([id]) => ({ id, px: state.pinnedSizes[id] })))}`);
    state.tileReason = "anim-refusal";
    state.snapNextTile = true; // containment pass — snap through PASS-1/PASS-2
    await tileWindows();
  }, delay);
}

let tilingTimer = null;
export async function tileWindows() {
  // Drag-in-flight guard — events.js sets this while a drag is active
  // so unrelated triggers (focusedChanged, sd.windows.all push, etc.)
  // don't yank the dragged window out from under the cursor.
  if (state.dragInFlight) {
    // Don't lose the pass: ANY click opens a bracket (global eventtap), so
    // a created/destroyed event landing mid-click would otherwise skip its
    // retile forever — handleWindowEvent already committed lastKnownIds, so
    // no later diff re-fires it. endDragBracket runs the deferred pass.
    state.tileDeferred = true;
    log("skip tiling — drag in flight (deferred)");
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
  state.tileDeferred = false;
  const snap = state.snapNextTile === true;
  state.snapNextTile = false;
  cancelAllAnimations();
  state.tilingCount = 1;
  try {
    await tileWindowsInternal(snap);
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
