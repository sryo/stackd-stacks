// displaySetChanged — a spaces push naming a different set of displays than
// the ones windowscape knows means a display was added or removed and the
// display list hasn't caught up yet. Tiling on that push would lay out with
// the old display list and pre-change window frames (pulling a window that
// macOS just moved onto a reconnected display back to the built-in one), so
// the spaces handler leaves the retile to the display-change settle.
import test from "node:test";
import assert from "node:assert/strict";
import { displaySetChanged } from "../modules/layouts.js";

const displays = [{ uuid: "A" }, { uuid: "B" }];

test("same displays: not a topology change", () => {
  assert.equal(displaySetChanged({ A: {}, B: {} }, displays), false);
});

test("display added or removed: topology change", () => {
  assert.equal(displaySetChanged({ A: {} }, displays), true);
  assert.equal(displaySetChanged({ A: {}, B: {}, C: {} }, displays), true);
});

test("no known displays yet: not a change (boot)", () => {
  assert.equal(displaySetChanged({ A: {} }, []), false);
});
