import { sd } from "sd://runtime/api.js";

let cached = "";

export default {
  id: "battery",
  side: "right",
  order: 50,
  interval: 60,
  setup(refresh) {
    sd.battery.subscribe((b) => {
      if (!b) { cached = ""; refresh(); return; }
      const prefix = b.charging ? "▲ " : "";
      cached = `${prefix}${Math.round(b.percent)}%`;
      refresh();
    });
  },
  update() { return cached; }
};
