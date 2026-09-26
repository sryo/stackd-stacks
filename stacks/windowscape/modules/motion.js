// Pure pieces of tile motion. The daemon animates (sd.windows.setFrame with
// {duration, easing} ticks every window on one display-link clock); this
// module only shapes the request and keeps the stack's own bookkeeping.
// No sd import, so node can test it.

const CURVES = new Set(["easeOutCubic", "linear"]);

/// setFrame options for an animated tile write, or null for an instant one.
/// Spring derives its own settle time from distance, so it carries no
/// duration; the curves need a positive animationDuration.
export function motionOptions(c) {
  if (!c || !c.enableAnimations) return null;
  if (CURVES.has(c.animationEasing)) {
    const duration = +c.animationDuration;
    return duration > 0 ? { duration, easing: c.animationEasing } : null;
  }
  return { easing: "spring" };
}

export function framesNearlyIdentical(a, b) {
  return Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2 &&
         Math.abs(a.w - b.w) < 2 && Math.abs(a.h - b.h) < 2;
}

/// Synchronous mirror of which windows have a daemon animation in flight.
/// Each begin() hands out a token; only the matching end() clears the
/// entry, so a superseded animation's late settle can't erase the newer
/// animation that replaced it. Ids are normalized to numbers.
export function createInFlight() {
  const tokens = new Map();
  let seq = 0;
  return {
    begin(id) { const t = ++seq; tokens.set(+id, t); return t; },
    end(id, token) { if (tokens.get(+id) === token) tokens.delete(+id); },
    drop(id) { tokens.delete(+id); },
    has(id) { return tokens.has(+id); },
    ids() { return [...tokens.keys()]; },
    clear() { tokens.clear(); },
  };
}

/// Windows that settled more than `px` off their target on the tiling axis:
/// [[id, live], ...]. entries: [{ id, target, live }]. When every window of
/// the `population` reads as refused the reads are suspect (not a real
/// min/max), so nothing is returned.
export function pickRefusals(entries, horizontal, px, population) {
  const refused = [];
  for (const { id, target, live } of entries) {
    const dMajor = Math.abs(horizontal ? live.w - target.w : live.h - target.h);
    if (dMajor > px) refused.push([id, live]);
  }
  return refused.length >= population ? [] : refused;
}
