// Pure unit tests for predictResizeFrame (windowscape gesture resize).
// predictResizeFrame runs the REAL tiler math (pairwise A/B basis → resolveFlex
// → tileWeighted) so the gesture preview equals the committed frame.
import test from "node:test";
import assert from "node:assert/strict";
import { predictResizeFrame, specFromState, PIN_MIN_PX } from "../modules/layouts.js";
import { resolveFlex } from "../modules/flex.js";

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
  assert.deepEqual(r.frame, { x: 0, y: 200, w: 1000, h: 400 });
  assert.equal(r.bId, 1);
});

test("middle window, drag down → grows downward into the lower neighbor", () => {
  const r = predict({ activeId: 2, neighborId: 3, edge: "trailing", requestedSize: 400 });
  assert.deepEqual(r.frame, { x: 0, y: 300, w: 1000, h: 400 });
  assert.equal(r.bId, 3);
});

test("shrink is the mirror of grow (conservation with the neighbor)", () => {
  const r = predict({ activeId: 2, neighborId: 3, edge: "trailing", requestedSize: 200 });
  assert.deepEqual(r.frame, { x: 0, y: 300, w: 1000, h: 200 });
});

test("edge window keeps its screen edge pinned, grows inward", () => {
  const r = predict({ activeId: 1, neighborId: 2, edge: "trailing", requestedSize: 400 });
  assert.deepEqual(r.frame, { x: 0, y: 0, w: 1000, h: 400 });
});

test("preview == commit: the frame equals a from-scratch resolveFlex layout", () => {
  const r = predict({ activeId: 2, neighborId: 1, edge: "leading", requestedSize: 400 });
  // Independently: pin A=2 at 400, B=1 at 200 (net zero), tile 3 flex.
  const sizes = resolveFlex([{ basis: 200 }, { basis: 400, active: true }, { weight: 1 }], SF.h, 0);
  let y = 0; const frames = {};
  [1, 2, 3].forEach((id, i) => { frames[id] = { x: 0, y, w: 1000, h: sizes[i] }; y += sizes[i]; });
  assert.deepEqual(r.frame, frames[2]);
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

test("oversubscription: the active window is held; the row still fills exactly", () => {
  const r = predict({
    activeId: 2, neighborId: 1, edge: "leading", requestedSize: 300,
    aBase: 100, bBase: 100, nonCollapsed: [1, 2, 3, 4], pins: { 4: 600 },
  });
  const total = Object.values(r.pins).reduce((s, v) => s + v, 0);
  assert.equal(r.pins[2], 300, "the dragged window keeps its size");
  assert.equal(total, SF.h, `row fills exactly (${total})`);
});

test("solo tile → no pairwise resize, returns the plain tiled frame", () => {
  const r = predict({ activeId: 1, neighborId: null, requestedSize: 500, nonCollapsed: [1] });
  assert.deepEqual(r.frame, { x: 0, y: 0, w: 1000, h: 900 });
});

test("specFromState feeds the app-min cache as a floor (max with any per-window pin)", () => {
  const specOf = specFromState({
    pins: { 3: 700 }, refusalSet: new Set([3]), weightOf: () => 1,
    appMinOf: (id) => (id === 2 ? 500 : id === 3 ? 300 : 0),
  });
  assert.equal(specOf(1).min, 0, "no pin, no app-min → 0");
  assert.equal(specOf(2).min, 500, "app-min becomes the floor for an un-pinned window");
  assert.equal(specOf(3).min, 700, "per-window refusal (700) wins over app-min (300)");
  assert.equal(specOf(2).basis, null, "app-min never pins the window");
});
