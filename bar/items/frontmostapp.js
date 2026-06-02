import { sd } from "sd://runtime/api.js";

let cached = "";

export default {
  id: "frontmostapp",
  side: "left",
  order: 10,
  interval: 0,
  bold: true,
  setup(refresh) {
    sd.app.frontmost.subscribe((a) => {
      cached = (a && a.name) || "";
      refresh();
    });
  },
  update() { return cached; }
};
