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

// An app minimum is a size the window was HELD ABOVE its target at. A window
// sitting below its target (Stow at its natural 520px when asked for 853) has
// a maximum or a not-yet-ready frame; learning that size as a floor overrides
// every narrower user pin from then on.
import { heldAboveTarget } from "../modules/layouts.js";

test("held above the target is a floor candidate", () => {
  assert.equal(heldAboveTarget({ actualPx: 845, targetPx: 400 }), true);
});

test("held below the target is not a floor (Stow 520 vs 853)", () => {
  assert.equal(heldAboveTarget({ actualPx: 520, targetPx: 853 }), false);
});

test("within rounding of the target is not a floor", () => {
  assert.equal(heldAboveTarget({ actualPx: 401, targetPx: 400 }), false);
});
