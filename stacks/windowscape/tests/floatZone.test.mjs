// The float zone: a column beside the tiles where floated windows (which
// can't be resized) sit at their own size, so no tile ever covers them.
// Fixtures are real window sizes.
import test from "node:test";
import assert from "node:assert/strict";
import { planFloatZone, floatsToDock, zoneCapable } from "../modules/floatzone.js";

const area = { x: 0, y: 57, w: 2560, h: 1607 };
const calc     = { id: 1, w: 230, h: 408 };
const settings = { id: 2, w: 491, h: 690 };
const getInfo  = { id: 3, w: 265, h: 829 };
const about    = { id: 4, w: 327, h: 487 };
const opts = { gap: 0, pad: 8, maxW: 900 };

const inter = (a, b) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test("no members → no zone, area unchanged", () => {
  const p = planFloatZone({ area, members: [], ...opts });
  assert.equal(p.zone, null);
  assert.deepEqual(p.tileArea, area);
  assert.deepEqual(p.placements, []);
});

test("one member → zone at the right edge, tiles shrink by exactly its width", () => {
  const p = planFloatZone({ area, members: [calc], ...opts });
  assert.deepEqual(p.zone, { x: 2560 - 246, y: 57, w: 246, h: 1607 });
  assert.deepEqual(p.tileArea, { x: 0, y: 57, w: 2560 - 246, h: 1607 });
  assert.deepEqual(p.placements, [{ id: 1, x: 2560 - 246 + 8, y: 57 + 8 }]);
});

test("gap separates tiles from the zone", () => {
  const p = planFloatZone({ area, members: [calc], ...opts, gap: 10 });
  assert.equal(p.tileArea.w + 10 + p.zone.w, area.w);
});

test("members stack top-down in dock order", () => {
  const p = planFloatZone({ area, members: [getInfo, settings], ...opts });
  assert.equal(p.zone.w, 491 + 16);
  assert.deepEqual(p.placements.map((q) => q.id), [3, 2]);
  assert.equal(p.placements[1].y, 57 + 8 + 829 + 8);
  assert.deepEqual(p.overflow, []);
});

test("what doesn't fit vertically overflows, oldest first", () => {
  const tall = { id: 6, w: 700, h: 900 };
  const p = planFloatZone({ area, members: [getInfo, about, tall], ...opts });
  assert.deepEqual(p.overflow, [3]);
  assert.deepEqual(p.placements.map((q) => q.id), [4, 6]);
});

test("small members pair up side by side before overflowing", () => {
  const short = { ...area, h: 900 };
  // Calculator + About fit side by side (230+327+3·8 ≤ 900-wide cap).
  const p = planFloatZone({ area: short, members: [calc, about, { id: 5, w: 230, h: 408 }], ...opts });
  assert.deepEqual(p.overflow, []);
  for (let i = 0; i < p.placements.length; i++)
    for (let j = i + 1; j < p.placements.length; j++) {
      const a = { ...p.placements[i], ...sizeOf(p.placements[i].id) };
      const b = { ...p.placements[j], ...sizeOf(p.placements[j].id) };
      assert.equal(inter(a, b), false, `${a.id} overlaps ${b.id}`);
    }
});
function sizeOf(id) {
  return { 1: calc, 2: settings, 3: getInfo, 4: about, 5: { w: 230, h: 408 } }[id];
}

test("a member wider than the cap overflows and takes no width", () => {
  const p = planFloatZone({ area, members: [{ id: 9, w: 1200, h: 400 }, calc], ...opts });
  assert.deepEqual(p.overflow, [9]);
  assert.equal(p.zone.w, 246);
});

test("removing a member keeps the members above it in place within the zone", () => {
  const rel = (p) => p.placements.map((q) => ({ id: q.id, dx: q.x - p.zone.x, y: q.y }));
  const a = planFloatZone({ area, members: [calc, about, getInfo], ...opts });
  const b = planFloatZone({ area, members: [calc, getInfo], ...opts });
  assert.deepEqual(rel(b)[0], rel(a)[0]);
});

test("zone, tiles and members never intersect (randomized)", () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let k = 0; k < 300; k++) {
    const members = Array.from({ length: rnd(6) }, (_, i) => ({ id: i + 1, w: 150 + rnd(700), h: 150 + rnd(900) }));
    const p = planFloatZone({ area, members, ...opts, gap: rnd(20) });
    if (!p.zone) continue;
    assert.equal(inter(p.zone, p.tileArea), false);
    const rects = p.placements.map((q) => ({ ...q, ...members.find((m) => m.id === q.id) }));
    for (const r of rects) {
      assert.ok(r.x >= p.zone.x && r.x + r.w <= p.zone.x + p.zone.w, "inside zone horizontally");
      assert.ok(r.y >= p.zone.y && r.y + r.h <= p.zone.y + p.zone.h, "inside zone vertically");
    }
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) assert.equal(inter(rects[i], rects[j]), false);
  }
});

// ── floatsToDock ──
// Fixed-size panels dock the moment they appear, so the tiles make room as a
// direct result of opening one, not later on an unrelated focus change.
const f = (id, extra = {}) => ({ id, reason: "fixed-size", onscreen: true, minimized: false, ...extra });
const none = { docked: new Set(), loose: new Set() };

test("a fixed-size panel docks as soon as it's known", () => {
  assert.deepEqual(floatsToDock({ floats: [f(1)], ...none }), [1]);
});

test("learned panels dock too", () => {
  assert.deepEqual(floatsToDock({ floats: [f(1, { reason: "panel" })], ...none }), [1]);
});

test("user-floated windows stay where the user put them", () => {
  assert.deepEqual(floatsToDock({ floats: [f(1, { reason: "user" })], ...none }), []);
});

test("already docked, dragged loose, hidden or minimized → not docked", () => {
  assert.deepEqual(floatsToDock({ floats: [f(1)], docked: new Set([1]), loose: new Set() }), []);
  assert.deepEqual(floatsToDock({ floats: [f(1)], docked: new Set(), loose: new Set([1]) }), []);
  assert.deepEqual(floatsToDock({ floats: [f(1, { onscreen: false })], ...none }), []);
  assert.deepEqual(floatsToDock({ floats: [f(1, { minimized: true })], ...none }), []);
});

// ── zone-capable displays ──
// The zone only exists on wide landscape displays (planZoneFor). A panel
// "docked" on a portrait or narrow display is never placed, and being docked
// keeps it from returning to its app's own frame — it stays wherever its
// refused tile left it, on top of the tiles.
test("zoneCapable: wide landscape displays hold a zone, portrait and narrow ones don't", () => {
  assert.equal(zoneCapable({ w: 2560, h: 1440 }, 1800), true);
  assert.equal(zoneCapable({ w: 1080, h: 2560 }, 1800), false);
  assert.equal(zoneCapable({ w: 1710, h: 1112 }, 1800), false);
});

test("a panel on a display with no zone is not docked", () => {
  assert.deepEqual(floatsToDock({ floats: [f(1, { zoneCapable: false }), f(2)], ...none }), [2]);
});
