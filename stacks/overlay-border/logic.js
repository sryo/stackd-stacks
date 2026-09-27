// Pure helpers for the focused-window border. No sd.* access, so they run
// under plain node (tests/logic.test.mjs).

// Drop a destroyed window's entries from per-window caches (inclusion
// verdicts, corner hints) so they don't grow for the whole session.
export function forgetWindow(detail, ...caches) {
  if (!detail || typeof detail.id !== "number") return;
  for (const cache of caches) cache.delete(detail.id);
}
