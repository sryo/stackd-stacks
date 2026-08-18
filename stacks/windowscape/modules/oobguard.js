// Guard for the out-of-bracket resize path: decides whether a live-read
// frame delta is trustworthy enough to mint pins, or is native-fullscreen
// fallout. Enter/exit transitions animate a window through screen-sized
// frames and fire the same resized bangs as a user drag; the tiler already
// refuses to TOUCH fullscreen spaces, but a pin minted from a transition
// frame (window at ~screen width, its row-mate squeezed to a sliver)
// survives the fullscreen session and deforms the first re-tile after
// exit. Pure — node-testable.

/// How long after a display's space flips fullscreen→normal we keep
/// distrusting resize reads: the exit animation resizes the window back
/// through the same bogus frames, and its resized bangs can debounce-fire
/// after the space info has already flipped.
export const FS_EXIT_GRACE_MS = 1500;

/// Fraction of the tile area a "resize" must reach to be dismissed as a
/// fullscreen frame when the row is shared. A real side-by-side adjustment
/// never leaves one window at effectively the whole area.
export const FS_SIZE_FRACTION = 0.95;

/// Reason this OOB resize must NOT mint pins, or null when it's safe.
///   spaceIsFullscreen — the window's display shows a fullscreen space now
///   msSinceFsExit     — ms since that display left a fullscreen space
///                       (null = never has)
///   liveMajor         — live frame size on the display's major axis
///   areaMajor         — tile area size on the same axis (0 = unknown)
///   tiledCount        — windows currently tiled on that display
export function oobPinBlockReason({ spaceIsFullscreen, msSinceFsExit, liveMajor, areaMajor, tiledCount }) {
  if (spaceIsFullscreen) return "fullscreen-space";
  if (msSinceFsExit != null && msSinceFsExit < FS_EXIT_GRACE_MS) return "fullscreen-exit-grace";
  if (tiledCount >= 2 && areaMajor > 0 && liveMajor >= areaMajor * FS_SIZE_FRACTION) {
    return "fullscreen-size";
  }
  return null;
}
