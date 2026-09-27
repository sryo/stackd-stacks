// Trackpad feel for gesture steps: decides which click, if any, a step earns.
// Pure (no sd.* access) so it runs under plain node (tests/stepFeel.test.mjs);
// gestures.js maps the verdict to an sd.haptic waveform.
//
//   "step": a reorder swapped, or a resize changed the size by another
//            `bucketPx` net (its steps are fine-grained). Clicks closer than
//            `gapMs` are dropped so a fast drag doesn't buzz.
//   "end":  the first resize step blocked at the size clamp. It re-arms
//            once the size is `bucketPx` back from where it stopped. A
//            reorder blocked at the row's end stays silent.
//
// Resize is tracked as a net position, so a finger wobbling at a limit
// (tttaps flips direction on small reversals) nets out to nothing instead
// of re-arming the end stop and ticking on every flip.
export function stepFeel({ bucketPx, gapMs }) {
  let pos = 0, mark = 0, endAt = null, lastStepAt = -Infinity;

  function stepped(now) {
    if (now - lastStepAt < gapMs) return null;
    lastStepAt = now;
    return "step";
  }

  return {
    reorder(moved, now) {
      return moved ? stepped(now) : null;
    },
    resize(changedPx, now) {
      if (!changedPx) {
        if (endAt !== null) return null;
        endAt = pos;
        return "end";
      }
      pos += changedPx;
      if (endAt !== null && Math.abs(pos - endAt) >= bucketPx) endAt = null;
      if (Math.abs(pos - mark) < bucketPx) return null;
      mark = pos;
      return stepped(now);
    },
    reset() {
      pos = 0;
      mark = 0;
      endAt = null;
    },
  };
}
