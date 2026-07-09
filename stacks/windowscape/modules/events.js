// Event plumbing — port of events.lua (slimmed: no AXObserver per-app yet,
// no right-click eventtap for snapshots, no watchdog). The 1Hz lifecycle
// poll + the windowsAll / focused signals drive everything here.

import { sd } from "sd://runtime/api.js";
import { cfg } from "./config.js";
import {
  state, log, evt, updateWindowOrder, isAppIncluded, displayForWindow,
  migrateWindowId, activeSpaceOnDisplay
} from "./core.js";
import { tileWindows, pruneStaleWeights } from "./tiler.js";
import { PIN_MIN_PX } from "./layouts.js";
import { updateLayout as updateSnapshotLayout } from "./snapshots.js";
import { isAnimating } from "./animation.js";
import { onWindowDestroyed as fullscreenOnDestroyed } from "./fullscreen.js";

// Push an inclusion verdict to the overlay-border stack so it can paint the
// focused window's border in the included vs excluded palette. The bang is
// user-defined (bare name, no `sd.` prefix); overlay-border caches per-id so
// re-focus is free.
function emitInclusionBang(w) {
  if (!w || !w.id) return;
  sd.bang.declare('overlay-border.inclusion').emit({ winId: w.id, included: isAppIncluded(w) });
}

// Spatial drop-position calculator — port of operations.lua calculateDropPosition.
// Returns the 0-based insertion index for a window dropped at `dropFrame`
// among `screenWindows` (already filtered to same-display, non-collapsed).
// Horizontal displays compare centers on x, vertical on y. This is what
// makes "drag window2 to the left of window1" actually reorder them.
function calculateDropPosition(dropFrame, screenWindows, horizontal) {
  if (!dropFrame) return 0;
  const dcx = dropFrame.x + dropFrame.w / 2;
  const dcy = dropFrame.y + dropFrame.h / 2;
  let insertIdx = 0;
  for (let i = 0; i < screenWindows.length; i++) {
    const f = screenWindows[i].frame;
    if (!f) continue;
    const cx = f.x + f.w / 2;
    const cy = f.y + f.h / 2;
    if (horizontal ? dcx > cx : dcy > cy) insertIdx = i + 1;
  }
  return insertIdx;
}

let eventDebounceTimer = null;
let lastKnownIds = new Set();
let lastKnownFrames = Object.create(null); // id -> { app, frame }

// CGS-lag suppression + recreation stash. The daemon fires
// sd.window.destroyed off the AX observer, then immediately rebuilds
// sd.windows.all from CGWindowList — which can lag the AX destroy by
// ~50–500ms, so the all-push that lands right after the destroy bang
// STILL includes the just-closed id. Without suppression, the
// all-subscriber overwrites our eager delete in windowsById and
// handleWindowEvent's 30ms debounce sees no change vs lastKnownIds →
// early returns → no retile until something else wakes the system.
//
// The entry also stashes the window's per-id state (weight/pin/tile
// target/space cache) at destroy time: the destroy handler eagerly purges
// all of it before the debounced handleWindowEvent can pair the destroy
// with a same-slot recreation (apps like Terminal recreate a window at
// the same frame on tab operations), so migration must read from here,
// not from the live maps.
const destroyedRecently = new Map(); // id -> { ts, app, frame, weight, pin, target, spaces }
const DESTROYED_GRACE_MS = 2000;

// Refresh windowSpaces cache for ids we haven't seen before, so the tiler
// has a current spaces list when it next runs.
async function refreshSpacesCache(ids) {
  for (const id of ids) {
    if (state.windowSpacesCache[id]) continue;
    state.windowSpacesCache[id] = await sd.spaces.windowSpaces(id);
  }
}

// Same-slot recreation pairing — successor of the boolean isTabSwitch
// (events.lua). A "tab switch" here is really an app destroying a window
// and recreating it at a near-identical frame (Terminal does this on tab
// operations); the daemon's CGWindowIDs are stable across true tab
// switches, so any destroy+create pair we see is real window churn.
// Greedy one-to-one matching by ascending frame diff: same app, total
// |Δx|+|Δy|+|Δw|+|Δh| < 50px. Returning pairs instead of a boolean keeps
// one matching pair from suppressing the retile for every unrelated
// window in the same debounce batch.
function matchRecreationPairs(newIds, removedIds, currentData) {
  if (newIds.length === 0 || removedIds.length === 0) return [];
  const candidates = [];
  for (const nid of newIds) {
    const nd = currentData[nid];
    if (!nd) continue;
    for (const oid of removedIds) {
      const od = lastKnownFrames[oid];
      if (!od) continue;
      if (od.app !== nd.app) continue;
      const f1 = od.frame, f2 = nd.frame;
      const diff = Math.abs(f1.x - f2.x) + Math.abs(f1.y - f2.y) +
                   Math.abs(f1.w - f2.w) + Math.abs(f1.h - f2.h);
      if (diff < 50) candidates.push({ oid, nid, diff });
    }
  }
  candidates.sort((a, b) => a.diff - b.diff);
  const usedOld = new Set(), usedNew = new Set(), pairs = [];
  for (const c of candidates) {
    if (usedOld.has(c.oid) || usedNew.has(c.nid)) continue;
    usedOld.add(c.oid); usedNew.add(c.nid);
    pairs.push(c);
  }
  return pairs;
}

function debouncedHandleWindowEvent() {
  if (eventDebounceTimer) clearTimeout(eventDebounceTimer);
  eventDebounceTimer = setTimeout(() => {
    eventDebounceTimer = null;
    handleWindowEvent();
  }, cfg.eventDebounceSeconds * 1000);
}

async function handleWindowEvent() {
  if (state.tilingCount > 0) {
    setTimeout(handleWindowEvent, 200);
    return;
  }

  const currentIds = new Set();
  const currentData = Object.create(null);
  for (const id in state.windowsById) {
    const w = state.windowsById[id];
    if (!isAppIncluded(w)) continue;
    const d = displayForWindow(w);
    if (!d) continue;
    currentIds.add(+id);
    currentData[id] = { app: w.app, frame: { ...w.frame } };
  }

  const newIds = [...currentIds].filter((id) => !lastKnownIds.has(id));
  const removedIds = [...lastKnownIds].filter((id) => !currentIds.has(id));

  const pairs = matchRecreationPairs(newIds, removedIds, currentData);

  lastKnownIds = currentIds;
  lastKnownFrames = currentData;

  // Migrate identity for each recreation pair: the new id inherits the old
  // id's order position, tile membership, weight/pin, tile target and space
  // cache. Keep the destroyedRecently entry for the old id — the CGS-lag
  // all-push suppression above still needs to filter the ghost.
  const pairedNew = new Set(), pairedOld = new Set();
  for (const { oid, nid } of pairs) {
    migrateWindowId(oid, nid, destroyedRecently.get(oid));
    pairedOld.add(oid); pairedNew.add(nid);
    evt(`RECREATE-MIGRATE ${oid}→${nid} (${currentData[nid]?.app})`);
  }
  // Belt: if the stash had no spaces list, fetch one so the tiler's space
  // filter has data. No-op when the stash seeded the cache.
  if (pairs.length) refreshSpacesCache([...pairedNew]);

  const restNew = newIds.filter((id) => !pairedNew.has(id));
  const restRemoved = removedIds.filter((id) => !pairedOld.has(id));
  if (restNew.length === 0 && restRemoved.length === 0) {
    if (pairs.length === 0) return;
    // Pure recreation batch: pairs are same-display by construction
    // (<50px frame diff), so per-display membership counts are unchanged —
    // no retile needed. updateWindowOrder still runs to validate
    // eligibility and fire onLayoutChange (state save).
    updateWindowOrder();
    return;
  }

  // Refresh cache for newcomers AND for any currently-eligible window
  // whose cache entry is missing. A window can briefly drop out of
  // currentIds (transient displayForWindow=null while state.displays is
  // still empty during boot, or a toggleExcluded round-trip) — the
  // removed-path purges its cache, and refreshing only IDs "new since
  // last tick" would strand a window present on both ticks but
  // cache-missing forever.
  const cacheMissing = [...currentIds].filter((id) => !state.windowSpacesCache[id]);
  await refreshSpacesCache(cacheMissing);
  for (const id of restRemoved) delete state.windowSpacesCache[id];

  log(`event: +${restNew.length} -${restRemoved.length}`);
  updateWindowOrder();
  state.tileReason = `lifecycle +${restNew.length}-${restRemoved.length}`;
  await tileWindows();
  // Refresh the focused window's inclusion verdict — overlay-border owns
  // the border render now, we just push the policy.
  const fid = sd.windows.focused.peek()?.id;
  if (fid != null) emitInclusionBang(state.windowsById[fid]);
}

// Out-of-bracket resize debounce — replaces the removed 500ms drift-watch
// poll. The daemon's per-window AX observers bang on every app/script-
// driven resize now; we debounce 300ms (same shape as lua's
// pendingReposition timer) so the last bang of a resize train wins, then
// run the SAME pairwise pin + retile as a bracket-close resize.
//
// Echo safety: our own tile-pass setFrames bounce back as resized bangs,
// and AX notifications trail the actual setFrame by up to several hundred
// ms — long after tilingCount cooled down — carrying frames that differ
// wildly from the pass's NEW targets. Trusting the bang payload here
// produces a pin-from-echo feedback loop (junk pins at 100-ish px,
// retile, more bangs, more pins). So the bang is only a WAKE-UP: at fire
// time we do ONE live AX read and compare against the CURRENT tile
// target. A settled echo matches its target → no-op; a real external
// resize persists at the foreign size → pin.
// PER-WINDOW debounce map — a single shared candidate slot lets one
// window's trailing echo train stomp another window's REAL resize (B's
// post-pass echoes overwrite A's candidacy, silently swallowing A's
// resize).
const oobResize = new Map(); // id -> { timer, retries }
function scheduleOutOfBracketResize(id) {
  const prev = oobResize.get(id);
  if (prev && prev.timer) clearTimeout(prev.timer);
  const entry = { timer: null, retries: 0 };
  oobResize.set(id, entry);
  armOobResizeTimer(id, entry);
}
function armOobResizeTimer(id, entry) {
  entry.timer = setTimeout(async () => {
    // A real user drag opened meanwhile — bracket close owns the decision.
    if (state.dragInFlight) { oobResize.delete(id); return; }
    // isAnimating: with cfg.enableAnimations the window can still be in
    // transit AFTER tilingCount cools down (under load the final animation
    // tick lands late). A live read mid-flight is >20px off its target by
    // construction — without this gate every animated pass risks phantom
    // PIN-PAIRs on windows nobody resized.
    if ((state.tilingCount > 0 || isAnimating(id)) && entry.retries < 5) {
      entry.retries++;
      armOobResizeTimer(id, entry);
      return;
    }
    // Apply-latency grace: a tile pass re-targeted this window moments ago
    // and apps apply setFrames asynchronously — a live read now can catch
    // the PRE-apply frame and mint a phantom pin, which cascades: each
    // pass's pin transfer produces the next window's ±delta mismatch,
    // phantom pins oversubscribe the row, PIN-CLAMP resets, repeat. Wait
    // out a fresh target (each retry re-checks, so back-to-back passes keep
    // deferring); if it never ages, bail WITHOUT pinning — a real drift
    // either re-bangs later or is contained by the next pass's PASS-2.
    const tgtTs = state.lastTileTarget?.[id]?.ts;
    if (tgtTs != null && Date.now() - tgtTs < 1000) {
      if (entry.retries < 8) {
        entry.retries++;
        armOobResizeTimer(id, entry);
        return;
      }
      oobResize.delete(id);
      log(`OOB-SETTLE-BAIL id=${id} — target still fresh after ${entry.retries} retries, not pinning`);
      return;
    }
    oobResize.delete(id);
    const live = await sd.windows.frame(id).catch(() => null);
    if (!live) return;
    if (state.windowsById[id]) state.windowsById[id].frame = live;
    const tgt = state.lastTileTarget?.[id]?.frame;
    const w = state.windowsById[id];
    const d = w && displayForWindow(w);
    if (!tgt || !d) return;
    const horizontal = d.frame.w > d.frame.h;
    const dMajor = Math.abs(horizontal ? live.w - tgt.w : live.h - tgt.h);
    if (dMajor <= 20) return; // settled echo — pass moved it back already
    // Fire-time zoom check (not bang-time): the 300ms debounce coalesces
    // the zoom's moved+resized bang train into one suppressed decision.
    if (isZoomSuspect(id)) {
      evt(`ZOOM-SUPPRESS-PIN id=${id} path=oob`);
      scheduleZoomSnapBack(id);
      return;
    }
    log(`RESIZE-OUTSIDE-BRACKET id=${id} live-dMajor=${Math.round(dMajor)} → pairwise pin + tile`);
    pinFromActualSize(id);
    state.tileReason = `ax-resize(${id})`;
    state.snapNextTile = true; // resize containment settles instantly
    await tileWindows();
  }, 300);
}

export function start() {
  // Snapshot of all windows → state.windowsById rebuilt each tick. We use
  // this channel ONLY to keep windowsById fresh (frame/title/app props for
  // the windows already in the rotation). We deliberately do NOT trigger
  // tile passes here — the daemon's sd.windows.all push refires on every
  // focused-window title change (e.g. Terminal spinner), which would
  // otherwise produce 75+ no-op tile passes per second. Tile triggers come from
  // the lifecycle bangs below (created / destroyed / minimized /
  // deminimized) which only fire on actual layout-relevant transitions.
  sd.windows.all.subscribe(async (list) => {
    if (!Array.isArray(list)) return;
    const now = Date.now();
    for (const [id, entry] of destroyedRecently) {
      if (now - entry.ts > DESTROYED_GRACE_MS) destroyedRecently.delete(id);
    }
    const next = Object.create(null);
    // The tiler only admits isStandard === true, so a created-bang stub
    // (no isStandard field) stays out of rotation until this push confirms
    // it — and since the all-push is not otherwise a tile trigger, the
    // confirmation must schedule the pass itself or a slow-AX window would
    // never tile until some unrelated event.
    let confirmedNew = false;
    for (const w of list) {
      // Skip ids the destroyed bang already told us are gone — CGWindowList
      // can keep reporting them for a beat after AX fires destroy.
      if (destroyedRecently.has(w.id)) continue;
      next[w.id] = w;
      // Feed the tiler's boot-phantom gate: only windows seen onscreen at
      // least once earn the offscreen-flicker grace.
      if (w.onscreen !== false) state.everOnscreen.add(+w.id);
      if (w.isStandard === true && state.windowsById[w.id]?.isStandard !== true) {
        confirmedNew = true;
      }
      // A window that just went offscreen may have changed spaces under us
      // (native fullscreen moves it to its own space). Drop its space cache
      // so the next refreshSpacesCache re-queries instead of keeping the
      // pre-move space list alive in the old space's rotation.
      const prev = state.windowsById[w.id];
      if (prev && prev.onscreen !== false && w.onscreen === false) {
        delete state.windowSpacesCache[w.id];
      }
    }
    state.windowsById = next;
    if (confirmedNew) debouncedHandleWindowEvent();
    // Prune minimizedIds of IDs that are gone — keeps the set bounded
    // and lets a re-created window (same app, new CGWindowID) get a
    // fresh tile slot.
    for (const id of state.minimizedIds) {
      if (!next[id]) state.minimizedIds.delete(id);
    }
    for (const id of state.everOnscreen) {
      if (!next[id]) state.everOnscreen.delete(id);
    }
  });

  // Post-R1b: subscribe to the granular focusedChanged channel, not the legacy
  // sd.windows.focused union. The union also fires on titleChanged, which we
  // don't want — every title-only flicker (Slack, Code, Chrome tabs) would
  // detach + reattach the overlay and shove the same id back onto focusHistory.
  sd.windows.focusedChanged.subscribe((w) => {
    if (!w || !w.id) return;
    // Update focusHistory.
    const id = w.id;
    const i = state.focusHistory.indexOf(id);
    if (i >= 0) state.focusHistory.splice(i, 1);
    state.focusHistory.unshift(id);
    if (state.focusHistory.length > state.focusHistoryMax) {
      state.focusHistory.length = state.focusHistoryMax;
    }
    // Push inclusion verdict so overlay-border can paint the right palette.
    // The overlay attach itself is driven by overlay-border's own
    // focusedChanged subscription.
    emitInclusionBang(state.windowsById[id] || w);
  });

  sd.spaces.all.subscribe((info) => {
    if (!info) return;
    state.spacesByDisplay = info;
    // Active space changed — rebuild order + retile. Re-render the snapshot
    // strip too so tiles follow their origin desktop (show/hide per Space)
    // and the tiler reserves strip space only on the active desktop.
    updateWindowOrder();
    updateSnapshotLayout();
    state.tileReason = "spaces";
    tileWindows();
  });

  // Display geometry changes. macOS posts NSApplication.didChangeScreen­Parameters­
  // (which sd.display.all rides) BEFORE NSScreen metrics settle — reading
  // visibleFrame inside this callback often returns the OLD frame. Lua
  // events.lua line 705 debounces 250ms before re-tiling for this exact reason,
  // and resets tilingCount + clears any in-flight cooldowns so the post-debounce
  // tile pass isn't blocked. Port the same shape.
  let displayDebounce = null;
  // Cache the geometry signature so we can skip retiles when the only
  // thing that changed was brightness (sd.display.all re-pushes on every
  // 2s brightness poll). Without this, every brightness sample triggers
  // a tile pass — which races with the per-pass AX probe and produces
  // spurious "Terminal dropped from rotation" events when AX is briefly
  // slow under load.
  let lastDisplayGeoSig = "";
  sd.display.all && sd.display.all.subscribe && sd.display.all.subscribe((d) => {
    if (!Array.isArray(d)) return;
    state.displays = d;
    const sig = d.map(s => {
      const f = s.frame || {}, vf = s.visibleFrame || {};
      return `${s.displayID}|${f.x},${f.y},${f.w},${f.h}|${vf.x},${vf.y},${vf.w},${vf.h}`;
    }).join("/");
    if (sig === lastDisplayGeoSig) return; // brightness-only push, ignore
    lastDisplayGeoSig = sig;
    const runDisplaySettle = () => {
      displayDebounce = null;
      // A drag bracket is open — mid-drag frames are transient, and a
      // premature updateWindowOrder here migrated the dragged window
      // between space orders before the drop decision ran. Re-arm and
      // settle after the bracket closes.
      if (state.dragInFlight) {
        displayDebounce = setTimeout(runDisplaySettle, 250);
        return;
      }
      // Pull a fresh displays snapshot after the settle delay so screenFrame
      // math uses the now-current visibleFrame instead of the stale value
      // that fired this callback.
      const settled = sd.display.all.peek?.();
      if (Array.isArray(settled)) state.displays = settled;
      // Clear stale tile cooldown so the retile actually runs.
      state.tilingCount = 0;
      updateWindowOrder();
      state.tileReason = "display-change";
      tileWindows();
    };
    if (displayDebounce) clearTimeout(displayDebounce);
    displayDebounce = setTimeout(runDisplaySettle, 250);
  });

  // Lifecycle bangs — invalidate space cache for destroyed windows AND
  // retile (closed window leaves a gap the remaining tiles should fill).
  window.onBang_sd_window_destroyed = (detail) => {
    if (detail && detail.id) {
      const id = +detail.id;
      // Stash per-id state BEFORE the eager purge below — if this destroy
      // turns out to be half of a same-slot recreation pair,
      // handleWindowEvent's migration reads weight/pin/target/spaces from
      // this stash (the live maps are already scrubbed by then).
      const w = state.windowsById[id];
      destroyedRecently.set(id, {
        ts: Date.now(),
        app: w?.app,
        frame: w?.frame && { ...w.frame },
        weight: state.windowWeights[id] ?? null,
        pin: state.pinnedSizes[id] ?? null,
        target: state.lastTileTarget[id] || null,
        spaces: state.windowSpacesCache[id] || null,
      });
      delete state.windowSpacesCache[id];
      // Eagerly drop from the live index so handleWindowEvent's currentIds
      // reflects the close. Without this, CGWindowList's lag (~50–500ms)
      // means the all-push that lands between the destroy bang and the
      // 30ms debounce can keep id in windowsById → no diff vs lastKnownIds
      // → silent early return → no retile.
      delete state.windowsById[id];
      delete state.lastTileTarget[id];
      state.minimizedIds.delete(id);
      // If the destroyed window was the simulated-fullscreen target, exit
      // so the parked peers come back into view. No-op otherwise.
      fullscreenOnDestroyed(id);
    }
    pruneStaleWeights();
    debouncedHandleWindowEvent();
  };
  window.onBang_sd_window_created = (detail) => {
    // Seed the live index from the bang payload (created bangs carry
    // {id, pid, app, title, frame}). The daemon tries
    // to land the sd.windows.all push BEFORE this bang, but on retry
    // exhaustion the bang can still win the race — seeding here makes
    // handleWindowEvent's diff see the window either way.
    if (detail && detail.id != null && detail.frame) {
      const id = +detail.id;
      destroyedRecently.delete(id);
      const w = state.windowsById[id] || (state.windowsById[id] = { id });
      w.pid   = detail.pid;
      w.app   = detail.app;
      w.title = detail.title;
      w.frame = detail.frame;
    }
    debouncedHandleWindowEvent();
  };
  // Explicit minimize tracking — drives the tile-eligibility filter in
  // core.updateWindowOrder (state.minimizedIds). Using these bangs
  // instead of CGWindowIsOnscreen because that flag flickers false when
  // the window is momentarily occluded.
  window.onBang_sd_window_minimized = (detail) => {
    if (!detail || detail.id == null) return;
    state.minimizedIds.add(+detail.id);
    // Eager hydration — the bang can beat the pumped sd.windows.all push,
    // and the immediate tile pass below reads windowsById's enrichment.
    if (state.windowsById[+detail.id]) state.windowsById[+detail.id].isMinimized = true;
    // Skip handleWindowEvent — it bails when newIds/removedIds are empty
    // (a minimize doesn't add/remove from windowsById, it just flips an
    // eligibility flag). Tile directly so the freed slot collapses and
    // remaining tiles absorb the space.
    updateWindowOrder();
    state.tileReason = `minimize(${detail.id})`;
    tileWindows();
  };
  window.onBang_sd_window_deminimized = (detail) => {
    if (!detail || detail.id == null) return;
    state.minimizedIds.delete(+detail.id);
    // Eager hydration — without this the immediate tile pass still sees the
    // minimize-era isMinimized:true (the refreshed all-push races the bang)
    // and skips the restored window; nothing retiles when the push lands.
    if (state.windowsById[+detail.id]) state.windowsById[+detail.id].isMinimized = false;
    updateWindowOrder();
    state.tileReason = `deminimize(${detail.id})`;
    tileWindows();
  };

  // Spatial reorder on window-moved — port of events.lua handleWindowMoved.
  // The daemon fires sd.window.moved for origin changes AND sd.window.resized
  // for size changes as SEPARATE bangs from per-window AX observers. A pure
  // right/bottom-edge resize changes size only → only `resized` fires; a
  // top/left-edge resize changes both. Hammerspoon's window_filter coalesces
  // these into one `windowMoved`; we have to subscribe to both and dedupe.
  //
  // Drag-bracket model: leftMouseDown opens the bracket (sets dragInFlight),
  // leftMouseUp closes it (after a 100ms grace for trailing bangs).
  // Mid-bracket bangs hydrate state and record the candidate moved id; the
  // decision (resize-pairwise-pin vs reorder vs no-op) fires ONCE at bracket
  // close. Without the bracket the drag-train would fire reorder on each
  // intermediate bang and the window would jump back under the cursor.
  // Bangs OUTSIDE any bracket: resized → 300ms-debounced pairwise pin +
  // retile (scheduleOutOfBracketResize); moved-only → ignored (next tile
  // pass snaps positions).
  const handleDragBang = (detail, kind) => {
    if (!detail || !detail.id) return;
    // ALWAYS hydrate state.windowsById from the bang. sd.windows.all is
    // throttled (fires on focus/title change only), so peer frames otherwise
    // drift stale.
    if (detail.frame && state.windowsById[+detail.id]) {
      state.windowsById[+detail.id].frame = detail.frame;
    }
    // Collapsed-window heuristic: a moved/resized bang for a collapsed
    // widget is usually the APP shuffling itself in the rail (Sticky Notes'
    // internal x-arrangement), NOT a user drag. Short-circuit those — but
    // still hydrated above so the strip math sees current x.
    const cw = state.windowsById[+detail.id];
    if (cw && cw.frame && cw.frame.h <= cfg.collapsedWindowHeight) {
      const tgt = state.lastTileTarget?.[+detail.id]?.frame;
      const yDrift = tgt ? Math.abs(cw.frame.y - tgt.y) : 0;
      if (yDrift <= cfg.collapsedWindowHeight) return;
    }
    // Filter to windows windowscape actually tiles. The synth poll fires
    // moved/resized bangs for every CGWindowList entry — including AppKit
    // service windows like CursorUIViewService autocomplete renderers,
    // tiny popup floats, etc. — that we never tile. Letting those bangs
    // through sets dragInFlight (blocking real tiles), and worse: if a
    // service-window bang fires AFTER the user's real drag bang, it
    // overwrites lastMovedId → debounce runs against the WRONG id →
    // user's resize/reorder is silently dropped.
    //
    // Accept the bang if either: (a) we've actually tiled this id on some
    // display (post-first-pass), OR (b) it's a window we WOULD tile —
    // isAppIncluded + has a frame + lives on a known display. The second
    // path covers the boot race: after a hot-reload, lastTiledByDisplay
    // is empty until the first tile pass finishes; a user drag in that
    // window would otherwise get DRAG-SKIP'd and lost.
    const w = state.windowsById[+detail.id];
    const wasTiled = Object.values(state.lastTiledByDisplay || {})
      .some(arr => Array.isArray(arr) && arr.includes(+detail.id));
    const eligible = w && w.frame && isAppIncluded(w) && displayForWindow(w);
    if (!wasTiled && !eligible) {
      log(`DRAG-SKIP non-tiled id=${detail.id} (${w?.app?.slice(0,12)}) lastTiled=${JSON.stringify(state.lastTiledByDisplay)}`);
      return;
    }
    const app = state.windowsById[detail.id]?.app?.slice(0, 12);
    const tgt = state.lastTileTarget && state.lastTileTarget[+detail.id];
    // Echo suppression: the daemon classifies each moved/resized bang against
    // its own write ledger (FrameLedger, 20px/1.5s) and ships the verdict as
    // detail.self — authoritative, since the daemon knows exactly what it wrote.
    // Trust it instead of reconstructing the echo test client-side from
    // lastTileTarget (retires the old 600ms/5px heuristic).
    if (detail.self) {
      log(`DRAG-IGNORED echo id=${detail.id} (${app}) (daemon self)`);
      return;
    }

    // If a drag bracket is open (between leftMouseDown and leftMouseUp), record
    // the moved id as the candidate and bail. The decision runs at bracket
    // close — see endDragBracket below. The LATEST mid-bracket bang wins as
    // the candidate (drag-train's final position is what matters).
    if (state.dragInFlight) {
      state.dragCandidateId = +detail.id;
      log(`DRAG-MID id=${detail.id} (${app}) bracket-open, recording candidate`);
      return;
    }
    // Outside any bracket → app/script/AX-driven change.
    if (kind !== "resized") {
      // moved-only: ignore. The next tile pass snaps positions back, and
      // reacting to every AX move would fight app-internal moves.
      log(`MOVE-IGNORED-OUTSIDE-BRACKET id=${detail.id} (${app})`);
      return;
    }
    const wd = displayForWindow(w);
    if (!wd || !tgt || !tgt.frame || !detail.frame) return;
    const horizontal = wd.frame.w > wd.frame.h;
    const dMajor = Math.abs(horizontal
      ? detail.frame.w - tgt.frame.w
      : detail.frame.h - tgt.frame.h);
    if (dMajor <= 20) return;
    log(`RESIZE-OOB-BANG id=${detail.id} (${app}) dMajor=${Math.round(dMajor)} → debounce`);
    scheduleOutOfBracketResize(+detail.id);
  };
  window.onBang_sd_window_moved   = (detail) => handleDragBang(detail, "moved");
  window.onBang_sd_window_resized = (detail) => handleDragBang(detail, "resized");
}

// Titlebar double-click (macOS zoom) detection. Zoom manifests as a plain
// moved+resized AX pair — no distinct event, no isZooming observable — so
// without detection the bracket-close / out-of-bracket handlers misread it
// as a user drag-resize and pin the zoomed size (then the tiler fights the
// zoom animation). Policy: IGNORE the zoom — suppress the pin and snap
// the window back to its tile slot once the animation settles.
//
// Detection: two mouse-downs within DOUBLE_CLICK_MS at (nearly) the same
// point, landing in the top TITLEBAR_BAND_PX of a window we actually tile
// (union of lastTiledByDisplay — non-tiled/excluded windows keep native
// zoom). For ZOOM_SUSPECT_MS afterwards, any oversized resize for that id
// schedules a snap-back retile instead of a pairwise pin.
const DOUBLE_CLICK_MS = 400;
const CLICK_SLOP_PX = 5;
const TITLEBAR_BAND_PX = 40;
const ZOOM_SUSPECT_MS = 1500;
let lastDown = null;    // { x, y, ts } of the previous leftMouseDown
let zoomSuspect = null; // { id, ts, downPos: {x, y} }
const zoomSnapTimers = new Map(); // id -> { timer, retries }

// Tiled window whose titlebar band contains the point, or null. Tiled
// windows don't overlap, so first hit wins.
function titlebarHit(x, y) {
  for (const displayID in state.lastTiledByDisplay) {
    const arr = state.lastTiledByDisplay[displayID];
    if (!Array.isArray(arr)) continue;
    for (const id of arr) {
      const f = state.windowsById[+id]?.frame;
      if (!f) continue;
      if (x >= f.x && x < f.x + f.w && y >= f.y && y < f.y + TITLEBAR_BAND_PX) {
        return +id;
      }
    }
  }
  return null;
}

function trackTitlebarDoubleClick(payload) {
  if (!payload || payload.x == null || payload.y == null) return;
  const now = Date.now();
  const p = { x: payload.x, y: payload.y, ts: now };
  if (lastDown && now - lastDown.ts <= DOUBLE_CLICK_MS &&
      Math.abs(p.x - lastDown.x) <= CLICK_SLOP_PX &&
      Math.abs(p.y - lastDown.y) <= CLICK_SLOP_PX) {
    const id = titlebarHit(p.x, p.y);
    if (id != null) {
      zoomSuspect = { id, ts: now, downPos: { x: p.x, y: p.y } };
      evt(`ZOOM-SUSPECT id=${id}`);
    }
  } else if (zoomSuspect &&
             (Math.abs(p.x - zoomSuspect.downPos.x) > 2 * CLICK_SLOP_PX ||
              Math.abs(p.y - zoomSuspect.downPos.y) > 2 * CLICK_SLOP_PX)) {
    // A distinct new click elsewhere ends the suspect window early —
    // protects a genuine edge-resize started right after a double-click.
    log(`ZOOM-CLEAR id=${zoomSuspect.id} reason=new-click`);
    zoomSuspect = null;
  }
  lastDown = p;
}

function isZoomSuspect(id) {
  return zoomSuspect != null && +zoomSuspect.id === +id &&
         Date.now() - zoomSuspect.ts < ZOOM_SUSPECT_MS;
}

// Coalesced snap-back: one retile per zoomed window, after the OS zoom
// animation settles (~350-500ms). No pin was written and lastTileTarget is
// untouched, so the pass recomputes the identical tile frame and re-asserts
// it; trailing bangs land in the fresh echo window (or read the settled
// frame at the OOB live-read) — no feedback loop.
function scheduleZoomSnapBack(id) {
  const prev = zoomSnapTimers.get(id);
  if (prev && prev.timer) clearTimeout(prev.timer);
  const entry = { timer: null, retries: 0 };
  zoomSnapTimers.set(id, entry);
  armZoomSnapTimer(id, entry);
}
function armZoomSnapTimer(id, entry) {
  entry.timer = setTimeout(async () => {
    if ((state.dragInFlight || state.tilingCount > 0) && entry.retries < 5) {
      entry.retries++;
      armZoomSnapTimer(id, entry);
      return;
    }
    zoomSnapTimers.delete(id);
    if (zoomSuspect && +zoomSuspect.id === +id) zoomSuspect = null; // consumed
    evt(`ZOOM-SNAPBACK id=${id} → retile`);
    state.tileReason = `zoom-snapback(${id})`;
    state.snapNextTile = true;
    await tileWindows();
  }, 450);
}

// Drag-bracket — opened on leftMouseDown, closed on leftMouseUp. While open,
// tile passes are blocked (state.dragInFlight) and bang-triggered actions are
// deferred to bracket close. The candidate moved id is captured from mid-drag
// bangs; at close, we run ONE decision based on the final frame.
let dragSafetyTimer = null;
let dragCloseTimer = null;
export function startDragBracket(payload) {
  // Reset bracket state. If a previous bracket is still pending close (e.g.
  // user click-drag-click in rapid succession), cancel the pending close so
  // we don't run the prior decision on the new mouse-down.
  if (dragCloseTimer) { clearTimeout(dragCloseTimer); dragCloseTimer = null; }
  if (dragSafetyTimer) { clearTimeout(dragSafetyTimer); dragSafetyTimer = null; }
  state.dragInFlight = true;
  state.dragCandidateId = null;
  trackTitlebarDoubleClick(payload);
  // Safety: drop the gate after 5s of no mouseUp. Shouldn't happen (every
  // mouseDown gets a mouseUp), but if the eventtap drops one we don't want
  // tile passes blocked forever.
  dragSafetyTimer = setTimeout(() => {
    log("DRAG-BRACKET safety timeout — clearing dragInFlight");
    state.dragInFlight = false;
    state.dragCandidateId = null;
    dragSafetyTimer = null;
    if (state.tileDeferred) {
      updateWindowOrder();
      state.tileReason = "bracket-safety-deferred";
      tileWindows();
    }
  }, 5000);
}

// Tear the drag bracket down synchronously without processing a candidate.
// The gesture-resize path uses this instead of endDragBracket: it commits its
// own frame directly, so it must NOT let the mouse-drag close reinterpret a
// stray resize/move bang recorded mid-gesture (an unrelated window refusing an
// app-minimum) as a cross-display drop or reorder.
export function clearDragBracket() {
  if (dragSafetyTimer) { clearTimeout(dragSafetyTimer); dragSafetyTimer = null; }
  if (dragCloseTimer) { clearTimeout(dragCloseTimer); dragCloseTimer = null; }
  state.dragInFlight = false;
  state.dragCandidateId = null;
}

export function endDragBracket(payload) {
  if (dragSafetyTimer) { clearTimeout(dragSafetyTimer); dragSafetyTimer = null; }
  if (dragCloseTimer) { clearTimeout(dragCloseTimer); dragCloseTimer = null; }
  // Double-click-and-HOLD drag: the cursor moved between down and up, so
  // this is a real drag, not a zoom. Runs synchronously at mouseUp — before
  // the close timer below reads the suspect.
  if (zoomSuspect && payload && payload.x != null &&
      (Math.abs(payload.x - zoomSuspect.downPos.x) > CLICK_SLOP_PX ||
       Math.abs(payload.y - zoomSuspect.downPos.y) > CLICK_SLOP_PX)) {
    log(`ZOOM-CLEAR id=${zoomSuspect.id} reason=cursor-moved`);
    zoomSuspect = null;
  }
  // 100ms grace for the trailing synth-poll bang to land — the OS posts
  // the final moved/resized bang after mouseUp (CGS-side observation), so
  // we wait so dragCandidateId reflects the FINAL position, not the
  // mid-drag one.
  dragCloseTimer = setTimeout(async () => {
    dragCloseTimer = null;
    const movedId = state.dragCandidateId;
    state.dragCandidateId = null;
    state.dragInFlight = false;
    if (movedId == null) {
      // No bang fired between mouseDown and mouseUp+100ms → just a click,
      // not a drag. Still run any tile pass that got skipped while the
      // bracket was open (lifecycle events land mid-click constantly).
      if (state.tileDeferred) {
        updateWindowOrder();
        state.tileReason = "bracket-deferred";
        await tileWindows();
      }
      return;
    }
    // Zoom suspect — a titlebar double-click is not a drag at all. The
    // zoom's mid-animation bangs made this window the candidate; both the
    // resize branch (would pin the zoomed size) and the reorder branch
    // (would reorder off a mid-zoom frame) are wrong. Snap back instead.
    if (isZoomSuspect(movedId)) {
      evt(`ZOOM-SUPPRESS-PIN id=${movedId} path=bracket`);
      scheduleZoomSnapBack(movedId);
      return;
    }
    // Cross-display drop — checked BEFORE the resize branch, because macOS
    // auto-shrinks windows that don't fit the destination display and that
    // size delta must not be read as a user resize (pinFromActualSize would
    // no-op at idx<0 and the drop would be lost). Source display comes from
    // lastTiledByDisplay, which is frozen at pre-drag membership while the
    // bracket is open (tile passes defer), so it's the display the window
    // was tiled on when the drag started.
    const moved = state.windowsById[movedId];
    if (moved && moved.frame) {
      const src = sourceDisplayIdFor(movedId);
      const dest = displayForWindow(moved);
      if (src != null && dest && +dest.displayID !== +src) {
        await crossDisplayDrop(movedId, src, dest);
        return;
      }
    }
    const tgt = state.lastTileTarget?.[movedId]?.frame;
    const liveFrame = state.windowsById[movedId]?.frame;
    if (tgt && liveFrame) {
      const dW = Math.abs(liveFrame.w - tgt.w);
      const dH = Math.abs(liveFrame.h - tgt.h);
      if (dW > 20 || dH > 20) {
        log(`DRAG-CLOSE id=${movedId} resize dW=${Math.round(dW)} dH=${Math.round(dH)}`);
        pinFromActualSize(movedId);
        state.snapNextTile = true; // resize containment settles instantly
        await tileWindows();
        return;
      }
    }
    log(`DRAG-CLOSE id=${movedId} position-only → reorder`);
    reorderOnDrop(movedId);
  }, 100);
}

// User resize → edge-aware PAIRWISE transfer: pin BOTH sides of the
// dragged edge. The resized window A keeps its actual major-axis size; the
// neighbor across the dragged edge (B) gives/takes exactly the delta. A+B's
// combined px nets to zero change, so the flex remainder — and every other
// tile's share — stays exactly where it was. (The previous model pinned
// only A and let ALL flex siblings absorb the delta proportionally.)
//
// Edge picking: if A's major-axis origin moved >5px off its tile target,
// the LEADING edge was dragged → B is the previous non-collapsed tile in
// display order; otherwise the TRAILING edge → next tile. A missing
// neighbor (A at the row end) falls back to the other side; a solo tile
// stays unpinned.
export function pinFromActualSize(movedId, opts) {
  const w = state.windowsById[movedId];
  if (!w || !w.frame) return;
  const d = displayForWindow(w);
  if (!d) return;
  const tiled = state.lastTiledByDisplay[d.displayID];
  if (!tiled || tiled.length === 0) return;
  const onScreen = tiled.filter((id) => {
    const ww = state.windowsById[id];
    return ww && ww.frame && ww.frame.h > cfg.collapsedWindowHeight;
  });
  if (onScreen.length < 2) return; // single tile: pin meaningless
  const idx = onScreen.indexOf(+movedId);
  if (idx < 0) return;

  const horizontal = d.frame.w > d.frame.h;
  const tgt = state.lastTileTarget?.[+movedId]?.frame;
  if (!tgt) return;
  const actualSize = horizontal ? w.frame.w : w.frame.h;
  // A's baseline: its pin when already pinned (the pin IS its target),
  // else its last tile target.
  const aBase = state.pinnedSizes[+movedId] ?? (horizontal ? tgt.w : tgt.h);
  const delta = actualSize - aBase;
  if (Math.abs(delta) < 20) return;

  // Which edge moved? A gesture commit passes the fence it previewed against;
  // otherwise infer it from major-axis origin drift (mouse / AX resize).
  let leading, bId;
  if (opts && opts.neighborId != null && onScreen.includes(+opts.neighborId)) {
    bId = +opts.neighborId;
    leading = opts.edge === "leading";
  } else {
    const originDrift = Math.abs(horizontal ? w.frame.x - tgt.x : w.frame.y - tgt.y);
    leading = originDrift > 5;
    let bIdx = leading ? idx - 1 : idx + 1;
    if (bIdx < 0 || bIdx >= onScreen.length) bIdx = leading ? idx + 1 : idx - 1;
    bId = onScreen[bIdx]; // exists: onScreen.length >= 2
  }

  state.pinnedSizes[+movedId] = Math.max(PIN_MIN_PX, Math.floor(actualSize));
  // The window the user actively grabbed — PIN-CLAMP keeps this one fixed and
  // shrinks the others so the resize sticks.
  state.lastPinPairId = +movedId;
  // A user resize supersedes any refusal provenance — PIN-CLAMP may shed
  // this pin again.
  state.refusalPins.delete(+movedId);

  // B's baseline: its pin if pinned, else its last tile target, else live frame.
  const bTgt = state.lastTileTarget?.[+bId]?.frame;
  const bLive = state.windowsById[bId]?.frame;
  const bBase = state.pinnedSizes[+bId]
    ?? (bTgt ? (horizontal ? bTgt.w : bTgt.h) : null)
    ?? (bLive ? (horizontal ? bLive.w : bLive.h) : null);
  if (bBase == null) {
    log(`PIN-PAIR id=${movedId} neighbor ${bId} has no target/frame — pinned A only`);
    if (state.onLayoutChange) state.onLayoutChange();
    return;
  }
  const bWant = Math.floor(bBase - delta);
  if (bWant < PIN_MIN_PX) {
    // Clamp; do NOT push the overflow to a third tile — accepted imperfection.
    log(`PIN-PAIR clamp neighbor ${bId} ${bWant}px → ${PIN_MIN_PX}px (overflow not redistributed)`);
  }
  state.pinnedSizes[+bId] = Math.max(PIN_MIN_PX, bWant);
  // Only a transfer that GROWS B supersedes a refusal-min provenance; shrinking
  // B toward its app minimum keeps the flag so PIN-CLAMP holds B fixed.
  if (bWant >= bBase) state.refusalPins.delete(+bId);
  if (state.onLayoutChange) state.onLayoutChange();
  log(`PIN-PAIR ${horizontal ? "w" : "h"} edge=${leading ? "leading" : "trailing"} A=${movedId}→${state.pinnedSizes[+movedId]}px B=${bId}→${state.pinnedSizes[+bId]}px delta=${Math.round(delta)}`);
}

// Display the window was tiled on in the most recent tile pass — the drag
// bracket defers tile passes, so during a drag this is the pre-drag display.
function sourceDisplayIdFor(movedId) {
  for (const displayID in state.lastTiledByDisplay) {
    const arr = state.lastTiledByDisplay[displayID];
    if (Array.isArray(arr) && arr.some((id) => +id === +movedId)) return +displayID;
  }
  return null;
}

// Cross-display drop — the window left srcDisplayID and was released on
// dest. Unlike reorderOnDrop (which reorders among same-display peers),
// this migrates the window between space orders and reflows BOTH displays.
// Also the shared bookkeeping for the moveScreenPrev/Next hotkeys
// (operations.js moveWindowToAdjacentScreen), which had the same
// stale-space-cache dropout.
export async function crossDisplayDrop(movedId, srcDisplayID, dest) {
  const moved = state.windowsById[movedId];
  if (!moved || !moved.frame) return;
  evt(`DRAG-CROSS id=${movedId} (${moved.app}) src=${srcDisplayID} dest=${dest.displayID}`);

  // A stale space cache would drop the window from the destination
  // order. Delete synchronously FIRST — an absent entry means "no info,
  // include optimistically" in updateWindowOrder's space filter, so no pass
  // that interleaves the await below can exclude the window.
  delete state.windowSpacesCache[movedId];
  const destSpace = activeSpaceOnDisplay(dest.uuid);
  const fresh = await sd.spaces.windowSpaces(movedId).catch(() => null);
  if (fresh && fresh.length && destSpace != null && fresh.includes(destSpace)) {
    state.windowSpacesCache[movedId] = fresh;
    log(`CROSS-SPACES id=${movedId} refreshed=${JSON.stringify(fresh)}`);
  } else if (destSpace != null) {
    // The OS hasn't re-registered the window on the destination Space yet.
    // Leave the cache absent (optimistic include) and converge once later.
    setTimeout(async () => {
      const again = await sd.spaces.windowSpaces(movedId).catch(() => null);
      if (again && again.length && again.includes(destSpace)) {
        state.windowSpacesCache[movedId] = again;
        log(`CROSS-SPACES id=${movedId} converged=${JSON.stringify(again)}`);
      }
    }, 750);
  }

  // Spaces info not populated at all — skip order surgery; the optimistic
  // cache plus updateWindowOrder will place the window on the dest display.
  if (destSpace == null) {
    updateWindowOrder();
    state.tileReason = `cross-display(${movedId})`;
    await tileWindows();
    return;
  }

  // Remove from the source space's order. Skipped when both displays share
  // the active space ("Displays have separate Spaces" off) — then the
  // remove-then-insert below operates on the single shared array.
  const srcDisplay = state.displays.find((d) => +d.displayID === +srcDisplayID);
  const srcSpace = srcDisplay ? activeSpaceOnDisplay(srcDisplay.uuid) : null;
  if (srcSpace != null && srcSpace !== destSpace) {
    state.windowOrderBySpace[srcSpace] =
      (state.windowOrderBySpace[srcSpace] || []).filter((id) => +id !== +movedId);
  }

  // Insert at the drop position among the destination's tiled, non-collapsed
  // peers. Empty destination (no peers) → append: first window on that
  // display just works.
  const tiled = state.lastTiledByDisplay[dest.displayID];
  const tiledSet = tiled && tiled.length ? new Set(tiled.map((id) => +id)) : null;
  const destOrder = (state.windowOrderBySpace[destSpace] || []).filter((id) => +id !== +movedId);
  const peers = [];
  for (const id of destOrder) {
    if (tiledSet && !tiledSet.has(+id)) continue;
    const w = state.windowsById[id];
    if (!w || !w.frame) continue;
    if (w.frame.h <= cfg.collapsedWindowHeight) continue;
    const wd = displayForWindow(w);
    if (!wd || wd.displayID !== dest.displayID) continue;
    peers.push(w);
  }
  const horizontal = dest.frame.w > dest.frame.h;
  const newIdx = calculateDropPosition(moved.frame, peers, horizontal);
  let insertAt = destOrder.length;
  if (peers.length > 0) {
    insertAt = newIdx >= peers.length
      ? destOrder.indexOf(peers[peers.length - 1].id) + 1
      : destOrder.indexOf(peers[newIdx].id);
    if (insertAt < 0) insertAt = destOrder.length;
  }
  destOrder.splice(insertAt, 0, +movedId);
  state.windowOrderBySpace[destSpace] = destOrder;

  // Weight is relative and renormalizes per display — keep it. A pin is
  // absolute px captured against the SOURCE display's major axis (possibly
  // even the other axis after a landscape→portrait move) — drop it.
  delete state.pinnedSizes[movedId];
  state.refusalPins.delete(+movedId);

  updateWindowOrder();
  state.tileReason = `cross-display(${movedId})`;
  await tileWindows();
}

async function reorderOnDrop(movedId) {
  const moved = state.windowsById[movedId];
  if (!moved || !moved.frame) return;
  if (!isAppIncluded(moved)) return;
  const d = displayForWindow(moved);
  if (!d) return;
  const space = state.spacesByDisplay[d.uuid]?.active;
  if (space == null) return;
  const order = state.windowOrderBySpace[space] || [];

  // Same-display, non-collapsed peers (excluding the moved window itself).
  // Filter by lastTiledByDisplay so we only reorder among windows the tiler
  // actually placed — phantom CGWindowList entries don't get a slot.
  const tiled = state.lastTiledByDisplay[d.displayID];
  const tiledSet = tiled && tiled.length ? new Set(tiled.map(id => +id)) : null;
  const peers = [];
  for (const id of order) {
    if (id === movedId) continue;
    if (tiledSet && !tiledSet.has(+id)) continue;
    const w = state.windowsById[id];
    if (!w || !w.frame) continue;
    if (w.frame.h <= cfg.collapsedWindowHeight) continue;
    const wd = displayForWindow(w);
    if (!wd || wd.displayID !== d.displayID) continue;
    peers.push(w);
  }
  if (peers.length === 0) { await tileWindows(); return; }

  const horizontal = d.frame.w > d.frame.h;
  const newIdx = calculateDropPosition(moved.frame, peers, horizontal);

  // Splice moved into peers at newIdx; rebuild order keeping off-display
  // and on-display-collapsed entries in place.
  peers.splice(newIdx, 0, moved);
  const peerById = new Map(peers.map(w => [w.id, w]));
  const collapsedOnScreen = [];
  for (const id of order) {
    const w = state.windowsById[id];
    if (!w || !w.frame) continue;
    if (w.frame.h <= cfg.collapsedWindowHeight) {
      const wd = displayForWindow(w);
      if (wd && wd.displayID === d.displayID) collapsedOnScreen.push(id);
    }
  }
  const newOrder = [];
  for (const id of order) {
    const w = state.windowsById[id];
    if (!w) continue;
    const wd = displayForWindow(w);
    const onOther = !wd || wd.displayID !== d.displayID;
    if (onOther) newOrder.push(id);
  }
  for (const w of peers) newOrder.push(w.id);
  for (const id of collapsedOnScreen) newOrder.push(id);

  state.windowOrderBySpace[space] = newOrder;
  await tileWindows();
}
