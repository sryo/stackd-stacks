export const name = "claudecli";
export const multimodal = false;
export const guidance = "Anthropic claude CLI backend stub — not yet ported. See Muse/backends/claudecli.lua for the original Hammerspoon implementation.";

export async function available() {
  return { ok: false, reason: "not yet ported" };
}

export async function* stream(_opts) {
  throw new Error("not yet ported");
}
