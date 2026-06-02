// Weighted tiling distribution — port of layouts.lua tileWeighted.
// distributeWeighted / distributeEven match the Lua exactly.

import { cfg } from "./config.js";

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
export function tileWeighted(screenFrame, nonCollapsed, collapsed, horizontal, weightOf) {
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
      const { base, rem } = distributeEven(screenFrame.w, cfg.tileGap, numCollapsed);
      let cx = screenFrame.x;
      const cy = screenFrame.y + mainH;
      for (let i = 0; i < collapsed.length; i++) {
        const w = base + (i === numCollapsed - 1 ? rem : 0);
        out.push({ winId: collapsed[i], frame: { x: cx, y: cy, w, h: cfg.collapsedWindowHeight } });
        cx += w + cfg.tileGap;
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
      const cx = screenFrame.x;
      let cy = screenFrame.y + mainH;
      for (const id of collapsed) {
        out.push({ winId: id, frame: { x: cx, y: cy, w: screenFrame.w, h: cfg.collapsedWindowHeight } });
        cy += cfg.collapsedWindowHeight + cfg.tileGap;
      }
    }
  }
  return out;
}
