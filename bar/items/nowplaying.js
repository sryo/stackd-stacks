import { sd } from "sd://runtime/api.js";

// Now-playing pills, hybrid of two sources:
//
//   - sd.media.nowPlaying: rich active-player metadata (title/artist).
//     Driven by MediaRemote + Spotify osascript fallback.
//   - sd.audio.processes: every process producing audio right now, via
//     CoreAudio process objects. Renders as bare secondary pills (app
//     name) for any app that ISN'T the active rich pill.
//
// Active pill click → global toggle. Secondary pill click → focus that app
// (per-app MediaRemote dispatch isn't reachable from our daemon, so
// "bring it forward and let the user control it" is best-effort).
//
// Browser pause lag (~10s on Arc / Chrome / Safari) is the browser's
// stream-release timeout — CoreAudio's IsRunningOutput stays true until
// the app actually closes the output stream. Apple's Control Center hides
// this by using MediaRemote (gated for non-com.apple.* bundles). Accepted.

const PREFIX     = "nowplaying:";
const ACTIVE_ID  = PREFIX + "_active";
const tracked    = new Map();   // bar-item id → last value

let activeSnap  = null;
let procsSnap   = [];

function truncate(s, n) {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function appNameFor(bundleId, fallbackName) {
  // Daemon reads CFBundleDisplayName / CFBundleName from the resolved
  // top-level .app's Info.plist (helpers walk up to their parent first),
  // so the fallback name covers every app without a hardcoded table.
  if (fallbackName) return fallbackName;
  const tail = (bundleId || "").split(".").pop() || "App";
  return tail.charAt(0).toUpperCase() + tail.slice(1);
}

function activeSpec(m) {
  if (!m || (!m.title && m.playing === false)) return null;
  const title  = truncate(m.title || "", 30);
  const artist = m.artist ? truncate(m.artist, 20) : null;
  if (!title && !artist) return null;
  return { id: ACTIVE_ID, value: artist ? `${title} · ${artist}` : title };
}

const HIDE_BUNDLES = new Set([
  null, "", "com.mateoyadarola.stackd", "stackd",
  "com.apple.coreaudiod", "com.apple.audio.coreaudiod"
]);
function shouldRenderProcess(p, activeTitle) {
  if (!p || !p.playingOutput) return false;
  if (HIDE_BUNDLES.has(p.bundleId)) return false;
  // Skip the secondary that matches the active rich pill so we don't
  // double up. activeSnap doesn't carry a bundleId, so we match on the
  // app name returned by NSRunningApplication.localizedName.
  if (activeTitle && p.name && p.name === activeTitle) return false;
  return true;
}

function secondarySpec(p) {
  return {
    id:    PREFIX + (p.bundleId || `pid-${p.pid}`),
    value: appNameFor(p.bundleId, p.name)
  };
}

sd.bang.declare("nowplaying.toggle").on((detail) => {
  if (!detail || typeof detail.id !== "string") return;
  if (detail.id === ACTIVE_ID) { sd.media.command("toggle"); return; }
  if (!detail.id.startsWith(PREFIX)) return;
  const tail = detail.id.slice(PREFIX.length);
  if (tail.startsWith("pid-")) return;
  sd.apps.focus(tail);
});

function rerender() {
  const specs = [];
  const active = activeSpec(activeSnap);
  if (active) specs.push(active);
  const activeName = activeSnap && (activeSnap.title || null);
  for (const p of (procsSnap || [])) {
    if (!shouldRenderProcess(p, activeName)) continue;
    specs.push(secondarySpec(p));
  }

  const wanted = new Set(specs.map(s => s.id));
  for (const id of [...tracked.keys()]) {
    if (!wanted.has(id)) {
      sd.bang("bar.unregister", { id });
      tracked.delete(id);
    }
  }

  for (const s of specs) {
    if (tracked.get(s.id) === s.value) continue;
    if (tracked.has(s.id)) {
      sd.bang("bar.update", { id: s.id, value: s.value });
      tracked.set(s.id, s.value);
      continue;
    }
    sd.bang("bar.register", {
      id:          s.id,
      side:        "center-right",
      // Active pill sorts left of secondaries; same-order items break
      // ties by id alphabetically (core.js allItems sort).
      order:       s.id === ACTIVE_ID ? 49 : 50,
      value:       s.value,
      onClickBang: "nowplaying.toggle"
    });
    tracked.set(s.id, s.value);
  }
}

sd.media.nowPlaying.subscribe((m)   => { activeSnap = m || null;                  rerender(); });
sd.audio.processes.subscribe((arr)  => { procsSnap  = Array.isArray(arr) ? arr : []; rerender(); });

export default {
  id: "nowplaying",
  side: "center-right",
  order: 50,
  interval: 0,
  setup() {},
  update() { return ""; }
};
