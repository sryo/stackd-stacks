// Pure unit tests for palette decision helpers (modules/logic.js): no sd.*,
// no DOM, so they run under plain `node --test tests/`.
import test from "node:test";
import assert from "node:assert/strict";
import { titleRuns, createGeneration, mapLimit, digitPicksRow, clampToScreen } from "../modules/logic.js";

test("titleRuns: merges adjacent matched chars into bold runs", () => {
  assert.deepEqual(titleRuns("Safari", [0, 1, 4]), [
    { text: "Sa", bold: true }, { text: "fa", bold: false },
    { text: "r", bold: true }, { text: "i", bold: false },
  ]);
});

test("titleRuns: no positions yields one plain run", () => {
  assert.deepEqual(titleRuns("New Window", []), [{ text: "New Window", bold: false }]);
  assert.deepEqual(titleRuns("New Window", undefined), [{ text: "New Window", bold: false }]);
});

test("titleRuns: markup in a title stays literal text", () => {
  const title = "<img src=x onerror=alert(1)>.txt";
  const runs = titleRuns(title, [1, 2, 3]);
  assert.equal(runs.map(r => r.text).join(""), title);
  assert.deepEqual(runs[1], { text: "img", bold: true });
});

test("titleRuns: empty title yields no runs", () => {
  assert.deepEqual(titleRuns("", [0]), []);
});

test("createGeneration: only the latest token is current", () => {
  const gen = createGeneration();
  const a = gen.next();
  assert.ok(gen.isCurrent(a));
  const b = gen.next();
  assert.ok(!gen.isCurrent(a), "older refresh is stale");
  assert.ok(gen.isCurrent(b));
});

test("createGeneration: a slow older result resolving last is dropped", async () => {
  const gen = createGeneration();
  const applied = [];
  const run = async (label, delay) => {
    const token = gen.next();
    await new Promise(r => setTimeout(r, delay));
    if (gen.isCurrent(token)) applied.push(label);
  };
  await Promise.all([run("slow-old", 20), run("fast-new", 1)]);
  assert.deepEqual(applied, ["fast-new"]);
});

test("createGeneration: settled() waits for a refresh started while waiting", async () => {
  const gen = createGeneration();
  const done = [];
  const later = (label, ms) => new Promise(r => setTimeout(() => { done.push(label); r(); }, ms));
  gen.track(later("first", 5));
  setTimeout(() => gen.track(later("second", 10)), 1);
  await gen.settled();
  assert.deepEqual(done, ["first", "second"]);
});

test("createGeneration: settled() resolves immediately with nothing tracked", async () => {
  await createGeneration().settled();
});

test("mapLimit: preserves input order and never exceeds the cap", async () => {
  let inFlight = 0, peak = 0;
  const out = await mapLimit([30, 5, 20, 1, 10, 2], 3, async (ms, i) => {
    inFlight += 1; peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, ms));
    inFlight -= 1;
    return i;
  });
  assert.deepEqual(out, [0, 1, 2, 3, 4, 5]);
  assert.equal(peak, 3);
});

test("mapLimit: empty input resolves to []", async () => {
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
});

test("digitPicksRow: empty noun query picks a row", () => {
  assert.equal(digitPicksRow("noun", ""), true);
});

test("digitPicksRow: a text filter still picks a row", () => {
  assert.equal(digitPicksRow("noun", "saf"), true);
  assert.equal(digitPicksRow("noun", "~/Docs"), true);
  assert.equal(digitPicksRow("noun", "e"), true);
});

test("digitPicksRow: an expression in progress types the digit", () => {
  for (const q of ["2+", "(", " ", "12*3", "3.5 / ", "2^", "pi*", "e+", "-"]) {
    assert.equal(digitPicksRow("noun", q), false, JSON.stringify(q));
  }
});

test("digitPicksRow: verb stage always picks", () => {
  assert.equal(digitPicksRow("verb", "2+"), true);
});

const SCREEN = { x: 0, y: 0, w: 1440, h: 900 };

test("clampToScreen: keeps an in-bounds panel where it is", () => {
  assert.deepEqual(clampToScreen(100, 200, 800, 470, SCREEN, 8), { x: 100, y: 200 });
});

test("clampToScreen: pulls each overflowing edge back inside the margin", () => {
  assert.deepEqual(clampToScreen(-50, -50, 800, 470, SCREEN, 8), { x: 8, y: 8 });
  assert.deepEqual(clampToScreen(1000, 700, 800, 470, SCREEN, 8), { x: 632, y: 422 });
});

test("clampToScreen: respects a non-origin display frame", () => {
  const right = { x: 1440, y: -200, w: 1920, h: 1080 };
  assert.deepEqual(clampToScreen(1400, -300, 800, 470, right, 8), { x: 1448, y: -192 });
});

test("clampToScreen: no screen frame leaves the point untouched", () => {
  assert.deepEqual(clampToScreen(-5, -5, 800, 470, null, 8), { x: -5, y: -5 });
});
