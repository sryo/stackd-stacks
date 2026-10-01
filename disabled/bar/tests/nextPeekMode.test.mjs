// nextPeekMode — the fullscreen peek state machine. In a fullscreen space
// the bar hides ("fullscreen-minimal"); touching the top edge of THIS
// display reveals it ("fullscreen-peek") until the pointer drops well
// below the bar.
import test from "node:test";
import assert from "node:assert/strict";
import { nextPeekMode } from "../logic.js";

const primary = { index: 0, displayID: 1, frame: { x: 0, y: 0, w: 1512, h: 982 } };
// Stacked above the primary, sharing its x range.
const above = { index: 1, displayID: 2, frame: { x: 0, y: -1440, w: 2560, h: 1440 } };
const at = (x, y, display) => ({ x, y, display: { id: display.displayID, frame: display.frame } });

test("touching the top edge of this display peeks", () => {
  assert.equal(nextPeekMode("fullscreen-minimal", at(500, 0, primary), primary, 33), "fullscreen-peek");
});

test("touching the top edge of a display stacked above does not peek here", () => {
  assert.equal(nextPeekMode("fullscreen-minimal", at(500, -1440, above), primary, 33), "fullscreen-minimal");
});

test("the display above peeks from its own top edge", () => {
  assert.equal(nextPeekMode("fullscreen-minimal", at(500, -1440, above), above, 33), "fullscreen-peek");
});

test("dropping below the bar ends the peek", () => {
  assert.equal(nextPeekMode("fullscreen-peek", at(500, 60, primary), primary, 33), "fullscreen-minimal");
});

test("staying within the bar keeps the peek", () => {
  assert.equal(nextPeekMode("fullscreen-peek", at(500, 30, primary), primary, 33), "fullscreen-peek");
});

test("a pointer on another display leaves the peek alone", () => {
  assert.equal(nextPeekMode("fullscreen-peek", at(500, -700, above), primary, 33), "fullscreen-peek");
});

test("outside fullscreen the mode never changes", () => {
  assert.equal(nextPeekMode("normal", at(500, 0, primary), primary, 33), "normal");
});

test("a pointer with no display falls back to the frame bounds", () => {
  assert.equal(nextPeekMode("fullscreen-minimal", { x: 500, y: -1440, display: null }, primary, 33), "fullscreen-minimal");
  assert.equal(nextPeekMode("fullscreen-minimal", { x: 500, y: 1, display: null }, primary, 33), "fullscreen-peek");
});
