// nextSpaceOrder — a space's left-to-right tile order after a membership
// change. Tiled windows keep their relative order and newcomers append. A
// minimized window keeps its place while it is away, so restoring it puts it
// back in the slot it left instead of at the end of the row.
import test from "node:test";
import assert from "node:assert/strict";
import { nextSpaceOrder, sortBySlot } from "../modules/order.js";

test("newcomers append after the existing order", () => {
  assert.deepEqual(nextSpaceOrder([1, 2], [1, 2, 3], new Set()), [1, 2, 3]);
});

test("a window that is gone leaves the order", () => {
  assert.deepEqual(nextSpaceOrder([1, 2, 3], [1, 3], new Set()), [1, 3]);
});

test("a minimized window keeps its place while it is away", () => {
  assert.deepEqual(nextSpaceOrder([1, 2, 3], [1, 3], new Set([2])), [1, 2, 3]);
});

test("restoring a minimized window returns it to its old slot", () => {
  const away = nextSpaceOrder([1, 2, 3], [1, 3], new Set([2]));
  assert.deepEqual(nextSpaceOrder(away, [1, 2, 3], new Set()), [1, 2, 3]);
});

test("a window opened while another is minimized goes after it", () => {
  const away = nextSpaceOrder([1, 2, 3], [1, 3], new Set([2]));
  const opened = nextSpaceOrder(away, [1, 3, 4], new Set([2]));
  assert.deepEqual(opened, [1, 2, 3, 4]);
  assert.deepEqual(nextSpaceOrder(opened, [1, 2, 3, 4], new Set()), [1, 2, 3, 4]);
});

test("a held window that was never in the order is not added", () => {
  // Minimized before this space's order ever saw it: it has no slot to keep.
  assert.deepEqual(nextSpaceOrder([1], [1], new Set([9])), [1]);
});

test("duplicates collapse to the first position", () => {
  assert.deepEqual(nextSpaceOrder([1, 2, 1], [1, 2], new Set()), [1, 2]);
});

// sortBySlot: the row order a reorder step works from. Mid-animation the
// live frames still show the previous layout; the tiler's targets already
// show the new one.
test("sortBySlot orders by the tiler's target frames over live frames", () => {
  const wins = [
    { id: 1, frame: { x: 0,    y: 0, w: 1200, h: 800 } },
    { id: 2, frame: { x: 1210, y: 0, w: 600,  h: 800 } },
  ];
  const targets = { 1: { frame: { x: 610, y: 0, w: 1200, h: 800 } }, 2: { frame: { x: 0, y: 0, w: 600, h: 800 } } };
  assert.deepEqual(sortBySlot(wins, true, targets).map((w) => w.id), [2, 1]);
});

test("sortBySlot falls back to the live frame without a target", () => {
  const wins = [
    { id: 1, frame: { x: 900, y: 0, w: 600, h: 800 } },
    { id: 2, frame: { x: 0,   y: 0, w: 600, h: 800 } },
  ];
  assert.deepEqual(sortBySlot(wins, true, {}).map((w) => w.id), [2, 1]);
  assert.deepEqual(sortBySlot(wins, true, undefined).map((w) => w.id), [2, 1]);
});

test("sortBySlot sorts a column by vertical centers", () => {
  const wins = [
    { id: 1, frame: { x: 0, y: 500, w: 800, h: 400 } },
    { id: 2, frame: { x: 0, y: 0,   w: 800, h: 400 } },
  ];
  assert.deepEqual(sortBySlot(wins, false, {}).map((w) => w.id), [2, 1]);
});

test("sortBySlot takes a recent order over any frames when it holds the same windows", () => {
  const wins = [
    { id: 1, frame: { x: 0,    y: 0, w: 1200, h: 800 } },
    { id: 2, frame: { x: 1210, y: 0, w: 600,  h: 800 } },
  ];
  assert.deepEqual(sortBySlot(wins, true, {}, [2, 1]).map((w) => w.id), [2, 1]);
});

test("sortBySlot ignores a recent order for a different set of windows", () => {
  const wins = [
    { id: 1, frame: { x: 0,    y: 0, w: 600, h: 800 } },
    { id: 2, frame: { x: 700,  y: 0, w: 600, h: 800 } },
    { id: 3, frame: { x: 1400, y: 0, w: 600, h: 800 } },
  ];
  assert.deepEqual(sortBySlot(wins, true, {}, [2, 1]).map((w) => w.id), [1, 2, 3]);
});
