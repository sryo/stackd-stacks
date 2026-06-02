export const name = "openai";
export const multimodal = true;
export const guidance = "OpenAI Chat Completions backend stub — not yet ported. See Muse/backends/openai.lua for the original Hammerspoon implementation.";

export async function available() {
  return { ok: false, reason: "not yet ported" };
}

export async function* stream(_opts) {
  throw new Error("not yet ported");
}
