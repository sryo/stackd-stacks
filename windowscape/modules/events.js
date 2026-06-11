// Event plumbing — port of events.lua (slimmed: no AXObserver per-app yet,
// no right-click eventtap for snapshots, no watchdog). The 1Hz lifecycle
// poll + the windowsAll / focused signals drive everything here.

import { sd } from "sd://runtime/api.js";
import { cfg } from "./config.js";
import {
  state, log, updateWindowOrder, isAppIncluded, displayForWindow
} from "./core.js";
import { tileWindows, pruneStaleWeights } from "./tiler.js";
import { isAnimating } from "./animation.js";
import { onWindowDestroyed as fullscreenOnDestroyed } from "./fullscreen.js";
import { refresh as refreshButtons } from "./buttons.js";

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

// CGS-lag suppression. The daemon fires sd.window.destroyed off the AX
// observer, then immediately rebuilds sd.windows.all from CGWindowList —
// which can lag the AX destroy by ~50–500ms, so the all-push that lands
// right after the destroy bang STILL includes the just-closed id. Without
// suppression, the all-subscriber overwrites our eager delete in
// windowsById and handleWindowEvent's 30ms debounce sees no change vs
// lastKnownIds → early returns → no retile until something else wakes
// the system (the "few seconds" the user reported on 2→1 closes).
const destroyedRecently = new Map(); // id -> timestamp ms
const DESTROYED_GRACE_MS = 2000;

// Refresh windowSpaces cache for ids we haven't seen before, so the tiler
// has a current spaces list when it next runs.
async function refreshSpacesCache(ids) {
  for (const id of ids) {
    if (state.windowSpacesCache[id]) continue;
    state.windowSpacesCache[id] = await sd.spaces.windowSpaces(id);
  }
}

// True if the lifecycle delta looks like a tab switch: same-app windows with
// near-identical frames. Port of events.lua isTabSwitch.
function isTabSwitch(newIds, removedIds, currentData) {
  if (newIds.length === 0 || removedIds.length === 0) return false;
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
      if (diff < 50) return true;
    }
  }
  return false;
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

  const tabSwitch = isTabSwitch(newIds, removedIds, currentData);

  lastKnownIds = currentIds;
  lastKnownFrames = currentData;

  if (tabSwitch) return;
  if (newIds.length === 0 && removedIds.length === 0) return;

  // Refresh cache for newcomers AND for any currently-eligible window
  // whose cache entry is missing. The strict "only newIds" approach
  // lost cache entries permanently whenever a window briefly dropped
  // out of currentIds (e.g. transient displayForWindow=null while
  // state.displays was still empty during boot, or a toggleExcluded
  // round-trip): the removed-path purged the cache, but the rejoin-
  // path only refreshes IDs that are "new since last tick" — windows
  // present on both ticks but cache-missing fell through forever.
  const cacheMissing = [...currentIds].filter((id) => !state.windowSpacesCache[id]);
  await refreshSpacesCache(cacheMissing);
  for (const id of removedIds) delete state.windowSpacesCache[id];

  log(`event: +${newIds.length} -${removedIds.length}`);
  updateWindowOrder();
  state.tileReason = `lifecycle +${newIds.length}-${removedIds.length}`;
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
// produced a pin-from-echo feedback storm (junk pins at 100-ish px,
// retile, more bangs, more pins). So the bang is only a WAKE-UP: at fire
// time we do ONE live AX read and compare against the CURRENT tile
// target. A settled echo matches its target → no-op; a real external
// resize persists at the foreign size → pin. Same comparison the old
// 500ms drift poller did, but event-driven.
// PER-WINDOW debounce map — a single shared candidate slot let one
// window's trailing echo train stomp another window's REAL resize (B's
// post-pass echoes overwrote A's candidacy and A's resize was silently
// swallowed; same bug class as the service-window lastMovedId stomp
// documented at the drag bracket).
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
    // construction — without this gate every animated pass risked phantom
    // PIN-PAIRs on windows nobody resized (the S4 "non-adjacent-changed"
    // storm, 2026-06-10).
    if ((state.tilingCount > 0 || isAnimating(id)) && entry.retries < 5) {
      entry.retries++;
      armOobResizeTimer(id, entry);
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
  // focused-window title change (e.g. Terminal spinner), which used to
  // produce 75+ no-op tile passes per second. Tile triggers now come from
  // the lifecycle bangs below (created / destroyed / minimized /
  // deminimized) which only fire on actual layout-relevant transitions.
  sd.windows.all.subscribe(async (list) => {
    if (!Array.isArray(list)) return;
    const now = Date.now();
    for (const [id, ts] of destroyedRecently) {
      if (now - ts > DESTROYED_GRACE_MS) destroyedRecently.delete(id);
    }
    const next = Object.create(null);
    for (const w of list) {
      // Skip ids the destroyed bang already told us are gone — CGWindowList
      // can keep reporting them for a beat after AX fires destroy.
      if (destroyedRecently.has(w.id)) continue;
      next[w.id] = w;
    }
    state.windowsById = next;
    // Prune minimizedIds of IDs that are gone — keeps the set bounded
    // and lets a re-created window (same app, new CGWindowID) get a
    // fresh tile slot.
    for (const id of state.minimizedIds) {
      if (!next[id]) state.minimizedIds.delete(id);
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
    // Active space changed — rebuild order + retile.
    updateWindowOrder();
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
    if (displayDebounce) clearTimeout(displayDebounce);
    displayDebounce = setTimeout(() => {
      displayDebounce = null;
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
    }, 250);
  });

  // Lifecycle bangs — invalidate space cache for destroyed windows AND
  // retile (closed window leaves a gap the remaining tiles should fill).
  window.onBang_sd_window_destroyed = (detail) => {
    if (detail && detail.id) {
      const id = +detail.id;
      destroyedRecently.set(id, Date.now());
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
    // Seed the live index from the bang payload (daemon rework 2026-06:
    // created bangs carry {id, pid, app, title, frame}). The daemon tries
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
    if (tgt && tgt.frame && tgt.ts != null && detail.frame) {
      const f = detail.frame;
      const ageMs = Date.now() - tgt.ts;
      if (ageMs <= 600 &&
          Math.abs(f.x - tgt.frame.x) <= 5 && Math.abs(f.y - tgt.frame.y) <= 5 &&
          Math.abs(f.w - tgt.frame.w) <= 5 && Math.abs(f.h - tgt.frame.h) <= 5) {
        log(`DRAG-IGNORED echo id=${detail.id} (${app}) age=${ageMs}ms`);
        return;
      }
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

// Drag-bracket — opened on leftMouseDown, closed on leftMouseUp. While open,
// tile passes are blocked (state.dragInFlight) and bang-triggered actions are
// deferred to bracket close. The candidate moved id is captured from mid-drag
// bangs; at close, we run ONE decision based on the final frame.
let dragSafetyTimer = null;
let dragCloseTimer = null;
export function startDragBracket() {
  // Reset bracket state. If a previous bracket is still pending close (e.g.
  // user click-drag-click in rapid succession), cancel the pending close so
  // we don't run the prior decision on the new mouse-down.
  if (dragCloseTimer) { clearTimeout(dragCloseTimer); dragCloseTimer = null; }
  if (dragSafetyTimer) { clearTimeout(dragSafetyTimer); dragSafetyTimer = null; }
  state.dragInFlight = true;
  state.dragCandidateId = null;
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

export function endDragBracket() {
  if (dragSafetyTimer) { clearTimeout(dragSafetyTimer); dragSafetyTimer = null; }
  if (dragCloseTimer) { clearTimeout(dragCloseTimer); dragCloseTimer = null; }
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
export function pinFromActualSize(movedId) {
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

  // Which edge moved? Origin drift on the major axis = leading-edge drag.
  const originDrift = Math.abs(horizontal ? w.frame.x - tgt.x : w.frame.y - tgt.y);
  const leading = originDrift > 5;
  let bIdx = leading ? idx - 1 : idx + 1;
  if (bIdx < 0 || bIdx >= onScreen.length) bIdx = leading ? idx + 1 : idx - 1;
  const bId = onScreen[bIdx]; // exists: onScreen.length >= 2

  state.pinnedSizes[+movedId] = Math.max(50, Math.floor(actualSize));

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
  if (bWant < 50) {
    // Clamp; do NOT push the overflow to a third tile — accepted imperfection.
    log(`PIN-PAIR clamp neighbor ${bId} ${bWant}px → 50px (overflow not redistributed)`);
  }
  state.pinnedSizes[+bId] = Math.max(50, bWant);
  if (state.onLayoutChange) state.onLayoutChange();
  log(`PIN-PAIR ${horizontal ? "w" : "h"} edge=${leading ? "leading" : "trailing"} A=${movedId}→${state.pinnedSizes[+movedId]}px B=${bId}→${state.pinnedSizes[+bId]}px delta=${Math.round(delta)}`);
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
