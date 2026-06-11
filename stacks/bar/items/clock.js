import { sd } from "sd://runtime/api.js";

// Matches Rebar's `os.date("%a %b %d  %H:%M")` — e.g. "Mon Jun 01  14:23".
// Locale-aware weekday + month abbreviations (Lua bound LC_TIME to the user
// locale for the same reason); 24h time; two spaces between date and time.
const DATE_OPTS = { weekday: "short", month: "short", day: "2-digit" };
const TIME_OPTS = { hour: "2-digit", minute: "2-digit", hour12: false };

function formatDateLikeStrftime(now) {
  // Intl emits "Mon, Jun 01" by default — strip the comma to match strftime.
  const date = now.toLocaleDateString(undefined, DATE_OPTS).replace(",", "");
  const time = now.toLocaleTimeString(undefined, TIME_OPTS);
  return `${date}  ${time}`;
}

export default {
  id: "clock",
  side: "left",
  order: 30,
  interval: 30,
  update() { return formatDateLikeStrftime(new Date()); },
  onClick() { sd.proc.exec("/usr/bin/open", ["/System/Applications/Calendar.app"]); }
};
