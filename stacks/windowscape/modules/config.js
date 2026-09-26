// WindowScape configuration.
// All knobs the user might want to tweak live here.

export const cfg = {
  tileGap:               0,
  collapsedWindowHeight: 12,
  exclusionMode:         true,
  eventDebounceSeconds:  0.03,
  // Lifecycle retiles (open/close/minimize/spaces) animate on the daemon's
  // motion engine; resize containment always snaps.
  enableAnimations:      true,
  // "spring" (settle time follows distance; a retarget mid-flight keeps its
  // velocity), "easeOutCubic" or "linear". easeOutCubic at 0.15s is a
  // short fixed-duration glide.
  animationEasing:       "spring",
  // Seconds; applies to the curve easings only.
  animationDuration:     0.15,
  // Dragging a tiled window's edge moves the neighbor across it live, every
  // frame, instead of on release.
  liveResize:            true,
  debugLogging:          true,
  widthDefault:          1.0
};
