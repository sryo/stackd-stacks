// Live neighbor resize: the pure row math behind sd.window.resizing. The
// dragged window's actual frame is input; the neighbor across the moved edge
// (and any tile the layout shifts) is computed with the tiler's own solver,
// so the frames written mid-drag equal what the release commit tiles.
import test from "node:test";
import assert from "node:assert/strict";
import {
  liveEdgeOf, neighborFor, dragBaselines, liveRow, changedWrites,
} from "../modules/liveresize.js";
import { pairwisePins, tileWeighted, specFromState, PIN_MIN_PX } from "../modules/layouts.js";
import { cfg } from "../modules/config.js";

const SF = { x: 0, y: 0, w: 1000, h: 800 }; // horizontal row → major axis = width
const weightOf = () => 1;
const sizeOf = () => ({ w: 200, h: 12 });
const noMin = () => 0;
const byId = (frames) => Object.fromEntries(frames.map((t) => [t.winId, t.frame]));

function row(over) {
  return liveRow({
    screenFrame: SF, horizontal: true, nonCollapsed: [1, 2], collapsed: [],
    weightOf, sizeOf, pins: {}, refusalSet: new Set(), appMinOf: noMin, minOf: noMin,
    baselines: { 1: 500, 2: 500 }, ...over,
  });
}

test("right-edge drag grows A and shrinks B; A is never written", () => {
  const r = row({ activeId: 1, edge: "trailing", neighborId: 2, frame: { x: 0, y: 0, w: 560, h: 800 } });
  const f = byId(r.frames);
  assert.equal(f[1], undefined, "the dragged window is input, never a write");
  assert.deepEqual(f[2], { x: 560, y: 0, w: 440, h: 800 });
  assert.equal(r.aSize, 560);
  assert.equal(r.clamped, false);
});

test("left-edge drag moves the shared edge left: the previous tile shrinks", () => {
  const r = row({ activeId: 2, edge: "leading", neighborId: 1, frame: { x: 420, y: 0, w: 580, h: 800 } });
  assert.deepEqual(byId(r.frames)[1], { x: 0, y: 0, w: 420, h: 800 });
  assert.equal(r.aSize, 580);
});

test("shrinking A hands the space back to B", () => {
  const r = row({ activeId: 1, edge: "trailing", neighborId: 2, frame: { x: 0, y: 0, w: 400, h: 800 } });
  assert.deepEqual(byId(r.frames)[2], { x: 400, y: 0, w: 600, h: 800 });
});

test("neighbor min clamp: B stops at its minimum, A may overlap, commit size is capped", () => {
  const minOf = (id) => (id === 2 ? 450 : 0);
  const r = row({ activeId: 1, edge: "trailing", neighborId: 2, minOf, frame: { x: 0, y: 0, w: 600, h: 800 } });
  assert.deepEqual(byId(r.frames)[2], { x: 550, y: 0, w: 450, h: 800 });
  assert.equal(r.clamped, true);
  assert.equal(r.aSize, 550, "release snaps A back to the most B allows");
});

test("the clamp floor is never below PIN_MIN_PX", () => {
  const r = row({ activeId: 1, edge: "trailing", neighborId: 2, frame: { x: 0, y: 0, w: 990, h: 800 } });
  assert.equal(byId(r.frames)[2].w, PIN_MIN_PX);
  assert.equal(r.aSize, 1000 - PIN_MIN_PX);
});

test("a B already below its learned min is not forced to grow", () => {
  const minOf = (id) => (id === 2 ? 600 : 0);
  const r = row({ activeId: 1, edge: "trailing", neighborId: 2, minOf, frame: { x: 0, y: 0, w: 520, h: 800 } });
  assert.equal(r.aSize, 500, "A held at its baseline");
  assert.deepEqual(byId(r.frames)[2], { x: 500, y: 0, w: 500, h: 800 });
});

test("3-window row: the far tile keeps its frame and is not rewritten", () => {
  const S3 = { x: 0, y: 0, w: 900, h: 800 };
  const targets = { 1: { x: 0, y: 0, w: 300, h: 800 }, 2: { x: 300, y: 0, w: 300, h: 800 }, 3: { x: 600, y: 0, w: 300, h: 800 } };
  const r = liveRow({
    screenFrame: S3, horizontal: true, nonCollapsed: [1, 2, 3], collapsed: [],
    weightOf, sizeOf, pins: {}, refusalSet: new Set(), appMinOf: noMin, minOf: noMin,
    baselines: { 1: 300, 2: 300, 3: 300 },
    activeId: 1, edge: "trailing", neighborId: 2, frame: { x: 0, y: 0, w: 350, h: 800 },
  });
  const f = byId(r.frames);
  assert.deepEqual(f[2], { x: 350, y: 0, w: 250, h: 800 });
  assert.deepEqual(f[3], targets[3]);
  const writes = changedWrites(r.frames, targets);
  assert.deepEqual(writes.map((t) => t.winId), [2], "only the neighbor is written");
});

test("3-window row, middle tile's leading edge: the first tile shrinks, the last is untouched", () => {
  const S3 = { x: 0, y: 0, w: 900, h: 800 };
  const r = liveRow({
    screenFrame: S3, horizontal: true, nonCollapsed: [1, 2, 3], collapsed: [],
    weightOf, sizeOf, pins: {}, refusalSet: new Set(), appMinOf: noMin, minOf: noMin,
    baselines: { 1: 300, 2: 300, 3: 300 },
    activeId: 2, edge: "leading", neighborId: 1, frame: { x: 240, y: 0, w: 360, h: 800 },
  });
  const f = byId(r.frames);
  assert.deepEqual(f[1], { x: 0, y: 0, w: 240, h: 800 });
  assert.deepEqual(f[3], { x: 600, y: 0, w: 300, h: 800 });
});

test("3-window row: a far tile the layout moves is shifted with the row", () => {
  // Pins that no longer sum to the axis: the solver fills the row, so the
  // far tile lands where the release commit will put it, not where it was.
  const S3 = { x: 0, y: 0, w: 900, h: 800 };
  const pins = { 1: 300, 2: 300, 3: 200 };
  const r = liveRow({
    screenFrame: S3, horizontal: true, nonCollapsed: [1, 2, 3], collapsed: [],
    weightOf, sizeOf, pins, refusalSet: new Set(), appMinOf: noMin, minOf: noMin,
    baselines: { 1: 300, 2: 300, 3: 200 },
    activeId: 1, edge: "trailing", neighborId: 2, frame: { x: 0, y: 0, w: 350, h: 800 },
  });
  const f = byId(r.frames);
  const stale = { 3: { x: 600, y: 0, w: 200, h: 800 } };
  assert.equal(f[3].x + f[3].w, 900, "far tile fills to the row end");
  assert.deepEqual(changedWrites([{ winId: 3, frame: f[3] }], stale).map((t) => t.winId), [3]);
});

test("vertical stack: bottom-edge drag moves the lower neighbor's top edge", () => {
  const V = { x: 0, y: 0, w: 800, h: 1000 };
  const r = liveRow({
    screenFrame: V, horizontal: false, nonCollapsed: [1, 2], collapsed: [],
    weightOf, sizeOf, pins: {}, refusalSet: new Set(), appMinOf: noMin, minOf: noMin,
    baselines: { 1: 500, 2: 500 },
    activeId: 1, edge: "trailing", neighborId: 2, frame: { x: 0, y: 0, w: 800, h: 620 },
  });
  assert.deepEqual(byId(r.frames)[2], { x: 0, y: 620, w: 800, h: 380 });
});

test("commit at release equals the live frames — no double-subtract", () => {
  const baselines = { 1: 500, 2: 500 };
  let last;
  for (const w of [520, 560, 610, 600]) {
    last = row({ activeId: 1, edge: "trailing", neighborId: 2, baselines, frame: { x: 0, y: 0, w, h: 800 } });
  }
  const liveB = byId(last.frames)[2];
  // Commit against the DRAG-START baselines, not whatever the live writes
  // left behind in the tile targets.
  const p = pairwisePins({ aBase: baselines[1], bBase: baselines[2], actualSize: last.aSize });
  assert.equal(p.a, 600);
  assert.equal(p.b, liveB.w, "B's committed pin equals its last live frame");
  // Re-baselining B from its live-written frame is the double-subtract bug.
  const wrong = pairwisePins({ aBase: 500, bBase: liveB.w, actualSize: last.aSize });
  assert.notEqual(wrong.b, liveB.w);
  // And the tiler, fed the committed pins, lands every tile where it was live.
  const pins = { 1: p.a, 2: p.b };
  const specOf = specFromState({ pins, refusalSet: new Set(), weightOf, lastId: 1, appMinOf: noMin });
  const tiled = byId(tileWeighted(SF, [1, 2], [], true, sizeOf, specOf));
  assert.deepEqual(tiled[1], { x: 0, y: 0, w: 600, h: 800 });
  assert.deepEqual(tiled[2], liveB);
});

test("pairwisePins keeps A+B constant and floors B at PIN_MIN_PX", () => {
  assert.deepEqual(pairwisePins({ aBase: 500, bBase: 500, actualSize: 560.5 }),
    { a: 560, b: 439, bWant: 439, delta: 60.5 });
  const c = pairwisePins({ aBase: 500, bBase: 500, actualSize: 990 });
  assert.equal(c.b, PIN_MIN_PX);
  assert.equal(c.bWant, 10);
});

test("cross-axis drags are not live: top/bottom on a row, left/right on a stack", () => {
  const e = (o) => ({ left: false, right: false, top: false, bottom: false, ...o });
  assert.equal(liveEdgeOf(e({ bottom: true }), true), null);
  assert.equal(liveEdgeOf(e({ top: true }), true), null);
  assert.equal(liveEdgeOf(e({ right: true }), false), null);
  assert.equal(liveEdgeOf(e({ left: true }), false), null);
  // Major-axis edges lock the drag, including from a corner.
  assert.equal(liveEdgeOf(e({ right: true }), true), "trailing");
  assert.equal(liveEdgeOf(e({ left: true }), true), "leading");
  assert.equal(liveEdgeOf(e({ right: true, bottom: true }), true), "trailing");
  assert.equal(liveEdgeOf(e({ top: true }), false), "leading");
  assert.equal(liveEdgeOf(e({ bottom: true }), false), "trailing");
  // Both major edges moving is a move, not an edge drag.
  assert.equal(liveEdgeOf(e({ left: true, right: true }), true), null);
  assert.equal(liveEdgeOf(null, true), null);
});

test("neighborFor: the tile across the moved edge, none at the row's end", () => {
  assert.equal(neighborFor([1, 2, 3], 2, "trailing"), 3);
  assert.equal(neighborFor([1, 2, 3], 2, "leading"), 1);
  assert.equal(neighborFor([1, 2, 3], 3, "trailing"), null);
  assert.equal(neighborFor([1, 2, 3], 1, "leading"), null);
  assert.equal(neighborFor([1, 2, 3], 9, "trailing"), null);
  assert.equal(neighborFor([1, 2, 3], 1, null), null);
});

test("late began: baselines come from the drag-start state, not the late startFrame", () => {
  // A's first steps read as echoes, so the daemon's began arrives 12px in,
  // with startFrame already past the real start.
  const targets = { 1: { x: 0, y: 0, w: 500, h: 800 }, 2: { x: 500, y: 0, w: 500, h: 800 } };
  const late = { x: 0, y: 0, w: 512, h: 800 };
  const baselines = dragBaselines({
    ids: [1, 2], pins: {}, targets, snapshot: {}, horizontal: true, activeId: 1, startFrame: late,
  });
  assert.deepEqual(baselines, { 1: 500, 2: 500 });
  const r = row({ activeId: 1, edge: "trailing", neighborId: 2, baselines, frame: { x: 0, y: 0, w: 520, h: 800 } });
  assert.deepEqual(byId(r.frames)[2], { x: 520, y: 0, w: 480, h: 800 }, "B gives up all 20px, not 8");
});

test("dragBaselines priority: pin, then tile target, then mouse-down snapshot, then startFrame", () => {
  const b = dragBaselines({
    ids: [1, 2, 3, 4],
    pins: { 1: 410 },
    targets: { 1: { w: 999, h: 1 }, 2: { w: 420, h: 1 } },
    snapshot: { 2: { w: 998, h: 1 }, 3: { w: 430, h: 1 } },
    horizontal: true, activeId: 4, startFrame: { w: 440, h: 1 },
  });
  assert.deepEqual(b, { 1: 410, 2: 420, 3: 430, 4: 440 });
});

test("changedWrites skips frames already written (or already in place)", () => {
  const frames = [
    { winId: 2, frame: { x: 560, y: 0, w: 440, h: 800 } },
    { winId: 3, frame: { x: 0, y: 0, w: 10, h: 10 } },
  ];
  const last = { 2: { x: 560, y: 0, w: 440, h: 800 } };
  assert.deepEqual(changedWrites(frames, last).map((t) => t.winId), [3]);
  assert.deepEqual(changedWrites(frames, {}).map((t) => t.winId), [2, 3]);
});

test("gaps: the neighbor starts one tile gap past A's moved edge", () => {
  const was = cfg.tileGap;
  cfg.tileGap = 10;
  try {
    const r = liveRow({
      screenFrame: SF, horizontal: true, nonCollapsed: [1, 2], collapsed: [],
      weightOf, sizeOf, pins: {}, refusalSet: new Set(), appMinOf: noMin, minOf: noMin,
      baselines: { 1: 495, 2: 495 },
      activeId: 1, edge: "trailing", neighborId: 2, frame: { x: 0, y: 0, w: 545, h: 800 },
    });
    assert.deepEqual(byId(r.frames)[2], { x: 555, y: 0, w: 445, h: 800 });
  } finally {
    cfg.tileGap = was;
  }
});
