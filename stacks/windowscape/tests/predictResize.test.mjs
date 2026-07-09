// Pure unit tests for predictResizeFrame (windowscape gesture resize).
// predictResizeFrame runs the REAL tiler math (pairwise pin → resolve → tile)
// so the gesture preview equals the committed frame. Node >=22 auto-detects
// ESM, so this imports the real module directly — no package.json needed.
import test from "node:test";
import assert from "node:assert/strict";
import { predictResizeFrame, tileWeighted, resolvePinOversubscription, PIN_MIN_PX } from "../modules/layouts.js";

const SF = { x: 0, y: 0, w: 1000, h: 900 }; // vertical stack → major axis = height
const weightOf = () => 1;
const sizeOf = () => ({ w: 200, h: 200 }); // only consulted for collapsed widgets

function predict(over) {
  return predictResizeFrame({
    screenFrame: SF, horizontal: false, nonCollapsed: [1, 2, 3], collapsed: [],
    weightOf, sizeOf, pins: {}, refusalSet: new Set(),
    aBase: 300, bBase: 300, floor: PIN_MIN_PX, ...over,
  });
}

test("middle window, drag up → grows upward, top edge moves, bottom fixed", () => {
  const r = predict({ activeId: 2, neighborId: 1, edge: "leading", requestedSize: 400 });
  // top 300→200 (up by Δ=100), bottom stays at 600; neighbor above shrinks
  assert.deepEqual(r.frame, { x: 0, y: 200, w: 1000, h: 400 });
  assert.equal(r.bId, 1);
});

test("middle window, drag down → grows downward into the lower neighbor", () => {
  const r = predict({ activeId: 2, neighborId: 3, edge: "trailing", requestedSize: 400 });
  // top stays at 300, bottom 600→700 (down by Δ=100)
  assert.deepEqual(r.frame, { x: 0, y: 300, w: 1000, h: 400 });
  assert.equal(r.bId, 3);
});

test("shrink is the mirror of grow (conservation with the neighbor)", () => {
  const r = predict({ activeId: 2, neighborId: 3, edge: "trailing", requestedSize: 200 });
  // Δ=−100: window shrinks, lower neighbor grows back; total row unchanged
  assert.deepEqual(r.frame, { x: 0, y: 300, w: 1000, h: 200 });
});

test("edge window keeps its screen edge pinned, grows inward", () => {
  const r = predict({ activeId: 1, neighborId: 2, edge: "trailing", requestedSize: 400 });
  assert.deepEqual(r.frame, { x: 0, y: 0, w: 1000, h: 400 }); // y=0 (screen edge) fixed
});

test("preview == commit: the returned frame equals the tiler's own recipe", () => {
  const r = predict({ activeId: 2, neighborId: 1, edge: "leading", requestedSize: 400 });
  // Independently replicate what tiler.js does with the committed pins.
  const pins = { 2: 400, 1: 200 };
  const resolved = resolvePinOversubscription(pins, new Set(), 2, SF.h, PIN_MIN_PX);
  const targets = tileWeighted(SF, [1, 2, 3], [], false, weightOf, sizeOf, (id) => resolved.pins[id] ?? null);
  const committed = targets.find((t) => +t.winId === 2).frame;
  assert.deepEqual(r.frame, committed);
});

test("collapsed strip present → heights use mainH, no overgrowth into the rail", () => {
  const r = predict({
    activeId: 2, neighborId: 1, edge: "leading", requestedSize: 396,
    aBase: 296, bBase: 296, nonCollapsed: [1, 2, 3], collapsed: [4],
  });
  // mainH = 900 − collapsedWindowHeight(12) = 888; even thirds of 888 = 296
  assert.deepEqual(r.frame, { x: 0, y: 196, w: 1000, h: 396 });
  assert.ok(r.frame.y + r.frame.h <= 888, "must not grow into the collapsed rail");
});

test("oversubscription: active window preserved, resolved pins fit the axis", () => {
  const r = predict({
    activeId: 2, neighborId: 1, edge: "leading", requestedSize: 300,
    aBase: 100, bBase: 100, nonCollapsed: [1, 2, 3, 4], pins: { 4: 600 },
  });
  const total = Object.values(r.pins).reduce((s, v) => s + v, 0);
  assert.equal(r.pins[2], 300, "the dragged window keeps its size (tier-1)");
  assert.ok(total <= SF.h, `resolved pins ${total} must fit ${SF.h}`);
});

test("solo tile → no pairwise resize, returns the plain tiled frame", () => {
  const r = predict({ activeId: 1, neighborId: null, requestedSize: 500, nonCollapsed: [1] });
  assert.deepEqual(r.frame, { x: 0, y: 0, w: 1000, h: 900 });
});
