// Invariant fence for refreshBlockedByFullscreen, the snapshot refresh gate.
// The contract it pins: a tile is skipped exactly when the display it lives
// on shows a native fullscreen space; displays gate independently; and
// missing evidence (unknown display, no Spaces info yet) never blocks.
import test from "node:test";
import assert from "node:assert/strict";
import { refreshBlockedByFullscreen, liveStreamIds } from "../modules/snapgate.js";

const displays = [
  { displayID: 1, uuid: "AAAA" },
  { displayID: 2, uuid: "BBBB" },
];

const desktop    = { spaces: [3, 4], active: 3, isFullscreen: false };
const fullscreen = { spaces: [3, 4, 9], active: 9, isFullscreen: true };

test("display on a desktop space → refresh runs", () => {
  assert.equal(refreshBlockedByFullscreen(1, displays, { AAAA: desktop }), false);
});

test("display in a fullscreen space → refresh blocked", () => {
  assert.equal(refreshBlockedByFullscreen(1, displays, { AAAA: fullscreen }), true);
});

test("two displays gate independently", () => {
  const spaces = { AAAA: fullscreen, BBBB: desktop };
  assert.equal(refreshBlockedByFullscreen(1, displays, spaces), true);
  assert.equal(refreshBlockedByFullscreen(2, displays, spaces), false);
});

test("snapshot on a display that went away → not blocked", () => {
  assert.equal(refreshBlockedByFullscreen(7, displays, { AAAA: fullscreen }), false);
});

test("display with no Spaces entry → not blocked", () => {
  assert.equal(refreshBlockedByFullscreen(2, displays, { AAAA: fullscreen }), false);
});

test("pre-Spaces-info startup (empty / missing snapshots) → not blocked", () => {
  assert.equal(refreshBlockedByFullscreen(1, displays, {}), false);
  assert.equal(refreshBlockedByFullscreen(1, [], { AAAA: fullscreen }), false);
  assert.equal(refreshBlockedByFullscreen(1, null, null), false);
});

test("isFullscreen absent on the entry → not blocked", () => {
  assert.equal(refreshBlockedByFullscreen(1, displays, { AAAA: { active: 3 } }), false);
});

test("liveStreamIds: every drawn tile streams", () => {
  const strips = { 1: { displayID: 1, tiles: [{ winId: 10 }, { winId: 11 }] },
                   2: { displayID: 2, tiles: [{ winId: 20 }] } };
  assert.deepEqual(liveStreamIds(strips, displays, { AAAA: desktop, BBBB: desktop }), [10, 11, 20]);
});

test("liveStreamIds: a strip on a fullscreen display doesn't stream", () => {
  const strips = { 1: { displayID: 1, tiles: [{ winId: 10 }] },
                   2: { displayID: 2, tiles: [{ winId: 20 }] } };
  assert.deepEqual(liveStreamIds(strips, displays, { AAAA: fullscreen, BBBB: desktop }), [20]);
});

test("liveStreamIds: no strips → nothing streams", () => {
  assert.deepEqual(liveStreamIds({}, displays, {}), []);
});
