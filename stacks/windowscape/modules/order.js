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
