// Verbs — what Enter / ⌘N / the verb stage can do to an item. keepOpen
// verbs return { rewriteQuery } to mutate state instead of closing the
// palette (enter directory).
import { sd } from "sd://runtime/api.js";
import { recents } from "./recents.js";
import { abbreviatePath } from "./sources.js";

export const VERBS = {
  activate: {
    id: "activate", label: "Activate",
    async run(item) {
      if (item.source === "menuitems") {
        if (item.enabled === false) return false;
        const pid = item.payload && item.payload.appPid;
        const path = item.payload && item.payload.path;
        if (!pid || !path) return false;
        return await sd.apps.selectMenuItem(pid, path);
      }
      if (item.payload && item.payload.bundleId) {
        return await sd.apps.focus(item.payload.bundleId);
      }
    }
  },
  launch: {
    id: "launch", label: "Launch",
    async run(item) {
      // installedapps: open the .app path. apps: focus by bundleId.
      if (item.payload && item.payload.bundleId) {
        return await sd.apps.launch(item.payload.bundleId);
      }
      if (item.payload && item.payload.path) {
        return await sd.proc.exec("/usr/bin/open", [item.payload.path]);
      }
    }
  },
  hide: {
    id: "hide", label: "Hide",
    async run(item) {
      if (item.payload && item.payload.bundleId) {
        return await sd.apps.hide(item.payload.bundleId);
      }
    }
  },
  quit: {
    id: "quit", label: "Quit",
    async run(item) {
      if (item.payload && item.payload.bundleId) {
        return await sd.apps.kill(item.payload.bundleId);
      }
    }
  },
  copypath: {
    id: "copypath", label: "Copy Path",
    async run(item) {
      const p = item.payload && item.payload.path;
      if (p) await sd.pasteboard.set(p);
    }
  },
  copynumber: {
    id: "copynumber", label: "Copy",
    async run(item) {
      const v = item.payload && (item.payload.formatted || String(item.payload.value));
      if (v != null) await sd.pasteboard.set(String(v));
    }
  },
  enter: {
    id: "enter", label: "Enter", keepOpen: true,
    async run(item) {
      const p = item.payload && item.payload.path;
      if (!p) return null;
      recents.record("files", p);
      return { rewriteQuery: abbreviatePath(p) + "/" };
    }
  },
  open: {
    id: "open", label: "Open",
    async run(item) {
      const p = item.payload && item.payload.path;
      if (!p) return;
      await sd.proc.exec("/usr/bin/open", [p]);
      const parent = p.replace(/\/[^/]+$/, "");
      if (parent) recents.record("files", parent);
    }
  },
  reveal: {
    id: "reveal", label: "Reveal in Finder",
    async run(item) {
      const p = item.payload && item.payload.path;
      if (!p) return;
      await sd.proc.exec("/usr/bin/open", ["-R", p]);
    }
  },
  runshell: {
    id: "runshell", label: "Run",
    async run(item) {
      const cmd = item.payload && item.payload.command;
      if (!cmd) return;
      // Fire-and-forget via zsh -lc (matches runshell.lua).
      sd.proc.exec("/bin/zsh", ["-lc", cmd]).catch(() => {});
    }
  },
  askmuse: {
    id: "askmuse", label: "Ask Muse",
    async run(item) {
      // Port of askmuse.lua. Builds the same "describe" payload
      // (title, distinct subtitle, app name, bundle id) and fires
      // muse.ask — muse stack subscribes via handles: ["muse.ask"].
      if (!item) return false;
      const lines = [];
      if (item.title) lines.push(item.title);
      if (item.subtitle && item.subtitle !== item.title) lines.push(item.subtitle);
      const p = item.payload || {};
      if (p.appName)  lines.push("App: "    + p.appName);
      if (p.bundleId) lines.push("Bundle: " + p.bundleId);
      sd.bang('muse.ask', { context: lines.join("\n") });
    }
  }
};
