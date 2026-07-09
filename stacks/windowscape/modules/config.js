// WindowScape configuration.
// All knobs the user might want to tweak live here.

export const cfg = {
  tileGap:               0,
  collapsedWindowHeight: 12,
  exclusionMode:         true,
  eventDebounceSeconds:  0.03,
  // OFF. Two daemon-side blockers:
  // (1) sd.windows.batch.begin returns false on EVERY call in the running
  // daemon — the per-tick atomic-transaction path animations were designed
  // around is dead, so the loop fell back to plain per-window setFrames;
  // (2) at that point the 30-60fps RPC fan-out saturates the daemon main
  // thread under churn, and app min-width refusals (Terminal ~80col,
  // TextEdit ~115px) surface ASYNC as resized bangs that the out-of-
  // bracket path converts into pairwise-pin oscillations in crowded
  // layouts. The snap path contains refusals synchronously in PASS-2.
  // Re-enable only after the daemon batch path works live.
  enableAnimations:      false,
  animationDuration:     0.15,
  // 30, not 60: every animation tick is one setFrame RPC per in-flight
  // window, each a synchronous AX write on the daemon main thread. At
  // 60fps a churn burst (7-9 windows, chained passes) saturated the
  // thread — focus pushes and the overlay vsync starved, borders lagged,
  // convergence crawled. 5 frames over
  // 0.15s still reads as motion.
  animationFPS:          30,
  debugLogging:          true,
  widthDefault:          1.0
};
