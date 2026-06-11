import { sd } from "sd://runtime/api.js";

// Muse backend: Fabric CLI (https://github.com/danielmiessler/fabric).
// Ported from ~/.hammerspoon/Muse/backends/fabric.lua.
//
// Requires the `fabric` binary on PATH and a configured model (fabric --setup).
// Pattern is optional; when set, runs `fabric --stream --pattern <name>`.
// Per fabric.lua line 6-9: Muse's systemPrompt is intentionally NOT applied —
// fabric patterns ARE the system prompt; layering would fight them.

export const name       = "fabric";
export const multimodal = false;
export const guidance   = "Install fabric: brew install fabric-ai (or see github.com/danielmiessler/fabric), then run `fabric --setup` to pick a model. Optionally `stackd set muse --setting fabricConfig.pattern=improve_writing`.";

const DEFAULTS = {
  pattern: null
};

async function readConfig() {
  const stored = await sd.settings.get("fabricConfig");
  return Object.assign({}, DEFAULTS, stored || {});
}

// Mirror Lua's h.commandOnPath via a login-shell `command -v` so PATH matches
// the user's interactive environment (fabric typically installs to ~/go/bin or
// /opt/homebrew/bin which aren't on the daemon's PATH).
async function commandOnPath(bin) {
  const r = await sd.proc.exec(
    "/bin/zsh",
    ["-lc", "command -v " + bin],
    { timeout: 3 }
  );
  return r && r.code === 0 && r.stdout && r.stdout.trim().length > 0;
}

export async function available() {
  if (!(await commandOnPath("fabric"))) {
    return { ok: false, reason: "fabric CLI not found on PATH" };
  }
  return { ok: true };
}

export async function* stream({ prompt, signal }) {
  const cfg = await readConfig();
  let cmd = "fabric --stream";
  if (cfg.pattern && cfg.pattern.length > 0) {
    // Pattern names are restricted to [a-z0-9_]; no shell-quoting risk, but
    // refuse anything funky just in case the user types one in by hand.
    if (!/^[A-Za-z0-9_.-]+$/.test(cfg.pattern)) {
      throw new Error("fabric: invalid pattern name: " + cfg.pattern);
    }
    cmd += " --pattern " + cfg.pattern;
  }

  // Run under the user's login shell so fabric's PATH and config land.
  const sh = "/bin/zsh";
  // queue + waiter pattern: collect chunks from the callback, emit via generator
  const queue = [];
  let resolve = null;
  let exited  = false;
  let error   = null;

  // sd.proc.stream doesn't take stdin (only env/cwd in opts). The Lua port
  // passes `prompt` as stdin to the task. We work around by piping the prompt
  // into fabric via the shell using a heredoc-safe sentinel; fabric reads stdin.
  // To avoid quoting hell, base64-encode the prompt and decode in-shell.
  const b64 = btoa(unescape(encodeURIComponent(prompt || "")));
  const piped = `printf %s '${b64}' | base64 -D | ${cmd}`;

  const handle = await sd.proc.stream(
    { cmd: sh, args: ["-lc", piped] },
    ({ stream, chunk, code }) => {
      if (stream === "stdout" && typeof chunk === "string" && chunk.length > 0) {
        queue.push(chunk);
        if (resolve) { const r = resolve; resolve = null; r(); }
      } else if (stream === "stderr" && typeof chunk === "string" && chunk.length > 0) {
        // Buffer stderr to surface on nonzero exit only.
        queue.push({ __stderr: chunk });
        if (resolve) { const r = resolve; resolve = null; r(); }
      } else if (stream === "exit") {
        exited = true;
        if (typeof code === "number" && code !== 0) {
          error = new Error("fabric exited " + code);
        }
        if (resolve) { const r = resolve; resolve = null; r(); }
      }
    }
  );
  if (!handle) throw new Error("fabric: failed to spawn");

  // Cancel the child if the caller aborts (Esc / new prompt).
  const onAbort = () => { handle.cancel(); };
  if (signal) {
    if (signal.aborted) { handle.cancel(); }
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
