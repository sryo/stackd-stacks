// interactiveRects — the hover-gate rects the bar hands the daemon. They
// stay in CSS viewport coordinates: the daemon converts them against the
// panel's frame, so they must not carry the screen origin.
import test from "node:test";
import assert from "node:assert/strict";
import { interactiveRects } from "../logic.js";

const domRect = (left, top, width, height) => ({ left, top, width, height, x: left, y: top, right: left + width, bottom: top + height });

test("item rects pass through in viewport coordinates", () => {
  assert.deepEqual(interactiveRects([domRect(12, 0, 80, 33)]), [{ x: 12, y: 0, w: 80, h: 33 }]);
});

test("hidden items with an empty box are dropped", () => {
  assert.deepEqual(interactiveRects([domRect(0, 0, 0, 0), domRect(100, 0, 40, 0), domRect(200, 0, 40, 33)]),
    [{ x: 200, y: 0, w: 40, h: 33 }]);
});

test("no items clears the gate", () => {
  assert.deepEqual(interactiveRects([]), []);
});
