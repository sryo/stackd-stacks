// Weighted + pin-aware tiling distribution. tileWeighted is the entry
// point; distributePinned does the per-axis math (pinned tiles take their
// fixed px, the rest share the remainder by weight). Per BELIEFS #1,
// min/max belong to live AX, not a persistent cache — refusal is handled
// in tiler.js PASS-2 by converting the refused window to a pin.

import { cfg } from "./config.js";

// Pin-aware distribution. `pinnedSizeOf(item)` returns a pixel size if the
// item is pinned (= held at a user-chosen fixed size), or null if it's
// flexible. Pinned items consume their stored px first; flexible items
// share the remainder by weight. hy3:base semantics — "manually resize one
// tile and the others, not it, redistribute."
//
// Edge cases:
// - n == 1: single tile fills the full `total` regardless of pin.
// - All pinned: pins scale down proportionally if their sum exceeds avail.
// - Pins overflow leaving < 100px per flex cell: pins scale down so each
//   flex tile gets at least 100px.
const FLEX_FLOOR_PX = 100;
export const PIN_MIN_PX = 50;
export function distributePinned(total, gap, items, weightOf, pinnedSizeOf) {
  if (items.length === 0) return [];
  const avail = total - Math.max(items.length - 1, 0) * gap;
  if (items.length === 1) return [avail];

  const pinned = new Array(items.length).fill(null);
  let pinnedSum = 0;
  let flexCount = 0;
  let flexWeightSum = 0;
  for (let i = 0; i < items.length; i++) {
    const px = pinnedSizeOf ? pinnedSizeOf(items[i]) : null;
    if (typeof px === "number" && px > 0) {
      pinned[i] = Math.max(PIN_MIN_PX, Math.floor(px));
      pinnedSum += pinned[i];
    } else {
      flexCount++;
      flexWeightSum += weightOf(items[i]);
    }
  }

  // No flex tiles — pins occupy the whole row. Scale to fit if oversized.
  if (flexCount === 0) {
    const scale = pinnedSum > avail ? avail / pinnedSum : 1;
    const out = new Array(items.length);
    let allocated = 0;
    for (let i = 0; i < items.length; i++) {
      if (i === items.length - 1) {
        out[i] = avail - allocated;
      } else {
        out[i] = Math.max(PIN_MIN_PX, Math.floor(pinned[i] * scale));
        allocated += out[i];
      }
    }
    return out;
  }

  // Pins leave < 100px per flex cell — shrink pins to reserve flex floor.
  const flexFloor = FLEX_FLOOR_PX * flexCount;
  let flexAvail = avail - pinnedSum;
  if (flexAvail < flexFloor && pinnedSum > 0) {
    const target = Math.max(0, avail - flexFloor);
    const scale = target / pinnedSum;
    pinnedSum = 0;
    for (let i = 0; i < items.length; i++) {
      if (pinned[i] != null) {
        pinned[i] = Math.max(PIN_MIN_PX, Math.floor(pinned[i] * scale));
        pinnedSum += pinned[i];
      }
    }
    flexAvail = avail - pinnedSum;
  }
  if (flexAvail < 0) flexAvail = 0;

  // Locate the last flex index so we can drop rounding remainder into it
  // (matches distributeWeighted's "last cell absorbs the residual" pattern).
  let lastFlexIdx = -1;
  for (let i = 0; i < items.length; i++) {
    if (pinned[i] == null) lastFlexIdx = i;
  }

  const out = new Array(items.length);
  let flexAllocated = 0;
  for (let i = 0; i < items.length; i++) {
    if (pinned[i] != null) {
      out[i] = pinned[i];
      continue;
    }
    if (i === lastFlexIdx) {
      out[i] = Math.max(PIN_MIN_PX, flexAvail - flexAllocated);
    } else {
      const share = flexWeightSum > 0
        ? Math.floor(flexAvail * weightOf(items[i]) / flexWeightSum)
        : Math.floor(flexAvail / flexCount);
      out[i] = Math.max(PIN_MIN_PX, share);
      flexAllocated += out[i];
    }
  }
  return out;
}

// Resolve a pin set that oversubscribes the tiling axis, without mutating its
// inputs. A refusal pin encodes an app minimum the window will re-assert, so
// it is held fixed and the overflow is absorbed from the user pins. Tiers:
//   1. keep the window the user just resized (activeId), shrink the OTHER user
//      pins proportionally into the remaining budget;
//   2. no preservable active → shrink ALL user pins proportionally;
//   3. refusal minimums alone exceed the axis → shed user pins (then refusal
//      pins if still over) so the row falls back to weighted flex.
// Returns { pins, refusalDrop, tier, active }: `pins` is the surviving id→px
// map (ids absent from it must be un-pinned by the caller); `refusalDrop` lists
// ids whose refusal flag the caller must clear.
export function resolvePinOversubscription(sizes, refusalSet, activeId, majorAxis, floor) {
  const ids = Object.keys(sizes).map(Number);
  const pinSum = ids.reduce((s, id) => s + sizes[id], 0);
  if (pinSum <= majorAxis) return { pins: { ...sizes }, refusalDrop: [], tier: 0, active: null };

  const out = { ...sizes };
  const refusalIds = ids.filter((id) => refusalSet.has(+id));
  const userIds    = ids.filter((id) => !refusalSet.has(+id));
  const refusalSum = refusalIds.reduce((s, id) => s + out[id], 0);

  let active = activeId == null ? null : +activeId;
  if (active != null && !userIds.includes(active)) active = null;

  // Proportional shrink of `list` to exactly `budget`; the last cell absorbs
  // the rounding residual (matches distributePinned's residual placement).
  const shrink = (list, budget) => {
    const listSum = list.reduce((s, id) => s + out[id], 0);
    if (listSum <= 0) return;
    let alloc = 0;
    for (let i = 0; i < list.length; i++) {
      const id = list[i];
      out[id] = (i === list.length - 1)
        ? Math.max(floor, budget - alloc)
        : Math.max(floor, Math.floor(out[id] * budget / listSum));
      alloc += out[id];
    }
  };

  const others      = userIds.filter((id) => id !== active);
  const activePx    = active != null ? out[active] : 0;
  const otherBudget = majorAxis - refusalSum - activePx;
  const userBudget  = majorAxis - refusalSum;
  const userSum     = userIds.reduce((s, id) => s + out[id], 0);

  if (active != null && others.length > 0 && otherBudget >= others.length * floor) {
    shrink(others, otherBudget);
    return { pins: out, refusalDrop: [], tier: 1, active };
  }
  if (userIds.length > 0 && userBudget >= userIds.length * floor && userSum > 0) {
    shrink(userIds, userBudget);
    return { pins: out, refusalDrop: [], tier: 2, active: null };
  }
  // Tier 3: refusal minimums alone oversubscribe. Shed user pins, then refusal
  // pins too if still over.
  for (const id of userIds) delete out[id];
  const refusalDrop = [];
  const stillSum = refusalIds.reduce((s, id) => s + (out[id] ?? 0), 0);
  if (stillSum > majorAxis) {
    for (const id of refusalIds) { delete out[id]; refusalDrop.push(+id); }
  }
  return { pins: out, refusalDrop, tier: 3, active: null };
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
export function tileWeighted(screenFrame, nonCollapsed, collapsed, horizontal, weightOf, sizeOf, pinnedSizeOf) {
  const out = [];
  const numCollapsed = collapsed.length;
  const numNon = nonCollapsed.length;

  if (horizontal) {
    const collapsedH = numCollapsed > 0 ? (cfg.collapsedWindowHeight + cfg.tileGap) : 0;
    const mainH = screenFrame.h - collapsedH;

    if (numNon > 0) {
      const widths = distributePinned(screenFrame.w, cfg.tileGap, nonCollapsed, weightOf, pinnedSizeOf);
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
      const heights = distributePinned(mainH, cfg.tileGap, nonCollapsed, weightOf, pinnedSizeOf);
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
