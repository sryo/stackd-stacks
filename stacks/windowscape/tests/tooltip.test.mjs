// Fence for the snapshot-strip tooltip helpers: what the hover tooltip says
// for a minimized window, and where its overlay panel goes next to the tile.
import test from "node:test";
import assert from "node:assert/strict";
import { tooltipLines, tooltipRect, TIP_W, TIP_H, TIP_GAP } from "../modules/tooltip.js";

test("app and title on two lines; one line when they match or one is missing", () => {
  assert.deepEqual(tooltipLines({ app: "Arc", title: "Docs" }), ["Arc", "Docs"]);
  assert.deepEqual(tooltipLines({ app: "Notes", title: "Notes" }), ["Notes"]);
  assert.deepEqual(tooltipLines({ app: "Arc", title: "" }), ["Arc"]);
  assert.deepEqual(tooltipLines({ title: "Only title" }), ["Only title"]);
  assert.deepEqual(tooltipLines({}), ["Untitled"]);
});

test("long lines are shortened in the middle", () => {
  const [, t] = tooltipLines({ app: "Arc", title: "a".repeat(40) + "b".repeat(40) });
  assert.ok(t.length <= 60, t);
  assert.ok(t.startsWith("aaa") && t.endsWith("bbb") && t.includes("..."), t);
});

test("right rail: panel sits left of the tile, vertically centered", () => {
  const tile = { gx: 2430, gy: 300, gw: 120, gh: 80 };
  assert.deepEqual(tooltipRect(tile, true),
    { x: 2430 - TIP_GAP - TIP_W, y: 300 + 40 - TIP_H / 2, w: TIP_W, h: TIP_H, align: "right" });
});

test("bottom strip: panel sits above the tile, horizontally centered", () => {
  const tile = { gx: 500, gy: 1500, gw: 120, gh: 80 };
  assert.deepEqual(tooltipRect(tile, false),
    { x: 500 + 60 - TIP_W / 2, y: 1500 - TIP_GAP - TIP_H, w: TIP_W, h: TIP_H, align: "bottom" });
});

test("the panel stays inside the given bounds along the strip", () => {
  const bounds = { x: 0, y: 0, w: 2560, h: 1600 };
  const nearLeft = tooltipRect({ gx: 10, gy: 1500, gw: 120, gh: 80 }, false, bounds);
  assert.equal(nearLeft.x, 0);
  const nearTop = tooltipRect({ gx: 2430, gy: 2, gw: 120, gh: 40 }, true, bounds);
  assert.equal(nearTop.y, 0);
  const nearBottom = tooltipRect({ gx: 2430, gy: 1580, gw: 120, gh: 20 }, true, bounds);
  assert.equal(nearBottom.y, 1600 - TIP_H);
});
