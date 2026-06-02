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
  defaultEnabled: false,
  update(refresh) { fetchOnce(refresh); return cached; },
  onClick: "open -a Weather"
};
