// The collapsed rail along the bottom of a landscape display. Collapsed
// Stickies notes keep their own width (the app refuses width writes), so when
// their widths add up past the display they must overlap instead of running
// off its right edge.
import test from "node:test";
import assert from "node:assert/strict";
import { tileWeighted } from "../modules/layouts.js";

const SF = { x: 0, y: 38, w: 1710, h: 1074 };
const spec = () => ({ weight: 1, basis: null, min: 0, active: false });

test("notes wider than the display in total all stay on it", () => {
  const widths = { 1: 570, 2: 570, 3: 570, 4: 427 };
  const out = tileWeighted(SF, [9], [1, 2, 3, 4], true, (id) => ({ w: widths[id], h: 12 }), spec);
  for (const t of out.filter((t) => t.winId !== 9)) {
    assert.ok(t.frame.x >= SF.x, `${t.winId} starts on screen`);
    assert.ok(t.frame.x + t.frame.w <= SF.x + SF.w, `${t.winId} ends on screen (x=${t.frame.x})`);
  }
  const xs = out.filter((t) => t.winId !== 9).map((t) => t.frame.x);
  assert.deepEqual([...xs].sort((a, b) => a - b), xs, "left-to-right order kept");
  assert.equal(xs[0], SF.x);
});

test("notes that fit are justified edge to edge", () => {
  const out = tileWeighted(SF, [], [1, 2], true, () => ({ w: 400, h: 12 }), spec);
  assert.equal(out[0].frame.x, 0);
  assert.equal(out[1].frame.x + out[1].frame.w, 1710);
});
