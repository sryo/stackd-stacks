import { sd } from "sd://runtime/api.js";

// Lua reads `transportType` directly off the default output device to decide
// whether to suppress the device-name label (built-in speakers stay
// unlabeled; AirPods / external get a name). sd.audio.output's subscribe
// payload only carries {volume, muted, deviceName}, so we keep a parallel
// `sd.audio.devices` lookup and re-resolve the transport whenever the
// device name changes.

let cached = "";
let transportByName = Object.create(null);
let lastSeenName = null;
let refreshFn = null;

// Strip the user's possessive ("Mateo's AirPods Max" → "AirPods Max").
function trimPossessive(name) {
  if (!name) return "";
  return name.replace(/^[^']+'s\s+/, "");
}

async function refreshTransports() {
  try {
    const list = await sd.audio.devices({ scope: "output" });
    transportByName = Object.create(null);
    for (const d of list || []) {
      if (d && d.name) transportByName[d.name] = d.transportType || null;
    }
    if (refreshFn) refreshFn();
  } catch {
    // ignore — we'll fall back to showing the raw name
  }
}

function recompute(refresh, output) {
  if (!output) { cached = ""; refresh(); return; }

  const name = output.deviceName || "";
  if (name && name !== lastSeenName && !(name in transportByName)) {
    // Unknown device — refresh the lookup, will re-render when it lands.
    lastSeenName = name;
    refreshTransports();
  } else {
    lastSeenName = name;
  }

  const transport = transportByName[name];
  const isBuiltIn = transport === "Built-in" || transport == null;
  const label = isBuiltIn ? "" : trimPossessive(name);

  if (output.muted) {
    cached = label ? `{sf:speaker.slash.fill} ${label} muted` : "{sf:speaker.slash.fill} muted";
    refresh(); return;
  }
  if (output.volume == null) {
    cached = label ? `{sf:speaker.wave.2.fill} ${label}` : "{sf:speaker.wave.2.fill}";
    refresh(); return;
  }
  // CoreAudio's virtual main volume is 0..1; show it as a percentage.
  const pct = Math.round(output.volume * 100);
  cached = label ? `{sf:speaker.wave.2.fill} ${label} ${pct}%` : `{sf:speaker.wave.2.fill} ${pct}%`;
  refresh();
}

export default {
  id: "volume",
  side: "right",
  order: 65,
  interval: 0,
  setup(refresh) {
    refreshFn = refresh;
    refreshTransports();
    sd.audio.output.subscribe((o) => recompute(refresh, o));
  },
  teardown() { refreshFn = null; },
  update() { return cached; }
};
