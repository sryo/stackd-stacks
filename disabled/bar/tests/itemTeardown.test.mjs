// Item lifecycle — every bar item's setup(set, bar) returns a cleanup that
// releases what it subscribed to, so toggling an item off from the context
// menu actually stops it.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./support/sd-loader.mjs", import.meta.url);
const { liveSubscribers } = await import("./support/fake-sd.mjs");
const { default: ITEMS } = await import("../items/index.js");

const fakeBar = () => {
  const items = new Map();
  return {
    items,
    register(spec) { items.set(spec.id, spec); },
    unregister(id) { items.delete(id); },
    update() {}
  };
};

for (const item of ITEMS) {
  test(`${item.id} releases its channels on cleanup`, () => {
    const before = liveSubscribers();
    const cleanup = item.setup(() => {}, fakeBar());
    assert.equal(typeof cleanup, "function");
    cleanup();
    assert.equal(liveSubscribers(), before);
  });
}

test("nowplaying removes its pills on cleanup", async () => {
  const { sd } = await import("./support/fake-sd.mjs");
  const nowplaying = ITEMS.find((i) => i.id === "nowplaying");
  const bar = fakeBar();
  const cleanup = nowplaying.setup(() => {}, bar);
  sd.media.nowPlaying.push({ title: "Song", playing: true });
  assert.deepEqual([...bar.items.keys()], ["nowplaying:_active"]);
  cleanup();
  assert.equal(bar.items.size, 0);
});
