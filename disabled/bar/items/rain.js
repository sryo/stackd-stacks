import { sd } from "sd://runtime/api.js";
import { rainPollDelay } from "../logic.js";

const RAIN_THRESHOLD_PCT = 50;

function formatLead(hoursAhead) {
  if (hoursAhead < 1) return "{sf:umbrella.fill} now";
  if (hoursAhead < 24) return `{sf:umbrella.fill} ${Math.round(hoursAhead)}h`;
  return `{sf:umbrella.fill} ${Math.round(hoursAhead / 24)}d`;
}

function nextRainHours(j) {
  if (!j || !j.weather) return null;
  const now = Date.now() / 1000;
  for (const day of j.weather) {
    const m = (day.date || "").match(/(\d+)-(\d+)-(\d+)/);
    if (!m) continue;
    const [, Y, Mo, D] = m;
    for (const h of (day.hourly || [])) {
      const t = Number(h.time) || 0;
      // wttr.in hours are local time as HHMM.
      const slot = new Date(Number(Y), Number(Mo) - 1, Number(D), Math.floor(t / 100), t % 100, 0).getTime() / 1000;
      const chance = Number(h.chanceofrain) || 0;
      if (slot >= now && chance >= RAIN_THRESHOLD_PCT) {
        return (slot - now) / 3600;
      }
    }
  }
  return null;
}

// Resolves to the label, or undefined when the forecast couldn't be fetched.
async function fetchRain() {
  const r = await sd.proc.exec("/usr/bin/curl", [
    "-s", "--max-time", "5",
    "-H", "User-Agent: curl/8.0",
    "https://wttr.in/?format=j1"
  ]);
  if (!r || r.code !== 0 || !r.stdout) return undefined;
  const hours = nextRainHours(JSON.parse(r.stdout));
  return hours == null ? "" : formatLead(hours);
}

export default {
  id: "rain",
  side: "left",
  order: 45,
  setup(set) {
    let timer = null, stopped = false;
    async function poll() {
      let label;
      try { label = await fetchRain(); } catch (e) { console.error("rain: fetch", e); }
      if (stopped) return;
      if (label !== undefined) set(label);
      timer = setTimeout(poll, rainPollDelay(label !== undefined));
    }
    poll();
    return () => { stopped = true; clearTimeout(timer); };
  },
  onClick() {
    sd.proc.exec("/usr/bin/open", ["-a", "Weather"]).catch((e) => console.error("rain: open", e));
  }
};
