// isNotched — whether this display has a camera notch the center zones
// must straddle. The daemon reports the notch geometry directly.
import test from "node:test";
import assert from "node:assert/strict";
import { isNotched } from "../logic.js";

test("a reported notch width means notched", () => {
  assert.equal(isNotched({ notch: { leftWidth: 646, rightX: 866, width: 220, safeAreaTop: 32 } }), true);
});

test("a display without notch geometry is not notched, however tall its menu bar", () => {
  assert.equal(isNotched({ notch: null, frame: { h: 1440 }, visibleFrame: { h: 1400 } }), false);
});

test("no screen info is not notched", () => {
  assert.equal(isNotched(null), false);
});
