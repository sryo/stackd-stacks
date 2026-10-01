// rainPollDelay — when the rain item fetches the forecast next. A failed
// fetch (offline at login, wttr.in hiccup) retries within minutes instead
// of leaving the item blank for the full forecast interval.
import test from "node:test";
import assert from "node:assert/strict";
import { rainPollDelay } from "../logic.js";

test("after a successful fetch the next one is 30 minutes out", () => {
  assert.equal(rainPollDelay(true), 30 * 60 * 1000);
});

test("after a failed fetch it retries in 5 minutes", () => {
  assert.equal(rainPollDelay(false), 5 * 60 * 1000);
});
