// Pure unit tests for the palette matcher + ranking. matcher.js has no
// sd.* / DOM dependency; frecency is injected via boostOf.
import test from "node:test";
import assert from "node:assert/strict";
import { fuzzyMatch, subtitleScore, rank, BYPASS_SCORE } from "../modules/matcher.js";

const noBoost = () => 0;

test("fuzzyMatch: exact match dominates everything", () => {
  const exact = fuzzyMatch("safari", "Safari");
  const prefix = fuzzyMatch("safari", "Safari Technology Preview");
  assert.ok(exact.score > prefix.score, "exact beats prefix");
  assert.ok(exact.score >= 1000, "exact bonus applied");
});

test("fuzzyMatch: prefix beats scattered subsequence", () => {
  const prefix = fuzzyMatch("new", "New Window");
  const scattered = fuzzyMatch("new", "Note Editor Widget");
  assert.ok(prefix.score > scattered.score);
});

test("fuzzyMatch: word-boundary hits beat mid-word hits", () => {
  const boundary = fuzzyMatch("nw", "New Window");
  const midword = fuzzyMatch("nw", "unwind");
  assert.ok(boundary.score > midword.score);
});

test("fuzzyMatch: returns null when a char is missing, positions when not", () => {
  assert.equal(fuzzyMatch("xyz", "Safari"), null);
  const m = fuzzyMatch("sf", "Safari");
  assert.deepEqual(m.positions, [0, 2]);
});

test("fuzzyMatch: empty query scores 0 with no positions", () => {
  assert.deepEqual(fuzzyMatch("", "anything"), { score: 0, positions: [] });
});

test("subtitleScore: exact > prefix > substring > null", () => {
  assert.equal(subtitleScore("file", "file"), 600);
  assert.equal(subtitleScore("file", "file > save"), 200);
  assert.ok(subtitleScore("save", "file > save") > 0);
  assert.equal(subtitleScore("zzz", "file > save"), null);
});

test("rank: menu items win score ties over apps (source priority)", () => {
  const items = [
    { id: "a", title: "Safari", source: "apps" },
    { id: "m", title: "Safari", source: "menuitems" },
  ];
  const out = rank(items, "safari", noBoost);
  assert.equal(out[0].source, "menuitems");
});

test("rank: empty query hides hideOnEmptyQuery items and keeps native order", () => {
  const items = [
    { id: "1", title: "File", source: "menuitems" },
    { id: "2", title: "Edit", source: "menuitems" },
    { id: "3", title: "Ghost", source: "installedapps", hideOnEmptyQuery: true },
  ];
  const out = rank(items, "", noBoost);
  assert.deepEqual(out.map(i => i.id), ["1", "2"]);
});

test("rank: frecency boost floats history items on empty query", () => {
  const items = [
    { id: "cold", title: "Cold", source: "menuitems" },
    { id: "hot", title: "Hot", source: "menuitems" },
  ];
  const out = rank(items, "", (src, id) => (id === "hot" ? 5000 : 0));
  assert.equal(out[0].id, "hot");
  assert.equal(out[0].fromHistory, true);
  assert.equal(out[1].fromHistory, false);
});

test("rank: bypassMatcher items score BYPASS_SCORE regardless of query", () => {
  const items = [
    { id: "calc:active", title: "= 4", source: "calc", bypassMatcher: true },
    { id: "nomatch", title: "zzz", source: "apps" },
  ];
  const out = rank(items, "2+2", noBoost);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "calc:active");
});

test("rank: subtitle fallback matches at reduced weight", () => {
  const items = [
    { id: "t", title: "Save", source: "menuitems" },
    { id: "s", title: "Export", subtitle: "File > Save As…", source: "menuitems" },
  ];
  const out = rank(items, "save", noBoost);
  assert.equal(out.length, 2, "subtitle hit keeps the item in");
  assert.equal(out[0].id, "t", "title match outranks subtitle match");
});
