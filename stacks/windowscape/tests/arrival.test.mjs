// Which windows a lifecycle pass counts (arrival.js). A window on an untiled
// display (a loft) never counts, so its create or close retiles nothing; and
// while a loft is up, a window that has just appeared on a tiled display is
// held for cfg.arrivalGraceMs before it counts, because perch's Safari loft
// path makes a document window where Safari likes (the user's display) and
// moves it to the loft a few hundred ms later. Tiling it in and out again
// resized the user's windows twice (stackd.log 2026-11-10 16:07:19 and
// 16:07:52: `TILE n=2 display=1 via=lifecycle +1-0`, then `+0-1`, each one
// re-sizing Claude and System Settings, for Canary windows on the loft).
import test from "node:test";
import assert from "node:assert/strict";
import { countedOn, holdArrivals } from "../modules/arrival.js";
import { cfg } from "../modules/config.js";

const builtin = {
  displayID: 1, name: "Built-in Retina Display",
  frame: { x: 0, y: 0, w: 1710, h: 1112 }, visibleFrame: { x: 0, y: 38, w: 1710, h: 1074 },
};
const loft = {
  displayID: 32, name: "loft",
  frame: { x: -1280, y: 312, w: 1280, h: 800 }, visibleFrame: { x: -1280, y: 312, w: 1280, h: 800 },
};
const rules = [{ name: "loft" }];

test("a window on the loft is never counted", () => {
  assert.equal(countedOn(loft, rules), false);
  assert.equal(countedOn({ ...loft, name: "loft (2)" }, rules), false);
  assert.equal(countedOn(builtin, rules), true);
  assert.equal(countedOn(null, rules), false);
});

test("while a loft is up a fresh window on the user's display is held", () => {
  const r = holdArrivals([500], { firstSeenAt: { 500: 1000 }, now: 1030, graceMs: 400, untiledUp: true });
  assert.deepEqual(r.held, [500]);
  assert.deepEqual(r.counted, []);
  assert.equal(r.recheckAt, 1400);
});

test("a held window counts once the grace has passed", () => {
  const r = holdArrivals([500], { firstSeenAt: { 500: 1000 }, now: 1400, graceMs: 400, untiledUp: true });
  assert.deepEqual(r.held, []);
  assert.deepEqual(r.counted, [500]);
  assert.equal(r.recheckAt, null);
});

test("with no loft up nothing is held", () => {
  const r = holdArrivals([500], { firstSeenAt: { 500: 1000 }, now: 1030, graceMs: 400, untiledUp: false });
  assert.deepEqual(r.held, []);
  assert.deepEqual(r.counted, [500]);
});

test("a window with no recorded arrival (there at boot) is not held", () => {
  const r = holdArrivals([7], { firstSeenAt: {}, now: 1030, graceMs: 400, untiledUp: true });
  assert.deepEqual(r.counted, [7]);
});

test("the earliest release sets the recheck", () => {
  const r = holdArrivals([1, 2, 3], { firstSeenAt: { 1: 1000, 2: 900, 3: 0 }, now: 1100, graceMs: 400, untiledUp: true });
  assert.deepEqual(r.held, [1, 2]);
  assert.deepEqual(r.counted, [3]);
  assert.equal(r.recheckAt, 1300);
});

test("the default grace covers perch's create-then-move", () => {
  assert.ok(cfg.arrivalGraceMs >= 300 && cfg.arrivalGraceMs <= 1000, String(cfg.arrivalGraceMs));
});

// The 16:07 sequence, replayed through both rules: a window shows up on the
// user's display, is moved to the loft before the grace runs out, and closes
// there. Each lifecycle tick is counted the way handleWindowEvent counts.
test("create on the user's display, move to the loft, close: no tiled change", () => {
  const displays = { 1: builtin, 32: loft };
  const opts = { graceMs: cfg.arrivalGraceMs, untiledUp: true, rules };
  const firstSeenAt = { 24111: 0 };
  let known = new Set([22005, 22500]);
  const tick = (now, wins) => {
    const present = wins.filter((w) => countedOn(displays[w.d], rules)).map((w) => w.id);
    const fresh = present.filter((id) => !known.has(id));
    const { counted } = holdArrivals(fresh, { ...opts, firstSeenAt, now });
    const next = new Set(present.filter((id) => known.has(id) || counted.includes(id)));
    const changed = [...next].some((id) => !known.has(id)) || [...known].some((id) => !next.has(id));
    known = next;
    return changed;
  };
  const user = [{ id: 22005, d: 1 }, { id: 22500, d: 1 }];
  assert.equal(tick(30, [...user, { id: 24111, d: 1 }]), false, "created on display 1");
  assert.equal(tick(150, [...user, { id: 24111, d: 32 }]), false, "moved to the loft");
  assert.equal(tick(cfg.arrivalGraceMs + 10, [...user, { id: 24111, d: 32 }]), false, "grace recheck");
  assert.equal(tick(35000, user), false, "closed on the loft");
});

test("a window that stays on the user's display still tiles after the grace", () => {
  const r = holdArrivals([9], { firstSeenAt: { 9: 0 }, now: cfg.arrivalGraceMs, graceMs: cfg.arrivalGraceMs, untiledUp: true });
  assert.deepEqual(r.counted, [9]);
});
