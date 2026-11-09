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
  // Fixed-size panels dock into a column beside the tiles as they open, so no
  // tile covers them.
  floatZone:             true,
  floatZoneMaxFrac:      0.35,
  floatZoneMinDisplayW:  1800,
  // Minimized windows become live thumbnails in a strip at the display edge.
  // Off: minimize goes to the Dock as usual and no strip space is reserved.
  minimizeRail:          false,
  // Displays windowscape never tiles, matched by the name stackd reports
  // (NSScreen.localizedName): no tile passes, no moveScreen target, and
  // their arrival or departure doesn't retile the other displays. Windows
  // on them are left alone. uuid and displayID change on every reconnect of
  // a virtual display, so match by name.
  untiledDisplays:       [{ name: "loft" }],
  debugLogging:          true,
  widthDefault:          1.0
};
