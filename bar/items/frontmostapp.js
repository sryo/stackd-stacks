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
  update() { return cached; },
  // Click → open the Palette tucked under the menubar. Palette handles
  // the bang via window.onBang_palette_open and picks its anchored
  // placement instead of mouse-centered.
  onClick() { sd.bang("palette.open", { under: "bar" }); }
};
