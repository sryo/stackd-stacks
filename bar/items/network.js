import { sd } from "sd://runtime/api.js";

// Network status — mirrors Rebar's network.lua:
//   * "offline" when net.path.status is not "satisfied"
//   * SSID when associated; "Wi-Fi" if SSID hidden by Location TCC
//   * "Ethernet" for any other reachable transport
// Rebar layered hs.network.reachability + hs.network.primaryInterfaces +
// hs.wifi.currentNetwork. We replace the first two with sd.net.path (whose
// `interfaces[0]` is the preferred route, same role as primaryInterfaces).

let wifi = null, lan = null, path = null;
let cached = "";

function recompute(refresh) {
  // Treat unknown path as "online" so the bar doesn't flash "offline" during
  // the first few hundred ms before NWPathMonitor publishes.
  const reachable = !path || path.status === "satisfied";
  if (!reachable) { setIf(refresh, "offline"); return; }

  const primary = path && Array.isArray(path.interfaces) ? path.interfaces[0] : null;
  const ssid = wifi && wifi.ssid;

  if (primary === "wifi" || (!primary && ssid)) {
    if (ssid) { setIf(refresh, ssid); return; }
    // wifi.signal != 0 → associated but SSID hidden behind Location TCC.
    if (wifi && wifi.signal != null && wifi.signal !== 0) {
      setIf(refresh, "Wi-Fi"); return;
    }
    setIf(refresh, "Wi-Fi"); return;
  }
  if (primary === "wired" || primary === "other" || (lan && lan.ipv4)) {
    setIf(refresh, "Ethernet"); return;
  }
  if (primary === "cellular") { setIf(refresh, "Cellular"); return; }
  setIf(refresh, "offline");
}

function setIf(refresh, val) {
  if (cached === val) return;
  cached = val;
  refresh();
}

export default {
  id: "network",
  side: "right",
  order: 55,
  interval: 0,
  setup(refresh) {
    sd.net.wifi.subscribe((w) => { wifi = w; recompute(refresh); });
    sd.net.lan.subscribe ((l) => { lan  = l; recompute(refresh); });
    sd.net.path.subscribe((p) => { path = p; recompute(refresh); });
  },
  update() { return cached; }
};
