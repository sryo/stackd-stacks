import { sd } from "sd://runtime/api.js";

// Muse backend: OpenAI chat completions (SSE via fetch).
// Ported from ~/.hammerspoon/Muse/backends/openai.lua.
//
// Key sources (highest → lowest priority, mirroring the claude.js shape):
//   1. sd.settings  "openaiApiKey"
//   2. ~/.config/muse/openai.json  { "apiKey": "…" }
//   3. $OPENAI_API_KEY  in the user's login shell

export const name       = "openai";
export const multimodal = true;
export const guidance   = "Get a key at platform.openai.com/api-keys, then either `stackd set muse --setting openaiApiKey=…`, write { \"apiKey\": \"…\" } to ~/.config/muse/openai.json, or export OPENAI_API_KEY in ~/.zshrc";

const DEFAULTS = {
  model: "gpt-4o-mini"
};

async function readKey() {
  const stored = await sd.settings.get("openaiApiKey");
  if (stored && typeof stored === "string" && stored.length > 0) return stored;
  const file = await sd.fs.read("~/.config/muse/openai.json");
  if (file) {
    try {
      const obj = JSON.parse(file);
      if (obj && typeof obj.apiKey === "string" && obj.apiKey.length > 0) return obj.apiKey;
    } catch (_) {}
  }
  const env = await sd.proc.exec("/bin/zsh", ["-lc", "printf %s \"$OPENAI_API_KEY\""], { timeout: 3 });
  if (env && env.code === 0 && env.stdout && env.stdout.length > 0) return env.stdout.trim();
  return null;
}

async function readConfig() {
  const stored = await sd.settings.get("openaiConfig");
  return Object.assign({}, DEFAULTS, stored || {});
}

export async function available() {
  const k = await readKey();
  if (!k) return { ok: false, reason: "OPENAI_API_KEY not set" };
  return { ok: true };
}

export async function* stream({ prompt, history, attachments, signal }) {
  const apiKey = await readKey();
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  const cfg = await readConfig();

  const messages = [];
  if (cfg.systemPrompt) messages.push({ role: "system", content: cfg.systemPrompt });
  for (const m of (history || [])) messages.push(m);

  let userContent = prompt;
  if (attachments && attachments.length > 0) {
    userContent = [{ type: "text", text: prompt }];
    for (const a of attachments) {
      userContent.push({
        type: "image_url",
        image_url: { url: "data:" + a.mime + ";base64," + a.base64 }
      });
    }
  }
  messages.push({ role: "user", content: userContent });

  const body = {
    model:    cfg.model,
    stream:   true,
    messages
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      "authorization": "Bearer " + apiKey,
      "content-type":  "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") continue;
      let obj;
      try { obj = JSON.parse(payload); } catch (_) { continue; }
      const d = obj && obj.choices && obj.choices[0] && obj.choices[0].delta;
      if (d && typeof d.content === "string" && d.content.length > 0) {
        yield d.content;
      }
    }
  }
}
