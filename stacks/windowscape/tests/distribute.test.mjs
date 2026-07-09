// distributePinned: a new (flex) window joining a fully-pinned row must get a
// usable share, not the ~100px floor that makes it refuse and storm the pins.
import test from "node:test";
import assert from "node:assert/strict";
import { distributePinned, scalePinsToFill } from "../modules/layouts.js";

const w = () => 1;
const pinOf = (pins) => (id) => (pins[id] != null ? pins[id] : null);

test("new window against a fully-pinned row gets a fair share; pins shrink pro-rata", () => {
  // A + B pinned, filling the whole 2560px row; C is a fresh flex window (the log case).
  const out = distributePinned(2560, 0, ["A", "B", "C"], w, pinOf({ A: 1320, B: 1240 }));
  assert.equal(out[0] + out[1] + out[2], 2560, "row stays filled — no gap");
  assert.ok(out[2] >= 800, `newcomer gets a fair share, got ${out[2]} (was ~100)`);
  assert.ok(out[2] > 382, "newcomer above Arc's minimum → no refusal");
  assert.ok(Math.abs(out[0] / out[1] - 1320 / 1240) < 0.01, "pin proportions preserved");
});

test("a deliberate big pin with a still-usable flex remainder is NOT rebalanced", () => {
  // B (560px) is usable, so A's 2000px pin must be honored — resizing must still stick.
  const out = distributePinned(2560, 0, ["A", "B"], w, pinOf({ A: 2000 }));
  assert.deepEqual(out, [2000, 560]);
});

test("no pins → even split is unaffected", () => {
  assert.deepEqual(distributePinned(900, 0, ["A", "B", "C"], w, () => null), [300, 300, 300]);
});

test("all pinned (no flex) → unchanged, the rebalance never fires", () => {
  const out = distributePinned(1000, 0, ["A", "B"], w, pinOf({ A: 600, B: 400 }));
  assert.deepEqual(out, [600, 400]);
});

test("scalePinsToFill scales a short-summing pin set up to fill exactly, ratio preserved", () => {
  const out = scalePinsToFill({ 1: 759, 2: 843 }, 2560); // the log case: 1602 → 2560
  assert.equal(Object.values(out).reduce((s, v) => s + v, 0), 2560, "fills the row exactly");
  assert.ok(Math.abs(out[1] / out[2] - 759 / 843) < 0.01, "pin ratio preserved");
});

test("scalePinsToFill leaves an already-full pin set unchanged (scale = 1)", () => {
  assert.deepEqual({ ...scalePinsToFill({ 1: 1000, 2: 1560 }, 2560) }, { 1: 1000, 2: 1560 });
});

test("reorder-stable: filled pins give each window the same width regardless of order", () => {
  const filled = scalePinsToFill({ 1: 759, 2: 843 }, 2560);
  const pinOf2 = (id) => filled[id] ?? null;
  const ab = distributePinned(2560, 0, [1, 2], w, pinOf2); // window 1 first
  const ba = distributePinned(2560, 0, [2, 1], w, pinOf2); // window 1 second
  assert.equal(ab[0], ba[1], "window 1 keeps its width when moved");
  assert.equal(ab[1], ba[0], "window 2 keeps its width when moved");
});

test("growth: adding a window against pinned peers gives newcomers their fair share", () => {
  // The log case: Terminal + Claude pinned (856 + 853), Arc + a new Terminal join.
  // On growth the two flex tiles must get ~their fair share (2560/4 = 640), not the
  // 425 leftover that lands them under an app minimum; pins shrink pro-rata.
  const pins = pinOf({ T: 856, C: 853 });
  const out = distributePinned(2560, 0, ["T", "C", "A", "N"], w, pins, true);
  assert.equal(out.reduce((s, v) => s + v, 0), 2560, "row stays filled — no gap");
  assert.ok(out[2] >= 600 && out[3] >= 600, `flex tiles get ~fair share, got ${out[2]}/${out[3]}`);
  assert.ok(Math.abs(out[0] / out[1] - 856 / 853) < 0.02, "pin proportions preserved");
});

test("steady-state (no growth): the same crammed flex is left alone — pins stay sticky", () => {
  // Identical inputs, growth=false (a manual resize or close, not an add): the
  // deliberate pins persist even though flex lands at 425 (> the 400 floor).
  const out = distributePinned(2560, 0, ["T", "C", "A", "N"], w, pinOf({ T: 856, C: 853 }));
  assert.deepEqual(out, [856, 853, 425, 426], "pins stay sticky when the set didn't grow");
});
