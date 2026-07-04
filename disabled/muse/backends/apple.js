import { sd } from "sd://runtime/api.js";

// Muse backend: Apple Intelligence via FoundationModels (macOS 26+).
// Ported from ~/.hammerspoon/Muse/backends/apple.lua.
//
// Like the Hammerspoon original, this delegates to a tiny Swift helper binary
// that this repo doesn't ship. Build recipe (Swift 6, Xcode 26+):
//
//   import Foundation
//   import FoundationModels
//   let session = LanguageModelSession()
//   let prompt = String(data: FileHandle.standardInput.readDataToEndOfFile(),
//                       encoding: .utf8) ?? ""
//   let stream = session.streamResponse(to: prompt)
//   for try await partial in stream {
//     FileHandle.standardOutput.write(partial.data(using: .utf8)!)
//   }
//
//   swiftc -o muse-foundation muse-foundation.swift
//   mkdir -p ~/.config/muse && mv muse-foundation ~/.config/muse/
//
// Default helperPath uses the stackd config namespace (~/.config/muse/) rather
// than ~/.hammerspoon/. Override via `stackd set muse --setting appleConfig.helperPath=…`.

export const name       = "apple";
export const multimodal = false;
export const guidance   = "Build helper at ~/.config/muse/muse-foundation (see backends/apple.js for the Swift recipe). Requires macOS 26+.";

const DEFAULTS = {
  helperPath: "~/.config/muse/muse-foundation"
};

async function readConfig() {
  const stored = await sd.settings.get("appleConfig");
  return Object.assign({}, DEFAULTS, stored || {});
}

function parseMajor(version) {
  // sd.host.info().os.version is a string like "26.0" or "15.5.1".
  if (typeof version !== "string") return 0;
  const m = version.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

export async function available() {
  const cfg = await readConfig();
  // macOS gate: FoundationModels requires 26+.
  try {
    const info = await sd.host.info();
    const major = parseMajor(info && info.os && info.os.version);
    if (major > 0 && major < 26) {
      return { ok: false, reason: "FoundationModels requires macOS 26+ (running " + info.os.version + ")" };
    }
  } catch (_) { /* if host.info fails, fall through to the binary check */ }

  // Mirror Lua's io.open existence check (apple.lua:33-37).
  // sd.fs.read returns null for nonexistent paths; check via stat-equivalent
  // by attempting to read the first byte. We use a `test -x` shell check
  // because the helper is binary (not text) and may be large.
  const r = await sd.proc.exec("/bin/zsh", ["-lc", "test -x " + JSON.stringify(cfg.helperPath)], { timeout: 3 });
  if (!r || r.code !== 0) {
    return { ok: false, reason: "FoundationModels helper not built (" + cfg.helperPath + ")" };
  }
  return { ok: true };
}

export async function* stream({ prompt, signal }) {
  const cfg = await readConfig();

  // Per apple.lua:44-49: the helper protocol is "stdin = prompt". When a Muse
  // systemPrompt is set, wrap it inline until the helper grows a real system
  // channel.
  const stored = await sd.settings.get("appleConfig");
  const sp = stored && typeof stored.systemPrompt === "string" ? stored.systemPrompt : null;
  let input = prompt || "";
  if (sp && sp.length > 0) {
    input = "<system>\n" + sp + "\n</system>\n\n" + input;
  }

  // Pipe the prompt into the helper via shell (sd.proc.stream has no stdin
  // option; base64 round-trip avoids quoting).
  const b64 = btoa(unescape(encodeURIComponent(input)));
  const piped = `printf %s '${b64}' | base64 -D | ${JSON.stringify(cfg.helperPath)}`;

  const queue = [];
  let resolve = null;
  let exited  = false;
  let error   = null;

  const handle = await sd.proc.stream(
    { cmd: "/bin/zsh", args: ["-lc", piped] },
    ({ stream, chunk, code }) => {
      if (stream === "stdout" && typeof chunk === "string" && chunk.length > 0) {
        queue.push(chunk);
        if (resolve) { const r = resolve; resolve = null; r(); }
      } else if (stream === "stderr" && typeof chunk === "string" && chunk.length > 0) {
        queue.push({ __stderr: chunk });
        if (resolve) { const r = resolve; resolve = null; r(); }
      } else if (stream === "exit") {
        exited = true;
        if (typeof code === "number" && code !== 0) {
          error = new Error("apple helper exited " + code);
        }
        if (resolve) { const r = resolve; resolve = null; r(); }
      }
    }
  );
  if (!handle) throw new Error("apple: failed to spawn helper");

  const onAbort = () => { handle.cancel(); };
  if (signal) {
    if (signal.aborted) handle.cancel();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    let stderrBuf = "";
    while (true) {
      while (queue.length > 0) {
        const item = queue.shift();
        if (typeof item === "string") yield item;
        else if (item && item.__stderr) stderrBuf += item.__stderr;
      }
      if (exited) {
        if (error) {
          const tail = stderrBuf.trim().slice(-400);
          throw new Error(error.message + (tail ? ": " + tail : ""));
        }
        return;
      }
      await new Promise(r => { resolve = r; });
    }
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}
