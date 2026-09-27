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
