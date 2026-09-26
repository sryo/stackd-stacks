// Live neighbor resize — the pure row math. While the user drags a tiled
// window's edge (sd.window.resizing), the dragged window A is never written:
// its actual frame is the input. The neighbor B across the moved edge follows
// that edge, and the rest of the row lands where the tiler's solver puts it,
// so the frames written mid-drag are the frames the release commit tiles.
// No sd import, so node can test it.

import { cfg } from "./config.js";
import { predictResizeFrame, PIN_MIN_PX } from "./layouts.js";

// The moved edge on the tiling axis: "leading" (left on a row, top on a
// stack), "trailing" (right / bottom), or null when the drag is cross-axis
// (top/bottom on a row, left/right on a stack) or moved both major edges.
// `edges` is the daemon's { left, right, top, bottom } moved-since-start set.
export function liveEdgeOf(edges, horizontal) {
  if (!edges) return null;
  const lead = horizontal ? edges.left : edges.top;
  const trail = horizontal ? edges.right : edges.bottom;
  if (lead && !trail) return "leading";
  if (trail && !lead) return "trailing";
  return null;
}

// The tile across `edge` from `activeId` in row order, or null (row end,
// unknown id, no edge).
export function neighborFor(nonCollapsed, activeId, edge) {
  if (edge !== "leading" && edge !== "trailing") return null;
  const i = nonCollapsed.findIndex((id) => +id === +activeId);
  if (i < 0) return null;
  const j = edge === "leading" ? i - 1 : i + 1;
  return j >= 0 && j < nonCollapsed.length ? +nonCollapsed[j] : null;
}

// Each tile's major-axis size at drag start: its pin (the pin IS its size),
// else its last tile target, else its frame at mouse-down, else — for the
// dragged window only — the daemon's startFrame. The daemon's begin is
// echo-filtered, so it can arrive a few steps into the drag with a startFrame
// that has already moved; that is the last resort, never the baseline when
// the tiler knows better. Returns { id: px } for the ids it could size.
export function dragBaselines({ ids, pins, targets, snapshot, horizontal, activeId, startFrame }) {
  const major = (f) => (f ? (horizontal ? f.w : f.h) : null);
  const out = Object.create(null);
  for (const raw of ids) {
    const id = +raw;
    const v = pins?.[id]
      ?? major(targets?.[id])
      ?? major(snapshot?.[id])
      ?? (id === +activeId ? major(startFrame) : null);
    if (v != null) out[id] = v;
  }
  return { ...out };
}

// The row for one resizing frame of A. `frame` is A's actual frame; `edge`
// and `neighborId` name the moved edge and B. `baselines` are the drag-start
// sizes (dragBaselines). `minOf(id)` is the floor B may not be pushed under
// (the caller folds app minimums, learned refusals and refusals seen this
// drag); `appMinOf` is the tiler's own floor, so the solver agrees with the
// commit pass.
//
// Returns { frames, aSize, clamped }: `frames` is every non-collapsed tile
// except A ([{ winId, frame }]); `aSize` is the size A commits at on release —
// its actual size, or the most B can give when B hit its floor (A overlaps B
// until then); `clamped` says B hit its floor.
export function liveRow({
  screenFrame, horizontal, nonCollapsed, collapsed,
  weightOf, sizeOf, pins, refusalSet, appMinOf, minOf,
  activeId, edge, neighborId, frame, baselines,
}) {
  const A = +activeId, B = +neighborId;
  const major = (f) => (horizontal ? f.w : f.h);
  const aBase = baselines[A], bBase = baselines[B];
  const actual = major(frame);
  // B can't be pushed under its floor, and is never forced to GROW to it.
  const bMin = Math.min(bBase, Math.max(PIN_MIN_PX, (minOf && minOf(B)) || 0));
  const maxA = aBase + bBase - bMin;
  const clamped = actual > maxA;
  const aSize = Math.max(PIN_MIN_PX, Math.floor(Math.min(actual, maxA)));

  const r = predictResizeFrame({
    screenFrame, horizontal, nonCollapsed, collapsed,
    weightOf, sizeOf, pins, refusalSet, appMinOf,
    activeId: A, requestedSize: aSize, aBase, neighborId: B, bBase,
  });
  const frames = [];
  const collapsedSet = new Set((collapsed || []).map((id) => +id));
  for (const t of r.frames || []) {
    const id = +t.winId;
    if (id === A || collapsedSet.has(id)) continue;
    frames.push({ winId: id, frame: id === B && !clamped ? alignToEdge(t.frame, frame, edge, horizontal, bMin) : t.frame });
  }
  return { frames, aSize, clamped };
}

// B's shared edge sits one tile gap past A's ACTUAL moved edge (the app may
// round A off the solver's frame); B's far edge stays where the solver put
// it. Falls back to the solver frame if that would take B under its floor.
function alignToEdge(bFrame, aFrame, edge, horizontal, bMin) {
  const gap = cfg.tileGap;
  const pos = horizontal ? "x" : "y", size = horizontal ? "w" : "h";
  const out = { ...bFrame };
  if (edge === "trailing") {
    const start = aFrame[pos] + aFrame[size] + gap;
    out[size] = bFrame[pos] + bFrame[size] - start;
    out[pos] = start;
  } else {
    out[size] = aFrame[pos] - gap - bFrame[pos];
  }
  return out[size] >= bMin ? out : bFrame;
}

// The frames that differ from what `last` (id → frame) already holds — the
// tiles that actually need a write for this resizing frame.
export function changedWrites(frames, last) {
  return frames.filter(({ winId, frame }) => {
    const p = last && last[winId];
    return !p || p.x !== frame.x || p.y !== frame.y || p.w !== frame.w || p.h !== frame.h;
  });
}
