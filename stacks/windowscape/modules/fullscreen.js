// Simulated fullscreen — port of WindowScape/fullscreen.lua.
//
// "Simulated" vs native: the focused window expands to fill its display's
// visibleFrame, OTHER windows on the same display+space get parked off-screen
// (1x1 at the bottom-right corner), and the tiler is paused via the
// state.fullscreenState.active guard. No new Space is created — distinct
// from `sd.windows.fullscreen` which sets kAXFullScreen and moves the window
// out to its own Space.
//
// V1 cuts vs the lua source:
// - No overlay buttons (the 510-line fullscreen_ui.lua canvas + AX titlebar
//   measurement). Exit is keybind-only — the user toggles the same hotkey.
// - No expand/contract animation (cfg.enableAnimations applies to retiles,
//   not to the fullscreen transition itself).
// - No screen-config-change reframe loop (the lua's reframeToCurrentScreen).
//   Tier-2: re-anchor on display arrangement changes.
//
// State shape lives on state.fullscreenState in core.js — tiler.js reads
// .active to bail out, this module owns writes.

import { sd } from "sd://runtime/api.js";
import { state, displayForWindow, activeSpaceOnDisplay, getCurrentSpace, isAppIncluded, log } from "./core.js";
import { tileWindows } from "./tiler.js";

// Belt-and-suspenders push to overlay-border so the border has the right
// color even if the focused window's id didn't change across the
// fullscreen flip (focusedChanged would have already pushed otherwise).
function emitInclusionBang(winId) {
  if (!winId) return;
  const w = state.windowsById[winId];
  if (!w) return;
  sd.bang.declare('overlay-border.inclusion').emit({ winId, included: isAppIncluded(w) });
}

// Returns true if the window is on the same display + active space as the
// fullscreened window. Used to decide which peers get parked.
function isPeerOnSameDisplaySpace(peer, displayID, spaceId) {
  if (!peer || !peer.frame) return false;
  const wd = displayForWindow(peer);
  if (!wd || wd.displayID !== displayID) return false;
  const spaces = state.windowSpacesCache[peer.id] || [];
  // If the cache is empty (window never queried), fall back to allowing it —
  // matches lua's behavior of including a window when windowSpaces returns
  // nothing rather than excluding it.
  if (spaces.length === 0) return true;
  return spaces.includes(spaceId);
}

export function isFullscreenActive() {
  return !!(state.fullscreenState && state.fullscreenState.active);
}

export async function enterSimulatedFullscreen(winId) {
  if (!winId) return;
  const fs = state.fullscreenState;
  if (fs.active) return; // already in fullscreen — caller should toggle instead

  const win = state.windowsById[winId];
  if (!win || !win.frame) {
    log(`fullscreen: window ${winId} not in index, aborting`);
    return;
  }

  const d = displayForWindow(win);
  if (!d) {
    log(`fullscreen: no display for window ${winId}, aborting`);
    return;
  }
  const spaceId = activeSpaceOnDisplay(d.uuid) ?? getCurrentSpace();
  if (spaceId == null) {
    log(`fullscreen: no active space for display ${d.displayID}, aborting`);
    return;
  }

  log(`enter simulated fullscreen for win ${winId} (${win.app || "?"})`);

  // Snapshot pre-enter frames + weights + order before we mutate anything.
  // Restoring uses these refs directly — we never re-derive from live state.
  const savedFrames = Object.create(null);
  savedFrames[winId] = { ...win.frame };

  const screenFrame = { ...d.visibleFrame };
  const parkFrame = {
    x: screenFrame.x + screenFrame.w - 1,
    y: screenFrame.y + screenFrame.h - 1,
    w: 1, h: 1
  };

  const peerIds = [];
  for (const id in state.windowsById) {
    const numericId = +id;
    if (numericId === winId) continue;
    const peer = state.windowsById[id];
    if (!isPeerOnSameDisplaySpace(peer, d.displayID, spaceId)) continue;
    savedFrames[numericId] = { ...peer.frame };
    peerIds.push(numericId);
  }

  // Commit fullscreen state BEFORE issuing setFrame so the windowsAll
  // re-ingest the next tick sees fullscreenState.active and the tiler
  // bails. Without this, the off-screen park would race against a
  // debounced retile triggered by our own setFrame events.
  fs.active = true;
  fs.windowId = winId;
  fs.displayID = d.displayID;
  fs.spaceId = spaceId;
  fs.savedFrames = savedFrames;
  fs.savedOrder = [...(state.windowOrderBySpace[spaceId] || [])];
  fs.savedWeights = { ...state.windowWeights };
  fs.savedPinnedSizes = { ...state.pinnedSizes };

  // Park peers + fullscreen the target in one atomic compositor flip.
  await sd.windows.batch(async () => {
    for (const pid of peerIds) {
      await sd.windows.setFrame(pid, parkFrame);
    }
    await sd.windows.setFrame(winId, screenFrame);
  });

  // Re-focus the fullscreened window — parking peers may have shifted focus
  // depending on app behavior. Idempotent if focus didn't move.
  await sd.windows.focus(winId);

  // Belt-and-suspenders bang to overlay-border in case the focus didn't
  // change (toggling fullscreen on the already-focused window).
  emitInclusionBang(winId);
}

export async function exitSimulatedFullscreen() {
  const fs = state.fullscreenState;
  if (!fs.active) return;

  log(`exit simulated fullscreen (win ${fs.windowId})`);

  const savedFrames = fs.savedFrames || {};
  const savedOrder = fs.savedOrder;
  const savedWeights = fs.savedWeights;
  const savedPinnedSizes = fs.savedPinnedSizes;
  const focusedWinId = fs.windowId;
  const spaceId = fs.spaceId;

  // Clear state FIRST so the tiler's guard releases. Any retile we kick
  // off below needs the guard down.
  fs.active = false;
  fs.windowId = null;
  fs.displayID = null;
  fs.spaceId = null;
  fs.savedFrames = Object.create(null);
  fs.savedOrder = null;
  fs.savedWeights = null;
  fs.savedPinnedSizes = null;

  // Restore the order + weights + pins snapshots. If the saved order
  // references ids that have since died (window closed mid-fullscreen)
  // the next updateWindowOrder call will prune them on its eligibility pass.
  if (savedOrder && spaceId != null) {
    state.windowOrderBySpace[spaceId] = savedOrder;
  }
  if (savedWeights) {
    state.windowWeights = savedWeights;
  }
  if (savedPinnedSizes) {
    state.pinnedSizes = savedPinnedSizes;
  }

  // Re-park sweep — restore each saved frame for windows still alive.
  // The fullscreened window itself is included so it shrinks back to its
  // pre-enter size. Dead ids are silently skipped; the next tile pass
  // will reflow whatever remains.
  await sd.windows.batch(async () => {
    for (const idStr of Object.keys(savedFrames)) {
      const id = +idStr;
      if (!state.windowsById[id]) continue;
      await sd.windows.setFrame(id, savedFrames[idStr]);
    }
  });

  // Tile to settle any divergence between saved frames and current weight
  // distribution (e.g. peers that were added/removed while fullscreened).
  await tileWindows();

  // Restore focus to the previously fullscreened window if it's still
  // alive; otherwise the focus signal will resolve to whatever macOS
  // promotes after the window closed.
  if (focusedWinId && state.windowsById[focusedWinId]) {
    await sd.windows.focus(focusedWinId);
  }

  // Belt-and-suspenders bang — same id may be focused, so focusedChanged
  // wouldn't fire, but the border needs to reset to the right palette.
  if (focusedWinId) emitInclusionBang(focusedWinId);
}

// Exported keybind verb — flips between enter/exit based on current state.
// If fullscreen is active on a DIFFERENT window than the focused one,
// exit first then enter on the focused window (matches lua line 56-60
// where enter() short-circuits to exit() if state.active is already true).
export async function toggleSimulatedFullscreen() {
  const f = sd.windows.focused.peek();
  const fs = state.fullscreenState;

  if (fs.active) {
    // Whether the focused window matches the fullscreened one or not,
    // toggling exits — the lua behavior is "any toggle press leaves
    // fullscreen". Tier-2 could swap fullscreen target instead.
    await exitSimulatedFullscreen();
    return;
  }

  if (!f || !f.id) {
    log("fullscreen toggle: no focused window");
    return;
  }
  await enterSimulatedFullscreen(f.id);
}

// Called by events.js when a window is destroyed — if the fullscreened
// window dies mid-fullscreen, drop the active flag and tile so the others
// come back into view. Without this the parked peers would stay off-screen
// and the user would see an empty display with no way out.
export async function onWindowDestroyed(destroyedId) {
  const fs = state.fullscreenState;
  if (!fs.active) return;
  if (fs.windowId !== destroyedId) return;

  log(`fullscreened window ${destroyedId} destroyed — auto-exit`);
  // Clear the windowId so exit doesn't try to refocus a dead id.
  fs.windowId = null;
  await exitSimulatedFullscreen();
}
