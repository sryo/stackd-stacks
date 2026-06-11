import { sd } from "sd://runtime/api.js";

let cached = "";

export default {
  id: "brightness",
  side: "right",
  order: 70,
  interval: 0,
  setup(refresh) {
    sd.display.all.subscribe((displays) => {
      if (!Array.isArray(displays)) return;
      const uuid = sd.screen.current && sd.screen.current.uuid;
      const here = displays.find((d) => d.uuid === uuid) || displays[0];
      if (!here || here.brightness == null) { cached = ""; refresh(); return; }
      cached = `☀ ${Math.round(here.brightness * 100)}%`;
      refresh();
    });
  },
  update() { return cached; }
};
