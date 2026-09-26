// Hover tooltip for the minimized-window strip: what it says and where its
// overlay panel goes. The strip tiles live in click-through region overlays
// whose bounds are the strip band itself, so the tooltip needs its own panel
// beside the tile rather than a DOM element in either page. Pure —
// node-testable.

export const TIP_W = 340;   // panel size; the bubble inside hugs the tile side
export const TIP_H = 64;    // room for two lines of 13px text plus padding
export const TIP_GAP = 8;   // space between tile and panel
const MAX_CHARS = 60;

export function truncateMiddle(input, maxLength) {
  if (!input) return "";
  if (input.length <= maxLength) return input;
  const keep = maxLength - 3;
  return input.slice(0, Math.ceil(keep / 2)) + "..." + input.slice(input.length - Math.floor(keep / 2));
}

/// App name and window title, one per line; a single line when they are the
/// same or one is missing.
export function tooltipLines(data) {
  const app = data.app || "";
  const title = data.title || "";
  let lines;
  if (app && title && app !== title) lines = [app, title];
  else if (app) lines = [app];
  else lines = [title || "Untitled"];
  return lines.map((l) => truncateMiddle(l, MAX_CHARS));
}

/// Global rect for the tooltip panel. On a right-edge rail (landscape
/// display) it sits left of the tile, bubble right-aligned against it; on a
/// bottom strip it sits above, bubble bottom-aligned. `bounds` (the display
/// frame) keeps a tile near the end of the strip from pushing it off-screen.
export function tooltipRect(tile, rightRail, bounds) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  if (rightRail) {
    let y = tile.gy + tile.gh / 2 - TIP_H / 2;
    if (bounds) y = clamp(y, bounds.y, bounds.y + bounds.h - TIP_H);
    return { x: tile.gx - TIP_GAP - TIP_W, y, w: TIP_W, h: TIP_H, align: "right" };
  }
  let x = tile.gx + tile.gw / 2 - TIP_W / 2;
  if (bounds) x = clamp(x, bounds.x, bounds.x + bounds.w - TIP_W);
  return { x, y: tile.gy - TIP_GAP - TIP_H, w: TIP_W, h: TIP_H, align: "bottom" };
}
