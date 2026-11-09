// Untiled displays (cfg.untiledDisplays) — a display matched by name stays in
// state.displays (displayForWindow still resolves windows on it) but is never
// tiled, never a moveScreen target, and its arrival or departure does not
// count as a geometry change for the displays that are tiled. Fixture: the
// built-in panel plus a "loft" virtual display as stackd.log records it
// (`stack frame init=-1920,464 1920×1200 display=4`, 2026-11-09 15:00:20).
import test from "node:test";
import assert from "node:assert/strict";
import {
  isUntiledDisplay, tiledDisplays, adjacentDisplay, displayGeoSig, untiledRemoved, displayForFrame,
} from "../modules/layouts.js";
import { cfg } from "../modules/config.js";

const builtin = {
  displayID: 1, uuid: "BUILTIN-UUID", name: "Built-in Retina Display", builtin: true,
  frame: { x: 0, y: 0, w: 2560, h: 1664 }, visibleFrame: { x: 0, y: 57, w: 2560, h: 1607 },
};
const loft = {
  displayID: 4, uuid: "LOFT-UUID-1", name: "loft", builtin: false,
  frame: { x: -1920, y: 464, w: 1920, h: 1200 }, visibleFrame: { x: -1920, y: 464, w: 1920, h: 1200 },
};
const external = {
  displayID: 2, uuid: "EXT-UUID", name: "DELL U2720Q", builtin: false,
  frame: { x: 2560, y: 0, w: 2560, h: 1440 }, visibleFrame: { x: 2560, y: 25, w: 2560, h: 1415 },
};
const rules = [{ name: "loft" }];

test("default config leaves the loft untiled", () => {
  assert.deepEqual(cfg.untiledDisplays, [{ name: "loft" }]);
  assert.equal(isUntiledDisplay(loft), true);
  assert.equal(isUntiledDisplay(builtin), false);
});

test("isUntiledDisplay matches the display name exactly", () => {
  assert.equal(isUntiledDisplay(loft, rules), true);
  assert.equal(isUntiledDisplay({ ...loft, name: "Loft" }, rules), false);
  assert.equal(isUntiledDisplay({ ...loft, name: "loft 2" }, rules), false);
  assert.equal(isUntiledDisplay(builtin, rules), false);
});

test("isUntiledDisplay tolerates missing rules, names and displays", () => {
  assert.equal(isUntiledDisplay(loft, []), false);
  assert.equal(isUntiledDisplay(loft, null), false);
  assert.equal(isUntiledDisplay(loft, [{}]), false);
  assert.equal(isUntiledDisplay({ ...loft, name: undefined }, rules), false);
  assert.equal(isUntiledDisplay(null, rules), false);
});

test("a uuid change (every `loft up`) does not change the match", () => {
  assert.equal(isUntiledDisplay({ ...loft, uuid: "LOFT-UUID-2", displayID: 7 }, rules), true);
});

test("tiledDisplays drops untiled displays and keeps order", () => {
  assert.deepEqual(tiledDisplays([builtin, loft, external], rules), [builtin, external]);
  assert.deepEqual(tiledDisplays([builtin], rules), [builtin]);
  assert.deepEqual(tiledDisplays(null, rules), []);
});

test("displayForFrame still resolves a window on the loft (state.displays stays complete)", () => {
  const onLoft = { x: -1800, y: 500, w: 800, h: 600 };
  assert.equal(displayForFrame(onLoft, [builtin, loft]), loft);
});

test("adjacentDisplay: builtin plus loft has no tiled neighbor", () => {
  assert.equal(adjacentDisplay([builtin, loft], builtin, "next", rules), null);
  assert.equal(adjacentDisplay([builtin, loft], builtin, "prev", rules), null);
});

test("adjacentDisplay skips the loft and wraps among tiled displays", () => {
  const ds = [builtin, loft, external];
  assert.equal(adjacentDisplay(ds, builtin, "next", rules), external);
  assert.equal(adjacentDisplay(ds, builtin, "prev", rules), external);
  assert.equal(adjacentDisplay(ds, external, "next", rules), builtin);
});

test("adjacentDisplay from the loft itself reaches a tiled display", () => {
  assert.equal(adjacentDisplay([builtin, loft], loft, "next", rules), builtin);
  assert.equal(adjacentDisplay([builtin, loft], loft, "prev", rules), builtin);
});

test("adjacentDisplay without rules behaves like plain wraparound", () => {
  assert.equal(adjacentDisplay([builtin, loft], builtin, "next", []), loft);
  assert.equal(adjacentDisplay([builtin], builtin, "next", []), null);
  assert.equal(adjacentDisplay([builtin, loft], null, "next", []), null);
});

test("geometry signature ignores the loft being added or removed", () => {
  assert.equal(displayGeoSig([builtin, loft], rules), displayGeoSig([builtin], rules));
  assert.equal(displayGeoSig([loft, builtin], rules), displayGeoSig([builtin], rules));
});

test("geometry signature ignores the loft moving (second loft at -3840)", () => {
  const moved = { ...loft, displayID: 5, frame: { ...loft.frame, x: -3840 }, visibleFrame: { ...loft.visibleFrame, x: -3840 } };
  assert.equal(displayGeoSig([builtin, moved], rules), displayGeoSig([builtin, loft], rules));
});

test("geometry signature still changes for tiled displays", () => {
  const base = displayGeoSig([builtin, loft], rules);
  assert.notEqual(displayGeoSig([builtin, loft, external], rules), base);
  const dock = { ...builtin, visibleFrame: { ...builtin.visibleFrame, h: 1500 } };
  assert.notEqual(displayGeoSig([dock, loft], rules), base);
  // Without rules the loft counts like any display.
  assert.notEqual(displayGeoSig([builtin, loft], []), displayGeoSig([builtin], []));
});

test("geometry signature keeps the pre-existing format", () => {
  assert.equal(displayGeoSig([builtin], rules), "1|0,0,2560,1664|0,57,2560,1607");
});

test("untiledRemoved names an untiled display that left", () => {
  assert.deepEqual(untiledRemoved([builtin, loft], [builtin], rules), [loft]);
  assert.deepEqual(untiledRemoved([builtin], [builtin, loft], rules), []);
  assert.deepEqual(untiledRemoved([builtin, loft], [builtin, loft], rules), []);
  // A tiled display leaving is the normal settle path's business.
  assert.deepEqual(untiledRemoved([builtin, external], [builtin], rules), []);
  assert.deepEqual(untiledRemoved(null, [builtin], rules), []);
});
