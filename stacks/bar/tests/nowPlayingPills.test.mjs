// nowPlayingPills — the rich pill for the active player plus a bare pill per
// other app producing audio. sd.media.nowPlaying does not say which app is
// the active player, so a lone audio process while the active player is
// playing is taken to be that player and gets no second pill.
import test from "node:test";
import assert from "node:assert/strict";
import { nowPlayingPills } from "../logic.js";

const spotify = { pid: 10, bundleId: "com.spotify.client", name: "Spotify", playingOutput: true };
const chrome  = { pid: 20, bundleId: "com.google.Chrome", name: "Google Chrome", playingOutput: true };
const ids = (pills) => pills.map((p) => p.id);

test("the active player's own audio process gets no second pill", () => {
  const pills = nowPlayingPills({ title: "Song", artist: "Band", playing: true }, [spotify]);
  assert.deepEqual(pills, [{ id: "nowplaying:_active", value: "Song · Band" }]);
});

test("with several apps playing, each gets a pill", () => {
  const pills = nowPlayingPills({ title: "Song", playing: true }, [chrome, spotify]);
  assert.deepEqual(ids(pills), ["nowplaying:_active", "nowplaying:com.google.Chrome", "nowplaying:com.spotify.client"]);
});

test("a paused active player does not hide the app that is playing", () => {
  const pills = nowPlayingPills({ title: "Song", playing: false }, [chrome]);
  assert.deepEqual(ids(pills), ["nowplaying:_active", "nowplaying:com.google.Chrome"]);
});

test("without an active player every audible app gets a named pill", () => {
  const pills = nowPlayingPills(null, [chrome]);
  assert.deepEqual(pills, [{ id: "nowplaying:com.google.Chrome", value: "Google Chrome", bundleId: "com.google.Chrome" }]);
});

test("silent, system and nameless processes get no pill", () => {
  const pills = nowPlayingPills(null, [
    { ...chrome, playingOutput: false },
    { pid: 1, bundleId: "com.apple.coreaudiod", name: "coreaudiod", playingOutput: true },
    { pid: 2, bundleId: null, name: "x", playingOutput: true }
  ]);
  assert.deepEqual(pills, []);
});

test("long titles and artists are truncated", () => {
  const [pill] = nowPlayingPills({ title: "A".repeat(40), artist: "B".repeat(25), playing: true }, []);
  assert.equal(pill.value, "A".repeat(29) + "… · " + "B".repeat(19) + "…");
});
