// zoneItems — which zone each visible item renders in, and in what DOM
// order. Lower `order` sits closer to the zone's anchored edge; ties break
// by id. Without a notch there is no center-left zone.
import test from "node:test";
import assert from "node:assert/strict";
import { zoneItems } from "../logic.js";

const ids = (zones) => Object.fromEntries(Object.entries(zones).map(([k, v]) => [k, v.map((i) => i.id)]));

test("left-anchored zones render lowest order first", () => {
  const z = zoneItems([
    { id: "clock", side: "left", order: 30 },
    { id: "app", side: "left", order: 10 }
  ], true);
  assert.deepEqual(ids(z).left, ["app", "clock"]);
});

test("right-anchored zones render lowest order last, nearest the edge", () => {
  const z = zoneItems([
    { id: "battery", side: "right", order: 50 },
    { id: "network", side: "right", order: 55 },
    { id: "b", side: "center-left", order: 1 },
    { id: "a", side: "center-left", order: 1 }
  ], true);
  assert.deepEqual(ids(z).right, ["network", "battery"]);
  assert.deepEqual(ids(z)["center-left"], ["b", "a"]);
});

test("items default to the right zone at order 100", () => {
  const z = zoneItems([{ id: "x" }, { id: "y", side: "right", order: 99 }], true);
  assert.deepEqual(ids(z).right, ["x", "y"]);
});

test("without a notch, center-left items join center-right", () => {
  const z = zoneItems([
    { id: "pill", side: "center-right", order: 50 },
    { id: "early", side: "center-left", order: 10 }
  ], false);
  assert.deepEqual(ids(z), { left: [], "center-left": [], "center-right": ["early", "pill"], right: [] });
});
