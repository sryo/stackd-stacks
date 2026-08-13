// Pure per-tick decision core for AppTimeout. No sd.* access — index.html
// feeds it channel snapshots and executes the returned actions, so the
// whole kill policy is unit-testable with plain node (tests/logic.test.mjs).

export const CHECK_INTERVAL_MS = 10_000;
export const TIMEOUT_S         = 300;

// Loop-stop: an app killed repeatedly (a background service respawns it
// windowless faster than we monitor) is given up on for the session, so
// we stop fighting it. Session-only and deliberately separate from the
// persisted `ignored` allowlist — a safety valve, not a user decision.
export const KILL_WINDOW_S = 15 * 60;
export const KILL_LIMIT    = 3;

// A real, killable app is a `.app` bundle. XPC service helpers live in
// `.xpc` bundles (inside frameworks) and must never be auto-closed.
// bundleURL comes from sd.apps.running (daemon exposes it for this).
export const isApp = (app) => typeof app.bundleURL === "string" && app.bundleURL.endsWith(".app");

const isCandidate = (a) => !!a.bundleId && a.activationPolicy === "regular" && isApp(a);

// One monitoring pass. `state` is owned by the caller and mutated in place:
//   windowlessSince: Map bundleId → epoch seconds the countdown started
//   windowedPids:    Set pids seen with ≥1 window this session
//   killLog:         Map bundleId → [epoch seconds of recent kills]
//   gaveUp:          Set bundleIds we've stopped auto-closing
// Inputs: apps = sd.apps.running snapshot, wins = sd.windows.all snapshot,
// ignored = persisted protect-list, now = epoch seconds, bootS = stack boot.
// Returns { blind, kills, monitoring, stopped, gaveUpNow } — kills carry
// { bundleId, name }, the rest are display names for logging.
export function tick(state, { apps, wins, ignored, now, bootS }) {
  const { windowlessSince, windowedPids, killLog, gaveUp } = state;

  // Count by PID rather than display name. kCGWindowOwnerName (what
  // sd.windows.all surfaces as `w.app`) is the *process* name —
  // "Code" for VS Code, "Electron Helper" for some Electron apps —
  // while sd.apps.running's `name` is NSRunningApplication.localizedName
  // ("Visual Studio Code"). Matching on names misses windows for any
  // app where the two diverge and the app would be wrongly considered
  // windowless, then killed mid-session.
  const winCount = new Map();
  for (const w of wins) winCount.set(w.pid, (winCount.get(w.pid) || 0) + 1);

  // Track which processes have ever presented a window this session, and
  // forget dead pids. Only apps that showed a window are candidates for
  // auto-close — a background respawn (new pid, never a window) is left
  // alone, which is what stops the kill/respawn loop.
  for (const pid of winCount.keys()) windowedPids.add(pid);
  const livePids = new Set(apps.map((a) => a.pid));
  for (const pid of windowedPids) if (!livePids.has(pid)) windowedPids.delete(pid);

  // Blind-observer gate. The daemon's window list needs AX to classify
  // windows as standard; while the session is locked (or AX is slammed,
  // e.g. a daemon boot behind the lock screen) every window fails that
  // probe and sd.windows.all comes back EMPTY — every app "looks"
  // windowless even though nothing changed. Zero standard windows across
  // every running regular app is that failure signature, not a desktop
  // state worth acting on. On a blind tick: no countdown starts and no
  // kill executes, but existing countdowns keep aging on wall clock —
  // a genuinely windowless app still dies on schedule, its kill just
  // waits for the first sighted tick that can confirm it's still
  // windowless. An app whose windows were merely invisible gets cleared
  // by that same sighted tick instead of killed. Trade-off: if the user
  // really closes every window of every app at once, cleanup stalls
  // until some window appears — acceptable next to a mass-kill.
  const blind = wins.length === 0 && apps.some(isCandidate);
  if (blind) {
    // Apps channel stays live while blind — still drop entries whose
    // app quit entirely so a relaunch later restarts from zero.
    const running = new Set(apps.map((a) => a.bundleId).filter(Boolean));
    for (const bundleId of windowlessSince.keys()) {
      if (!running.has(bundleId)) windowlessSince.delete(bundleId);
    }
    return { blind, kills: [], monitoring: [], stopped: [], gaveUpNow: [] };
  }

  const kills = [], monitoring = [], stopped = [], gaveUpNow = [];
  const seen = new Set();
  for (const app of apps) {
    // Skipping bundleId-less apps also avoids sd.apps.kill(undefined).
    if (!app.bundleId || ignored[app.bundleId] !== undefined) continue;
    // Equivalent to Hammerspoon's app:kind() == 1: skip accessory
    // (LSUIElement) and prohibited (XPC helper) processes so we don't
    // try to kill Browser Helper / sandbox brokers / etc.
    if (app.activationPolicy !== "regular") continue;
    // Only real .app bundles. XPC service helpers (openAndSavePanelService,
    // QuickLookUIService) live in .xpc bundles and briefly flip to .regular
    // while presenting a panel, so activationPolicy alone lets them through.
    if (!isApp(app)) continue;
    seen.add(app.bundleId);
    const count = winCount.get(app.pid) || 0;
    const isFrontmost = !!app.active;

    // Candidates for auto-close: the process showed a window this session
    // (user actually used it), OR it was already running before this stack
    // booted (left over from before a restart — Preview sat windowless
    // across several reloads and was never cleaned up). What stays gated:
    // a process that LAUNCHED after boot and never presented a window —
    // that's a background service respawn (the Claude kill-loop).
    const preBoot = typeof app.launchedAt === "number" && app.launchedAt < bootS;
    if (count === 0 && !isFrontmost && (windowedPids.has(app.pid) || preBoot) && !gaveUp.has(app.bundleId)) {
      if (!windowlessSince.has(app.bundleId)) {
        windowlessSince.set(app.bundleId, now);
        monitoring.push(app.name);
      } else if (now - windowlessSince.get(app.bundleId) >= TIMEOUT_S) {
        kills.push({ bundleId: app.bundleId, name: app.name });
        windowlessSince.delete(app.bundleId);
        // Give up on an app we keep having to kill — something is
        // respawning it, and fighting that is worse than leaving it.
        const hits = (killLog.get(app.bundleId) || []).filter((t) => now - t < KILL_WINDOW_S);
        hits.push(now);
        killLog.set(app.bundleId, hits);
        if (hits.length >= KILL_LIMIT) {
          gaveUp.add(app.bundleId);
          gaveUpNow.push({ name: app.name, hits: hits.length });
        }
      }
    } else if (windowlessSince.has(app.bundleId)) {
      windowlessSince.delete(app.bundleId);
      stopped.push(app.name);
    }
  }
  // Drop entries whose app quit entirely between ticks.
  for (const bundleId of windowlessSince.keys()) {
    if (!seen.has(bundleId)) windowlessSince.delete(bundleId);
  }
  return { blind, kills, monitoring, stopped, gaveUpNow };
}
