import { sd } from "sd://runtime/api.js";

export default {
  id: "brightness",
  side: "right",
  order: 70,
  setup(set) {
    return sd.display.all.subscribe((displays) => {
      if (!Array.isArray(displays)) return;
      const uuid = sd.screen.current && sd.screen.current.uuid;
      const here = displays.find((d) => d.uuid === uuid) || displays[0];
      set(here && here.brightness != null ? `{sf:sun.max} ${Math.round(here.brightness * 100)}%` : "");
    });
  }
};
