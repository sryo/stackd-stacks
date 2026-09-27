import { sd } from "sd://runtime/api.js";

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
  return s.replace(/️/g, "")   // strip emoji variation selectors first
          .replace(/[☀⛅☁🌫🌦🌧⛈🌩🌨❄🌪]/gu, (e) => WTTR_SF[e] ? `{sf:${WTTR_SF[e]}}` : e);
}

async function fetchWeather() {
  const r = await sd.proc.exec("/usr/bin/curl", ["-s", "--max-time", "5", "wttr.in/?format=%t+%c"]);
  return iconize(((r && r.code === 0 && r.stdout) || "").replace(/\n/g, "").trim());
}

export default {
  id: "weather",
  side: "left",
  order: 40,
  setup(set) {
    const tick = () => fetchWeather().then(set, (e) => console.error("weather: fetch", e));
    tick();
    const h = setInterval(tick, 10 * 60 * 1000);
    return () => clearInterval(h);
  },
  onClick() {
    sd.proc.exec("/usr/bin/open", ["-a", "Weather"]).catch((e) => console.error("weather: open", e));
  }
};
