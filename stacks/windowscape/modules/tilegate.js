// Gate for a tile pass: which state, if any, holds it back. Pure:
// node-testable. tiler.js logs the reason and handles any follow-up (a drag
// defers its pass to the bracket's end).

/// null when a pass may run, else a short reason:
///   "booting"          — init hasn't restored the saved order and snapshot
///                        rail yet; init runs the first pass itself.
///   "drag"             — a drag is in flight; moving windows now yanks the
///                        dragged one out from under the cursor.
///   "fullscreen"       — simulated fullscreen owns the display.
///   "display-settling" — windowsById still holds pre-change frames; the
///                        settle tiles.
///   "snapshot"         — a window is being captured into the rail.
export function tileSkipReason(s) {
  if (s.booting) return "booting";
  if (s.dragInFlight) return "drag";
  if (s.fullscreenState && s.fullscreenState.active) return "fullscreen";
  if (s.displaySettling) return "display-settling";
  if (s.snapshotsState && s.snapshotsState.isCreating) return "snapshot";
  return null;
}
