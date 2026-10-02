// The gesture-resize preview outline is one overlay panel reused across
// gestures. Creating a panel (a WKWebView) costs the daemon's main thread
// enough that back-to-back swipes stall it — the touch recognizer then reads
// the stall as fingers lifted and splits one swipe into many one-step
// gestures. So a gesture's end hides the panel and the next gesture shows it
// again; only a quiet spell removes it.
import test from "node:test";
import assert from "node:assert/strict";
import { createPreviewKeeper } from "../modules/previewkeeper.js";

function fakes() {
  const log = [];
  let timer = null;
  let n = 0;
  return {
    log,
    fire: () => { const t = timer; timer = null; t && t(); },
    pending: () => timer != null,
    deps: {
      create: async (rect) => { log.push(["create", rect.h]); return { id: ++n }; },
      show: (h, rect) => log.push(["show", h.id, rect.h]),
      hide: (h) => log.push(["hide", h.id]),
      remove: (h) => log.push(["remove", h.id]),
      setFrame: (h, rect) => log.push(["frame", h.id, rect.h]),
      schedule: (fn) => { timer = fn; return 1; },
      cancel: () => { timer = null; },
    },
  };
}

test("back-to-back gestures create the panel once", async () => {
  const f = fakes();
  const k = createPreviewKeeper(f.deps);
  await k.begin({ h: 100 });
  k.end();
  await k.begin({ h: 200 });
  k.end();
  assert.deepEqual(f.log.filter(([op]) => op === "create").length, 1);
  assert.deepEqual(f.log, [["create", 100], ["hide", 1], ["show", 1, 200], ["hide", 1]]);
});

test("a quiet spell after the last gesture removes the panel", async () => {
  const f = fakes();
  const k = createPreviewKeeper(f.deps);
  await k.begin({ h: 100 });
  k.end();
  assert.ok(f.pending());
  f.fire();
  assert.deepEqual(f.log.at(-1), ["remove", 1]);
  await k.begin({ h: 50 });
  assert.deepEqual(f.log.at(-1), ["create", 50], "a fresh panel after removal");
});

test("a gesture inside the quiet spell cancels the removal", async () => {
  const f = fakes();
  const k = createPreviewKeeper(f.deps);
  await k.begin({ h: 100 });
  k.end();
  await k.begin({ h: 120 });
  assert.ok(!f.pending());
});

test("moves during a gesture reposition the shown panel", async () => {
  const f = fakes();
  const k = createPreviewKeeper(f.deps);
  await k.begin({ h: 100 });
  k.move({ h: 140 });
  assert.deepEqual(f.log.at(-1), ["frame", 1, 140]);
});

test("a gesture that ends before its panel exists hides it once it does", async () => {
  const f = fakes();
  const k = createPreviewKeeper(f.deps);
  const pending = k.begin({ h: 100 });
  k.end();
  await pending;
  assert.deepEqual(f.log, [["create", 100], ["hide", 1]]);
});

test("a panel hidden on arrival still gets its quiet-spell removal", async () => {
  const f = fakes();
  const k = createPreviewKeeper(f.deps);
  const pending = k.begin({ h: 100 });
  k.end();
  await pending;
  assert.ok(f.pending());
  f.fire();
  assert.deepEqual(f.log.at(-1), ["remove", 1]);
});
