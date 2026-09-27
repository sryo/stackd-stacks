import test from "node:test";
import assert from "node:assert/strict";
import { forgetWindow } from "../logic.js";

test("forgetWindow drops a destroyed window from every per-window cache", () => {
  const inclusion = new Map([[1, "excluded"], [2, "floating"]]);
  const hints = new Map([[1, { role: "AXWindow" }]]);
  forgetWindow({ id: 1 }, inclusion, hints);
  assert.deepEqual([...inclusion.keys()], [2]);
  assert.equal(hints.size, 0);
  forgetWindow(null, inclusion, hints);
  forgetWindow({ id: "1" }, inclusion, hints);
  assert.equal(inclusion.size, 1);
});
