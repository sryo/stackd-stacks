// A space's left-to-right tile order. No sd import, so node can test it.

/// The order after a membership change. `prev` is the last order,
/// `eligible` the ids that tile now (in discovery order), `held` the ids
/// that keep their place without tiling — minimized windows, so a restore
/// lands back in the slot it left. Existing ids keep their relative order,
/// new eligible ids append, anything else drops out.
export function nextSpaceOrder(prev, eligible, held) {
  const tiles = new Set(eligible);
  const seen = new Set();
  const next = [];
  for (const id of prev) {
    if (seen.has(id) || !(tiles.has(id) || held.has(id))) continue;
    next.push(id);
    seen.add(id);
  }
  for (const id of eligible) {
    if (seen.has(id)) continue;
    next.push(id);
    seen.add(id);
  }
  return next;
}

/// Windows in row order (left-to-right, or top-to-bottom for a column).
/// `recent` is the id order a reorder just produced; while it still holds
/// exactly these windows it wins, because the tile pass that moves them
/// awaits a read of every window before recording targets, so a quick
/// second step can land before either frames or targets show the swap.
/// Otherwise windows sort by where the tiler is sending them (`targets`,
/// state.lastTileTarget) and by their live frame only without a target:
/// mid-animation the live frames still show the previous layout.
export function sortBySlot(wins, horizontal, targets, recent) {
  if (recent && recent.length === wins.length) {
    const rank = new Map(recent.map((id, i) => [+id, i]));
    if (wins.every((w) => rank.has(+w.id))) {
      return [...wins].sort((a, b) => rank.get(+a.id) - rank.get(+b.id));
    }
  }
  const center = (win) => {
    const f = targets?.[+win.id]?.frame || win.frame;
    return horizontal ? f.x + f.w / 2 : f.y + f.h / 2;
  };
  return [...wins].sort((a, b) => center(a) - center(b));
}

/// Whether a window's cached Space list is stale for the display its frame
/// is on: the list lacks that display's active Space but holds another
/// display's active Space. That happens when the window changed displays
/// without a drag (the OS pushing a window it couldn't fit, an app moving
/// itself) — the list was read on the old display.
export function staleSpacesFor(cached, activeSpace, otherActiveSpaces) {
  if (!cached || cached.length === 0 || cached.includes(activeSpace)) return false;
  return otherActiveSpaces.some((s) => cached.includes(s));
}
