// Frame animation.
//
// Interpolates the window frame over cfg.animationDuration
// with an easeOutCubic curve at cfg.animationFPS. Per-window cancellable;
// near-no-op when source ≈ target. Without this every tile-driven setFrame
// snaps instantly, which makes reorders/resizes jarring.
//
// Implementation notes:
// - One shared rAF-style loop (setInterval at the configured FPS) rather
//   than per-window timers; cheaper at high window count and keeps all
//   active animations in sync so they all finish on the same tick.
// - sd.windows.setFrame is RPC over IPC, ~1–2ms per call. Per-tick frames
//   apply as parallel plain setFrames — see the note inside tickOnce for
//   why sd.windows.batch is deliberately NOT used here.
// - cfg.enableAnimations === false short-circuits to a direct setFrame.

import { sd } from "sd://runtime/api.js";
import { cfg } from "./config.js";
import { state } from "./core.js";

// winId → { startFrame, targetFrame, startTs, onComplete, slow }
const active = new Map();
let loopHandle = null;

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
function lerp(a, b, t)  { return a + (b - a) * t; }

function framesNearlyIdentical(a, b) {
  return Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2 &&
         Math.abs(a.w - b.w) < 2 && Math.abs(a.h - b.h) < 2;
}

// Reentrancy guard: a tick is begin-to-end async (N setFrame RPCs); at
// 60fps the interval can fire again before the previous tick's RPCs
// return. Skipped ticks cost nothing — t is wall-clock, so the next tick
// lands wherever the curve says.
let ticking = false;

async function tickOnce() {
  if (ticking) return;
  if (active.size === 0) {
    if (loopHandle) { clearInterval(loopHandle); loopHandle = null; }
    return;
  }
  ticking = true;
  try {
    const now = performance.now() / 1000;
    const duration = cfg.animationDuration || 0.18;
    const finished = [];

    // Plain per-window setFrames, applied in parallel. Deliberately NOT
    // sd.windows.batch: windows.batch.begin returns false on every call in
    // the running daemon (batched animations apply nothing), and the batch
    // path's split channels (AX size now / SLS position at commit) misplace
    // windows. The direct AX path is the same channel the non-animated tiler
    // rides. Cost: per-tick inter-window stagger instead of one compositor
    // flip — imperceptible at this duration.
    const writes = [];
    for (const [winId, a] of active.entries()) {
      const t = Math.min((now - a.startTs) / duration, 1);
      const e = easeOutCubic(t);
      const frame = {
        x: Math.round(lerp(a.startFrame.x, a.targetFrame.x, e)),
        y: Math.round(lerp(a.startFrame.y, a.targetFrame.y, e)),
        w: Math.round(lerp(a.startFrame.w, a.targetFrame.w, e)),
        h: Math.round(lerp(a.startFrame.h, a.targetFrame.h, e))
      };
      writes.push(sd.windows.setFrame(winId, frame).catch(() => {}));
      if (t >= 1) finished.push(winId);
    }
    await Promise.all(writes);

    for (const winId of finished) {
      const entry = active.get(winId);
      active.delete(winId);
      if (entry && entry.onComplete) {
        try { entry.onComplete(); } catch (_) { /* user callback errors don't stop the loop */ }
      }
    }
  } finally {
    ticking = false;
  }
}

function ensureLoop() {
  if (loopHandle) return;
  const fps = cfg.animationFPS || 60;
  loopHandle = setInterval(tickOnce, Math.max(8, Math.round(1000 / fps)));
}

// `active` keys are normalized to numbers (set/get/delete all coerce) so
// isAnimating lookups from events.js — where ids arrive as +detail.id —
// can't silently miss on string/number drift.
export function cancelAnimation(winId) {
  active.delete(+winId);
}

export function cancelAllAnimations() {
  active.clear();
}

export function isAnimating(winId) {
  return active.has(+winId);
}

// Drop-in replacement for `await sd.windows.setFrame(winId, target)`.
// Returns immediately; the animation runs on its own loop. Callers that
// need synchronous completion can pass onComplete or await sleep.
//
// cfg.enableAnimations === false short-circuits to direct setFrame.
export async function animatedSetFrame(winId, currentFrame, targetFrame, onComplete) {
  if (!winId || !targetFrame) return;
  // Record the FINAL target up front. The tiler's animated branch routes
  // through here instead of PASS-1 (which records targets itself), and the
  // echo guards in events.js — DRAG-IGNORED plus the out-of-bracket resize
  // wake-up's live-AX-read-vs-target comparison — all measure against
  // state.lastTileTarget. Without this record, every per-tick setFrame's
  // trailing resized bang compares against a stale pre-pass target, reads
  // as a foreign resize, and ripples junk pins across the row.
  state.lastTileTarget[+winId] = { frame: { ...targetFrame }, ts: Date.now() };
  if (!cfg.enableAnimations || !currentFrame || framesNearlyIdentical(currentFrame, targetFrame)) {
    await sd.windows.setFrame(winId, targetFrame);
    if (onComplete) onComplete();
    return;
  }
  // Replace any prior in-flight animation for this window — last call wins.
  active.set(+winId, {
    startFrame:  { ...currentFrame },
    targetFrame: { ...targetFrame },
    startTs:     performance.now() / 1000,
    onComplete:  onComplete || null
  });
  ensureLoop();
}
