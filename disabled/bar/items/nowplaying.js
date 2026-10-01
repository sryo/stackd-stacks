import { sd } from "sd://runtime/api.js";
import { nowPlayingPills } from "../logic.js";

// Now-playing pills from two sources:
//
//   - sd.media.nowPlaying: title/artist of the active player.
//   - sd.audio.processes: every process producing audio, shown as bare
//     app-name pills.
//
// Clicking the active pill toggles play/pause; clicking an app pill brings
// that app forward, since per-app media commands aren't reachable.
//
// Browsers keep reporting audio for ~10s after pausing: CoreAudio's
// IsRunningOutput stays true until the browser releases its output stream.

export default {
  id: "nowplaying",
  side: "center-right",
  order: 50,
  setup(_set, bar) {
    const shown = new Map();   // pill id → value
    let media = null, procs = [];

    function render() {
      const pills = nowPlayingPills(media, procs);
      const wanted = new Set(pills.map((p) => p.id));
      for (const id of [...shown.keys()]) {
        if (!wanted.has(id)) { bar.unregister(id); shown.delete(id); }
      }
      for (const p of pills) {
        if (shown.get(p.id) === p.value) continue;
        if (shown.has(p.id)) {
          bar.update(p.id, p.value);
        } else {
          bar.register({
            id: p.id,
            side: "center-right",
            // The active pill sorts left of the app pills.
            order: p.bundleId ? 50 : 49,
            value: p.value,
            onClick: p.bundleId
              ? () => sd.apps.focus(p.bundleId)
              : () => sd.media.command("toggle")
          });
        }
        shown.set(p.id, p.value);
      }
    }

    const unsubs = [
      sd.media.nowPlaying.subscribe((m) => { media = m || null; render(); }),
      sd.audio.processes.subscribe((arr) => { procs = Array.isArray(arr) ? arr : []; render(); })
    ];
    return () => {
      unsubs.forEach((u) => u());
      for (const id of shown.keys()) bar.unregister(id);
    };
  }
};
