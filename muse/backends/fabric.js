export const name = "fabric";
export const multimodal = false;
export const guidance = "Fabric patterns backend stub — not yet ported. See Muse/backends/fabric.lua for the original Hammerspoon implementation.";

export async function available() {
  return { ok: false, reason: "not yet ported" };
}

export async function* stream(_opts) {
  throw new Error("not yet ported");
}
