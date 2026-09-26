// The float zone: a column at the right of a display's tile area where
// floated windows sit at their own size, so no tile ever covers them. Pure —
// imports nothing, so node tests load it directly.
//
// Floats can only be moved, not resized, so the zone is sized by its
// members: as narrow as the widest one when they fit stacked, wider (up to
// maxW) when they only fit side by side, and whatever still doesn't fit
// overflows oldest first — the newest float stays live.

// Rows of members, left to right, each no wider than `limit`.
function rows(members, limit, pad) {
  const out = [];
  let row = null;
  for (const m of members) {
    if (row && row.w + pad + m.w <= limit) {
      row.items.push(m);
      row.w += pad + m.w;
      row.h = Math.max(row.h, m.h);
    } else {
      row = { items: [m], w: m.w, h: m.h };
      out.push(row);
    }
  }
  return out;
}

function height(rs, pad) {
  return rs.reduce((s, r) => s + r.h, 0) + pad * (rs.length + 1);
}

// area: the tile area (already clear of the snapshots rail).
// members: [{id, w, h}] in dock order, oldest first.
// Returns { zone, tileArea, placements: [{id, x, y}], overflow: [id] }.
export function planFloatZone({ area, members, gap = 0, pad = 8, maxW }) {
  const inner = maxW - 2 * pad;
  const overflow = [];
  const live = [];
  for (const m of members) {
    if (m.w > inner) overflow.push(m.id);
    else live.push(m);
  }

  let packed = null;
  while (live.length) {
    const widest = Math.max(...live.map((m) => m.w));
    for (const limit of [widest, inner]) {
      const rs = rows(live, limit, pad);
      if (height(rs, pad) <= area.h) { packed = rs; break; }
    }
    if (packed) break;
    overflow.push(live.shift().id);
  }
  // Oversized members were set aside first; report overflow in dock order.
  const order = new Map(members.map((m, i) => [m.id, i]));
  const over = overflow.sort((a, b) => order.get(a) - order.get(b));

  if (!packed) return { zone: null, tileArea: { ...area }, placements: [], overflow: over };

  const zw = Math.max(...packed.map((r) => r.w)) + 2 * pad;
  const zone = { x: area.x + area.w - zw, y: area.y, w: zw, h: area.h };
  const placements = [];
  let y = area.y + pad;
  for (const r of packed) {
    let x = zone.x + pad;
    for (const m of r.items) {
      placements.push({ id: m.id, x, y });
      x += m.w + pad;
    }
    y += r.h + pad;
  }
  return {
    zone,
    tileArea: { x: area.x, y: area.y, w: Math.max(0, area.w - zw - gap), h: area.h },
    placements,
    overflow: over,
  };
}

// Floats to dock: automatic floats (fixed-size, learned panels) as soon as
// they're known and visible,
// so the tiles make room as a direct result of opening one. User-floated
// windows (ctrl+cmd+p) and ones dragged out of the zone stay put.
// floats: [{id, reason, onscreen, minimized}], reason from floatReason.
export function floatsToDock({ floats, docked, loose }) {
  return floats
    .filter((f) => f.reason !== "user" && f.onscreen !== false && !f.minimized &&
      !docked.has(f.id) && !loose.has(f.id))
    .map((f) => f.id);
}
