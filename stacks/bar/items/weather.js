import { sd } from "sd://runtime/api.js";

let cached = "";

// wttr.in's %c is a condition emoji; swap the known set for SF tokens so
// the bar renders a tinted template glyph instead of a color emoji.
// Unknown conditions fall through as-is (better an emoji than a blank).
const WTTR_SF = {
  "☀": "sun.max",        "⛅": "cloud.sun",      "☁": "cloud",
  "🌫": "cloud.fog",      "🌦": "cloud.sun.rain", "🌧": "cloud.rain",
  "⛈": "cloud.bolt.rain", "🌩": "cloud.bolt",     "🌨": "cloud.snow",
  "❄": "snowflake",       "🌪": "tornado"
};
function iconize(s) {
  return s.replace(/\uFE0F/g, "")   // strip emoji variation selectors first
          .replace(/[☀⛅☁🌫🌦🌧⛈🌩🌨❄🌪]/gu, (e) => WTTR_SF[e] ? `{sf:${WTTR_SF[e]}}` : e);
}

async function fetchOnce(refresh) {
  const r = await sd.proc.exec("/bin/sh", [
    "-c",
    "curl -s --max-time 5 'wttr.in/?format=%t+%c' 2>/dev/null | tr -d '\\n'"
  ]);
  const val = iconize((r && r.stdout || "").trim());
  if (val !== cached) { cached = val; refresh(); }
}

export default {
  id: "weather",
  side: "left",
  order: 40,
  interval: 600,
  defaultEnabled: true,
  // tickItem awaits update() and writes the return value to state.values.
  // The previous shape (`fetchOnce(refresh); return cached;`) returned the
  // STALE empty `cached` before the async fetch resolved → bar wrote "",
  // and the inner refresh() only re-relayout'd against that same empty
  // state.values entry. await fixes it: tickItem sees the post-fetch value.
  async update(refresh) {
    await fetchOnce(refresh);
    return cached;
  },
  onClick: "open -a Weather"
};
