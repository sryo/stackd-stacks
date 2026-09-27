import test from "node:test";
import assert from "node:assert/strict";
import { throttledLatest } from "../logic.js";

// Same shape as sd.timer.throttle: leading call runs now, one trailing call
// runs when the window expires, with the arguments of the call that
// scheduled it.
function fakeThrottle() {
  const timers = [];
  const throttle = (fn) => {
    let open = true, scheduled = false;
    return (...args) => {
      if (open) { open = false; fn(...args); return; }
      if (!scheduled) { scheduled = true; timers.push(() => { scheduled = false; open = true; fn(...args); }); }
    };
  };
  return { throttle, flush: () => timers.splice(0).forEach((t) => t()) };
}

test("throttledLatest applies the first value at once and the last value when the window ends", () => {
  const { throttle, flush } = fakeThrottle();
  const applied = [];
  const set = throttledLatest(throttle, async (v) => { applied.push(v); }, 50);
  set(0.1); set(0.2); set(0.3); set(0.4);
  assert.deepEqual(applied, [0.1]);
  flush();
  assert.deepEqual(applied, [0.1, 0.4]);
});

test("throttledLatest reports a rejected apply instead of leaving it unhandled", async () => {
  const { throttle } = fakeThrottle();
  const errors = [];
  const set = throttledLatest(throttle, async () => { throw new Error("denied"); }, 50, (e) => errors.push(e.message));
  set(1);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(errors, ["denied"]);
});
