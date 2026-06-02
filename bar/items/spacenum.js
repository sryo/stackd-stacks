import { sd } from "sd://runtime/api.js";

let cached = "";

export default {
  id: "spacenum",
  side: "left",
  order: 50,
  interval: 0,
  setup(refresh) {
    sd.spaces.all.subscribe((all) => {
      if (!all) { cached = ""; refresh(); return; }
      const uuid = sd.screen.current && sd.screen.current.uuid;
      const info = uuid && all[uuid];
      if (!info || !Array.isArray(info.spaces) || info.active == null) {
        cached = ""; refresh(); return;
      }
      const dots = info.spaces.map((id) => (id === info.active ? "●" : "○"));
      cached = dots.join(" ");
      refresh();
    });
  },
  update() { return cached; }
};
