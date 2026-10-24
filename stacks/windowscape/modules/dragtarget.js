// The window under a drag's mouse-down, as the daemon's hit test reports it
// (sd.windows.at: { id, region, edges, ... } or null). Pure; events.js feeds
// it the hit and the bracket's bangs.
//
// Before the hit test the bracket guessed the dragged window from whichever
// moved/resized bang came last, so a neighbor refusing a write or a service
// window shuffling itself mid-drag could become "the drag". A null hit (the
// press landed on a stackd window, or the answer hasn't come yet) keeps that
// old rule.

// True when a mid-bracket bang for window `id` may be the drag's.
export function acceptsBang(target, id) {
  return target == null || +target.id === +id;
}

// The id of the tiled window whose title bar the press landed on (a
// double-click there may zoom it), else null. Counts the bar's controls too:
// a title bar drawn by web content (Electron) reads as "control" all over,
// and a missed zoom pins the zoomed size, where a false suspect costs
// nothing unless the window really resizes.
export function titlebarPress(hit, isTiled) {
  if (!hit || (hit.region !== "titlebar" && hit.region !== "control") || !isTiled(+hit.id)) return null;
  return +hit.id;
}

// True when a release frame `dW`/`dH` off the tile target is the user
// resizing the window. A window dragged by its title bar can still change
// size (macOS fits it to the display it lands on, or tiles it at a screen
// edge); that is no resize to pin.
export function isUserResize(target, dW, dH) {
  if (dW <= 20 && dH <= 20) return false;
  return !target || target.region !== "titlebar";
}
