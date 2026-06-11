import { sd } from "sd://runtime/api.js";

// Muse backend: Claude Code CLI in print mode (`claude -p`) with stream-json.
// Ported from ~/.hammerspoon/Muse/backends/claudecli.lua.
//
// Requires the `claude` binary on PATH (Claude Code CLI). Reuses the existing
// CLI auth — no API key needed.
//
// Multi-turn continuity: per claudecli.lua:35-37 + init.lua history layer,
// the session id is stashed on the history object (`history.sessionId`) after
// the first turn. Subsequent calls pass `--resume <id>` to continue.
// JavaScript arrays accept arbitrary properties the same way Lua tables do, so
// mutating `history.sessionId` here is observed by the caller (index.html).

export const name       = "claudecli";
export const multimodal = false;
export const guidance   = "Install: brew install --cask claude-code (or npm i -g @anthropic-ai/claude-code), then run `claude` once to log in.";

const DEFAULTS = {
  // No options yet (matches claudecli.lua line 8).
};

async function readConfig() {
  const stored = await sd.settings.get("claudecliConfig");
  return Object.assign({}, DEFAULTS, stored || {});
}

async function commandOnPath(bin) {
  const r = await sd.proc.exec(
    "/bin/zsh",
    ["-lc", "command -v " + bin],
    { timeout: 3 }
  );
  return r && r.code === 0 && r.stdout && r.stdout.trim().length > 0;
}

export async function available() {
  if (!(await commandOnPath("claude"))) {
    return { ok: false, reason: "claude CLI not found on PATH" };
  }
  return { ok: true };
}

// Single-quote a string for POSIX shell embedding (mirror h.shellQuote).
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

export async function* stream({ prompt, history, signal }) {
  const cfg = await readConfig();

  // Mirror claudecli.lua:22-23:
  //   --strict-mcp-config + empty mcpServers disables MCP entirely. Without
  //   this, claude hangs on MCP startup when launched from a non-interactive
  //   shell (the user's MCP servers reach an interactive shell but not us).
  let cmd = "claude -p --output-format=stream-json --verbose --include-partial-messages"
          + " --strict-mcp-config --mcp-config '{\"mcpServers\":{}}'";

  // Append Muse's house style on top of Claude Code's default system prompt.
  // --append-system-prompt preserves Claude Code's framing.
  const sp = cfg.systemPrompt;
  if (sp && sp.length > 0) {
    cmd += " --append-system-prompt " + shellQuote(sp);
  }

  // Resume the prior session if we have one. Validate the id to avoid shell
  // injection (claude session ids are UUID-shaped).
  if (history && typeof history.sessionId === "string" && history.sessionId.length > 0) {
    const id = history.sessionId;
    if (!/^[A-Za-z0-9._-]+$/.test(id)) {
      throw new Error("claudecli: refusing to resume with malformed session id");
    }
    cmd += " --resume " + id;
  }

  // Pipe prompt → stdin via base64 (sd.proc.stream has no stdin option).
  const b64 = btoa(unescape(encodeURIComponent(prompt || "")));
  const piped = `printf %s '${b64}' | base64 -D | ${cmd}`;

  const queue = [];
  let resolve = null;
  let exited  = false;
  let error   = null;

  // stream-json emits one JSON object per line. Chunks can split mid-line so
  // we buffer until newline.
  let lineBuf = "";

  const handle = await sd.proc.stream(
    { cmd: "/bin/zsh", args: ["-l", "-c", piped] },
    ({ stream, chunk, code }) => {
      if (stream === "stdout" && typeof chunk === "string" && chunk.length > 0) {
        lineBuf += chunk;
        let nl;
        while ((nl = lineBuf.indexOf("\n")) >= 0) {
          const line = lineBuf.slice(0, nl).replace(/\r$/, "");
          lineBuf = lineBuf.slice(nl + 1);
          if (!line) continue;
          let obj;
          try { obj = JSON.parse(line); } catch (_) { continue; }
          if (!obj || typeof obj !== "object") continue;

          // Per claudecli.lua:45-49: the deltas we care about.
          if (obj.type === "stream_event"
              && obj.event && obj.event.type === "content_block_delta"
              && obj.event.delta && obj.event.delta.type === "text_delta"
              && typeof obj.event.delta.text === "string") {
            queue.push(obj.event.delta.text);
            if (resolve) { const r = resolve; resolve = null; r(); }
          } else if (obj.type === "system" && obj.subtype === "init"
                     && typeof obj.session_id === "string" && history) {
            // Stash the id on the history object so the next call can --resume.
            history.sessionId = obj.session_id;
          }
        }
      } else if (stream === "stderr" && typeof chunk === "string" && chunk.length > 0) {
        queue.push({ __stderr: chunk });
        if (resolve) { const r = resolve; resolve = null; r(); }
      } else if (stream === "exit") {
        exited = true;
        if (typeof code === "number" && code !== 0) {
          error = new Error("claude exited " + code);
        }
        if (resolve) { const r = resolve; resolve = null; r(); }
      }
    }
  );
  if (!handle) throw new Error("claudecli: failed to spawn");

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
