// Onscreen-return detection for the sd.windows.all push. The tiler drops a
// window that stays offscreen past its grace (tiler.js), and the all-push is
// deliberately not a tile trigger, so without this a window that comes back
// (its desktop shown again after another app's fullscreen space, or a Cmd+H
// window unhidden) would stay out of the rotation. Pure — node-testable.

/// Ids in `list` that the tiler had counted as offscreen (`offscreenSince`
/// holds them) and that are onscreen again. Only `onscreen === false` means
/// offscreen, matching the tiler.
export function returnedOnscreen(prevById, list, offscreenSince) {
  const ids = [];
  for (const w of list) {
    if (offscreenSince[w.id] == null) continue;
    if (prevById[w.id]?.onscreen === false && w.onscreen !== false) ids.push(+w.id);
  }
  return ids;
}
