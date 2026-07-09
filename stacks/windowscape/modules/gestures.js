// Trackpad gesture verbs — maps TTTaps bangs onto window operations.
// The recognizer lives in the tttaps stack: a 3-finger drag fires one
// axis-locked sd.tttap.dragStep per commit-threshold of travel, so the user
// can step through sizes/positions and reverse without lifting.
//
// Up/down steps resize the focused window — up grows it, down shrinks it,
// consistently regardless of slot; left/right steps reorder. The space comes
// from ONE neighbor, fixed at bracket-open (the next tile, or the previous at
// the row's end). The preview outline renders the tiler's PREDICTED landing
// frame, so lifting commits with no jump: on dragEnd the predicted frame
// commits with one setFrame and the same pairwise pin the preview was built on.

import { sd } from "sd://runtime/api.js";
import { state, log, displayForWindow, appMinFor } from "./core.js";
import { adjustedFrameForDisplay } from "./snapshots.js";
import { isFullscreenActive } from "./fullscreen.js";
import { moveWindowInOrder } from "./operations.js";
import { startDragBracket, clearDragBracket, pinFromActualSize } from "./events.js";
import { cancelAnimation } from "./animation.js";
import { predictResizeFrame, PIN_MIN_PX } from "./layouts.js";
import { getWindowWeight, getCollapsedWindows, tileWindows } from "./tiler.js";

// Resize feel: vertical steps commit every 0.035 of trackpad travel (see
// tttaps CFG.dragStepCommitThresholdV) at 40px each — finer than the hotkeys'
// 100px GROW_STEP_PX so a drag reads as continuous growth.
const RESIZE_STEP_PX = 40;
const RESIZE_MIN_PX  = 100; // smallest the focused window may shrink to via gesture

// Gesture-resize bracket. The resize drag rides the SAME bracket as a mouse
// drag (events.startDragBracket / endDragBracket): the first step opens it
// (tile passes auto-defer while dragInFlight) and freezes the row context;
// each step re-predicts the focused window's landing frame and repaints the
// preview outline. dragEnd commits the predicted frame and closes the bracket.
let gestureBracket = null;

// --- preview outline -------------------------------------------------------
// Drawn via a daemon free-region overlay (sd.overlay.region) at the preview's
// GLOBAL rect, so it lands on whichever display holds the focused window.
// Styled to read as overlay-border's ring (8px blue, 16px radius); the overlay
// panel IS the rect, so .ring fills it (inset:0).
let previewHandle = null;
const PREVIEW_HTML = `<div class="ring"></div>`;
const PREVIEW_CSS = [
  ".ring {",
  "  position: absolute; inset: 0; box-sizing: border-box;",
  "  border: 8px solid rgba(26,77,230,0.8);",
  "  border-radius: 16px;",
  "  background: rgba(26,77,230,0.06);",
  "  pointer-events: none;",
  "}"
].join("\n");

function openGestureBracket() {
  const f = sd.windows.focused.peek();
  const w = f && f.id != null ? state.windowsById[f.id] : null;
  if (!w || !w.frame) return null;
  const d = displayForWindow(w);
  // A tile animation still converging on this window would make the frozen row
  // context stale — settle it where it stands.
  cancelAnimation(w.id);
  // Clamp/axis against the snapshot-rail-adjusted work area, matching the tiler
  // (a gesture-grow must not extend under the strip).
  const vf = (d && (adjustedFrameForDisplay(d) || d.visibleFrame || d.frame)) || null;
  const horizontal = vf ? vf.w > vf.h : (d ? d.frame.w > d.frame.h : true);

  // Frozen row context — tile passes defer while the bracket is open, so the
  // membership/order the preview predicts against is the one the commit uses.
  const tiled = (d && state.lastTiledByDisplay[d.displayID]) || [];
  const collapsed = getCollapsedWindows(tiled);
  const collapsedSet = new Set(collapsed.map((id) => +id));
  const nonCollapsed = tiled.filter((id) => !collapsedSet.has(+id));
  const focusedIdx = nonCollapsed.indexOf(+w.id);

  const major = (fr) => (horizontal ? fr.w : fr.h);
  const tgt = state.lastTileTarget?.[+w.id]?.frame;
  const aBase = state.pinnedSizes[+w.id] ?? (tgt ? major(tgt) : major(w.frame));

  // Neighbor that gives/takes the space: the next tile (trailing), falling back
  // to the previous tile at the row's end. Fixed for the whole gesture — up
  // grows the focused window into it, down shrinks and hands it back — so the
  // resize direction is consistent regardless of the window's slot.
  let edge = null, neighborId = null, bBase = null;
  if (focusedIdx >= 0 && nonCollapsed.length >= 2) {
    let nIdx = focusedIdx + 1;
    if (nIdx >= nonCollapsed.length) nIdx = focusedIdx - 1;
    neighborId = nonCollapsed[nIdx];
    edge = nIdx > focusedIdx ? "trailing" : "leading";
    const bTgt = state.lastTileTarget?.[+neighborId]?.frame;
    const bLive = state.windowsById[neighborId]?.frame;
    bBase = state.pinnedSizes[+neighborId]
      ?? (bTgt ? major(bTgt) : null)
      ?? (bLive ? major(bLive) : null);
  }

  startDragBracket();
  gestureBracket = {
    winId: w.id,
    horizontal,
    vf,
    nonCollapsed,
    collapsed,
    aBase,
    reqMajor: aBase,
    edge,
    neighborId,
    bBase,
    predicted: { ...w.frame }
  };
  // Create the preview overlay at the frozen frame (GLOBAL coords). Async: the
  // first few steps may land before it resolves — the handle guard below and
  // the next step's setFrame cover the gap. If the bracket already closed by
  // the time create resolves, drop the orphan.
  sd.overlay.region({ rect: { ...w.frame }, html: PREVIEW_HTML, css: PREVIEW_CSS })
    .then((h) => {
      if (gestureBracket && h) { previewHandle = h; h.setFrame(gestureBracket.predicted); }
      else if (h) h.remove();
    });
  log(`GESTURE bracket-open id=${w.id}`);
  return gestureBracket;
}

// One resize step: deltaPx > 0 grows the focused window (up), < 0 shrinks it
// (down). The neighbor that gives/takes the space is fixed at bracket-open, so
// the direction is consistent regardless of the window's slot.
function stepPreview(deltaPx) {
  if (!gestureBracket) {
    if (!openGestureBracket()) return;
  } else if (!state.dragInFlight) {
    // The bracket's 5s safety timeout cleared dragInFlight mid-gesture; keep the
    // accumulated state, just re-raise the tile gate.
    startDragBracket();
  }
  const g = gestureBracket;
  if (!g.vf || g.neighborId == null) return; // solo/unknown: nothing to resize

  // Clamp: window >= RESIZE_MIN_PX, neighbor >= PIN_MIN_PX. No app-minimum
  // guess — refusal pins are unreliable minimums (they blocked legit shrinks);
  // a shrink past a real app min just snaps a little on commit, which the
  // self-contained commit keeps contained.
  g.reqMajor = Math.max(RESIZE_MIN_PX, g.reqMajor + deltaPx);
  if (g.bBase != null) {
    // Ceiling: the neighbor can only shrink to PIN_MIN_PX, so the window can
    // grow at most by what the neighbor gives up.
    g.reqMajor = Math.min(g.reqMajor, Math.max(RESIZE_MIN_PX, g.aBase + g.bBase - PIN_MIN_PX));
  }

  const sizeOf = (id) => { const fr = state.windowsById[id]?.frame; return fr ? { w: fr.w, h: fr.h } : null; };
  const r = predictResizeFrame({
    screenFrame: g.vf, horizontal: g.horizontal,
    nonCollapsed: g.nonCollapsed, collapsed: g.collapsed,
    weightOf: getWindowWeight, sizeOf,
    pins: state.pinnedSizes, refusalSet: state.refusalPins,
    appMinOf: (id) => appMinFor(id, g.horizontal),
    activeId: g.winId, requestedSize: g.reqMajor, aBase: g.aBase,
    neighborId: g.neighborId, bBase: g.bBase,
    floor: PIN_MIN_PX
  });
  if (r.frame) {
    g.predicted = r.frame;
    if (previewHandle) previewHandle.setFrame(g.predicted);
  }
}

export function bind() {
  sd.bang.declare("sd.tttap.dragStep").on((detail) => {
    // Number() because `stackd bang sd.tttap.dragStep fingers=3 ...` delivers
    // CLI KEY=VAL detail values as strings; the tttaps emitter sends numbers.
    if (!detail || Number(detail.fingers) !== 3) return;
    // Simulated fullscreen parks the other tiles off-screen, so
    // reorder/resize is meaningless until exit.
    if (isFullscreenActive()) return;
    // An open bracket WE didn't open means a pointer drag is mid-flight —
    // a step would retile under the cursor.
    if (state.dragInFlight && !gestureBracket) return;
    log(`GESTURE dragStep ${detail.direction}`);

    // Up grows the focused window, down shrinks it; left/right reorder.
    // Orientation-independent — the resize MATH still reads the display axis
    // from the bracket (width on a row, height on a column).
    const dir = detail.direction;
    if (dir === "up" || dir === "down") {
      stepPreview(dir === "up" ? RESIZE_STEP_PX : -RESIZE_STEP_PX);
    } else {
      // Reorder — never inside an open resize bracket (the recognizer's axis
      // lock makes a mixed stream near-impossible; belt to its suspenders).
      if (gestureBracket) return;
      moveWindowInOrder(dir === "left" ? "backward" : "forward");
    }
  });

  // Fingers lifted after a drag-active gesture. Only meaningful when WE opened
  // the bracket; mouse brackets close via the leftMouseUp eventtap.
  sd.bang.declare("sd.tttap.dragEnd").on(() => {
    if (!gestureBracket) return;
    const g = gestureBracket;
    gestureBracket = null;
    if (previewHandle) { previewHandle.remove(); previewHandle = null; }
    const major = (fr) => (g.horizontal ? fr.w : fr.h);
    const dMajor = g.predicted ? Math.abs(major(g.predicted) - g.aBase) : 0;
    // Self-contained commit: tear the bracket down (dropping any stray candidate
    // a foreign resize bang recorded mid-gesture) and pin + retile synchronously.
    // Routing through the mouse-drag close would let that foreign candidate be
    // reinterpreted as a cross-display drop and defer the retile 100ms (a gap).
    clearDragBracket();
    if (dMajor >= 1 && g.neighborId != null && g.predicted) {
      sd.windows.setFrame(g.winId, { ...g.predicted });
      if (state.windowsById[g.winId]) state.windowsById[g.winId].frame = { ...g.predicted };
      pinFromActualSize(g.winId, { edge: g.edge, neighborId: g.neighborId });
      state.snapNextTile = true;
      log(`GESTURE commit id=${g.winId} ${g.horizontal ? "w" : "h"}=${Math.round(major(g.predicted))} edge=${g.edge}`);
    } else {
      log("GESTURE bracket-close (no net change)");
    }
    tileWindows();
  });
}
