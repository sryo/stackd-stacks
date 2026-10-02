// Pure helpers behind the daemon-driven tile animation: the setFrame option
// shape, the local in-flight mirror (sync isAnimating over async settles),
// and the post-settle refusal pick.
import test from "node:test";
import assert from "node:assert/strict";
import {
  motionOptions, framesNearlyIdentical, createInFlight, pickRefusals, confirmRefusals, pinRefusals,
} from "../modules/motion.js";

test("animations off → no motion options (instant setFrame)", () => {
  assert.equal(motionOptions({ enableAnimations: false, animationEasing: "spring" }), null);
});

test("spring → easing only; the daemon derives settle time", () => {
  assert.deepEqual(
    motionOptions({ enableAnimations: true, animationEasing: "spring", animationDuration: 0.15 }),
    { easing: "spring" });
});

test("curve easings carry the configured duration", () => {
  assert.deepEqual(
    motionOptions({ enableAnimations: true, animationEasing: "easeOutCubic", animationDuration: 0.15 }),
    { duration: 0.15, easing: "easeOutCubic" });
  assert.deepEqual(
    motionOptions({ enableAnimations: true, animationEasing: "linear", animationDuration: 0.2 }),
    { duration: 0.2, easing: "linear" });
});

test("unknown easing falls back to spring", () => {
  assert.deepEqual(
    motionOptions({ enableAnimations: true, animationEasing: "bouncy" }),
    { easing: "spring" });
});

test("curve easing with no usable duration → instant", () => {
  assert.equal(
    motionOptions({ enableAnimations: true, animationEasing: "easeOutCubic", animationDuration: 0 }),
    null);
});

test("framesNearlyIdentical: within 2px on every edge", () => {
  const a = { x: 0, y: 0, w: 100, h: 100 };
  assert.equal(framesNearlyIdentical(a, { x: 1, y: -1, w: 101, h: 99 }), true);
  assert.equal(framesNearlyIdentical(a, { x: 0, y: 0, w: 103, h: 100 }), false);
});

test("in-flight: begin → has; its own end clears it", () => {
  const f = createInFlight();
  const t = f.begin(7);
  assert.equal(f.has(7), true);
  assert.equal(f.has("7"), true, "string/number ids agree");
  f.end(7, t);
  assert.equal(f.has(7), false);
});

test("in-flight: a superseded animation's late settle keeps the newer one", () => {
  const f = createInFlight();
  const first = f.begin(7);
  const second = f.begin(7);
  f.end(7, first);
  assert.equal(f.has(7), true);
  f.end(7, second);
  assert.equal(f.has(7), false);
});

test("in-flight: drop forgets immediately and ignores the later settle", () => {
  const f = createInFlight();
  const t = f.begin(7);
  f.drop(7);
  assert.equal(f.has(7), false);
  const again = f.begin(7);
  f.end(7, t);
  assert.equal(f.has(7), true, "stale token can't clear the new animation");
  f.end(7, again);
  assert.deepEqual(f.ids(), []);
});

test("in-flight: ids lists every window still animating", () => {
  const f = createInFlight();
  f.begin(1); f.begin(2);
  assert.deepEqual(f.ids().sort(), [1, 2]);
});

const tgt = (w) => ({ x: 0, y: 0, w, h: 800 });

test("pickRefusals: window settled >20px off its major-axis target is refused", () => {
  const entries = [
    { id: 1, target: tgt(400), live: tgt(400) },
    { id: 2, target: tgt(400), live: tgt(845) },
  ];
  assert.deepEqual(pickRefusals(entries, true, 20, 3), [[2, tgt(845)]]);
});

test("pickRefusals: minor-axis drift and ≤20px rounding don't count", () => {
  const entries = [
    { id: 1, target: tgt(400), live: { x: 0, y: 0, w: 412, h: 700 } },
  ];
  assert.deepEqual(pickRefusals(entries, true, 20, 2), []);
});

test("pickRefusals: vertical displays compare heights", () => {
  const entries = [{ id: 1, target: { x: 0, y: 0, w: 800, h: 300 }, live: { x: 0, y: 0, w: 800, h: 360 } }];
  assert.equal(pickRefusals(entries, false, 20, 2).length, 1);
});

test("pickRefusals: every window 'refusing' is not a refusal — nothing pinned", () => {
  const entries = [
    { id: 1, target: tgt(400), live: tgt(600) },
    { id: 2, target: tgt(400), live: tgt(600) },
  ];
  assert.deepEqual(pickRefusals(entries, true, 20, 2), []);
});

// A refusal read off an animation's settle is re-applied once before it is
// believed: a window that takes its target on the second write never
// refused it, and must not leave a minimum behind.
test("confirmRefusals: a window that takes its target on re-apply is dropped", () => {
  const target = { x: 77, y: -941, w: 1080, h: 941 };
  const out = confirmRefusals(
    [{ id: 7, target, actual: { ...target } }],
    false, 20);
  assert.deepEqual(out, []);
});

test("confirmRefusals: a window still off its target keeps the re-read size", () => {
  const target = { x: 0, y: 38, w: 400, h: 1074 };
  const actual = { x: 0, y: 38, w: 845, h: 1074 };
  assert.deepEqual(confirmRefusals([{ id: 3, target, actual }], true, 20), [[3, actual]]);
});

test("confirmRefusals: an unreadable re-apply keeps the original reading", () => {
  const target = { x: 0, y: 38, w: 400, h: 1074 };
  const live = { x: 0, y: 38, w: 845, h: 1074 };
  assert.deepEqual(confirmRefusals([{ id: 3, target, actual: null, live }], true, 20), [[3, live]]);
});

// A refusal turns a window's pin into a floor only when the user never sized
// it. A window the user sized that its app then clamped keeps the clamped size
// as the user's pin: as a flexible floor it reads as a cramped newcomer and
// the next pass splits the row evenly.
test("pinRefusals: an unpinned window's refusal becomes a floor", () => {
  const pins = {}, refusals = new Set();
  pinRefusals(pins, refusals, [[5, { w: 845, h: 1074 }]], true, 50);
  assert.equal(pins[5], 845);
  assert.ok(refusals.has(5));
});

test("pinRefusals: a user-sized window keeps the clamped size as its own pin", () => {
  const pins = { 9: 216, 42: 2314 }, refusals = new Set();
  pinRefusals(pins, refusals, [[9, { w: 1080, h: 252 }]], false, 50);
  assert.equal(pins[9], 252);
  assert.ok(!refusals.has(9));
});

test("pinRefusals: a window already on a floor stays on it", () => {
  const pins = { 5: 845 }, refusals = new Set([5]);
  pinRefusals(pins, refusals, [[5, { w: 900, h: 1074 }]], true, 50);
  assert.equal(pins[5], 900);
  assert.ok(refusals.has(5));
});

test("pinRefusals: the pin never drops below the floor", () => {
  const pins = {}, refusals = new Set();
  pinRefusals(pins, refusals, [[5, { w: 10, h: 1074 }]], true, 50);
  assert.equal(pins[5], 50);
});
