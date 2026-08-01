// Subsequence matcher + ranking (port of matcher.lua). Pure — no sd.*, no
// DOM — so it stays node-testable (tests/matcher.test.mjs). Frecency is
// injected via `boostOf(source, id)` rather than imported, keeping the
// module free of daemon dependencies.
export const BYPASS_SCORE = 600;

function isWordBoundary(prev, ch) {
  if (prev == null) return true;
  if (" /._-".indexOf(prev) >= 0) return true;
  if (prev >= "a" && prev <= "z" && ch >= "A" && ch <= "Z") return true;
  return false;
}

export function fuzzyMatch(q, title) {
  if (!q) return { score: 0, positions: [] };
  if (!title) return null;
  const tl = title.toLowerCase();
  const ql = q.toLowerCase();
  const positions = [];
  let score = 0, ti = 0, consec = 0, firstIdx = null, lastIdx = null;
  for (let qi = 0; qi < ql.length; qi++) {
    const qc = ql[qi];
    let found = false;
    while (ti < tl.length) {
      if (tl[ti] === qc) {
        positions.push(ti);
        const prev = ti > 0 ? title[ti - 1] : null;
        let bonus = 0;
        if (ti === 0) bonus += 25;
        if (isWordBoundary(prev, title[ti])) bonus += 15;
        if (lastIdx != null && (ti - lastIdx) === 1) {
          consec += 1;
          bonus += 8 + consec * 2;
        } else { consec = 0; }
        score += 10 + bonus;
        if (firstIdx == null) firstIdx = ti;
        lastIdx = ti;
        ti += 1;
        found = true;
        break;
      }
      ti += 1;
    }
    if (!found) return null;
  }
  const span = lastIdx - firstIdx + 1;
  score -= Math.floor((span - ql.length) * 1.5);
  if (firstIdx > 0) score -= Math.min(firstIdx, 20);
  if (tl === ql) score += 1000;
  if (tl.startsWith(ql)) score += 200;
  if (score < 1) score = 1;
  return { score, positions };
}

export function subtitleScore(q, sub) {
  if (!q) return 0;
  if (!sub) return null;
  const s = sub.toLowerCase(), ql = q.toLowerCase();
  if (s === ql) return 600;
  if (s.startsWith(ql)) return 200;
  const pos = s.indexOf(ql);
  if (pos >= 0) return Math.max(0, 100 - pos);
  return null;
}

// Source priority. Menu items rank ahead of every other source on ties
// (user's mental map: the menubar is the primary surface). Order mirrors
// Palette.config.sources in init.lua:46.
export const SOURCE_PRIORITY = {
  menuitems:     0,
  apps:          1,
  installedapps: 2,
  calc:          3,
  shellrunner:   4,
  files:         5,
  verbs:         6
};

export function rank(items, q, boostOf) {
  const empty = q === "";
  const matches = [];
  let nativeIdx = 0;
  for (const item of items) {
    if (empty && item.hideOnEmptyQuery) continue;
    if (item.bypassMatcher) {
      const boost = boostOf(item.source, item.id);
      item.fromHistory = boost > 0;
      item.matchPositions = item.matchPositions || [];
      matches.push({ item, score: BYPASS_SCORE + boost / 100, nativeIdx: nativeIdx++ });
      continue;
    }
    let tScore = null, tPositions = [];
    if (empty) {
      tScore = 0;
    } else {
      const m = fuzzyMatch(q, item.title || "");
      if (m) { tScore = m.score; tPositions = m.positions; }
    }
    let sScore = null;
    if (tScore == null && !empty) sScore = subtitleScore(q, item.subtitle || "");
    const matchVal = tScore != null ? tScore : (sScore != null ? sScore * 0.6 : null);
    const hit = empty || matchVal != null;
    if (hit) {
      const boost = boostOf(item.source, item.id);
      item.fromHistory = boost > 0;
      item.matchPositions = tPositions;
      const total = empty ? boost : matchVal + boost / 10;
      matches.push({ item, score: total, nativeIdx: nativeIdx++ });
    } else {
      item.matchPositions = [];
    }
  }
  // Sort: score desc, then source-priority asc (menubar wins ties), then
  // native order (preserves File → Edit → View menu sequence on empty
  // query). Source priority is what makes menu items rank above apps when
  // both score equal — critical when the user types something that
  // matches a menu and an app title the same way.
  matches.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const pa = SOURCE_PRIORITY[a.item.source] ?? 99;
    const pb = SOURCE_PRIORITY[b.item.source] ?? 99;
    if (pa !== pb) return pa - pb;
    return a.nativeIdx - b.nativeIdx;
  });
  return matches.map(m => m.item);
}
