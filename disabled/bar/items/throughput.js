import { sd } from "sd://runtime/api.js";

function human(n) {
  if (n < 1024) return `${Math.round(n)}`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}k`;
  return `${(n / (1024 * 1024)).toFixed(1)}M`;
}

export default {
  id: "throughput",
  side: "right",
  order: 60,
  defaultEnabled: false,
  setup(set) {
    return sd.net.throughput.subscribe((t) => {
      if (t) set(`{sf:arrow.up} ${human(t.txBps)} {sf:arrow.down} ${human(t.rxBps)}`);
    });
  }
};
