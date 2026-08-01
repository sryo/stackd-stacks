// Frecency store (port of recents.lua). Settings key matches the HS spoon
// (recents.lua:7) so the user's Hammerspoon frecency carries over on first
// run. 30-day sliding window; count/recency score.
import { sd } from "sd://runtime/api.js";

let data = null;

async function load() {
  if (data) return;
  data = (await sd.settings.get("paletteUsageData")) || {};
}
async function save() { await sd.settings.set("paletteUsageData", data); }

export const recents = {
  async init() {
    await load();
    const cutoff = Date.now() / 1000 - 30 * 86400;
    let changed = false;
    for (const src in data) {
      for (const id in data[src]) {
        if (data[src][id].lastUsed < cutoff) {
          delete data[src][id]; changed = true;
        }
      }
      if (Object.keys(data[src]).length === 0) { delete data[src]; changed = true; }
    }
    if (changed) await save();
  },
  record(src, id) {
    if (!src || !id) return;
    data[src] = data[src] || {};
    const e = data[src][id] = data[src][id] || { count: 0, lastUsed: 0 };
    e.count += 1;
    e.lastUsed = Math.floor(Date.now() / 1000);
    save();
  },
  score(src, id) {
    if (!data) return 0;
    const e = data[src] && data[src][id];
    if (!e) return 0;
    const recency = Math.floor(Date.now() / 1000) - e.lastUsed;
    return e.count * 1000000 / (recency + 1);
  },
  entries(src) {
    return (data && data[src]) || {};
  },
  forget(src, id) {
    if (!data || !data[src] || !data[src][id]) return;
    delete data[src][id];
    if (Object.keys(data[src]).length === 0) delete data[src];
    save();
  }
};
