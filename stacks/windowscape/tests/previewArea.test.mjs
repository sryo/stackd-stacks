// previewArea: the work area the gesture-resize preview predicts against
// must be the one the tiler last laid the row out in.
import test from "node:test";
import assert from "node:assert/strict";
import { previewArea } from "../modules/layouts.js";

const d = { displayID: 1, frame: { x: 0, y: 0, w: 1440, h: 900 }, visibleFrame: { x: 0, y: 25, w: 1440, h: 875 } };
const rail = { x: 0, y: 25, w: 1300, h: 875 };

test("uses the tiler's last area for the display (snapshot rail and float zone applied)", () => {
  const last = { x: 0, y: 25, w: 1000, h: 875 };
  assert.deepEqual(previewArea(d, last, rail), { area: last, horizontal: true });
});

test("orientation comes from the rail frame, like the tiler, not the zone-narrowed area", () => {
  const narrow = { x: 0, y: 25, w: 600, h: 875 };
  assert.equal(previewArea(d, narrow, rail).horizontal, true);
});

test("before any tile pass: rail frame, then visibleFrame", () => {
  assert.deepEqual(previewArea(d, undefined, rail).area, rail);
  assert.deepEqual(previewArea(d, undefined, null).area, d.visibleFrame);
});

test("no display → no area", () => {
  assert.equal(previewArea(null, undefined, null), null);
});
