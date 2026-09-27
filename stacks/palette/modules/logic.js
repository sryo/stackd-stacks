// Pure palette decisions — no sd.*, no DOM — so they stay node-testable
// (tests/logic.test.mjs) alongside matcher.js.

// Split a title into plain / bold runs from the matcher's highlight
// positions. Callers render runs as text nodes, never as markup, so a
// filename or menu title containing HTML stays literal.
export function titleRuns(title, positions) {
  const set = new Set(positions || []);
  const runs = [];
  for (let i = 0; i < title.length; i++) {
    const bold = set.has(i);
    const last = runs[runs.length - 1];
    if (last && last.bold === bold) last.text += title[i];
    else runs.push({ text: title[i], bold });
  }
  return runs;
}

// Monotonic token for overlapping async refreshes: each refresh takes
// next(), and applies its result only if isCurrent() still holds when the
// awaits finish, so a slow older query can't overwrite a newer one.
// track()/settled() let an action (Enter) wait until the newest refresh,
// including any started while waiting, has landed.
export function createGeneration() {
  let current = 0;
  let latest = Promise.resolve();
  return {
    next() { current += 1; return current; },
    isCurrent(token) { return token === current; },
    track(promise) { latest = promise; return promise; },
    async settled() {
      let seen;
      do { seen = latest; await seen.catch(() => {}); } while (seen !== latest);
    },
  };
}

// Promise.all over `items` with at most `limit` calls of fn in flight.
// Results keep input order.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

// Bare 1..9 picks the Nth visible row (HS itemQuickPick) unless the noun
// query is an arithmetic expression in progress, where the digit belongs
// to the calculator. An expression can't start with a bare digit on an
// empty query (that's a row pick); a leading space or "(" starts one.
export function digitPicksRow(stage, query) {
  if (stage !== "noun" || query === "") return true;
  const stripped = query.replace(/\bpi\b|\be\b/gi, "");
  return !/^[\s\d+\-*/%^().]+$/.test(stripped);
}

// Clamp a w×h panel's top-left so it sits inside screen frame `sf` with
// `margin` on every side. A panel larger than the screen keeps its
// top-left edge visible.
export function clampToScreen(x, y, w, h, sf, margin) {
  if (!sf) return { x, y };
  x = Math.min(x, sf.x + sf.w - w - margin);
  y = Math.min(y, sf.y + sf.h - h - margin);
  return { x: Math.max(x, sf.x + margin), y: Math.max(y, sf.y + margin) };
}
