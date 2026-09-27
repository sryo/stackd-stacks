import test from "node:test";
import assert from "node:assert/strict";
import { cornerRects, sameRects, inFrame } from "../logic.js";

const primary = { frame: { x: 0, y: 0, w: 1512, h: 982 } };
const side = { frame: { x: 1512, y: -200, w: 1920, h: 1080 } };

test("cornerRects returns the four corner bands of every display", () => {
  const rects = cornerRects([primary, side], 4);
  assert.equal(rects.length, 8);
  assert.deepEqual(rects[0], { x: 0, y: 0, w: 4, h: 4 });
  assert.deepEqual(rects[7], { x: 1512 + 1920 - 4, y: -200 + 1080 - 4, w: 4, h: 4 });
});

test("sameRects is true for an unchanged display list so the tap-rect push can be skipped", () => {
  const a = cornerRects([primary, side], 4);
  assert.equal(sameRects(a, cornerRects([{ ...primary, name: "renamed" }, side], 4)), true);
  assert.equal(sameRects(a, cornerRects([primary], 4)), false);
  assert.equal(sameRects(a, cornerRects([primary, { frame: { ...side.frame, y: 0 } }], 4)), false);
  assert.equal(sameRects(null, a), false);
});

test("inFrame tells whether a corner lies on the panel's own display", () => {
  assert.equal(inFrame(primary.frame, 0, 0), true);
  assert.equal(inFrame(primary.frame, 1511, 981), true);
  assert.equal(inFrame(primary.frame, 1512, 0), false);
  assert.equal(inFrame(null, 0, 0), false);
});

test("ownDisplays keeps only the display this instance's panel is on", async () => {
  const { ownDisplays } = await import("../logic.js");
  const list = [{ ...primary, displayID: 1 }, { ...side, displayID: 2 }];
  assert.deepEqual(ownDisplays(list, { displayID: 2 }), [list[1]]);
  assert.deepEqual(ownDisplays(list, { displayID: 9 }), []);
  assert.deepEqual(ownDisplays(list, null), []);
});
