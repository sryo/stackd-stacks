// Pure decisions behind the snapshot strip (snapshots.js), kept free of
// sd:// imports so they run under plain node.

/// Whether a thumbnail saved in a previous session is restored on load.
///   entry       : the persisted snapshot data (absent → nothing to restore)
///   live        : the window's sd.windows.all entry, if listed. The list
///                 includes minimized windows, so presence alone says nothing.
///   axMinimized : sd.windows.isMinimized(id), the authoritative read
/// Kept only while AX still reports the window minimized and the list doesn't
/// contradict it.
export function keepPersistedSnapshot({ entry, live, axMinimized }) {
  if (!entry || !axMinimized) return false;
  return !(live && live.isMinimized === false);
}

/// What one view of a leftMouseDown does, given the context menu's state.
///   tap    : "observe" (the non-consuming eventtap, every click) or "direct"
///            (the click the rail or menu overlay itself received)
///   inMenu : click inside the menu's rect; onRow: on one of its rows
///   onTile : click on a thumbnail
/// Returns "tile" | "row" | "dismiss" | "none". A click on a tile or the menu
/// arrives both ways, in no set order, so each click is claimed by exactly
/// one of them and the menu state is read, not changed, by the other.
/// While the menu is open a thumbnail click only dismisses it.
export function menuClickAction({ tap, menuOpen, inMenu, onRow, onTile }) {
  if (!menuOpen) return tap === "direct" && onTile ? "tile" : "none";
  if (tap === "observe") return inMenu || onTile ? "none" : "dismiss";
  if (inMenu) return onRow ? "row" : "none";
  return "dismiss";
}

/// Global top-left for a context menu of `size` opened at cursor `p`, kept
/// `margin` px inside `bounds` (the global frame of the panel that draws it)
/// on all four sides.
export function clampMenuOrigin(p, size, bounds, margin = 4) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  return {
    x: clamp(p.x, bounds.x + margin, bounds.x + bounds.w - size.w - margin),
    y: clamp(p.y, bounds.y + margin, bounds.y + bounds.h - size.h - margin),
  };
}

/// Strip scroll offset after one scrollWheel payload. Point deltas are
/// positive when content moves toward the start, so the offset shrinks by
/// the delta. The dominant axis drives it, so a mouse wheel (deltaY only)
/// and a sideways trackpad swipe both scroll either strip orientation.
/// computeStrip clamps the result to the strip's content.
export function scrolledOffset(cur, { deltaX = 0, deltaY = 0 } = {}) {
  const d = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
  return (cur || 0) - d;
}

/// Global rect for a strip's rail overlay: its thumbnails' bounding box grown
/// by `margin` (room for their shadow), clipped to the reserved band. The
/// overlay takes real clicks, so it must not cover the band's empty rest,
/// where desktop icons sit. null when no thumbnail is inside the band.
export function railRect({ reserved, tiles }, margin) {
  if (!tiles.length) return null;
  const x0 = Math.max(reserved.x, Math.min(...tiles.map((t) => t.gx)) - margin);
  const y0 = Math.max(reserved.y, Math.min(...tiles.map((t) => t.gy)) - margin);
  const x1 = Math.min(reserved.x + reserved.w, Math.max(...tiles.map((t) => t.gx + t.gw)) + margin);
  const y1 = Math.min(reserved.y + reserved.h, Math.max(...tiles.map((t) => t.gy + t.gh)) + margin);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/// Context menu height: `items` rows, with null entries as separators.
export function menuHeight(items, { rowH, sepH, pad }) {
  return items.reduce((h, it) => h + (it ? rowH : sepH), pad * 2);
}
