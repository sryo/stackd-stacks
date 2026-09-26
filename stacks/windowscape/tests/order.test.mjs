// nextSpaceOrder — a space's left-to-right tile order after a membership
// change. Tiled windows keep their relative order and newcomers append. A
// minimized window keeps its place while it is away, so restoring it puts it
// back in the slot it left instead of at the end of the row.
import test from "node:test";
import assert from "node:assert/strict";
import { nextSpaceOrder } from "../modules/order.js";

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
