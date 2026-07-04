import { sd } from "sd://runtime/api.js";

// Muse backend: Google Gemini streamGenerateContent (SSE via fetch).
// Ported from ~/.hammerspoon/Muse/backends/gemini.lua.
//
// Key sources (highest → lowest priority):
//   1. sd.settings  "geminiApiKey"
//   2. ~/.config/muse/gemini.json  { "apiKey": "…" }
//   3. $GEMINI_API_KEY or $GOOGLE_API_KEY in the user's login shell

export const name       = "gemini";
export const multimodal = true;
export const guidance   = "Get a key at aistudio.google.com/apikey, then either `stackd set muse --setting geminiApiKey=…`, write { \"apiKey\": \"…\" } to ~/.config/muse/gemini.json, or export GEMINI_API_KEY in ~/.zshrc";

const DEFAULTS = {
  model: "gemini-2.5-flash"
};

async function readKey() {
  const stored = await sd.settings.get("geminiApiKey");
  if (stored && typeof stored === "string" && stored.length > 0) return stored;
  const file = await sd.fs.read("~/.config/muse/gemini.json");
  if (file) {
    try {
      const obj = JSON.parse(file);
      if (obj && typeof obj.apiKey === "string" && obj.apiKey.length > 0) return obj.apiKey;
    } catch (_) {}
  }
  const env = await sd.proc.exec(
    "/bin/zsh",
    ["-lc", "printf %s \"${GEMINI_API_KEY:-$GOOGLE_API_KEY}\""],
    { timeout: 3 }
  );
  if (env && env.code === 0 && env.stdout && env.stdout.length > 0) return env.stdout.trim();
  return null;
}

async function readConfig() {
  const stored = await sd.settings.get("geminiConfig");
  return Object.assign({}, DEFAULTS, stored || {});
}

export async function available() {
  const k = await readKey();
  if (!k) return { ok: false, reason: "GEMINI_API_KEY not set" };
  return { ok: true };
}

export async function* stream({ prompt, history, attachments, signal }) {
  const apiKey = await readKey();
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
  const cfg = await readConfig();

  // Gemini uses "model" instead of "assistant" and wraps each message in
  // { role, parts: [{ text }] }. Mirror gemini.lua line 31-34.
  const contents = [];
  for (const m of (history || [])) {
    const role = m.role === "assistant" ? "model" : "user";
    contents.push({ role, parts: [{ text: m.content }] });
  }
  const parts = [{ text: prompt }];
  if (attachments && attachments.length > 0) {
    for (const a of attachments) {
      parts.push({ inline_data: { mime_type: a.mime, data: a.base64 } });
    }
  }
  contents.push({ role: "user", parts });

  const payload = { contents };
  if (cfg.systemPrompt) {
    payload.system_instruction = { parts: [{ text: cfg.systemPrompt }] };
  }

  const url = "https://generativelanguage.googleapis.com/v1beta/models/"
            + encodeURIComponent(cfg.model) + ":streamGenerateContent?alt=sse";

  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "x-goog-api-key": apiKey,
      "content-type":   "application/json"
    },
    body: JSON.stringify(payload)
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
      const data = line.slice(6);
      let obj;
      try { obj = JSON.parse(data); } catch (_) { continue; }
      const cand = obj && obj.candidates && obj.candidates[0];
      const cParts = cand && cand.content && cand.content.parts;
      if (!cParts) continue;
      for (const p of cParts) {
        if (typeof p.text === "string" && p.text.length > 0) yield p.text;
      }
    }
  }
}
