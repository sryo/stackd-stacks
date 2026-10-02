// Which windows the tiler takes and which it leaves floating at the frame
// their app chose. Fixtures are real AX readings: document windows carry an
// enabled fullscreen button and a settable size; Calculator / About This Mac
// / an app's Settings refuse any size; System Settings resizes but has no
// fullscreen button and a fixed width; Activity Monitor has no fullscreen
// button but tiles fine above its minimum width.
import test from "node:test";
import assert from "node:assert/strict";
import { floatReason, isTileable, nextOverride, refusedGrowth, fixedWidthPin, isPanelRefusal, collapsedChanged, isRailShuffle, heldAbove } from "../modules/tileable.js";

const doc        = { id: 1, isStandard: true, isResizable: true,  canFullscreen: true };
const calculator = { id: 2, isStandard: true, isResizable: false, canFullscreen: false };
const settings   = { id: 3, isStandard: true, isResizable: true,  canFullscreen: false };
const pending    = { id: 4, isStandard: true };

test("document window tiles", () => {
  assert.equal(floatReason(doc), null);
  assert.equal(isTileable(doc), true);
});

test("a window that refuses any size floats", () => {
  assert.equal(floatReason(calculator), "fixed-size");
  assert.equal(isTileable(calculator), false);
});

test("a collapsible window (Stickies) is never fixed-size, even though collapsed it refuses a size", () => {
  const note = { id: 5, isStandard: true, isResizable: false, canFullscreen: false };
  assert.equal(floatReason(note, { collapsible: true }), null);
  assert.equal(isTileable(note, { collapsible: true }), true);
});

test("no fullscreen button alone does not float (Activity Monitor)", () => {
  assert.equal(isTileable(settings), true);
});

test("fixed-width windows tile, pinned at the width their app refused to grow past", () => {
  assert.equal(isTileable(settings), true);
  assert.equal(fixedWidthPin(settings, 865), 865);
  assert.equal(fixedWidthPin(settings, undefined), null, "app not learned yet");
  assert.equal(fixedWidthPin(doc, 865), null, "a fullscreen-capable window of the same app is not fixed");
});

test("traits not read yet → not tiled yet", () => {
  assert.equal(isTileable(pending), false);
});

test("non-standard windows never tile", () => {
  assert.equal(isTileable({ ...doc, isStandard: false }), false);
  assert.equal(isTileable({ ...doc, isStandard: undefined }), false);
  assert.equal(isTileable(null), false);
});

test("user overrides win both ways", () => {
  assert.equal(floatReason(doc, { override: "float" }), "user");
  assert.equal(isTileable(calculator, { override: "tile" }), true);
});

test("toggle: tiled → float", () => {
  assert.equal(nextOverride(doc, {}), "float");
});

test("toggle: user-floated → back to automatic", () => {
  assert.equal(nextOverride(doc, { override: "float" }), undefined);
});

test("toggle: auto-floated → forced tile, and forced tile → float", () => {
  assert.equal(nextOverride(calculator, {}), "tile");
  assert.equal(nextOverride(calculator, { override: "tile" }), "float");
});

test("refusedGrowth: only a window left smaller than its target has a maximum", () => {
  const target = { w: 1280, h: 1600 };
  assert.equal(refusedGrowth(target, { w: 865, h: 1600 }, true, 20), true);
  assert.equal(refusedGrowth({ w: 512, h: 1600 }, { w: 865, h: 1600 }, true, 20), false, "min-width refusal");
  assert.equal(refusedGrowth(target, { w: 1265, h: 1600 }, true, 20), false, "within rounding");
  assert.equal(refusedGrowth({ w: 800, h: 1600 }, { w: 800, h: 900 }, false, 20), true, "vertical axis");
});

// Get Info resizes, but won't grow to a tile's full height; System Settings
// and Activity Monitor (also no fullscreen button) do.
const getInfo = { id: 7, isStandard: true, isResizable: true, canFullscreen: false };

test("isPanelRefusal: no fullscreen button and short of the tile's cross axis", () => {
  const tile = { w: 400, h: 1607 };
  assert.equal(isPanelRefusal(getInfo, tile, { w: 400, h: 829 }, 20), true);
  assert.equal(isPanelRefusal(settings, tile, { w: 400, h: 1607 }, 20), false, "grows to full height");
  assert.equal(isPanelRefusal(doc, tile, { w: 400, h: 829 }, 20), false, "fullscreen-capable");
  assert.equal(isPanelRefusal(getInfo, tile, { w: 400, h: 1600 }, 20), false, "within rounding");
});

test("an app learned as a panel app floats its windows without a fullscreen button", () => {
  assert.equal(floatReason(getInfo, { panelApp: true }), "panel");
  assert.equal(floatReason(doc, { panelApp: true }), null, "the app's document windows still tile");
  assert.equal(floatReason({ ...getInfo, isResizable: false }, { panelApp: true, collapsible: true }), null);
});


test("collapsedChanged: expand and collapse both count, plain resizes don't", () => {
  const rail = { x: 0, y: 1100, w: 512, h: 12 };
  const tile = { x: 0, y: 38, w: 512, h: 1074 };
  assert.equal(collapsedChanged(rail, tile, 12), true);
  assert.equal(collapsedChanged(tile, rail, 12), true);
  assert.equal(collapsedChanged(tile, { ...tile, h: 900 }, 12), false);
  assert.equal(collapsedChanged(rail, rail, 12), false);
});

test("isRailShuffle: a collapsed note moving along the rail is the app's own shuffle", () => {
  const rail = { x: 0, y: 1100, w: 512, h: 12 };
  assert.equal(isRailShuffle(rail, { ...rail, x: 600 }, 12), true);
  assert.equal(isRailShuffle(null, rail, 12), true);
});

test("isRailShuffle: a tile that just collapsed in place is not a shuffle", () => {
  const tile = { x: 1140, y: 38, w: 570, h: 1062 };
  assert.equal(isRailShuffle(tile, { x: 1140, y: 38, w: 570, h: 12 }, 12), false);
});

test("isRailShuffle: a collapsed note dragged off the rail, or an expanded one, is not", () => {
  const rail = { x: 0, y: 1100, w: 512, h: 12 };
  assert.equal(isRailShuffle(rail, { ...rail, y: 500 }, 12), false);
  assert.equal(isRailShuffle(rail, { ...rail, h: 900 }, 12), false);
});

// A gesture step's target can land under a window's minimum while the
// gesture is still running (no refusal sweep between steps); the window
// holding larger than its last target is that minimum.
test("heldAbove: a window held larger than its target reports the size it held", () => {
  const target = { x: 77, y: -240, w: 1080, h: 240 };
  assert.equal(heldAbove(target, { x: 77, y: -240, w: 1080, h: 252 }, false, 5), 252);
});

test("heldAbove: a window at or under its target, or unread, reports nothing", () => {
  const target = { x: 0, y: 38, w: 855, h: 1074 };
  assert.equal(heldAbove(target, { ...target }, true, 5), null);
  assert.equal(heldAbove(target, { ...target, w: 700 }, true, 5), null);
  assert.equal(heldAbove(null, target, true, 5), null);
  assert.equal(heldAbove(target, null, true, 5), null);
});

test("heldAbove: a window still animating toward its target reports nothing", () => {
  // Finder mid-animation from 773 toward 497 reads its pre-animation frame
  // (the daemon swallows reports while it animates) — not a minimum.
  const target = { x: 77, y: -497, w: 1080, h: 497 };
  assert.equal(heldAbove(target, { x: 77, y: -773, w: 1080, h: 773 }, false, 5, true), null);
  assert.equal(heldAbove(target, { x: 77, y: -773, w: 1080, h: 773 }, false, 5, false), 773);
});

// On a portrait display the column's cross axis is width. System Settings
// has a fixed width but grows to any height — it tiles in a column like it
// does in a row. What marks a panel (Get Info) is refusing full height.
test("isPanelRefusal: a fixed-width window in a portrait column is not a panel", () => {
  const w = { canFullscreen: false };
  const target = { x: 77, y: -844, w: 1080, h: 844 };
  assert.equal(isPanelRefusal(w, target, { x: 77, y: -866, w: 865, h: 866 }, 20), false);
});

test("isPanelRefusal: a window short of full height is a panel in a column too", () => {
  const w = { canFullscreen: false };
  const target = { x: 77, y: -844, w: 1080, h: 844 };
  assert.equal(isPanelRefusal(w, target, { x: 77, y: -844, w: 1080, h: 400 }, 20), true);
});
