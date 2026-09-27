// Pure helpers for TimeTrail. No sd.* access, so they run under plain node
// (tests/logic.test.mjs).

// sd.mouse is global but each display has its own panel: returns the cursor
// in this panel's local coords plus the panel size, or null when the cursor
// is on another display. `m.display` is the cursor's display as of this
// push, so the translation follows display rearrangements.
export function cursorOnPanel(m, screen) {
  const d = m && m.display;
  if (!d || !d.frame || !screen || d.id !== screen.displayID) return null;
  const f = d.frame;
  return { x: m.x - f.x, y: m.y - f.y, w: f.w, h: f.h };
}
