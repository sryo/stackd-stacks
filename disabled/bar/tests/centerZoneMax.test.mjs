// centerZoneMax: how wide a center zone may grow before it runs into the
// side zone it grows toward. Center zones are anchored at the notch (or the
// screen middle) and grow outward, so a long song title used to draw over
// the right zone's leftmost items.
import test from "node:test";
import assert from "node:assert/strict";
import { centerZoneMax } from "../logic.js";

test("center-right on a notched 1710pt bar stops a gap short of the right zone", () => {
  // Anchored at 855 + 185/2 + 10, right zone's leftmost item starts at 1300.
  assert.equal(centerZoneMax(957.5, 1300, 14), 328.5);
});

test("center-right without a notch starts at the middle", () => {
  assert.equal(centerZoneMax(540, 900, 14), 346);
});

test("center-left grows leftward toward the left zone", () => {
  // Anchored edge at 752.5, left zone ends at 400.
  assert.equal(centerZoneMax(752.5, 400, 14), 338.5);
});

test("no room left clamps to zero", () => {
  assert.equal(centerZoneMax(957.5, 950, 14), 0);
});
