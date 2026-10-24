// The window under a drag's mouse-down, from sd.windows.at, decides which
// bangs inside the bracket belong to the drag, whether a double-click was on
// a title bar, and whether a size change at release is a user resize.
import test from "node:test";
import assert from "node:assert/strict";
import { acceptsBang, titlebarPress, isUserResize } from "../modules/dragtarget.js";

const hit = (id, region, edges = []) => ({ id, pid: 1, app: "App", frame: { x: 0, y: 0, w: 800, h: 600 }, region, edges });

test("with no hit test result every bang may be the drag's", () => {
  assert.equal(acceptsBang(null, 7), true);
  assert.equal(acceptsBang(undefined, 7), true);
});

test("with a hit only the window under the mouse-down is the drag's", () => {
  assert.equal(acceptsBang(hit(7, "titlebar"), 7), true);
  assert.equal(acceptsBang(hit(7, "edge", ["right"]), 9), false, "a neighbor refusing a write is not the drag");
  assert.equal(acceptsBang(hit(7, "content"), 9), false, "a service window's bang is not the drag");
});

test("a press anywhere in a tiled window's title bar names it", () => {
  const tiled = (id) => id === 7;
  assert.equal(titlebarPress(hit(7, "titlebar"), tiled), 7);
  assert.equal(titlebarPress(hit(8, "titlebar"), tiled), null, "an untiled window keeps native zoom");
  assert.equal(titlebarPress(hit(7, "control"), tiled), 7,
    "web-drawn title bars (Electron) read as controls; a zoom there must still be caught");
  assert.equal(titlebarPress(hit(7, "edge", ["top"]), tiled), null);
  assert.equal(titlebarPress(hit(7, "content"), tiled), null);
  assert.equal(titlebarPress(null, tiled), null);
});

test("a size change past 20px is a user resize unless the drag held the title bar", () => {
  assert.equal(isUserResize(hit(7, "edge", ["right"]), 120, 0), true);
  assert.equal(isUserResize(null, 0, 40), true, "no hit result keeps the size rule alone");
  assert.equal(isUserResize(hit(7, "edge", ["right"]), 15, 10), false);
  assert.equal(isUserResize(hit(7, "titlebar"), 300, 200), false,
    "macOS reshaping a window dragged by its title bar is not the user resizing it");
  assert.equal(isUserResize(hit(7, "content"), 120, 0), true, "a background drag can't be told from an app resize");
});
