import { sd } from "sd://runtime/api.js";

// "offline" when the network path isn't satisfied; otherwise the SSID on
// Wi-Fi ("Wi-Fi" when Location access hides it), "Ethernet" for any other
// wired route. sd.net.path's interfaces[0] is the preferred route.

function label(wifi, lan, path) {
  // An unknown path counts as online so the bar doesn't flash "offline"
  // before NWPathMonitor first publishes.
  if (path && path.status !== "satisfied") return "offline";
  const primary = path && Array.isArray(path.interfaces) ? path.interfaces[0] : null;
  const ssid = wifi && wifi.ssid;
  if (primary === "wifi" || (!primary && ssid)) return ssid || "Wi-Fi";
  if (primary === "wired" || primary === "other" || (lan && lan.ipv4)) return "Ethernet";
  if (primary === "cellular") return "Cellular";
  return "offline";
}

export default {
  id: "network",
  side: "right",
  order: 55,
  setup(set) {
    let wifi = null, lan = null, path = null;
    const update = () => set(label(wifi, lan, path));
    const unsubs = [
      sd.net.wifi.subscribe((w) => { wifi = w; update(); }),
      sd.net.lan.subscribe((l) => { lan = l; update(); }),
      sd.net.path.subscribe((p) => { path = p; update(); })
    ];
    return () => unsubs.forEach((u) => u());
  }
};
