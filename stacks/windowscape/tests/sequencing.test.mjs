// Concurrency helpers (modules/sequencing.js): the capture queue, the tile
// pass guard and the per-display strip overlay slots.
import test from "node:test";
import assert from "node:assert/strict";
import { serialQueue, coalescingRunner, overlaySlots } from "../modules/sequencing.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

test("serialQueue runs every call, one at a time, in call order", async () => {
  const log = [];
  let running = 0, maxRunning = 0;
  const run = serialQueue(async (id) => {
    running++; maxRunning = Math.max(maxRunning, running);
    log.push(`start ${id}`);
    await tick();
    log.push(`end ${id}`);
    running--;
  });
  await Promise.all([run(1), run(2), run(3)]);
  assert.equal(maxRunning, 1);
  assert.deepEqual(log, ["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
});

test("serialQueue keeps going after a call throws, and the caller sees the error", async () => {
  const done = [];
  const run = serialQueue(async (id) => { if (id === 1) throw new Error("boom"); done.push(id); });
  const first = run(1);
  const second = run(2);
  await assert.rejects(first, /boom/);
  await second;
  assert.deepEqual(done, [2]);
});

function gatedPass() {
  const gates = [];
  let runs = 0, running = 0, overlapped = false;
  const pass = async () => {
    runs++; running++;
    if (running > 1) overlapped = true;
    await new Promise((r) => gates.push(r));
    running--;
  };
  const release = async () => { gates.shift()(); for (let i = 0; i < 5; i++) await tick(); };
  return { pass, release, get runs() { return runs; }, get overlapped() { return overlapped; } };
}

test("coalescingRunner: calls during a pass run it exactly once more, after it finishes", async () => {
  const p = gatedPass();
  const run = coalescingRunner(p.pass);
  run();
  run(); run(); run();
  await tick();
  assert.equal(p.runs, 1);
  await p.release();
  assert.equal(p.runs, 2);
  await p.release();
  assert.equal(p.runs, 2);
  assert.equal(p.overlapped, false);
});

test("coalescingRunner: an idle call runs immediately; a throwing pass doesn't wedge it", async () => {
  let runs = 0;
  const run = coalescingRunner(async () => { runs++; if (runs === 1) throw new Error("boom"); });
  await assert.rejects(run(), /boom/);
  await run();
  assert.equal(runs, 2);
});

function fakeOverlays() {
  const pending = [];
  const painted = [], disposed = [];
  const slots = overlaySlots({
    create: () => new Promise((r) => pending.push(r)),
    paint: (entry, value) => painted.push([entry.handle, value]),
    dispose: (h) => disposed.push(h),
  });
  const resolveNext = async (h) => { pending.shift()(h); await tick(); };
  return { slots, pending, painted, disposed, resolveNext };
}

test("overlaySlots: a sync during creation paints the newest value once the handle exists", async () => {
  const o = fakeOverlays();
  o.slots.sync(1, "old");
  o.slots.sync(1, "new");
  assert.equal(o.pending.length, 1);
  await o.resolveNext("H");
  assert.deepEqual(o.painted, [["H", "new"]]);
  o.slots.sync(1, "later");
  assert.deepEqual(o.painted.at(-1), ["H", "later"]);
});

test("overlaySlots: a failed create is retried by the next sync", async () => {
  const o = fakeOverlays();
  o.slots.sync(1, "a");
  await o.resolveNext(null);
  assert.deepEqual(o.painted, []);
  o.slots.sync(1, "b");
  assert.equal(o.pending.length, 1);
  await o.resolveNext("H");
  assert.deepEqual(o.painted, [["H", "b"]]);
});

test("overlaySlots: removed while creating → the late handle is disposed, never painted", async () => {
  const o = fakeOverlays();
  o.slots.sync(1, "a");
  o.slots.remove(1);
  await o.resolveNext("H");
  assert.deepEqual(o.painted, []);
  assert.deepEqual(o.disposed, ["H"]);
  assert.deepEqual(o.slots.keys(), []);
});
