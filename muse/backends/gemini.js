export const name = "gemini";
export const multimodal = true;
export const guidance = "Google Gemini backend stub — not yet ported. See Muse/backends/gemini.lua for the original Hammerspoon implementation.";

export async function available() {
  return { ok: false, reason: "not yet ported" };
}

export async function* stream(_opts) {
  throw new Error("not yet ported");
}
