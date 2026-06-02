export const name = "apple";
export const multimodal = false;
export const guidance = "Apple Intelligence (Writing Tools) backend stub — not yet ported. See Muse/backends/apple.lua for the original Hammerspoon implementation.";

export async function available() {
  return { ok: false, reason: "not yet ported" };
}

export async function* stream(_opts) {
  throw new Error("not yet ported");
}
