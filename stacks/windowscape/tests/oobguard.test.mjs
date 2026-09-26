// Invariant fence for oobPinBlockReason — the fullscreen-transition guard
// on the out-of-bracket resize path. The contract it pins: resize reads
// taken inside a fullscreen space, within the exit grace, or showing a
// shared-row window at effectively the whole tile area must never mint
// pins; everything else stays eligible.
import test from "node:test";
import assert from "node:assert/strict";
import { oobPinBlockReason, FS_EXIT_GRACE_MS, FS_SIZE_FRACTION } from "../modules/oobguard.js";

const base = {
  spaceIsFullscreen: false,
  msSinceFsExit: null,
  liveMajor: 1200,
  areaMajor: 2420,
  tiledCount: 2,
};

test("normal shared-row resize → no block", () => {
  assert.equal(oobPinBlockReason(base), null);
});

test("fullscreen space → blocked regardless of sizes", () => {
  assert.equal(
    oobPinBlockReason({ ...base, spaceIsFullscreen: true, liveMajor: 100 }),
    "fullscreen-space");
});

test("inside exit grace → blocked; past it → clear", () => {
  assert.equal(
    oobPinBlockReason({ ...base, msSinceFsExit: FS_EXIT_GRACE_MS - 1 }),
    "fullscreen-exit-grace");
  assert.equal(oobPinBlockReason({ ...base, msSinceFsExit: FS_EXIT_GRACE_MS }), null);
});

test("never-fullscreen display (null msSinceFsExit) → clear", () => {
  assert.equal(oobPinBlockReason({ ...base, msSinceFsExit: null }), null);
});

test("shared row at ~full area → blocked at the fraction boundary", () => {
  const area = 2420;
  const atFraction = Math.ceil(area * FS_SIZE_FRACTION);
  assert.equal(
    oobPinBlockReason({ ...base, liveMajor: atFraction, areaMajor: area }),
    "fullscreen-size");
  assert.equal(
    oobPinBlockReason({ ...base, liveMajor: atFraction - 1, areaMajor: area }),
    null);
});

test("solo window at full area → NOT blocked (full-width is its tile)", () => {
  assert.equal(
    oobPinBlockReason({ ...base, tiledCount: 1, liveMajor: 2420 }),
    null);
});

test("unknown tile area (0) → size check disabled, others still apply", () => {
  assert.equal(oobPinBlockReason({ ...base, areaMajor: 0, liveMajor: 99999 }), null);
  assert.equal(
    oobPinBlockReason({ ...base, areaMajor: 0, spaceIsFullscreen: true }),
    "fullscreen-space");
});

// fsTransitionBlock is the fullscreen half of oobPinBlockReason, shared with
// the paths that have no resize train to size-check: the post-animation
// refusal sweep and drag-bracket close.
import { fsTransitionBlock } from "../modules/oobguard.js";

test("fsTransitionBlock: fullscreen space and exit grace block, anything else passes", () => {
  assert.equal(fsTransitionBlock({ spaceIsFullscreen: true, msSinceFsExit: null }), "fullscreen-space");
  assert.equal(fsTransitionBlock({ spaceIsFullscreen: false, msSinceFsExit: FS_EXIT_GRACE_MS - 1 }), "fullscreen-exit-grace");
  assert.equal(fsTransitionBlock({ spaceIsFullscreen: false, msSinceFsExit: FS_EXIT_GRACE_MS }), null);
  assert.equal(fsTransitionBlock({ spaceIsFullscreen: false, msSinceFsExit: null }), null);
});
