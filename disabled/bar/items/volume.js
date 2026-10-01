import { sd } from "sd://runtime/api.js";
import { volumeLabel } from "../logic.js";

// sd.audio.output carries { volume, muted, deviceName } but not the
// transport, so the device list is looked up again whenever a device name
// appears that the last lookup didn't cover (once per name).

export default {
  id: "volume",
  side: "right",
  order: 65,
  setup(set) {
    let transportByName = Object.create(null);
    let output = null;
    let lookedUp = null;
    const update = () => set(volumeLabel(output, output && transportByName[output.deviceName]));

    async function loadTransports() {
      try {
        const list = await sd.audio.devices({ scope: "output" });
        transportByName = Object.create(null);
        for (const d of list || []) {
          if (d && d.name) transportByName[d.name] = d.transportType || null;
        }
        update();
      } catch (e) {
        console.error("volume: audio devices", e);
      }
    }

    loadTransports();
    return sd.audio.output.subscribe((o) => {
      output = o;
      const name = o && o.deviceName;
      if (name && name !== lookedUp && !(name in transportByName)) {
        lookedUp = name;
        loadTransports();
      }
      update();
    });
  }
};
