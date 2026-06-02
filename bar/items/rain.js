import { sd } from "sd://runtime/api.js";

const RAIN_THRESHOLD_PCT = 50;
const POLL_INTERVAL_S = 1800;

let cached = "";
let pollHandle = null;

function formatLead(hoursAhead) {
  if (hoursAhead < 1) return "☔ now";
  if (hoursAhead < 24) return `☔ ${Math.round(hoursAhead)}h`;
  return `☔ ${Math.round(hoursAhead / 24)}d`;
}

function nextRainHours(j) {
  if (!j || !j.weather) return null;
  const now = Date.now() / 1000;
  for (const day of j.weather) {
    const dateStr = day.date || "";
    const m = dateStr.match(/(\d+)-(\d+)-(\d+)/);
    if (!m) continue;
    const [_, Y, Mo, D] = m;
    for (const h of (day.hourly || [])) {
      const t = Number(h.time) || 0;
      const hour = Math.floor(t / 100);
      const min  = t % 100;
      // wttr.in returns local-time hours; Date constructor treats month 0-indexed.
      const slot = new Date(Number(Y), Number(Mo) - 1, Number(D), hour, min, 0).getTime() / 1000;
      const chance = Number(h.chanceofrain) || 0;
      if (slot >= now && chance >= RAIN_THRESHOLD_PCT) {
        return (slot - now) / 3600;
      }
    }
  }
  return null;
}

async function poll(refresh) {
  const r = await sd.proc.exec("/usr/bin/curl", [
    "-s", "--max-time", "5",
    "-H", "User-Agent: curl/8.0",
    "https://wttr.in/?format=j1"
  ]);
  if (!r || r.code !== 0 || !r.stdout) return;
  let j;
  try { j = JSON.parse(r.stdout); } catch { return; }
  const hours = nextRainHours(j);
  const newVal = hours == null ? "" : formatLead(hours);
  if (newVal !== cached) { cached = newVal; refresh(); }
}

export default {
  id: "rain",
  side: "left",
  order: 45,
  interval: 0,
  defaultEnabled: false,
  setup(refresh) {
    poll(refresh);
    pollHandle = setInterval(() => poll(refresh), POLL_INTERVAL_S * 1000);
  },
  teardown() {
    if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
    cached = "";
  },
  update() { return cached; },
  onClick: "open -a Weather"
};
