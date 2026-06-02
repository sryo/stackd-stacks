// Session restore — port of restore.lua (layout only; snapshot rehydration
// is deferred along with the snapshot system).
//
// Save shape:
//   { spaces: { "<spaceId>": [{ bundleId, title, weight }, ...], ... } }
// Saved/loaded via sd.settings; the Lua used hs.settings which maps cleanly.

import { sd } from "sd://runtime/api.js";
import { cfg } from "./config.js";
import { state } from "./core.js";

const TITLE_HINT_LEN = 40;
const SAVE_DEBOUNCE = 500;
let saveTimer = null;

function titleHint(t) {
  return (t || "").slice(0, TITLE_HINT_LEN);
}

function bundleIdOf(win) {
  return win && (win.bundleId || win.app);
}

async function writeSync() {
  const payload = { spaces: {} };
  for (const spaceId of Object.keys(state.windowOrderBySpace)) {
    const order = state.windowOrderBySpace[spaceId] || [];
    const slots = [];
    for (const id of order) {
      const w = state.windowsById[id];
      const bid = bundleIdOf(w);
      if (!w || !bid) continue;
      slots.push({
        bundleId: bid,
        title: titleHint(w.title),
        weight: state.windowWeights[id] ?? cfg.widthDefault
      });
    }
    if (slots.length > 0) payload.spaces[String(spaceId)] = slots;
  }
  await sd.settings.set("layout", payload);
}

export function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; writeSync(); }, SAVE_DEBOUNCE);
}

export async function loadLayout() {
  const saved = await sd.settings.get("layout");
  if (!saved || !saved.spaces) return;
  for (const spaceKey of Object.keys(saved.spaces)) {
    const spaceId = Number(spaceKey);
    const slots = saved.spaces[spaceKey];
    const liveOrder = state.windowOrderBySpace[spaceId];
    if (!liveOrder || liveOrder.length === 0 || !Array.isArray(slots)) continue;

    const claimed = new Set();
    const matched = [];
    for (const slot of slots) {
      let pick = null;
      const targetBid = slot.bundleId;
      const hint = slot.title || "";
      // First pass: bundleId + title hint match.
      if (hint !== "") {
        for (const id of liveOrder) {
          if (claimed.has(id)) continue;
          const w = state.windowsById[id];
          if (!w) continue;
          if (bundleIdOf(w) !== targetBid) continue;
          if (titleHint(w.title) === hint) { pick = w; break; }
        }
      }
      // Second pass: bundleId only.
      if (!pick) {
        for (const id of liveOrder) {
          if (claimed.has(id)) continue;
          const w = state.windowsById[id];
          if (!w) continue;
          if (bundleIdOf(w) !== targetBid) continue;
          pick = w; break;
        }
      }
      if (pick) {
        claimed.add(pick.id);
        matched.push({ id: pick.id, weight: slot.weight });
      }
    }
    const newOrder = [];
    for (const m of matched) {
      newOrder.push(m.id);
      if (m.weight != null) state.windowWeights[m.id] = m.weight;
    }
    for (const id of liveOrder) {
      if (!claimed.has(id)) newOrder.push(id);
    }
    state.windowOrderBySpace[spaceId] = newOrder;
  }
}
