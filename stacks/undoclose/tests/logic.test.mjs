// Pure unit tests for undoclose's Finder tracking (logic.js): no sd.*, no
// DOM, so they run under plain `node --test tests/`.
import test from "node:test";
import assert from "node:assert/strict";
import { finderWindowId, createFinderPaths } from "../logic.js";

test("finderWindowId: returns the id of a Finder window payload", () => {
  assert.equal(finderWindowId({ id: 42, app: "Finder", title: "Downloads" }), 42);
});

test("finderWindowId: null for other apps, missing ids, and empty payloads", () => {
  assert.equal(finderWindowId({ id: 42, app: "Safari" }), null);
  assert.equal(finderWindowId({ app: "Finder" }), null);
  assert.equal(finderWindowId({ id: null, app: "Finder" }), null);
  assert.equal(finderWindowId(null), null);
});

test("createFinderPaths: a closed window yields its own folder, not the last focused one", () => {
  const paths = createFinderPaths();
  paths.record(1, "/Users/me/Documents/");
  paths.record(2, "/Users/me/Downloads/");
  assert.equal(paths.take(1), "/Users/me/Documents/");
});

test("createFinderPaths: navigating in the same window replaces its path", () => {
  const paths = createFinderPaths();
  paths.record(1, "/Users/me/");
  paths.record(1, "/Users/me/Projects/");
  assert.equal(paths.take(1), "/Users/me/Projects/");
});

test("createFinderPaths: take() forgets the window; unknown ids yield null", () => {
  const paths = createFinderPaths();
  paths.record(1, "/tmp/");
  paths.take(1);
  assert.equal(paths.take(1), null);
  assert.equal(paths.take(99), null);
});

test("createFinderPaths: an empty capture keeps the previous path", () => {
  const paths = createFinderPaths();
  paths.record(1, "/tmp/");
  paths.record(1, "");
  assert.equal(paths.take(1), "/tmp/");
});
