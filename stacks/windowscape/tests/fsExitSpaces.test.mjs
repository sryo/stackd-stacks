// Fence for fullscreenExits / idsCachedOnSpaces — after a display leaves a
// fullscreen space, the windows whose cached space list names that space must
// be re-queried, or a window that came back to the desktop stays filtered out
// of its rotation as "on another space".
import test from "node:test";
import assert from "node:assert/strict";
import { fullscreenExits, idsCachedOnSpaces } from "../modules/oobguard.js";

test("a display flipping fullscreen → normal reports the space it left", () => {
  const prev = { A: { active: 9, isFullscreen: true }, B: { active: 1, isFullscreen: false } };
  const next = { A: { active: 1, isFullscreen: false }, B: { active: 1, isFullscreen: false } };
  assert.deepEqual(fullscreenExits(prev, next), [{ uuid: "A", space: 9 }]);
});

test("no exit when staying fullscreen, entering it, or the display vanished", () => {
  const prev = { A: { active: 9, isFullscreen: true }, B: { active: 1, isFullscreen: false }, C: { active: 7, isFullscreen: true } };
  const next = { A: { active: 8, isFullscreen: true }, B: { active: 9, isFullscreen: true } };
  assert.deepEqual(fullscreenExits(prev, next), []);
  assert.deepEqual(fullscreenExits(undefined, next), []);
});

test("picks windows whose cached spaces include an exited space", () => {
  const cache = { 10: [9], 11: [1], 12: [1, 9], 13: [], 14: undefined };
  assert.deepEqual(idsCachedOnSpaces(cache, [9]).sort((a, b) => a - b), [10, 12]);
  assert.deepEqual(idsCachedOnSpaces(cache, []), []);
});
