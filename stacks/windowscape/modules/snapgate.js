// Gate for the snapshot refresh timer. A tile's strip is drawn on the display
// the window was minimized from, and only while that display shows the tile's
// origin desktop. While the display shows a native fullscreen space the strip
// can't be on screen, so re-capturing its tiles is invisible work stacked on
// top of whatever is fullscreen. Pure: node-testable.

/// True when the display hosting a snapshot currently shows a native
/// fullscreen space.
///   displayID       : the snapshot's data.displayID
///   displays        : sd.display.all snapshot ([{ displayID, uuid, ... }])
///   spacesByDisplay : sd.spaces.all snapshot ({ [uuid]: { isFullscreen } })
/// An unknown display or missing Spaces info never blocks: no evidence of
/// fullscreen means the refresh runs as before.
export function refreshBlockedByFullscreen(displayID, displays, spacesByDisplay) {
  if (!displays || !spacesByDisplay) return false;
  const d = displays.find((d) => d.displayID === displayID);
  return !!(d && spacesByDisplay[d.uuid]?.isFullscreen);
}
