import { sd } from "sd://runtime/api.js";

let cached = "";

async function fetchOnce(refresh) {
  const r = await sd.proc.exec("/bin/sh", [
    "-c",
    "curl -s --max-time 5 'wttr.in/?format=%t+%c' 2>/dev/null | tr -d '\\n'"
  ]);
  const val = (r && r.stdout || "").trim();
  if (val !== cached) { cached = val; refresh(); }
}

export default {
  id: "weather",
  side: "left",
  order: 40,
  interval: 600,
  defaultEnabled: true,
  // tickItem awaits update() and writes the return value to state.values.
  // The previous shape (`fetchOnce(refresh); return cached;`) returned the
  // STALE empty `cached` before the async fetch resolved → bar wrote "",
  // and the inner refresh() only re-relayout'd against that same empty
  // state.values entry. await fixes it: tickItem sees the post-fetch value.
  async update(refresh) {
    await fetchOnce(refresh);
    return cached;
  },
  onClick: "open -a Weather"
};
