// stepFeel: which trackpad click (if any) a resize step earns. Size changes
// click per bucket, a step blocked at the clamp clicks the end stop once, and
// further blocked steps stay silent until the size backs off a bucket.
import test from "node:test";
import assert from "node:assert/strict";
import { stepFeel } from "../modules/stepfeel.js";

const opts = { bucketPx: 48, gapMs: 35 };

test("reorder clicks each swap and stays silent at the row's end", () => {
  const f = stepFeel(opts);
  assert.equal(f.reorder(true, 0), "step");
  assert.equal(f.reorder(false, 100), null);
  assert.equal(f.reorder(false, 200), null);
  assert.equal(f.reorder(true, 300), "step");
});

test("reorder swaps closer than the gap don't click", () => {
  const f = stepFeel(opts);
  assert.equal(f.reorder(true, 0), "step");
  assert.equal(f.reorder(true, 20), null);
  assert.equal(f.reorder(true, 60), "step");
});

test("resize clicks once per bucket of size actually changed", () => {
  const f = stepFeel(opts);
  const clicks = [];
  for (let i = 1; i <= 8; i++) clicks.push(f.resize(12, i * 100));
  assert.deepEqual(clicks, [null, null, null, "step", null, null, null, "step"]);
});

test("resize at its limit clicks the end stop once, then goes quiet", () => {
  const f = stepFeel(opts);
  assert.equal(f.resize(5, 0), null);
  assert.equal(f.resize(0, 100), "end");
  assert.equal(f.resize(0, 200), null);
  assert.equal(f.resize(0, 300), null);
});

test("wobbling at a limit neither re-arms the end stop nor clicks steps", () => {
  const f = stepFeel(opts);
  assert.equal(f.resize(0, 0), "end");
  const clicks = [];
  for (let i = 1; i <= 12; i++) clicks.push(f.resize(i % 2 ? -12 : 12, i * 100), f.resize(0, i * 100 + 50));
  assert.deepEqual(clicks.filter(Boolean), []);
});

test("backing a full bucket off a limit re-arms the end stop", () => {
  const f = stepFeel(opts);
  assert.equal(f.resize(0, 0), "end");
  f.resize(-12, 100); f.resize(-12, 200); f.resize(-12, 300);
  assert.equal(f.resize(-12, 400), "step");
  f.resize(12, 500); f.resize(12, 600); f.resize(12, 700); f.resize(12, 800);
  assert.equal(f.resize(0, 900), "end");
});

test("step clicks closer than the gap are dropped, end stops never are", () => {
  const f = stepFeel(opts);
  assert.equal(f.resize(48, 0), "step");
  assert.equal(f.resize(48, 20), null);
  assert.equal(f.resize(0, 25), "end");
  assert.equal(f.resize(-48, 60), "step");
});

test("reset starts a new gesture: the bucket and the end stop clear", () => {
  const f = stepFeel(opts);
  f.resize(36, 0);
  assert.equal(f.resize(0, 100), "end");
  f.reset();
  assert.equal(f.resize(0, 200), "end");
  assert.equal(f.resize(36, 300), null);
  assert.equal(f.resize(12, 400), "step");
  assert.equal(f.resize(-12, 500), null);
});
