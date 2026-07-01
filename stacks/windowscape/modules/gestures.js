// Trackpad gesture verbs — maps TTTaps bangs onto window operations.
// The recognizer lives in the tttaps stack: a 3-finger drag fires one
// axis-locked sd.tttap.dragStep per commit-threshold of travel, so the
// user can step through positions/sizes and reverse without lifting.
//
// Horizontal steps route to the same reorder op the hotkeys use.
// Vertical steps are PREVIEW-ONLY: the gesture scales an outline (a div in
// windowscape's own fullscreen panel, styled like overlay-border's focus
// ring) around the focused window's center — the window itself never moves
// mid-gesture. On sd.tttap.dragEnd the final frame commits with ONE
// setFrame and the drag bracket closes, which runs the one pairwise pin +
// single retile, same as dropping a mouse resize.

import { sd } from "sd://runtime/api.js";
import { state, log, displayForWindow } from "./core.js";
import { adjustedFrameForDisplay } from "./snapshots.js";
import { isFullscreenActive } from "./fullscreen.js";
import { moveWindowInOrder } from "./operations.js";
import { startDragBracket, endDragBracket } from "./events.js";
import { cancelAnimation } from "./animation.js";

// Resize feel: vertical steps commit every 0.035 of trackpad travel (see
// tttaps CFG.dragStepCommitThresholdV) at 40px each — finer than the
// hotkeys' 100px GROW_STEP_PX so a drag reads as continuous growth. Steps
// only touch the preview DOM (no RPCs), so no coalescing is needed.
const RESIZE_STEP_PX = 40;
const RESIZE_MIN_PX  = 100; // matches operations.js PIN_MIN_PX

// Gesture-resize bracket. The vertical 3-finger drag rides the SAME
// bracket as a mouse drag (events.startDragBracket / endDragBracket): the
// first vertical step opens it (tile passes auto-defer while dragInFlight)
// and freezes the focused window's frame as the scale origin; each step
// re-scales the preview outline around that frame's center, clamped to the
// display work area — so the rightmost window slides left instead of dying
// against the screen edge (trailing-edge growth had no room to grow,
// 2026-06-10). dragEnd commits the previewed frame and closes the bracket.
let gestureBracket = null; // { winId, origFrame, frame, horizontal, vf } while active

// --- preview outline -------------------------------------------------------
// Drawn via a daemon free-region overlay (sd.overlay.region) at the preview's
// GLOBAL rect, so it lands on whichever display holds the focused window —
// windowscape's own panel is display:"primary" and couldn't render it on
// other displays (the outline/topbar appear there via their own stacks).
// Styled to read as overlay-border's ring (8px blue, 16px radius); the
// overlay panel IS the rect, so .ring fills it (inset:0).
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
  // A tile animation still converging on this window would make the frozen
  // scale origin stale — settle it where it stands.
  cancelAnimation(w.id);
  startDragBracket();
  gestureBracket = {
    winId: w.id,
    origFrame: { ...w.frame },
    frame: { ...w.frame },
    horizontal: d ? d.frame.w > d.frame.h : true,
    // Clamp against the snapshot-rail-adjusted work area, not the raw
    // visibleFrame — a gesture-grow of the rightmost window would
    // otherwise legally extend under the strip.
    vf: (d && (adjustedFrameForDisplay(d) || d.visibleFrame || d.frame)) || null
  };
  // Create the preview overlay at the frozen frame (GLOBAL coords, so the
  // daemon places it on the focused window's display). Async: the first few
  // steps may land before it resolves — setFrame guards on the handle and the
  // next step re-sends the latest frame, so nothing visible is lost. If the
  // bracket already closed by the time create resolves, drop the orphan.
  sd.overlay.region({ rect: { ...w.frame }, html: PREVIEW_HTML, css: PREVIEW_CSS })
    .then((h) => {
      if (gestureBracket && h) { previewHandle = h; h.setFrame(gestureBracket.frame); }
      else if (h) h.remove();
    });
  log(`GESTURE bracket-open id=${w.id}`);
  return gestureBracket;
}

function stepPreview(deltaPx) {
  // Open on the first vertical step; re-arm if the bracket's 5s safety
  // timeout cleared dragInFlight mid-gesture (very long drags) — keep the
  // accumulated frame, just re-raise the tile gate.
  if (!gestureBracket) {
    if (!openGestureBracket()) return;
  } else if (!state.dragInFlight) {
    startDragBracket();
  }
  const g = gestureBracket;
  // Scale around the ORIGINAL frame's center on the major axis, clamped to
  // the display work area (grow at an edge slides inward, never offscreen).
  if (g.horizontal) {
    const cx = g.origFrame.x + g.origFrame.w / 2;
    g.frame.w = Math.max(RESIZE_MIN_PX, g.frame.w + deltaPx);
    if (g.vf) g.frame.w = Math.min(g.frame.w, g.vf.w);
    g.frame.x = cx - g.frame.w / 2;
    if (g.vf) {
      if (g.frame.x < g.vf.x) g.frame.x = g.vf.x;
      if (g.frame.x + g.frame.w > g.vf.x + g.vf.w) g.frame.x = g.vf.x + g.vf.w - g.frame.w;
    }
  } else {
    const cy = g.origFrame.y + g.origFrame.h / 2;
    g.frame.h = Math.max(RESIZE_MIN_PX, g.frame.h + deltaPx);
    if (g.vf) g.frame.h = Math.min(g.frame.h, g.vf.h);
    g.frame.y = cy - g.frame.h / 2;
    if (g.vf) {
      if (g.frame.y < g.vf.y) g.frame.y = g.vf.y;
      if (g.frame.y + g.frame.h > g.vf.y + g.vf.h) g.frame.y = g.vf.y + g.vf.h - g.frame.h;
    }
  }
  if (previewHandle) previewHandle.setFrame(g.frame);
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
    switch (detail.direction) {
      case "left":
      case "right":
        // Reorders retile immediately; don't run one inside an open
        // gesture-resize bracket (the recognizer's axis lock makes a mixed
        // stream near-impossible, this is the belt to its suspenders).
        if (gestureBracket) return;
        moveWindowInOrder(detail.direction === "left" ? "backward" : "forward");
        break;
      case "up":    stepPreview(RESIZE_STEP_PX);  break;
      case "down":  stepPreview(-RESIZE_STEP_PX); break;
    }
  });

  // Fingers lifted after a drag-active gesture. Only meaningful when WE
  // opened the bracket; mouse brackets close via the leftMouseUp eventtap.
  sd.bang.declare("sd.tttap.dragEnd").on(() => {
    if (!gestureBracket) return;
    const g = gestureBracket;
    gestureBracket = null;
    if (previewHandle) { previewHandle.remove(); previewHandle = null; }
    const dMajor = g.horizontal
      ? Math.abs(g.frame.w - g.origFrame.w)
      : Math.abs(g.frame.h - g.origFrame.h);
    if (dMajor >= 1) {
      // Commit the previewed frame with ONE setFrame. Seed the bracket's
      // candidate + live frame ourselves: the AX resized bang can trail
      // past endDragBracket's 100ms grace, and the close decision needs
      // both to run the pairwise pin (the trailing bang then re-records
      // the same candidate — harmless).
      sd.windows.setFrame(g.winId, { ...g.frame });
      if (state.windowsById[g.winId]) state.windowsById[g.winId].frame = { ...g.frame };
      state.dragCandidateId = g.winId;
      log(`GESTURE commit id=${g.winId} ${g.horizontal ? "w" : "h"}=${Math.round(g.horizontal ? g.frame.w : g.frame.h)} → endDragBracket`);
    } else {
      log("GESTURE bracket-close (no net change) → endDragBracket");
    }
    endDragBracket();
  });
}
