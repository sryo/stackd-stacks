// areaChanged — whether a display's tiling area differs from the one its
// last tile pass used. The snapshot rail's delayed retile after an OS
// minimize runs only when the rail changed the area after that pass, so a
// minimize that the minimize pass already laid out around the rail is not
// tiled twice.
import test from "node:test";
import assert from "node:assert/strict";
import { areaChanged } from "../modules/layouts.js";

test("no previous pass means the area changed", () => {
  assert.equal(areaChanged(undefined, { x: 0, y: 57, w: 2420, h: 1607 }), true);
});

test("the same area is unchanged", () => {
  assert.equal(areaChanged({ x: 0, y: 57, w: 2420, h: 1607 }, { x: 0, y: 57, w: 2420, h: 1607 }), false);
});

test("a rail that appeared after the pass changes the area", () => {
  assert.equal(areaChanged({ x: 0, y: 57, w: 2560, h: 1607 }, { x: 0, y: 57, w: 2420, h: 1607 }), true);
});
