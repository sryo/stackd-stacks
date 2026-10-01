import { sd } from "sd://runtime/api.js";

export default {
  id: "battery",
  side: "right",
  order: 50,
  setup(set) {
    return sd.battery.subscribe((b) => {
      set(b ? `${b.charging ? "{sf:bolt.fill} " : ""}${Math.round(b.percent)}%` : "");
    });
  }
};
