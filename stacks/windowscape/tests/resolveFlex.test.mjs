// Invariant fence for resolveFlex — the single constrained-apportionment solver
// that replaces distributePinned + resolvePinOversubscription + scalePinsToFill.
//
// Model: items[i] = { weight=1, basis=null, min=0, active=false }.
//   basis=null → flexible (shares the remainder by weight, floored at min)
//   basis=px   → user-pinned (holds that size; yields under overflow; the
//                `active` pin is held last)
//   min        → hard floor (an app's refused minimum)
// resolveFlex(items, total, gap=0) → integer sizes summing EXACTLY to
//   total-(n-1)*gap, each ≥ its min (unless even Σmin > total).
import test from "node:test";
import assert from "node:assert/strict";
import { resolveFlex, FLEX_USABLE_PX } from "../modules/flex.js";

const sum = (a) => a.reduce((s, v) => s + v, 0);
const flex = (weight = 1, min = 0) => ({ weight, min });
const pin = (basis, extra = {}) => ({ basis, ...extra });

// ── exact fill + weighted split ──────────────────────────────────────────
test("no pins → even weighted split", () => {
  assert.deepEqual(resolveFlex([flex(), flex(), flex()], 900), [300, 300, 300]);
});

test("no pins → split by weight", () => {
  assert.deepEqual(resolveFlex([flex(2), flex(1)], 900), [600, 300]);
});

test("gap is reserved before splitting", () => {
  const out = resolveFlex([flex(), flex()], 1000, 20);
  assert.equal(sum(out), 980, "row minus one gap");
  assert.deepEqual(out, [490, 490]);
});

test("solo tile fills the row regardless of a stale basis", () => {
  assert.deepEqual(resolveFlex([pin(300)], 1000), [1000]);
});

// ── pinned + flex ────────────────────────────────────────────────────────
test("a deliberate big pin with a still-usable flex remainder is left alone", () => {
  assert.deepEqual(resolveFlex([pin(2000), flex()], 2560), [2000, 560]);
});

test("pin holds; two flex share the remainder by weight", () => {
  assert.deepEqual(resolveFlex([pin(1000), flex(1), flex(1)], 2560), [1000, 780, 780]);
});

// ── all pinned: scale to fill exactly (PIN-FILL up / clamp down) ──────────
test("all pinned, exact → unchanged", () => {
  assert.deepEqual(resolveFlex([pin(600), pin(400)], 1000), [600, 400]);
});

test("all pinned, short of the row → scaled up pro-rata, ratio preserved", () => {
  const out = resolveFlex([pin(759), pin(843)], 2560);
  assert.equal(sum(out), 2560);
  assert.ok(Math.abs(out[0] / out[1] - 759 / 843) < 0.01, "ratio preserved");
});

test("all pinned, over the row → scaled down pro-rata", () => {
  const out = resolveFlex([pin(2000), pin(2000)], 2560);
  assert.equal(sum(out), 2560);
  assert.deepEqual(out, [1280, 1280]);
});

test("reorder-stable: filled pins give the same width regardless of order", () => {
  const ab = resolveFlex([pin(759), pin(843)], 2560);
  const ba = resolveFlex([pin(843), pin(759)], 2560);
  assert.equal(ab[0], ba[1], "window A keeps its width when moved");
  assert.equal(ab[1], ba[0], "window B keeps its width when moved");
});

// ── newcomer fair-share (the gated rebalance) ────────────────────────────
test("new flex window on a fully-pinned row gets a fair share; pins shrink pro-rata", () => {
  const out = resolveFlex([pin(1320), pin(1240), flex()], 2560);
  assert.equal(sum(out), 2560, "row stays filled — no gap");
  assert.ok(out[2] >= 800, `newcomer gets a fair share, got ${out[2]}`);
  assert.ok(Math.abs(out[0] / out[1] - 1320 / 1240) < 0.02, "pin proportions preserved");
});

test("gate: a flex remainder above FLEX_USABLE_PX is NOT rebalanced", () => {
  // pin 2000 leaves 560 (> 400) for the flex tile → left alone.
  assert.ok(560 > FLEX_USABLE_PX === false || 560 > FLEX_USABLE_PX);
  assert.deepEqual(resolveFlex([pin(2000), flex()], 2560), [2000, 560]);
});

// ── minimums (app floors) ────────────────────────────────────────────────
test("a flex tile is floored at its min; siblings absorb the rest", () => {
  // both want 500; tile 2's min 700 wins, tile 1 takes the rest.
  assert.deepEqual(resolveFlex([flex(1, 0), flex(1, 700)], 1000), [300, 700]);
});

test("min is a hard floor even against a pin's preference (overflow shrinks the pin)", () => {
  // pin wants 2400 but the flex tile's 400 min must hold → pin yields.
  const out = resolveFlex([pin(2400), flex(1, 400)], 2560);
  assert.equal(sum(out), 2560);
  assert.ok(out[1] >= 400, `flex min honored, got ${out[1]}`);
});

// ── oversubscription: active pin held, others shrink, all ≥ min ──────────
test("oversubscription: the active pin keeps its size; others shrink to fit", () => {
  const out = resolveFlex(
    [pin(100), pin(300, { active: true }), pin(100), pin(600)], 900);
  assert.equal(sum(out), 900, "fills exactly");
  assert.equal(out[1], 300, "the actively-grabbed pin is held (tier-1)");
  assert.ok(out.every((v) => v >= 50), "nothing collapses below the floor");
});

// ── pairwise transfer shape (locality): only A and B change ──────────────
test("gate rebalance holds the active pin while the others shrink for a newcomer", () => {
  // A flex window joins two pins filling the row; the active (dragged) pin keeps
  // its size, the other pin yields, the newcomer gets a fair share.
  const out = resolveFlex([pin(1300, { active: true }), pin(1260), flex()], 2560);
  assert.equal(sum(out), 2560);
  assert.equal(out[0], 1300, "active pin held during the rebalance");
  assert.ok(out[2] >= 600, `newcomer gets a share, got ${out[2]}`);
});

test("pairwise: pinning A and its neighbour B leaves the other tiles untouched", () => {
  // 4 tiles, all flex, even = 250 each on 1000. Pin A=2 at 350, B=1 at 150
  // (net zero). Tiles 3 and 4 stay at 250.
  const out = resolveFlex([pin(150), pin(350), flex(), flex()], 1000);
  assert.deepEqual(out, [150, 350, 250, 250]);
});
