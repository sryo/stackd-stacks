// Pin-drift self-heal (renormalizedPins). In an all-pinned row resolveFlex
// scales the RENDERED sizes by inner/Σpins (PIN-FILL) but never mutates the
// pins, and pinFromActualSize's pairwise transfer keeps Σpins constant — so
// once the row's total stops matching the axis (a sibling left, a rail
// appeared, the work area changed), every tile pass re-inflates the user's
// sizes by the same stale factor and no resize ever sticks. The heal rescales
// the pin STATE once so pins and axis agree again.
import test from "node:test";
import assert from "node:assert/strict";
import {
  renormalizedPins, innerSpanFor, tileWeighted, specFromState,
  predictResizeFrame, PIN_MIN_PX,
} from "../modules/layouts.js";
import { cfg } from "../modules/config.js";

const weightOf = () => 1;
const sizeOf = () => ({ w: 200, h: 200 });

test("undershoot: stale-sum pins rescale proportionally to an exact fit", () => {
  // The observed field case: two pins born against a 1847px work area, now on
  // a 2530px portrait column (fill factor 1.3697 re-applied every pass).
  const healed = renormalizedPins({
    ids: [1, 2], pins: { 1: 1019, 2: 828 }, refusalSet: new Set(), inner: 2530,
  });
  assert.deepEqual({ ...healed }, { 1: 1396, 2: 1134 });
  assert.equal(healed[1] + healed[2], 2530, "healed pins sum exactly to the axis");
});

test("overshoot: pins past the axis rescale down", () => {
  const healed = renormalizedPins({
    ids: [1, 2], pins: { 1: 2000, 2: 2000 }, refusalSet: new Set(), inner: 2000,
  });
  assert.deepEqual({ ...healed }, { 1: 1000, 2: 1000 });
});

test("agreement within tolerance → null (no churn on rounding noise)", () => {
  const rf = new Set();
  assert.equal(renormalizedPins({ ids: [1, 2], pins: { 1: 1265, 2: 1265 }, refusalSet: rf, inner: 2530 }), null);
  assert.equal(renormalizedPins({ ids: [1, 2], pins: { 1: 1265, 2: 1262 }, refusalSet: rf, inner: 2530 }), null);
});

test("partially pinned row → null (flex siblings absorb the difference)", () => {
  assert.equal(renormalizedPins({ ids: [1, 2], pins: { 1: 800 }, refusalSet: new Set(), inner: 2530 }), null);
});

test("refusal pin in the row → null (that pin is an app floor, not a share)", () => {
  assert.equal(renormalizedPins({
    ids: [1, 2], pins: { 1: 1019, 2: 828 }, refusalSet: new Set([2]), inner: 2530,
  }), null);
});

test("solo row → null (solo pins are the tiler's job to drop)", () => {
  assert.equal(renormalizedPins({ ids: [1], pins: { 1: 500 }, refusalSet: new Set(), inner: 2530 }), null);
});

test("floor respected; excess reclaimed from tiles with slack", () => {
  const healed = renormalizedPins({
    ids: [1, 2], pins: { 1: 60, 2: 6000 }, refusalSet: new Set(), inner: 600, floor: 50,
  });
  assert.equal(healed[1], 50, "small pin lands on the floor, not below");
  assert.equal(healed[1] + healed[2], 600, "sum still exact");
});

test("innerSpanFor matches what resolveFlex actually apportions", () => {
  const flexSpec = () => ({ weight: 1 });
  const sumMajor = (frames, ids, horizontal) =>
    frames.filter((t) => ids.includes(t.winId))
      .reduce((s, t) => s + (horizontal ? t.frame.w : t.frame.h), 0);

  // Vertical, no collapsed rail.
  const sfV = { x: 0, y: 0, w: 1000, h: 2530 };
  const v = tileWeighted(sfV, [1, 2], [], false, sizeOf, flexSpec);
  assert.equal(sumMajor(v, [1, 2], false), innerSpanFor(sfV, false, 2, 0));

  // Vertical with two collapsed widgets eating into mainH.
  const v2 = tileWeighted(sfV, [1, 2], [3, 4], false, sizeOf, flexSpec);
  assert.equal(sumMajor(v2, [1, 2], false), innerSpanFor(sfV, false, 2, 2));

  // Horizontal: collapsed rail takes height, not width.
  const sfH = { x: 0, y: 0, w: 1710, h: 1112 };
  const h = tileWeighted(sfH, [1, 2, 3], [4], true, sizeOf, flexSpec);
  assert.equal(sumMajor(h, [1, 2, 3], true), innerSpanFor(sfH, true, 3, 1));
});

test("regression: healed pins render at face value — fill scale returns to 1", () => {
  const sf = { x: 77, y: 0, w: 1080, h: 2530 };
  const stale = { 1: 1019, 2: 828 };
  const spec = (pins) => specFromState({ pins, refusalSet: new Set(), weightOf, lastId: null, appMinOf: () => 0 });

  // Before the heal: rendered heights are inflated ×(2530/1847) — the bug.
  const before = tileWeighted(sf, [1, 2], [], false, sizeOf, spec(stale));
  assert.notEqual(before[0].frame.h, 1019, "stale pins do NOT render at face value");

  // After: rendered heights equal the healed pins exactly.
  const healed = renormalizedPins({ ids: [1, 2], pins: stale, refusalSet: new Set(), inner: innerSpanFor(sf, false, 2, 0) });
  const after = tileWeighted(sf, [1, 2], [], false, sizeOf, spec(healed));
  assert.equal(after[0].frame.h, healed[1]);
  assert.equal(after[1].frame.h, healed[2]);

  // And a gesture request against healed pins lands at the requested size.
  const r = predictResizeFrame({
    screenFrame: sf, horizontal: false, nonCollapsed: [1, 2], collapsed: [],
    weightOf, sizeOf, pins: healed, refusalSet: new Set(), appMinOf: () => 0,
    activeId: 1, requestedSize: healed[1] + 160, aBase: healed[1],
    neighborId: 2, bBase: healed[2], floor: PIN_MIN_PX,
  });
  assert.equal(r.frame.h, healed[1] + 160, "gesture steps land exactly where requested");
});
