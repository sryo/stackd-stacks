import { sd } from "sd://runtime/api.js";

// "Mon Jun 01  14:23": locale weekday and month, 24h time, two spaces
// between date and time.
const DATE_OPTS = { weekday: "short", month: "short", day: "2-digit" };
const TIME_OPTS = { hour: "2-digit", minute: "2-digit", hour12: false };

function format(now) {
  const date = now.toLocaleDateString(undefined, DATE_OPTS).replace(",", "");
  const time = now.toLocaleTimeString(undefined, TIME_OPTS);
  return `${date}  ${time}`;
}

export default {
  id: "clock",
  side: "left",
  order: 30,
  setup(set) {
    const tick = () => set(format(new Date()));
    tick();
    const h = setInterval(tick, 30 * 1000);
    return () => clearInterval(h);
  },
  onClick() {
    sd.proc.exec("/usr/bin/open", ["/System/Applications/Calendar.app"])
      .catch((e) => console.error("clock: open Calendar", e));
  }
};
