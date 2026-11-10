// Which windows a lifecycle pass counts (events.js handleWindowEvent) and
// tiles (tiler.js).
import { cfg } from "./config.js";
import { isUntiledDisplay } from "./layouts.js";

// A window on an untiled display is not in any tile set, so its arrival or
// departure must not wake a pass for the displays that are tiled.
export function countedOn(display, rules = cfg.untiledDisplays) {
  return !!display && !isUntiledDisplay(display, rules);
}

// New window ids whose arrival is held back. While an untiled display is up,
// a window seen for under graceMs may still be on its way there: browsers
// that can't make a window at a given place open it at their default spot on
// the user's display, and the agent moves it at once. A window with no
// recorded arrival time (there when the stack booted) is never held.
//   → { counted, held, recheckAt }  recheckAt: the earliest release, or null
export function holdArrivals(newIds, { firstSeenAt, now, graceMs, untiledUp }) {
  const counted = [], held = [];
  let recheckAt = null;
  for (const id of newIds) {
    const seen = firstSeenAt[id];
    if (untiledUp && seen != null && now - seen < graceMs) {
      held.push(id);
      const at = seen + graceMs;
      if (recheckAt == null || at < recheckAt) recheckAt = at;
    } else {
      counted.push(id);
    }
  }
  return { counted, held, recheckAt };
}
