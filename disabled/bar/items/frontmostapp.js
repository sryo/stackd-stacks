import { sd } from "sd://runtime/api.js";

export default {
  id: "frontmostapp",
  side: "left",
  order: 10,
  bold: true,
  setup(set) {
    return sd.app.frontmost.subscribe((a) => set((a && a.name) || ""));
  },
  // Opens the Palette tucked under the menu bar instead of centered on the
  // mouse.
  onClick() { sd.bang("palette.open", { under: "bar" }); }
};
