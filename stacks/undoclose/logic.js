// Pure undoclose decisions — no sd.*, no DOM — so they stay node-testable
// (tests/logic.test.mjs).

// CGWindowID of a Finder window from a sd.windows focusedChanged /
// titleChanged payload, or null when the payload isn't a Finder window.
export function finderWindowId(w) {
  if (!w || w.app !== "Finder" || w.id == null) return null;
  return w.id;
}

// Folder each open Finder window last showed, keyed by CGWindowID, so a
// close offers that window's folder even when it wasn't the focused one.
export function createFinderPaths() {
  const byId = new Map();
  return {
    record(id, path) { if (path) byId.set(id, path); },
    take(id) {
      const path = byId.get(id);
      byId.delete(id);
      return path || null;
    },
  };
}
