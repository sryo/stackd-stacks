// Tile animation, driven by the daemon's motion engine.
//
// sd.windows.setFrame(id, frame, {easing, duration}) animates daemon-side on
// the display clock: every window of a pass starts on the same tick and
// moves in lockstep, a new setFrame on a moving window supersedes it (a
// spring carries its velocity into the new target), and an instant
// setFrame / setFrameProbed cancels whatever is in flight. The promise
// resolves at settle: true = reached the target, false = superseded,
// cancelled, or the window couldn't be resolved.
//
// While a window animates the daemon swallows its moved/resized bangs, and
// the trailing ones carry `self: true` from its write ledger — events.js
// drops those, so the stack needs no echo bookkeeping of its own.
//
// isAnimating stays synchronous for the event handlers: a local mirror
// entered on each animated write and cleared by that write's own settle.

import { sd } from "sd://runtime/api.js";
import { cfg } from "./config.js";
import { state } from "./core.js";
import { motionOptions, framesNearlyIdentical, createInFlight } from "./motion.js";

const inFlight = createInFlight();

export function isAnimating(winId) {
  return inFlight.has(winId);
}

// Stops the window where it stands (its setFrame promise resolves false).
export function cancelAnimation(winId) {
  inFlight.drop(winId);
  return sd.windows.cancelAnimation(+winId).catch(() => false);
}

export function cancelAllAnimations() {
  const ids = inFlight.ids();
  inFlight.clear();
  return Promise.all(ids.map((id) => sd.windows.cancelAnimation(id).catch(() => false)));
}

// Tile write toward targetFrame; resolves true once the window settled there.
// Records targetFrame as the window's tile target up front — pins, the
// refusal sweep and the out-of-bracket resize check all measure against it.
// cfg.enableAnimations === false (or a window already at its target and not
// moving) writes instantly.
export function animatedSetFrame(winId, currentFrame, targetFrame) {
  if (!winId || !targetFrame) return Promise.resolve(false);
  const id = +winId;
  state.lastTileTarget[id] = { frame: { ...targetFrame } };
  const opts = motionOptions(cfg);
  // windowsById frames go stale while a window moves (its bangs are
  // swallowed), so an in-flight window always re-animates from where the
  // daemon actually has it.
  const atTarget = currentFrame && !inFlight.has(id) && framesNearlyIdentical(currentFrame, targetFrame);
  if (!opts || atTarget) {
    return sd.windows.setFrame(id, targetFrame).then((ok) => ok !== false, () => false);
  }
  const token = inFlight.begin(id);
  return sd.windows.setFrame(id, targetFrame, opts).then(
    (settled) => { inFlight.end(id, token); return settled === true; },
    () => { inFlight.end(id, token); return false; }
  );
}
