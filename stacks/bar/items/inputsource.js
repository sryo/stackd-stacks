import { sd } from "sd://runtime/api.js";

const KNOWN = {
  "U.S.":                 "US",
  "U.S. International":   "US",
  "ABC":                  "US",
  "British":              "UK",
  "Spanish":              "ES",
  "Spanish - ISO":        "ES",
  "Latin American":       "LA",
  "French":               "FR",
  "French - Numerical":   "FR",
  "German":               "DE",
  "Italian":              "IT",
  "Portuguese":           "PT",
  "Dutch":                "NL"
};

let cached = "";

export default {
  id: "inputsource",
  side: "right",
  order: 75,
  interval: 0,
  setup(refresh) {
    sd.input.layout.subscribe((info) => {
      const layout = info && (info.layout || info.name);
      if (!layout) { cached = ""; refresh(); return; }
      if (KNOWN[layout]) { cached = KNOWN[layout]; refresh(); return; }
      cached = layout.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase();
      refresh();
    });
  },
  update() { return cached; }
};
