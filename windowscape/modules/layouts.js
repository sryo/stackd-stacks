// Weighted tiling distribution — port of layouts.lua tileWeighted.
// distributeWeighted / distributeEven match the Lua exactly.

import { cfg } from "./config.js";

// Distribute `total` across `items` proportionally to `weightOf(item)`,
// reserving `gap` between cells. No per-item constraint handling — the
// tiler observes live actuals after setFrame and redistributes leftover
// space in a second sub-pass (see tiler.js). Per BELIEFS #1, min/max
// belong to live AX, not a persistent cache.
export function distributeWeighted(total, gap, items, weightOf) {
  if (items.length === 0) return [];
  let totalW = 0;
  for (const it of items) totalW += weightOf(it);
  const avail = total - Math.max(items.length - 1, 0) * gap;
  const sizes = new Array(items.length);
  let allocated = 0;
  for (let i = 0; i < items.length; i++) {
    if (i === items.length - 1) {
      sizes[i] = avail - allocated;
    } else {
      sizes[i] = Math.floor(avail * weightOf(items[i]) / totalW);
      allocated += sizes[i];
    }
  }
  return sizes;
}

export function distributeEven(total, gap, count) {
  if (count <= 0) return { base: 0, rem: 0 };
  const avail = total - Math.max(count - 1, 0) * gap;
  const base = Math.floor(avail / count);
  return { base, rem: avail - base * count };
}

// Returns [{winId, frame}, ...] frames for the given screen layout.
// horizontal=true: landscape (tile left→right), false: portrait.
//
// sizeOf(id) -> {w,h} returns the window's CURRENT live size. Used for
// collapsed windows so we position them in the strip without forcing a
// width that the app would refuse (Sticky Notes refuses width changes
// and stays at its content-determined size; forcing causes overlap
// because positions accumulate from `base` rather than the actual width
// the app honors). For non-collapsed windows the weighted distribution
// still drives width — those windows are the user-facing tile slots.
export function tileWeighted(screenFrame, nonCollapsed, collapsed, horizontal, weightOf, sizeOf) {
  const out = [];
  const numCollapsed = collapsed.length;
  const numNon = nonCollapsed.length;

  if (horizontal) {
    const collapsedH = numCollapsed > 0 ? (cfg.collapsedWindowHeight + cfg.tileGap) : 0;
    const mainH = screenFrame.h - collapsedH;

    if (numNon > 0) {
      const widths = distributeWeighted(screenFrame.w, cfg.tileGap, nonCollapsed, weightOf);
      let x = screenFrame.x;
      for (let i = 0; i < nonCollapsed.length; i++) {
        out.push({ winId: nonCollapsed[i], frame: { x, y: screenFrame.y, w: widths[i], h: mainH } });
        x += widths[i] + cfg.tileGap;
      }
    }
    if (numCollapsed > 0) {
      // Justify: distribute the collapsed widgets across the full rail
      // width. Their widths are app-managed (we don't try to resize), but
      // their POSITIONS are ours. Compute even spacing between widgets so
      // the leftmost sits at screenFrame.x, the rightmost ends at
      // screenFrame.x + screenFrame.w, the rest are evenly spaced. Was
      // packed at the left with a fixed cfg.tileGap; left ~half the rail
      // empty on most setups.
      const cy = screenFrame.y + mainH;
      const sizes = collapsed.map(id => {
        const live = sizeOf ? sizeOf(id) : null;
        return (live && live.w > 0) ? live.w : 200;
      });
      const totalContent = sizes.reduce((s, w) => s + w, 0);
      const slack = screenFrame.w - totalContent;
      // Spacing between widgets: slack / (n-1) if more than one; n=1 places
      // the lone widget at the left (no spacing makes sense).
      const gap = numCollapsed > 1 ? Math.max(0, slack / (numCollapsed - 1)) : 0;
      let cx = screenFrame.x;
      for (let i = 0; i < numCollapsed; i++) {
        out.push({ winId: collapsed[i], frame: { x: Math.round(cx), y: cy, w: sizes[i], h: cfg.collapsedWindowHeight } });
        cx += sizes[i] + gap;
      }
    }
  } else {
    let collapsedH = 0;
    if (numCollapsed > 0) {
      collapsedH = (cfg.collapsedWindowHeight + cfg.tileGap) * numCollapsed - cfg.tileGap;
    }
    const mainH = screenFrame.h - collapsedH;

    if (numNon > 0) {
      const heights = distributeWeighted(mainH, cfg.tileGap, nonCollapsed, weightOf);
      let y = screenFrame.y;
      for (let i = 0; i < nonCollapsed.length; i++) {
        out.push({ winId: nonCollapsed[i], frame: { x: screenFrame.x, y, w: screenFrame.w, h: heights[i] } });
        y += heights[i] + cfg.tileGap;
      }
    }
    if (numCollapsed > 0) {
      let cy = screenFrame.y + mainH;
      for (const id of collapsed) {
        // Vertical-display collapsed strip uses screen width; preserve
        // live width if smaller than screen so position math doesn't drift.
        const live = sizeOf ? sizeOf(id) : null;
        const w = (live && live.w > 0) ? Math.min(live.w, screenFrame.w) : screenFrame.w;
        out.push({ winId: id, frame: { x: screenFrame.x, y: cy, w, h: cfg.collapsedWindowHeight } });
        cy += cfg.collapsedWindowHeight + cfg.tileGap;
      }
    }
  }
  return out;
}
