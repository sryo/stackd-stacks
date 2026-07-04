import { sd } from "sd://runtime/api.js";

import * as claude    from "./claude.js";
import * as openai    from "./openai.js";
import * as gemini    from "./gemini.js";
import * as claudecli from "./claudecli.js";
import * as fabric    from "./fabric.js";
import * as apple     from "./apple.js";

export const backends = { claude, openai, gemini, claudecli, fabric, apple };

// Mirror HS init.lua line 33: default fallback order.
const DEFAULT_FALLBACK = ["claudecli", "claude", "openai", "gemini", "fabric", "apple"];

// Mirror HS init.lua lines 341–364 (chooseBackend):
//   1. Try `preferred` (primary). If available() ok, use it.
//   2. Otherwise walk fallbackOrder, return the first one that's available
//      AND isn't the primary (to avoid double-checking).
//   3. needsVision filters out non-multimodal backends entirely.
//   4. If nothing is available, returns null (caller surfaces guidance).
export async function pick(preferred, opts) {
  const needsVision = !!(opts && opts.needsVision);
  const userOrder   = await sd.settings.get("fallbackOrder");
  const order       = Array.isArray(userOrder) && userOrder.length > 0
                        ? userOrder
                        : DEFAULT_FALLBACK;

  const isOk = async (b) => {
    if (!b) return false;
    if (needsVision && !b.multimodal) return false;
    try {
      const a = await b.available();
      return !!(a && a.ok);
    } catch (_) { return false; }
  };

  // Primary first.
  if (preferred && backends[preferred]) {
    const primary = backends[preferred];
    if (await isOk(primary)) return { name: preferred, backend: primary };
  }

  // Then walk the configured fallback order, skipping the primary we just tried.
  for (const n of order) {
    if (n === preferred) continue;
    const b = backends[n];
    if (await isOk(b)) return { name: n, backend: b };
  }

  return null;
}
