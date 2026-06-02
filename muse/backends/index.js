import * as claude    from "./claude.js";
import * as openai    from "./openai.js";
import * as gemini    from "./gemini.js";
import * as claudecli from "./claudecli.js";
import * as fabric    from "./fabric.js";
import * as apple     from "./apple.js";

export const backends = { claude, openai, gemini, claudecli, fabric, apple };

export async function pick(preferred, opts) {
  const order = [preferred, "claude", "openai", "gemini", "claudecli", "fabric", "apple"];
  for (const name of order) {
    const b = backends[name];
    if (!b) continue;
    if (opts && opts.needsVision && !b.multimodal) continue;
    const a = await b.available();
    if (a && a.ok) return { name, backend: b };
  }
  return null;
}
