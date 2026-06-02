// WindowScape configuration — verbatim port of config.lua.
// All knobs the user might want to tweak live here.

export const cfg = {
  outlineColor:          { r: 0.1, g: 0.3, b: 0.9, a: 0.8 },
  outlineColorPinned:    { r: 0.9, g: 0.6, b: 0.1, a: 0.8 },
  outlineThickness:      8,
  tileGap:               0,
  collapsedWindowHeight: 12,
  exclusionMode:         true,
  eventDebounceSeconds:  0.2,
  enableAnimations:      false,
  animationDuration:     0.15,
  animationFPS:          60,
  debugLogging:          false,
  widthStep:             0.25,
  widthMin:              0.25,
  widthMax:              8.0,
  widthDefault:          1.0
};

export const CONST = {
  OUTLINE_REFRESH_INTERVAL: 0.033
};
