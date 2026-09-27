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

function abbreviate(layout) {
  return KNOWN[layout] || layout.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase();
}

export default {
  id: "inputsource",
  side: "right",
  order: 75,
  setup(set) {
    return sd.input.layout.subscribe((info) => {
      const layout = info && (info.layout || info.name);
      set(layout ? abbreviate(layout) : "");
    });
  }
};
