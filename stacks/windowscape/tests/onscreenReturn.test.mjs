// Fence for returnedOnscreen — a window the tiler dropped after its offscreen
// grace (e.g. hidden behind another app's fullscreen space) must trigger a
// retile when it comes back onscreen, or it stays out of the rotation until
// some unrelated event.
import test from "node:test";
import assert from "node:assert/strict";
import { returnedOnscreen } from "../modules/onscreen.js";

test("a window the tiler counted as offscreen that is back onscreen", () => {
  const prev = { 1: { onscreen: false }, 2: { onscreen: false }, 3: { onscreen: true } };
  const list = [{ id: 1, onscreen: true }, { id: 2, onscreen: false }, { id: 3, onscreen: true }];
  assert.deepEqual(returnedOnscreen(prev, list, { 1: 1000, 2: 1000 }), [1]);
});

test("ignores windows the tiler never counted as offscreen", () => {
  const prev = { 1: { onscreen: false } };
  const list = [{ id: 1, onscreen: true }];
  assert.deepEqual(returnedOnscreen(prev, list, {}), []);
});

test("ignores new windows and unknown onscreen state", () => {
  const list = [{ id: 1, onscreen: true }, { id: 2 }];
  assert.deepEqual(returnedOnscreen({ 2: { onscreen: false } }, list, { 1: 1, 2: 1 }), [2]);
  assert.deepEqual(returnedOnscreen({}, list, { 1: 1 }), []);
});
