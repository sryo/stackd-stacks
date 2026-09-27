import test from "node:test";
import assert from "node:assert/strict";
import { cursorOnPanel } from "../logic.js";

const screen = { displayID: 2, frame: { x: 1512, y: 0, w: 1920, h: 1080 } };

test("cursorOnPanel translates to panel-local coords using the display frame from the mouse payload", () => {
  // The display moved since the panel booted: the payload frame is current.
  const m = { x: 1600, y: 300, display: { id: 2, frame: { x: 1000, y: 100, w: 1920, h: 1080 } } };
  assert.deepEqual(cursorOnPanel(m, screen), { x: 600, y: 200, w: 1920, h: 1080 });
});

test("cursorOnPanel is null when the cursor is on another display or off-screen", () => {
  assert.equal(cursorOnPanel({ x: 10, y: 10, display: { id: 1, frame: { x: 0, y: 0, w: 1512, h: 982 } } }, screen), null);
  assert.equal(cursorOnPanel({ x: 10, y: 10, display: null }, screen), null);
  assert.equal(cursorOnPanel({ x: 10, y: 10, display: { id: 2, frame: screen.frame } }, null), null);
});
