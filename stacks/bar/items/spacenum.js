import { sd } from "sd://runtime/api.js";

export default {
  id: "spacenum",
  side: "left",
  order: 50,
  setup(set) {
    return sd.spaces.all.subscribe((all) => {
      if (!all) { set(""); return; }
      const uuid = sd.screen.current && sd.screen.current.uuid;
      let info = uuid ? all[uuid] : null;
      // With "Displays have Separate Spaces" off, the daemon keys the one
      // shared space set under the primary display's UUID.
      if (!info) {
        const keys = Object.keys(all);
        if (keys.length === 1) info = all[keys[0]];
      }
      // A single space gets no indicator.
      if (!info || !Array.isArray(info.spaces) || info.active == null || info.spaces.length <= 1) {
        set(""); return;
      }
      set(info.spaces.map((id) => (id === info.active ? "{sf:circle.fill}" : "{sf:circle}")).join(" "));
    });
  }
};
