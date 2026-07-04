import { sd } from "sd://runtime/api.js";

export const name = "claude";
export const multimodal = true;
export const guidance = "Get a key at console.anthropic.com/settings/keys, then either `stackd set muse --setting claudeApiKey=…`, write { \"apiKey\": \"…\" } to ~/.config/muse/claude.json, or export ANTHROPIC_API_KEY in ~/.zshrc";

const DEFAULTS = {
  model:     "claude-sonnet-4-6",
  maxTokens: 1024,
  systemPrompt: `You are Muse, a quiet inline assistant invoked next to the user's text caret. Your reply may be pasted directly into the field they were working in.

Reply concisely. No preamble ("Sure!", "Here is...", "Certainly"). No closing offers ("Let me know if...", "Hope this helps"). No meta-commentary about your own response. Match the user's tone, register, and length — short questions get short replies.

Plain text by default. Use Markdown or code fences only when explicitly asked or when the content genuinely requires it (e.g. actual code).

If <context>...</context> appears, that is the text the user wants to discuss. Do not echo it back. Rewrite requests get just the rewritten text. Questions get just the answer.`
};

async function readKey() {
  const stored = await sd.settings.get("claudeApiKey");
  if (stored && typeof stored === "string" && stored.length > 0) return stored;
  const file = await sd.fs.read("~/.config/muse/claude.json");
  if (file) {
    try {
      const obj = JSON.parse(file);
      if (obj && typeof obj.apiKey === "string" && obj.apiKey.length > 0) return obj.apiKey;
    } catch (_) {}
  }
  const env = await sd.proc.exec("/bin/zsh", ["-lc", "printf %s \"$ANTHROPIC_API_KEY\""], { timeout: 3 });
  if (env && env.code === 0 && env.stdout && env.stdout.length > 0) return env.stdout.trim();
  return null;
}

async function readConfig() {
  const stored = await sd.settings.get("claudeConfig");
  return Object.assign({}, DEFAULTS, stored || {});
}

export async function available() {
  const k = await readKey();
  if (!k) return { ok: false, reason: "ANTHROPIC_API_KEY not set" };
  return { ok: true };
}

export async function* stream({ prompt, history, attachments, signal }) {
  const apiKey = await readKey();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const cfg = await readConfig();

  const messages = [];
  for (const m of (history || [])) messages.push(m);
  let userContent = prompt;
  if (attachments && attachments.length > 0) {
    userContent = attachments.map(a => ({
      type: "image",
      source: { type: "base64", media_type: a.mime, data: a.base64 }
    }));
    userContent.push({ type: "text", text: prompt });
  }
  messages.push({ role: "user", content: userContent });

  const body = {
    model:      cfg.model,
    max_tokens: cfg.maxTokens,
    stream:     true,
    messages
  };
  if (cfg.systemPrompt) body.system = cfg.systemPrompt;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal,
    headers: {
      "x-api-key":         apiKey,
      "anthropic-version": "2023-06-01",
      "content-type":      "application/json"
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
      if (obj && obj.type === "content_block_delta" && obj.delta && obj.delta.text) {
        yield obj.delta.text;
      }
    }
  }
}
