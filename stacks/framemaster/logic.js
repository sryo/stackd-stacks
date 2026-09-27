// Pure hot-corner geometry for FrameMaster. No sd.* access, so it runs under
// plain node (tests/logic.test.mjs). Rects are global top-left coordinates,
// the same space as sd.display.all frames.

// The four `band`-sized corner squares of every display, in the order
// top-left, top-right, bottom-left, bottom-right per display.
export function cornerRects(displays, band) {
  const out = [];
  for (const d of displays) {
    const f = d && d.frame; if (!f) continue;
    out.push({ x: f.x,            y: f.y,            w: band, h: band });
    out.push({ x: f.x + f.w - band, y: f.y,            w: band, h: band });
    out.push({ x: f.x,            y: f.y + f.h - band, w: band, h: band });
    out.push({ x: f.x + f.w - band, y: f.y + f.h - band, w: band, h: band });
  }
  return out;
}

export function sameRects(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((r, i) => r.x === b[i].x && r.y === b[i].y && r.w === b[i].w && r.h === b[i].h);
}

export function inFrame(f, x, y) {
  return !!f && x >= f.x && x < f.x + f.w && y >= f.y && y < f.y + f.h;
}
