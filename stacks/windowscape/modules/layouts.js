// Tile positioning. tileWeighted is the entry point; the per-axis width math
// now lives in resolveFlex (modules/flex.js), which subsumes the old
// distributePinned / resolvePinOversubscription (PIN-CLAMP) / scalePinsToFill
// (PIN-FILL) / newcomer-rebalance. Per BELIEFS #1, min/max belong to live AX,
// not a persistent cache — refusal is handled in tiler.js PASS-2 by feeding the
// refused size in as the tile's `min`.

import { cfg } from "./config.js";
import { resolveFlex, PIN_MIN_PX, FLEX_USABLE_PX } from "./flex.js";

export { PIN_MIN_PX, FLEX_USABLE_PX };

// Positions non-collapsed tiles along the major axis via resolveFlex, and
// justifies collapsed widgets along the rail. `specOf(id)` returns the tile's
// solver spec { weight, basis, min, active }. `sizeOf(id)` gives a collapsed
// widget's live size. Returns [{ winId, frame }].
export function tileWeighted(screenFrame, nonCollapsed, collapsed, horizontal, sizeOf, specOf) {
  const out = [];
  const numCollapsed = collapsed.length;
  const numNon = nonCollapsed.length;

  if (horizontal) {
    const collapsedH = numCollapsed > 0 ? (cfg.collapsedWindowHeight + cfg.tileGap) : 0;
    const mainH = screenFrame.h - collapsedH;

    if (numNon > 0) {
      const widths = resolveFlex(nonCollapsed.map(specOf), screenFrame.w, cfg.tileGap);
      let x = screenFrame.x;
      for (let i = 0; i < nonCollapsed.length; i++) {
        out.push({ winId: nonCollapsed[i], frame: { x, y: screenFrame.y, w: widths[i], h: mainH } });
        x += widths[i] + cfg.tileGap;
      }
    }
    if (numCollapsed > 0) {
      // Justify collapsed widgets across the full rail width: leftmost at
      // screenFrame.x, rightmost flush against the right edge, evenly spaced.
      const cy = screenFrame.y + mainH;
      const sizes = collapsed.map((id) => {
        const live = sizeOf ? sizeOf(id) : null;
        return (live && live.w > 0) ? live.w : 200;
      });
      const totalContent = sizes.reduce((s, w) => s + w, 0);
      const slack = screenFrame.w - totalContent;
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
      const heights = resolveFlex(nonCollapsed.map(specOf), mainH, cfg.tileGap);
      let y = screenFrame.y;
      for (let i = 0; i < nonCollapsed.length; i++) {
        out.push({ winId: nonCollapsed[i], frame: { x: screenFrame.x, y, w: screenFrame.w, h: heights[i] } });
        y += heights[i] + cfg.tileGap;
      }
    }
    if (numCollapsed > 0) {
      let cy = screenFrame.y + mainH;
      for (const id of collapsed) {
        // Vertical-display collapsed strip uses screen width; preserve live
        // width if smaller than screen so position math doesn't drift.
        const live = sizeOf ? sizeOf(id) : null;
        const w = (live && live.w > 0) ? Math.min(live.w, screenFrame.w) : screenFrame.w;
        out.push({ winId: id, frame: { x: screenFrame.x, y: cy, w, h: cfg.collapsedWindowHeight } });
        cy += cfg.collapsedWindowHeight + cfg.tileGap;
      }
    }
  }
  return out;
}

// Build a tile's solver spec from the persisted state maps: a user pin →
// `basis`, an AX-refusal pin → `min` (the app's floor), else a flex `weight`.
// The last-grabbed pin (`lastId`) is marked active so it's held under overflow.
// Shared by the tiler (commit) and predictResizeFrame (preview) so the two agree.
export function specFromState({ pins, refusalSet, weightOf, lastId, appMinOf }) {
  const A = lastId != null ? +lastId : null;
  return (id) => {
    const p = pins[id];
    const refusal = refusalSet && refusalSet.has(+id);
    const perWindowMin = (p != null && refusal) ? p : 0;
    const appMin = appMinOf ? (appMinOf(id) || 0) : 0;
    return {
      weight: weightOf(id),
      basis: (p != null && !refusal) ? p : null,
      min: Math.max(perWindowMin, appMin),
      active: +id === A,
    };
  };
}

// Predict the frame the tiler will assign when a window is resized to
// `requestedSize` against `neighborId`, WITHOUT mutating anything. Mirrors the
// commit path (pairwise A/B basis override → resolveFlex → tileWeighted) so the
// gesture preview equals the committed frame. Pure. Returns { frame, pins, bId }.
export function predictResizeFrame({
  screenFrame, horizontal, nonCollapsed, collapsed,
  weightOf, sizeOf, pins, refusalSet, appMinOf,
  activeId, requestedSize, aBase, neighborId, bBase,
  floor = PIN_MIN_PX,
}) {
  const A = +activeId;
  const baseSpec = specFromState({ pins, refusalSet, weightOf, lastId: A, appMinOf });
  const framesFor = (specOf) => tileWeighted(screenFrame, nonCollapsed, collapsed, horizontal, sizeOf, specOf);
  const frameOfA = (frames) => { const hit = frames.find((x) => +x.winId === A); return hit ? hit.frame : null; };
  const pinsOf = (frames) => { const o = Object.create(null); for (const t of frames) o[t.winId] = horizontal ? t.frame.w : t.frame.h; return o; };

  // Solo / neighborless → no pairwise transfer; preview the plain tiled frame.
  if (nonCollapsed.indexOf(A) < 0 || nonCollapsed.length < 2 || neighborId == null) {
    const frames = framesFor(baseSpec);
    return { frame: frameOfA(frames), pins: pinsOf(frames), bId: null };
  }

  const B = +neighborId;
  const reqA = Math.max(floor, Math.floor(requestedSize));
  const delta = reqA - aBase;
  const bWant = Math.max(floor, Math.floor(bBase - delta));
  const specOf = (id) => {
    if (+id === A) return { weight: weightOf(id), basis: reqA, min: appMinOf ? appMinOf(id) : 0, active: true };
    if (+id === B) return { weight: weightOf(id), basis: bWant, min: appMinOf ? appMinOf(id) : 0 };
    return baseSpec(id);
  };
  const frames = framesFor(specOf);
  return { frame: frameOfA(frames), pins: pinsOf(frames), bId: B };
}
