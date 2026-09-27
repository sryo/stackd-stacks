// Pure helpers for SideSwipe. No sd.* access, so they run under plain node
// (tests/logic.test.mjs).

// Rate-limit `apply` through `throttle` (sd.timer.throttle) while always
// landing on the most recent value: sd.timer.throttle's trailing call
// reuses the arguments of the call that scheduled it, so the value is read
// at fire time instead of passed through. `apply` may return a promise or
// nothing; rejections go to `onError`.
export function throttledLatest(throttle, apply, ms, onError = () => {}) {
  let latest;
  const fire = throttle(() => {
    try { Promise.resolve(apply(latest)).catch(onError); } catch (e) { onError(e); }
  }, ms);
  return (value) => { latest = value; fire(); };
}

// Quantize a 0..1 level into `steps` detents, the way the macOS volume and
// brightness HUDs do, and say which trackpad click (sd.haptic pattern) the
// move earned: none on a touch's first frame (`prev` undefined) or within
// the current step, "alignment" for a new step, "levelChange" on reaching
// either end. The step only moves once the level is `hysteresis` steps past
// the rounding boundary, so a finger resting on one doesn't chatter.
export function detent(prev, level, steps = 16, hysteresis = 0.15) {
  const pos = level * steps;
  if (prev !== undefined && Math.abs(pos - prev) < 0.5 + hysteresis) {
    return { step: prev, pattern: null };
  }
  const step = Math.round(pos);
  if (prev === undefined || step === prev) return { step, pattern: null };
  return { step, pattern: step === 0 || step === steps ? "levelChange" : "alignment" };
}
