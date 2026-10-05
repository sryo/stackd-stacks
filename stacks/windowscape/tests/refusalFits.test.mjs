// A refusal is an app's minimum only if the row can actually hold it. A
// transient oversized frame (an app mid-resize, a runaway window) read back as
// a "refusal" would pin and learn a floor that eats the whole axis, squeezing
// every sibling to its own minimum and looping PASS2-PIN-REFUSED.
import test from "node:test";
import assert from "node:assert/strict";
import { refusalFits, renormalizedPins } from "../modules/layouts.js";

test("a size that leaves siblings their minimums fits", () => {
  assert.equal(refusalFits({ actualPx: 626, inner: 2530, otherMins: [0], floor: 50 }), true);
  assert.equal(refusalFits({ actualPx: 2278, inner: 2530, otherMins: [252], floor: 50 }), true);
});

test("a size that starves a sibling below its minimum does not fit", () => {
  assert.equal(refusalFits({ actualPx: 2529, inner: 2530, otherMins: [252], floor: 50 }), false);
});

test("siblings with no learned minimum still keep the pin floor", () => {
  assert.equal(refusalFits({ actualPx: 2500, inner: 2530, otherMins: [0], floor: 50 }), false);
  assert.equal(refusalFits({ actualPx: 2480, inner: 2530, otherMins: [0], floor: 50 }), true);
});

test("field case: bogus 2529px min on Claude no longer forces Finder under 252", () => {
  // Without the guard both pins are "held" at their mins and the heal falls
  // back to proportional scaling → Finder 250 (under its 252 floor).
  const mins = { 1: 252, 2: 2529 };
  const bad = renormalizedPins({
    ids: [1, 2], pins: { 1: 252, 2: 2301 }, refusalSet: new Set(), inner: 2530, minOf: (id) => mins[id],
  });
  assert.ok(bad[1] < 252, "documents the failure mode the guard prevents");
  assert.equal(refusalFits({ actualPx: 2529, inner: 2530, otherMins: [252], floor: 50 }), false);
  const good = renormalizedPins({
    ids: [1, 2], pins: { 1: 252, 2: 2301 }, refusalSet: new Set(), inner: 2530, minOf: (id) => ({ 1: 252, 2: 0 })[id],
  });
  assert.equal(good[1], 252);
  assert.equal(good[2], 2278);
});
