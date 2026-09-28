// Pure decisions behind the snapshot strip (modules/snaprules.js).
import test from "node:test";
import assert from "node:assert/strict";
import { keepPersistedSnapshot, menuClickAction, clampMenuOrigin, scrolledOffset, railRect, menuHeight } from "../modules/snaprules.js";

const entry = { app: "Notes", image: "data:" };

test("persisted thumbnail survives when the window list still carries it minimized", () => {
  assert.equal(keepPersistedSnapshot({ entry, live: { id: 7, isMinimized: true }, axMinimized: true }), true);
});

test("persisted thumbnail survives when the window is absent from the list but AX says minimized", () => {
  assert.equal(keepPersistedSnapshot({ entry, live: undefined, axMinimized: true }), true);
});

test("persisted thumbnail is dropped when the listed window is not minimized", () => {
  assert.equal(keepPersistedSnapshot({ entry, live: { id: 7, isMinimized: false }, axMinimized: true }), false);
});

test("persisted thumbnail is dropped when AX no longer reports it minimized", () => {
  assert.equal(keepPersistedSnapshot({ entry, live: { id: 7, isMinimized: true }, axMinimized: false }), false);
  assert.equal(keepPersistedSnapshot({ entry, live: undefined, axMinimized: false }), false);
});

test("an order id with no saved entry is dropped", () => {
  assert.equal(keepPersistedSnapshot({ entry: undefined, live: undefined, axMinimized: true }), false);
});

// The observer tap sees every leftMouseDown; the rail and the menu overlays
// receive their own clicks directly. Either may arrive first.
test("menu closed: only the direct click acts, on a tile", () => {
  assert.equal(menuClickAction({ tap: "direct", menuOpen: false, inMenu: false, onRow: false, onTile: true }), "tile");
  assert.equal(menuClickAction({ tap: "observe", menuOpen: false, inMenu: false, onRow: false, onTile: true }), "none");
});

test("menu open: a click on a thumbnail dismisses the menu and never acts on the tile", () => {
  const verdicts = ["observe", "direct"].map((tap) =>
    menuClickAction({ tap, menuOpen: true, inMenu: false, onRow: false, onTile: true }));
  assert.ok(!verdicts.includes("tile"));
  assert.deepEqual(verdicts.filter((v) => v !== "none"), ["dismiss"]);
});

test("menu open: a row click runs the row exactly once, whichever arrives first", () => {
  const verdicts = ["observe", "direct"].map((tap) =>
    menuClickAction({ tap, menuOpen: true, inMenu: true, onRow: true, onTile: true }));
  assert.deepEqual(verdicts.filter((v) => v !== "none"), ["row"]);
});

test("menu open: a click elsewhere dismisses from the observer tap", () => {
  assert.equal(menuClickAction({ tap: "observe", menuOpen: true, inMenu: false, onRow: false, onTile: false }), "dismiss");
});

test("menu open: a click on the menu's padding or separator does nothing", () => {
  for (const tap of ["observe", "direct"]) {
    assert.equal(menuClickAction({ tap, menuOpen: true, inMenu: true, onRow: false, onTile: false }), "none");
  }
});

const panel = { x: 0, y: 0, w: 1440, h: 900 };
const size = { w: 160, h: 200 };

test("menu opens at the cursor when it fits", () => {
  assert.deepEqual(clampMenuOrigin({ x: 100, y: 100 }, size, panel), { x: 100, y: 100 });
});

test("menu near the right/bottom edge is pulled back inside", () => {
  assert.deepEqual(clampMenuOrigin({ x: 1430, y: 890 }, size, panel), { x: 1440 - 160 - 4, y: 900 - 200 - 4 });
});

test("a cursor left of or above the panel (another display) still lands the menu inside it", () => {
  assert.deepEqual(clampMenuOrigin({ x: -800, y: -50 }, size, panel), { x: 4, y: 4 });
  const offset = { x: 1440, y: 0, w: 1920, h: 1080 };
  assert.deepEqual(clampMenuOrigin({ x: 200, y: 300 }, size, offset), { x: 1444, y: 300 });
});

// scrollWheel payloads carry point deltas: positive deltaY moves content
// down (toward the start), as in any scroll view.
test("strip scroll follows the wheel/trackpad delta, not a fixed step", () => {
  assert.equal(scrolledOffset(100, { deltaX: 0, deltaY: -12 }), 112);
  assert.equal(scrolledOffset(100, { deltaX: 0, deltaY: 30 }), 70);
});

test("strip scroll uses the dominant axis, so a sideways swipe scrolls a row", () => {
  assert.equal(scrolledOffset(100, { deltaX: -40, deltaY: 3 }), 140);
});

test("a payload without deltas leaves the offset alone", () => {
  assert.equal(scrolledOffset(100, {}), 100);
  assert.equal(scrolledOffset(undefined, { deltaY: -5 }), 5);
});

// The rail overlay takes real clicks, so it covers only its thumbnails (plus
// a margin for their shadow), never the empty rest of the reserved band.
const band = { x: 2420, y: 57, w: 140, h: 1607 };
const railTile = (gy, gh = 100) => ({ gx: 2432, gy, gw: 120, gh });

test("railRect hugs the thumbnails, not the whole band", () => {
  const r = railRect({ reserved: band, tiles: [railTile(65), railTile(169)] }, 8);
  assert.deepEqual(r, { x: 2424, y: 57, w: 136, h: 220 });
});

test("railRect is clipped to the band when thumbnails scroll past it", () => {
  const r = railRect({ reserved: band, tiles: [railTile(-300, 900), railTile(604, 1500)] }, 8);
  assert.deepEqual(r, { x: 2424, y: band.y, w: 136, h: band.h });
});

test("railRect is null with nothing to cover", () => {
  assert.equal(railRect({ reserved: band, tiles: [] }, 8), null);
  assert.equal(railRect({ reserved: band, tiles: [railTile(5000)] }, 8), null);
});

test("menuHeight adds rows, separators and padding", () => {
  const items = [{}, {}, null, {}, {}, {}];
  assert.equal(menuHeight(items, { rowH: 26, sepH: 9, pad: 4 }), 4 + 5 * 26 + 9 + 4);
});
