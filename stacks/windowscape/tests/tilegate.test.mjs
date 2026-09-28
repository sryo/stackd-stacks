// Which state holds a tile pass back. The boot gate keeps window/display
// events that land while init is still restoring the saved order and the
// snapshot rail from tiling against half-loaded state; init's own pass tiles.
import test from "node:test";
import assert from "node:assert/strict";
import { tileSkipReason } from "../modules/tilegate.js";

const idle = () => ({
  booting: false, dragInFlight: false, fullscreenState: null,
  displaySettling: false, snapshotsState: null,
});

test("an idle state tiles", () => {
  assert.equal(tileSkipReason(idle()), null);
});

test("booting holds every pass until init tiles", () => {
  assert.equal(tileSkipReason({ ...idle(), booting: true }), "booting");
});

test("booting wins over a display change at startup", () => {
  // The daemon replays the display set on load; it must not tile early either.
  assert.equal(tileSkipReason({ ...idle(), booting: true, displaySettling: true }), "booting");
});

test("the existing gates still hold a pass", () => {
  assert.equal(tileSkipReason({ ...idle(), dragInFlight: true }), "drag");
  assert.equal(tileSkipReason({ ...idle(), fullscreenState: { active: true } }), "fullscreen");
  assert.equal(tileSkipReason({ ...idle(), fullscreenState: { active: false } }), null);
  assert.equal(tileSkipReason({ ...idle(), displaySettling: true }), "display-settling");
  assert.equal(tileSkipReason({ ...idle(), snapshotsState: { isCreating: true } }), "snapshot");
});
