// isPrimaryScreen — whether this bar instance sits on the primary display.
// display:"all" spawns one instance per NSScreen in order; index 0 is the
// screen that carries the system menu bar.
import test from "node:test";
import assert from "node:assert/strict";
import { isPrimaryScreen } from "../logic.js";

test("the first screen is primary", () => {
  assert.equal(isPrimaryScreen({ index: 0, displayID: 1, frame: { x: 0, y: 0, w: 1512, h: 982 } }), true);
});

test("any other screen is not primary", () => {
  assert.equal(isPrimaryScreen({ index: 1, displayID: 2, frame: { x: 1512, y: 0, w: 2560, h: 1440 } }), false);
});

test("no screen info is not primary", () => {
  assert.equal(isPrimaryScreen(null), false);
});
