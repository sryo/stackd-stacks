// Which windows the tiler takes, and which it leaves floating at the frame
// their app chose. Pure — imports nothing, so node tests load it directly.
//
// A window's traits come from sd.windows.all: isResizable (its size can be
// set at all) and canFullscreen (it has an enabled fullscreen button).
// Panels that still report AXStandardWindow — Calculator, About This Mac,
// an app's Settings, Finder's Get Info — refuse any size, and float.
// Fixed-width windows like System Settings do resize, but only vertically;
// they tile, pinned at their width. They're told apart from min-width
// windows (Activity Monitor) by refusing to grow, which the tiler learns
// per app (refusedGrowth, fixedWidthPin).

// opts.override: "float" | "tile" | undefined — the user's per-window toggle.
// opts.panelApp: the window's app has shown panels (isPanelRefusal).
// opts.collapsible: the window has been seen titlebar-collapsed (Stickies).
// A collapsed window reports its size as unsettable, and the reading is
// cached for the window's life, so it says nothing about the window.
export function floatReason(w, opts = {}) {
  if (opts.override === "float") return "user";
  if (opts.override === "tile") return null;
  if (opts.collapsible) return null;
  if (w.isResizable === false) return "fixed-size";
  if (opts.panelApp && w.canFullscreen === false) return "panel";
  return null;
}

// Traits must be confirmed like isStandard: a window whose traits haven't
// been read yet waits for the push that carries them.
export function isTileable(w, opts = {}) {
  if (!w || w.isStandard !== true) return false;
  if (w.isResizable === undefined) return false;
  return floatReason(w, opts) == null;
}

// Toggle: a tiled window floats; a user-floated one returns to automatic;
// an automatically floated one is forced into the tiling.
export function nextOverride(w, opts = {}) {
  if (floatReason(w, opts) == null) return "float";
  if (opts.override === "float") return undefined;
  return opts.override === "tile" ? "float" : "tile";
}

// The window ended up more than px smaller than its target on the major
// axis: it has a maximum size, which a tile it can't fill would leave as a
// gap. Larger-than-target is a minimum size — tileable, contained by a pin.
export function refusedGrowth(target, live, horizontal, px) {
  const d = horizontal ? target.w - live.w : target.h - live.h;
  return d > px;
}

// A window that resizes but can't grow to its tile's full height, and has
// no fullscreen button, is a panel (Finder's Get Info): System Settings and
// Activity Monitor, also without the button, grow to full height. Height on
// either orientation — in a portrait column the cross axis is width, where
// System Settings' fixed width would otherwise read as a panel.
export function isPanelRefusal(w, target, live, px) {
  return w.canFullscreen === false && refusedGrowth(target, live, false, px);
}

// The pinned width for a window whose app was learned fixed-width
// (learnedPx), or null. Only windows without a fullscreen button: the same
// app's fullscreen-capable windows resize freely.
export function fixedWidthPin(w, learnedPx) {
  if (w.canFullscreen !== false || !(learnedPx > 0)) return null;
  return learnedPx;
}

// A window whose app collapsed or expanded it (a Stickies note going to or
// from the rail) since its last tile. Only the height changes, so a
// major-axis drift check on a landscape display never sees it.
export function collapsedChanged(target, live, collapsedH) {
  return !!target && !!live && (target.h <= collapsedH) !== (live.h <= collapsedH);
}

// A moved/resized report for a collapsed widget that is the app arranging
// its own rail (Stickies re-spaces collapsed notes) rather than a change the
// tiler must answer: it was already collapsed at its target and stayed on
// the rail's row.
export function isRailShuffle(target, live, collapsedH) {
  if (!live || live.h > collapsedH) return false;
  if (!target) return true;
  return target.h <= collapsedH && Math.abs(live.y - target.y) <= collapsedH;
}

// The size a window held above its target on the tiling axis, when it held
// more than `px` above it (an app minimum the target went under); else null.
// Never while it is still animating: its frame then is the one from before
// the animation, not a size it held.
export function heldAbove(target, live, horizontal, px, animating = false) {
  if (animating || !target || !live) return null;
  const held = horizontal ? live.w : live.h;
  return held - (horizontal ? target.w : target.h) > px ? held : null;
}
