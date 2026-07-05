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
      let info = uuid ? all[uuid] : null;
      // When "Displays have Separate Spaces" is off, the daemon keys the
      // whole payload under the primary display's UUID, so per-display
      // lookups on other displays miss. A single entry means one shared
      // space set — use it.
      if (!info) {
        const keys = Object.keys(all);
        if (keys.length === 1) info = all[keys[0]];
      }
      if (!info || !Array.isArray(info.spaces) || info.active == null) {
        cached = ""; refresh(); return;
      }
      // Hide the indicator when there's only one space — a single ● dot
      // conveys no useful information and just consumes pixels in the bar.
      if (info.spaces.length <= 1) {
        cached = ""; refresh(); return;
      }
      const dots = info.spaces.map((id) => (id === info.active ? "{sf:circle.fill}" : "{sf:circle}"));
      cached = dots.join(" ");
      refresh();
    });
  },
  update() { return cached; }
};
