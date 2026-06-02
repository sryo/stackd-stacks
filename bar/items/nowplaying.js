import { sd } from "sd://runtime/api.js";

// Rebar's nowplaying drove this via osascript against Spotify / Music, gated
// on whether either app was running. sd.media.nowPlaying is broader — it
// surfaces *any* MediaRemote producer (browser audio, Podcasts, third-party
// players) without launching the source app. We keep Rebar's format
// ("title · artist") and its "hide while paused" behavior so the bar reads
// the same; the broader source coverage is a free upgrade.

let cached = "";

export default {
  id: "nowplaying",
  side: "center-left",
  order: 50,
  interval: 0,
  setup(refresh) {
    sd.media.nowPlaying.subscribe((m) => {
      if (!m || !m.title || m.playing === false) {
        cached = ""; refresh(); return;
      }
      cached = m.artist ? `${m.title} · ${m.artist}` : m.title;
      refresh();
    });
  },
  update() { return cached; },
  onClick() { sd.media.command("toggle"); }
};
