// Frame animation — port of WindowScape/animation.lua.
//
// Lua animation.lua interpolates win:frame() over cfg.animationDuration
// with an easeOutCubic curve at cfg.animationFPS. Per-window cancellable;
// near-no-op when source ≈ target. Without this every tile-driven setFrame
// snaps instantly, which makes reorders/resizes jarring.
//
// Implementation notes vs lua:
// - One shared rAF-style loop (setInterval at the configured FPS) rather
//   than per-window timers; cheaper at high window count and keeps all
//   active animations in sync so they all finish on the same tick.
// - sd.windows.setFrame is RPC over IPC, ~1–2ms per call. We batch per
//   frame inside a single sd.windows.batch so the daemon-side
//   SLSTransaction commits all in-flight tiles atomically each tick —
//   matches the lua's "all windows arrive at their new frame together"
//   feel.
// - cfg.enableAnimations === false short-circuits to a direct setFrame;
//   same exit as the lua's flag check.

import { sd } from "sd://runtime/api.js";
import { cfg } from "./config.js";

// winId → { startFrame, targetFrame, startTs, onComplete, slow }
const active = new Map();
let loopHandle = null;

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
function lerp(a, b, t)  { return a + (b - a) * t; }

function framesNearlyIdentical(a, b) {
  return Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2 &&
         Math.abs(a.w - b.w) < 2 && Math.abs(a.h - b.h) < 2;
}

async function tickOnce() {
  if (active.size === 0) {
    if (loopHandle) { clearInterval(loopHandle); loopHandle = null; }
    return;
  }
  const now = performance.now() / 1000;
  const duration = cfg.animationDuration || 0.18;
  const finished = [];

  // One batch per tick — every in-flight tile gets its current frame in
  // a single atomic transaction. Matches the lua's per-tick setFrame loop
  // and avoids visible inter-window stagger on the compositor.
  await sd.windows.batch(async () => {
    for (const [winId, a] of active.entries()) {
      const t = Math.min((now - a.startTs) / duration, 1);
      const e = easeOutCubic(t);
      const frame = {
        x: Math.round(lerp(a.startFrame.x, a.targetFrame.x, e)),
        y: Math.round(lerp(a.startFrame.y, a.targetFrame.y, e)),
        w: Math.round(lerp(a.startFrame.w, a.targetFrame.w, e)),
        h: Math.round(lerp(a.startFrame.h, a.targetFrame.h, e))
      };
      await sd.windows.setFrame(winId, frame);
      if (t >= 1) finished.push(winId);
    }
  });

  for (const winId of finished) {
    const entry = active.get(winId);
    active.delete(winId);
    if (entry && entry.onComplete) {
      try { entry.onComplete(); } catch (_) { /* user callback errors don't stop the loop */ }
    }
  }
}

function ensureLoop() {
  if (loopHandle) return;
  const fps = cfg.animationFPS || 60;
  loopHandle = setInterval(tickOnce, Math.max(8, Math.round(1000 / fps)));
}

export function cancelAnimation(winId) {
  active.delete(winId);
}

export function cancelAllAnimations() {
  active.clear();
}

export function isAnimating(winId) {
  return active.has(winId);
}

// Drop-in replacement for `await sd.windows.setFrame(winId, target)`.
// Returns immediately; the animation runs on its own loop. Callers that
// need synchronous completion can pass onComplete or await sleep.
//
// cfg.enableAnimations === false short-circuits to direct setFrame — same
// exit point as lua animation.animatedSetFrame.
export async function animatedSetFrame(winId, currentFrame, targetFrame, onComplete) {
  if (!winId || !targetFrame) return;
  if (!cfg.enableAnimations || !currentFrame || framesNearlyIdentical(currentFrame, targetFrame)) {
    await sd.windows.setFrame(winId, targetFrame);
    if (onComplete) onComplete();
    return;
  }
  // Replace any prior in-flight animation for this window — last call wins,
  // matches lua cancelAnimation(winId) at the top of animatedSetFrame.
  active.set(winId, {
    startFrame:  { ...currentFrame },
    targetFrame: { ...targetFrame },
    startTs:     performance.now() / 1000,
    onComplete:  onComplete || null
  });
  ensureLoop();
}
