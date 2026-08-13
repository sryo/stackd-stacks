// Fence for AppTimeout's per-tick kill policy — especially the
// blind-observer gate: when the daemon boots behind the lock screen, AX
// probes fail and sd.windows.all comes back empty, making every running
// app look windowless. Pre-gate, five minutes of that killed Arc, Terminal,
// anything regular. The invariant under test: no countdown STARTS and no
// kill EXECUTES on a tick whose window snapshot is blind, while countdowns
// keep aging so genuinely windowless apps still die on schedule at the
// first sighted tick.
import test from "node:test";
import assert from "node:assert/strict";
import { tick, TIMEOUT_S, KILL_LIMIT } from "../logic.js";

const BOOT = 1000;

function freshState() {
  return {
    windowlessSince: new Map(),
    windowedPids: new Set(),
    killLog: new Map(),
    gaveUp: new Set(),
  };
}

function app(name, { pid, active = false, launchedAt = BOOT - 100, policy = "regular", url } = {}) {
  return {
    name,
    bundleId: `com.test.${name.toLowerCase()}`,
    pid,
    active,
    launchedAt,
    activationPolicy: policy,
    bundleURL: url !== undefined ? url : `/Applications/${name}.app`,
  };
}

const win = (pid) => ({ pid });

function run(state, { apps, wins, now, ignored = {} }) {
  return tick(state, { apps, wins, ignored, now, bootS: BOOT });
}

// ── normal (sighted) operation ───────────────────────────────────────────

test("windowless non-frontmost app is monitored, then killed after TIMEOUT_S", () => {
  const state = freshState();
  const arc = app("Arc", { pid: 10 });
  const finder = app("Finder", { pid: 20 });

  let r = run(state, { apps: [arc, finder], wins: [win(10), win(20)], now: BOOT });
  assert.deepEqual(r.monitoring, [], "windowed apps are not monitored");

  r = run(state, { apps: [arc, finder], wins: [win(20)], now: BOOT + 10 });
  assert.deepEqual(r.monitoring, ["Arc"]);
  assert.deepEqual(r.kills, [], "monitoring starts a countdown, not a kill");

  r = run(state, { apps: [arc, finder], wins: [win(20)], now: BOOT + 10 + TIMEOUT_S });
  assert.deepEqual(r.kills, [{ bundleId: "com.test.arc", name: "Arc" }]);
  assert.equal(state.windowlessSince.size, 0, "killed app leaves the countdown map");
});

test("regaining a window (or frontmost) cancels the countdown", () => {
  const state = freshState();
  const arc = app("Arc", { pid: 10 });

  run(state, { apps: [arc], wins: [win(10)], now: BOOT });
  // A second app's window keeps the tick sighted while Arc goes windowless.
  const other = app("Other", { pid: 99 });
  run(state, { apps: [arc, other], wins: [win(99)], now: BOOT + 10 });
  assert.ok(state.windowlessSince.has("com.test.arc"));

  const r = run(state, { apps: [arc, other], wins: [win(10), win(99)], now: BOOT + 20 });
  assert.deepEqual(r.stopped, ["Arc"]);
  assert.deepEqual(r.kills, []);
});

test("ignored, non-regular, non-.app, and frontmost apps are never candidates", () => {
  const state = freshState();
  const shown = [
    app("Prot", { pid: 1 }),
    app("Helper", { pid: 2, policy: "accessory" }),
    app("Xpc", { pid: 3, url: "/S/L/F/Foo.framework/x.xpc" }),
    app("Front", { pid: 4, active: true }),
  ];
  // Give every pid a window first so windowedPids qualifies them all.
  run(state, { apps: shown, wins: shown.map((a) => win(a.pid)), now: BOOT });

  const r = run(state, {
    apps: shown,
    wins: [win(99)],  // some unrelated window keeps the tick sighted
    now: BOOT + 10,
    ignored: { "com.test.prot": "Prot" },
  });
  assert.deepEqual(r.monitoring, []);
});

test("launched-after-boot process that never showed a window is left alone", () => {
  const state = freshState();
  const respawn = app("Ghost", { pid: 30, launchedAt: BOOT + 5 });
  const other = app("Other", { pid: 99 });

  const r = run(state, { apps: [respawn, other], wins: [win(99)], now: BOOT + 10 });
  assert.deepEqual(r.monitoring, [], "background respawn is not a candidate");
});

test("pre-boot windowless leftover IS a candidate", () => {
  const state = freshState();
  const leftover = app("Preview", { pid: 40, launchedAt: BOOT - 500 });
  const other = app("Other", { pid: 99 });

  const r = run(state, { apps: [leftover, other], wins: [win(99)], now: BOOT + 10 });
  assert.deepEqual(r.monitoring, ["Preview"]);
});

test("KILL_LIMIT kills inside the window flips the app to gaveUp", () => {
  const state = freshState();
  const other = app("Other", { pid: 99 });
  let now = BOOT;
  for (let i = 0; i < KILL_LIMIT; i++) {
    const ghost = app("Ghost", { pid: 50 + i, launchedAt: BOOT - 500 });
    run(state, { apps: [ghost, other], wins: [win(99)], now });
    now += TIMEOUT_S;
    const r = run(state, { apps: [ghost, other], wins: [win(99)], now });
    assert.equal(r.kills.length, 1, `kill #${i + 1}`);
    if (i === KILL_LIMIT - 1) assert.equal(r.gaveUpNow.length, 1);
    now += 10;
  }
  const ghost = app("Ghost", { pid: 60, launchedAt: BOOT - 500 });
  const r = run(state, { apps: [ghost, other], wins: [win(99)], now });
  assert.deepEqual(r.monitoring, [], "gaveUp app is never monitored again");
});

// ── the blind-observer gate ──────────────────────────────────────────────

test("blind tick: zero windows anywhere starts no countdowns", () => {
  const state = freshState();
  const arc = app("Arc", { pid: 10, launchedAt: BOOT - 500 });
  const term = app("Terminal", { pid: 11, launchedAt: BOOT - 500 });

  const r = run(state, { apps: [arc, term], wins: [], now: BOOT });
  assert.equal(r.blind, true);
  assert.deepEqual(r.monitoring, []);
  assert.equal(state.windowlessSince.size, 0);
});

test("blind tick: an expired countdown is NOT executed, and the entry survives", () => {
  const state = freshState();
  const arc = app("Arc", { pid: 10 });
  const other = app("Other", { pid: 99 });

  run(state, { apps: [arc, other], wins: [win(99)], now: BOOT });          // monitor Arc
  const r = run(state, { apps: [arc, other], wins: [], now: BOOT + TIMEOUT_S + 60 });
  assert.equal(r.blind, true);
  assert.deepEqual(r.kills, [], "no kill may be decided on blind data");
  assert.ok(state.windowlessSince.has("com.test.arc"), "countdown keeps aging");
});

test("first sighted tick after blind expiry: windowed app is cleared, not killed", () => {
  const state = freshState();
  const arc = app("Arc", { pid: 10 });
  const other = app("Other", { pid: 99 });

  run(state, { apps: [arc, other], wins: [win(99)], now: BOOT });          // monitor Arc
  run(state, { apps: [arc, other], wins: [], now: BOOT + TIMEOUT_S + 60 }); // blind, expired
  const r = run(state, { apps: [arc, other], wins: [win(10), win(99)], now: BOOT + TIMEOUT_S + 70 });
  assert.deepEqual(r.kills, []);
  assert.deepEqual(r.stopped, ["Arc"], "its windows were merely invisible — clear the countdown");
});

test("first sighted tick after blind expiry: still-windowless app dies on schedule", () => {
  const state = freshState();
  const arc = app("Arc", { pid: 10 });
  const other = app("Other", { pid: 99 });

  run(state, { apps: [arc, other], wins: [win(99)], now: BOOT });          // monitor Arc
  run(state, { apps: [arc, other], wins: [], now: BOOT + TIMEOUT_S + 60 }); // blind, expired
  const r = run(state, { apps: [arc, other], wins: [win(99)], now: BOOT + TIMEOUT_S + 70 });
  assert.deepEqual(r.kills, [{ bundleId: "com.test.arc", name: "Arc" }],
    "the countdown never paused — the kill just waited for sighted confirmation");
});

test("blind tick still prunes countdowns for apps that quit", () => {
  const state = freshState();
  const arc = app("Arc", { pid: 10 });
  const other = app("Other", { pid: 99 });

  run(state, { apps: [arc, other], wins: [win(99)], now: BOOT });          // monitor Arc
  const r = run(state, { apps: [other], wins: [], now: BOOT + 20 });        // Arc quit; tick blind
  assert.equal(r.blind, true);
  assert.equal(state.windowlessSince.size, 0, "quit app leaves the map even while blind");
});

test("empty desktop with no regular apps running is not 'blind'", () => {
  const state = freshState();
  const helper = app("Helper", { pid: 2, policy: "accessory" });
  const r = run(state, { apps: [helper], wins: [], now: BOOT });
  assert.equal(r.blind, false, "nothing killable running — emptiness is meaningless, not blindness");
});
