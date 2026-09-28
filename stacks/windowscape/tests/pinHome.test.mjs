// A pin is a size on one display's major axis. When a window lands on another
// display, or its display flips between landscape and portrait, the pin no
// longer means anything there and must not shape the new row.
import test from "node:test";
import assert from "node:assert/strict";
import { pinHomeKey, pinsFromElsewhere, tileWeighted, specFromState } from "../modules/layouts.js";

const weightOf = () => 1;
const sizeOf = () => ({ w: 200, h: 200 });
const spec = (pins) => specFromState({ pins, refusalSet: new Set(), weightOf, lastId: null, appMinOf: () => 0 });

test("a pin set on another display is left behind", () => {
  const homes = { 42: pinHomeKey(3, false) };
  const here = pinHomeKey(1, true);
  assert.deepEqual(pinsFromElsewhere({ ids: [2118, 42], pins: { 42: 1996 }, homes, here }), [42]);
});

test("a pin set on this display and axis stays", () => {
  const here = pinHomeKey(1, true);
  assert.deepEqual(pinsFromElsewhere({ ids: [1, 2], pins: { 1: 600, 2: 900 }, homes: { 1: here, 2: here }, here }), []);
});

test("the same display flipping axis leaves its pins behind", () => {
  const homes = { 1: pinHomeKey(1, false) };
  assert.deepEqual(pinsFromElsewhere({ ids: [1], pins: { 1: 800 }, homes, here: pinHomeKey(1, true) }), [1]);
});

test("a pin with no recorded home is kept (restored layouts, recreated windows)", () => {
  assert.deepEqual(pinsFromElsewhere({ ids: [1], pins: { 1: 800 }, homes: {}, here: pinHomeKey(1, true) }), []);
});

test("unpinned windows are never reported", () => {
  const homes = { 1: pinHomeKey(3, false) };
  assert.deepEqual(pinsFromElsewhere({ ids: [1], pins: {}, homes, here: pinHomeKey(1, true) }), []);
});

test("regression: a portrait pin moved to a landscape row no longer skews the split", () => {
  // Field case: Claude pinned at 1996px tall on a portrait display, unplugged
  // onto a 2420px-wide landscape row beside one unpinned window → 470/1950.
  const sf = { x: 0, y: 57, w: 2420, h: 1607 };
  const pins = { 42: 1996 };
  const skewed = tileWeighted(sf, [2118, 42], [], true, sizeOf, spec(pins));
  assert.notEqual(skewed[0].frame.w, skewed[1].frame.w, "the stale pin skews the row");

  for (const id of pinsFromElsewhere({ ids: [2118, 42], pins, homes: { 42: pinHomeKey(3, false) }, here: pinHomeKey(1, true) }))
    delete pins[id];
  const even = tileWeighted(sf, [2118, 42], [], true, sizeOf, spec(pins));
  assert.equal(even[0].frame.w, even[1].frame.w);
});
