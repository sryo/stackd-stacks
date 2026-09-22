// displayForFrame — which display a window belongs to, from its frame. The
// center wins; a window whose center is off every display goes to the one it
// overlaps most; a window that overlaps no known display belongs to none.
// The last rule matters right after a display is reconnected: the display
// list can still be the old one while macOS has already moved a window back
// onto the returning display, and claiming it for the built-in display would
// pull it back.
import test from "node:test";
import assert from "node:assert/strict";
import { displayForFrame } from "../modules/layouts.js";

const builtin  = { displayID: 1, frame: { x: 0,  y: 0,     w: 1710, h: 1112 } };
const external = { displayID: 2, frame: { x: 77, y: -2560, w: 1080, h: 2560 } };

test("center on a display picks that display", () => {
  const f = { x: 100, y: 100, w: 400, h: 300 };
  assert.equal(displayForFrame(f, [builtin, external]).displayID, 1);
  assert.equal(displayForFrame({ x: 77, y: -2530, w: 1080, h: 2530 }, [builtin, external]).displayID, 2);
});

test("center off-screen falls back to the most-overlapped display", () => {
  // Dragged mostly past the right edge of the built-in display.
  const f = { x: 1500, y: 100, w: 600, h: 300 };
  assert.equal(displayForFrame(f, [builtin, external]).displayID, 1);
});

test("a window on no known display belongs to none", () => {
  // Stale list (external not known yet); the window already sits on it.
  const onExternal = { x: 77, y: -2530, w: 1080, h: 2530 };
  assert.equal(displayForFrame(onExternal, [builtin]), null);
});

test("missing frame or displays yield null", () => {
  assert.equal(displayForFrame(null, [builtin]), null);
  assert.equal(displayForFrame({ x: 0, y: 0, w: 10, h: 10 }, []), null);
});
