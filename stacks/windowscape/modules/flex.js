// resolveFlex — one constrained-width apportionment along a single axis.
//
// Replaces distributePinned + resolvePinOversubscription + scalePinsToFill.
// Each item is { weight=1, basis=null, min=0, active=false }:
//   basis=null → flexible: shares the remainder by weight, floored at min.
//   basis=px   → user-pinned: holds that size; yields under overflow; the one
//                marked `active` (the last-grabbed tile) is held last.
//   min        → a hard floor (an app's refused minimum).
//
// Returns integer sizes summing EXACTLY to total-(n-1)*gap. Pure — no state,
// no sd.*. The five old branches are now three inputs to this function:
// weighted split (grow), pinned-hold, and shrink-to-fit (overflow).

export const PIN_MIN_PX = 50;         // a pin can't be narrower than this
export const FLEX_USABLE_PX = 400;    // a flex tile below this is likely under an app min

const floorOf = (it, isPin) => Math.max(it.min || 0, isPin ? PIN_MIN_PX : 0);

// Distribute `avail` among `idx` items by weight, each floored at its min.
// Water-filling: any item whose weighted share falls below its min is frozen
// at min and removed; the rest re-share the reduced pool. Returns a map id→px.
function waterfill(idx, avail, weightOf, minOf) {
  const out = Object.create(null);
  let active = idx.slice();
  let pool = Math.max(0, avail);
  // Freeze min-violators until every remaining share clears its min.
  for (;;) {
    const W = active.reduce((s, i) => s + weightOf(i), 0);
    if (W <= 0) { for (const i of active) out[i] = pool / Math.max(1, active.length); break; }
    const below = active.filter((i) => pool * (weightOf(i) / W) < minOf(i));
    if (below.length === 0) {
      for (const i of active) out[i] = pool * (weightOf(i) / W);
      break;
    }
    for (const i of below) { out[i] = minOf(i); pool -= minOf(i); }
    active = active.filter((i) => !below.includes(i));
    if (active.length === 0) break;
  }
  return out;
}

// Shrink pinned items into `budget`, holding the active one at its basis and
// shrinking the others pro-rata, each floored. Returns a map id→px.
function shrinkPins(pinIdx, basisOf, budget, activeIdx, floorOfIdx) {
  const out = Object.create(null);
  let others = pinIdx;
  let pool = budget;
  if (activeIdx != null && pinIdx.includes(activeIdx) && basisOf(activeIdx) <= budget) {
    out[activeIdx] = basisOf(activeIdx);
    pool = budget - basisOf(activeIdx);
    others = pinIdx.filter((i) => i !== activeIdx);
  }
  const sumOthers = others.reduce((s, i) => s + basisOf(i), 0);
  const scale = sumOthers > 0 ? pool / sumOthers : 0;
  for (const i of others) out[i] = Math.max(floorOfIdx(i), basisOf(i) * scale);
  return out;
}

// Round a float map to integers over the given order, forcing an exact sum.
// Floors each, then hands the leftover pixels to the largest-fractional cells.
function roundExact(order, floats, target) {
  const floored = order.map((i) => Math.floor(floats[i]));
  let rem = target - floored.reduce((s, v) => s + v, 0);
  const frac = order
    .map((i, k) => ({ k, f: floats[i] - floored[k] }))
    .sort((a, b) => b.f - a.f);
  for (let j = 0; j < frac.length && rem > 0; j++, rem--) floored[frac[j].k]++;
  // negative leftover (rare rounding overshoot): trim from the largest cells
  for (let j = frac.length - 1; j >= 0 && rem < 0; j--, rem++) floored[frac[j].k]--;
  const res = Object.create(null);
  order.forEach((i, k) => { res[i] = floored[k]; });
  return res;
}

export function resolveFlex(items, total, gap = 0) {
  const n = items.length;
  if (n === 0) return [];
  const inner = total - Math.max(0, n - 1) * gap;
  if (n === 1) return [inner];                       // solo fills, basis ignored

  const idxAll = items.map((_, i) => i);
  const isPin = items.map((it) => it.basis != null);
  const weightOf = (i) => (items[i].weight != null ? items[i].weight : 1);
  const floorAt = (i) => floorOf(items[i], isPin[i]);
  const minOf = (i) => items[i].min || 0;

  const pinIdx = idxAll.filter((i) => isPin[i]);
  const flexIdx = idxAll.filter((i) => !isPin[i]);
  const activeIdx = idxAll.find((i) => isPin[i] && items[i].active);

  // Working pin sizes (may be shrunk by the rebalance / overflow steps below).
  const pinPx = Object.create(null);
  for (const i of pinIdx) pinPx[i] = Math.max(floorAt(i), Math.floor(items[i].basis));

  // ── all pinned: scale to fill exactly (subsumes PIN-FILL up / clamp down) ──
  if (flexIdx.length === 0) {
    let pinSum = pinIdx.reduce((s, i) => s + pinPx[i], 0);
    let sizes;
    if (pinSum > inner) {
      sizes = shrinkPins(pinIdx, (i) => pinPx[i], inner, activeIdx, floorAt);
    } else {
      const scale = pinSum > 0 ? inner / pinSum : 1;      // PIN-FILL up (or exact)
      sizes = Object.create(null);
      for (const i of pinIdx) sizes[i] = pinPx[i] * scale;
    }
    const r = roundExact(idxAll, sizes, inner);
    return idxAll.map((i) => r[i]);
  }

  // ── pinned + flex ─────────────────────────────────────────────────────────
  let pinSum = pinIdx.reduce((s, i) => s + pinPx[i], 0);
  const flexCount = flexIdx.length;
  const fairPer = inner / n;
  const perFlex = (inner - pinSum) / flexCount;

  // Gated newcomer rebalance: a flex tile cramped below the usable floor AND
  // below its fair share → shrink pins pro-rata so newcomers get a fair share.
  // (A deliberate big pin with a still-usable remainder is left alone.)
  if (pinSum > 0 && perFlex < FLEX_USABLE_PX && perFlex < fairPer) {
    const target = Math.max(0, inner - fairPer * flexCount);
    const scale = target / pinSum;
    for (const i of pinIdx) pinPx[i] = Math.max(floorAt(i), Math.floor(pinPx[i] * scale));
    pinSum = pinIdx.reduce((s, i) => s + pinPx[i], 0);
  }

  // Overflow: if the pins plus the flex minimums can't fit, shrink the pins
  // (active held) so every flex tile can still reach its min. Mins are floors.
  const flexMinSum = flexIdx.reduce((s, i) => s + minOf(i), 0);
  if (pinSum + flexMinSum > inner) {
    const shrunk = shrinkPins(pinIdx, (i) => pinPx[i], Math.max(0, inner - flexMinSum), activeIdx, floorAt);
    for (const i of pinIdx) pinPx[i] = shrunk[i];
    pinSum = pinIdx.reduce((s, i) => s + pinPx[i], 0);
  }

  const flexAvail = Math.max(0, inner - pinSum);
  const flexSizes = waterfill(flexIdx, flexAvail, weightOf, minOf);

  const sizes = Object.create(null);
  for (const i of pinIdx) sizes[i] = pinPx[i];
  for (const i of flexIdx) sizes[i] = flexSizes[i];
  const r = roundExact(idxAll, sizes, inner);
  return idxAll.map((i) => r[i]);
}
