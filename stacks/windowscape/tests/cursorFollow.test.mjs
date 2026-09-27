// cursorFollow: where the cursor goes when a keyboard reorder moves the window
// it sits on. The window may still be animating, so the tiler's target frame
// is the landing spot; the live frame is only a fallback.
import test from "node:test";
import assert from "node:assert/strict";
import { cursorFollow } from "../modules/layouts.js";

const oldFrame = { x: 0, y: 0, w: 500, h: 800 };
const mouse = { x: 100, y: 200 };

test("keeps the cursor's offset inside the window, at the tile target", () => {
  const target = { x: 700, y: 0, w: 500, h: 800 };
  const live = { x: 150, y: 0, w: 500, h: 800 };   // mid-animation
  assert.deepEqual(cursorFollow(mouse, oldFrame, target, live), { x: 800, y: 200 });
});

test("falls back to the live frame without a target", () => {
  assert.deepEqual(cursorFollow(mouse, oldFrame, null, { x: 700, y: 10, w: 1, h: 1 }), { x: 800, y: 210 });
});

test("no frame → no warp", () => {
  assert.equal(cursorFollow(mouse, oldFrame, null, null), null);
});
