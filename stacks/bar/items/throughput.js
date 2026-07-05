import { sd } from "sd://runtime/api.js";

let cached = "";
let unsub = null;

function human(n) {
  if (n < 1024) return `${Math.round(n)}`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}k`;
  return `${(n / (1024 * 1024)).toFixed(1)}M`;
}

export default {
  id: "throughput",
  side: "right",
  order: 60,
  interval: 0,
  defaultEnabled: false,
  setup(refresh) {
    // Daemon owns the netstat scrape + diff math (sd.net.throughput,
    // polled 1s). We just format the rate and refresh the bar.
    unsub = sd.net.throughput.subscribe((t) => {
      if (!t) return;
      const val = `{sf:arrow.up} ${human(t.txBps)} {sf:arrow.down} ${human(t.rxBps)}`;
      if (val !== cached) { cached = val; refresh(); }
    });
  },
  teardown() {
    if (unsub) { unsub(); unsub = null; }
    cached = "";
  },
  update() { return cached; }
};
