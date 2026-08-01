// Item sources: menuitems / apps / installedapps / calc / shellrunner /
// files (ports of the matching .lua sources). Static sources list once per
// open; dynamic sources re-evaluate per keystroke.
import { sd } from "sd://runtime/api.js";
import { fuzzyMatch } from "./matcher.js";
import { recents } from "./recents.js";

export const SELF = "stackd";

// The frontmost app at the *last moment before Palette stole focus*.
// Once Palette's window invokes, sd.app.frontmost becomes "stackd" —
// useless for "show me this app's menubar".
let priorFront = null;
sd.app.frontmost.subscribe((a) => {
  if (!a || !a.name) return;
  if (a.name === SELF) return;
  priorFront = a;
});
export function getPriorFront() { return priorFront; }

// ───────────────── apps source (port of apps.lua) ───────────────────────
// Running apps with at least one visible window. Subtitle = "N windows"
// matching HS. visibleWindows is per-pid AX, slowish but n ≤ ~20.
export const appsSource = {
  id: "apps",
  async list() {
    const list = sd.apps.running.value || [];
    const out = [];
    for (const a of list) {
      if (!a.name || !a.bundleId || a.name === SELF) continue;
      if (a.activationPolicy && a.activationPolicy !== "regular") continue;
      let wins = [];
      try { wins = await sd.apps.visibleWindows(a.pid); } catch (e) {}
      const n = Array.isArray(wins) ? wins.length : 0;
      if (n === 0) continue;
      out.push({
        id:          "app:" + a.bundleId,
        title:       a.name,
        subtitle:    n + " window" + (n === 1 ? "" : "s"),
        source:      "apps",
        payload:     { bundleId: a.bundleId, pid: a.pid, appName: a.name },
        defaultVerb: "activate",
        verbs:       ["activate", "hide", "quit", "askmuse"]
      });
    }
    return out;
  }
};

// ─────────────── menu-items source (port of menuitems.lua) ──────────────
// One IPC call to sd.apps.menu(pid) → entire menu tree as nested
// {title, role, enabled?, marked?, shortcut?, children?} dicts. We flatten
// it into one Palette item per leaf. Per-app id prefixing so usage counts
// don't collide (Safari's "File > Save" ≠ Terminal's "File > Save").
let menuCache = { pid: null, items: null };
export function resetMenuCache() { menuCache = { pid: null, items: null }; }

function collectMenuLeaves(node, menuPath, pathList, items) {
  const title = node && node.title;
  if (!title || title === "") {
    // Wrapper without a title — recurse into kids.
    if (node && Array.isArray(node.children)) {
      for (const k of node.children) collectMenuLeaves(k, menuPath, pathList, items);
    }
    return;
  }
  const here = menuPath ? menuPath + " > " + title : title;
  const childPath = pathList.concat([title]);
  if (Array.isArray(node.children) && node.children.length > 0) {
    for (const k of node.children) collectMenuLeaves(k, here, childPath, items);
  } else {
    items.push({
      id:          here,             // app prefix added by caller
      title,
      subtitle:    here,
      source:      "menuitems",
      payload:     { appPid: null, appName: null, path: childPath },
      accessory:   node.shortcut || null,
      enabled:     node.enabled !== false,
      markChar:    node.marked ? "✓" : null,
      defaultVerb: "activate",
      verbs:       ["activate", "askmuse"]
    });
  }
}
async function rebuildMenuItems(pid, appName) {
  const tree = await sd.apps.menu(pid);
  if (!tree) return [];
  const tops = Array.isArray(tree.children) ? tree.children : [];
  const items = [];
  // Skip the system Apple menu (always the first top-level child of the
  // AX menubar tree). HS's app:getMenuItems() never returns it — the
  // Apple menu is owned by SystemUIServer, not the frontmost app — so
  // matching HS's surface means walking from topIdx 1 onwards. Without
  // this, "About This Mac" / "Sleep" / "Shut Down" outrank the app's
  // own File / Edit / View entries on shared-letter queries.
  tops.forEach((top, topIdx) => {
    if (topIdx === 0) return;
    collectMenuLeaves(top, null, [], items);
  });
  for (const it of items) {
    it.payload.appPid = pid;
    it.payload.appName = appName;
    it.id = appName + " :: " + it.id;
  }
  return items;
}
export const menuItemsSource = {
  id: "menuitems",
  async list() {
    const a = priorFront || sd.app.frontmost.peek();
    if (!a || !a.pid || a.name === SELF) return [];
    if (menuCache.pid === a.pid && menuCache.items) return menuCache.items;
    const items = await rebuildMenuItems(a.pid, a.name || "");
    menuCache = { pid: a.pid, items };
    return items;
  }
};

// ─────────── installedapps source (port of installedapps.lua) ───────────
// mdfind for .app bundles. We can't read CFBundleIdentifier from JS
// without spawning a helper — use the path as the id and the .app stem
// as the display name. Hidden when query empty so palette doesn't flood.
let installedCache = [];
export async function rebuildInstalled() {
  const r = await sd.proc.exec("/usr/bin/mdfind",
    ["kMDItemContentType == 'com.apple.application-bundle'"]);
  if (!r || r.code !== 0) return;
  const seen = new Set();
  const out = [];
  for (const path of (r.stdout || "").split("\n")) {
    if (!path || path.indexOf(".app/") >= 0) continue;
    if (path.indexOf("/Library/Application Support/") >= 0) continue;
    if (!path.endsWith(".app")) continue;
    const stem = path.replace(/^.*\//, "").replace(/\.app$/, "");
    if (stem === SELF) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path, name: stem });
  }
  installedCache = out;
}
export const installedSource = {
  id: "installedapps",
  async list() {
    // HS hides installed apps already running with visible windows. We
    // approximate by skipping anything whose name matches a running app
    // (close enough without bundleID readback).
    const runningNames = new Set((sd.apps.running.value || []).map(a => a.name));
    return installedCache
      .filter(e => !runningNames.has(e.name))
      .map(e => ({
        id:               "installedapp:" + e.path,
        title:            e.name,
        subtitle:         "",
        source:           "installedapps",
        payload:          { path: e.path, appName: e.name },
        defaultVerb:      "launch",
        verbs:            ["launch", "askmuse"],
        hideOnEmptyQuery: true
      }));
  }
};

// ─────────────────── calc source (port of calc.lua) ─────────────────────
// Dynamic: re-evaluated per keystroke. One synthetic row when the query
// parses as an arithmetic expression; rendered as an inline card at the
// top of the list (render.js special-cases source === "calc").
function looksMathy(s) {
  if (!/\d/.test(s)) return false;
  if (/[+\-*/%^()]/.test(s)) return true;
  if (s.indexOf(".") >= 0) return true;
  return /\bpi\b|\be\b/i.test(s);
}
function evalCalc(src) {
  const cleaned = src.replace(/\s+/g, "");
  // Tight whitelist: digits, math ops, parens, dot, and the letters of pi/e.
  if (!/^[0-9+\-*/%^().pieE]+$/i.test(cleaned)) return null;
  const js = cleaned
    .replace(/\^/g, "**")
    .replace(/\bpi\b/gi, "Math.PI")
    .replace(/\be\b/gi, "Math.E");
  try {
    // eslint-disable-next-line no-new-func
    const v = Function("\"use strict\";return (" + js + ");")();
    if (typeof v !== "number" || !isFinite(v)) return null;
    return v;
  } catch (e) { return null; }
}
function formatNumber(n) {
  if (n === Math.floor(n) && Math.abs(n) < 1e15) return String(Math.trunc(n));
  return Number(n.toPrecision(6)).toString();
}
export const calcSource = {
  id: "calc",
  dynamic: true,
  list(query) {
    const q = (query || "").trim();
    if (!q || !looksMathy(q)) return [];
    const v = evalCalc(q);
    if (v == null) return [];
    const formatted = formatNumber(v);
    return [{
      id:               "calc:active",
      title:            "= " + formatted,
      subtitle:         q,
      source:           "calc",
      payload:          { expression: q, value: v, formatted },
      defaultVerb:      "copynumber",
      verbs:            ["copynumber", "askmuse"],
      hideOnEmptyQuery: true,
      bypassMatcher:    true
    }];
  }
};

// ───────────── shellrunner source (port of shellrunner.lua) ─────────────
// Dynamic: emits "Run shell command" row when query's first token is on
// $PATH. Cached lookups; fire-and-forget on activate.
const shellLookupCache = new Map();
async function isOnPath(token) {
  if (shellLookupCache.has(token)) return shellLookupCache.get(token);
  if (!token || token.indexOf("/") >= 0) { shellLookupCache.set(token, false); return false; }
  try {
    const r = await sd.proc.exec("/usr/bin/env", ["which", token], { timeout: 1 });
    const ok = r && r.code === 0 && (r.stdout || "").trim().length > 0;
    shellLookupCache.set(token, !!ok);
    return !!ok;
  } catch (e) { shellLookupCache.set(token, false); return false; }
}
export const shellSource = {
  id: "shellrunner",
  dynamic: true,
  async list(query) {
    const q = (query || "").trim();
    if (!q) return [];
    const first = q.match(/^(\S+)/);
    if (!first) return [];
    const ok = await isOnPath(first[1]);
    if (!ok) return [];
    return [{
      id:               "shell:active",
      title:            q,
      subtitle:         "Run shell command",
      source:           "shellrunner",
      payload:          { command: q },
      defaultVerb:      "runshell",
      verbs:            ["runshell", "askmuse"],
      hideOnEmptyQuery: true,
      bypassMatcher:    true
    }];
  }
};

// ─────────────────── files source (port of files.lua) ───────────────────
// Two modes: path mode (query starts with /, ~/, ./) lists directory
// children filtered by tail. Visited mode (no trigger) pulls dir entries
// from recents("files").
let HOME = "";
(async () => {
  try {
    const r = await sd.proc.exec("/usr/bin/whoami", []);
    if (r && r.code === 0) HOME = "/Users/" + (r.stdout || "").trim();
  } catch (e) {}
})();
function expandPath(p) {
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return HOME + p.slice(1);
  if (p.startsWith("./")) return HOME + p.slice(1);
  return p;
}
export function abbreviatePath(absPath) {
  if (HOME && absPath.startsWith(HOME)) return "~" + absPath.slice(HOME.length);
  return absPath;
}
function isPathTrigger(q) {
  return q.startsWith("/") || q.startsWith("~/") || q.startsWith("./");
}
const MAX_PATH_RESULTS = 30;
const MAX_VISITED_RESULTS = 10;
async function listPathDir(query) {
  const slashAt = query.lastIndexOf("/");
  if (slashAt < 0) return [];
  const dir = query.slice(0, slashAt);
  const tail = query.slice(slashAt + 1);
  let absDir;
  if (dir === "") absDir = "/";
  else if (dir === "~") absDir = HOME;
  else absDir = expandPath(dir);
  if (!absDir) absDir = "/";
  const showHidden = tail.startsWith(".");
  // sd.fs.list is in-process FileManager — no fork+exec per directory.
  const names = (await sd.fs.list(absDir, { hidden: showHidden }).catch(() => null)) || [];
  // Stat first so the sort can promote directories above files at equal
  // score (matches Lua files.lua's tertiary sort key). Doing it inline
  // means we stat all matches, not just the top 30 — acceptable because
  // the fuzzy filter has already culled most names and sd.fs.stat is
  // in-process (FileManager.attributesOfItem), not a subprocess.
  const scored = [];
  for (const name of names) {
    let score = 0, positions = [];
    if (tail !== "") {
      const m = fuzzyMatch(tail, name);
      if (!m) continue;
      score = m.score;
      positions = m.positions;
    }
    const full = absDir === "/" ? "/" + name : absDir + "/" + name;
    const st = await sd.fs.stat(full).catch(() => null);
    const isDir = !!(st && st.isDir);
    scored.push({ name, score, positions, full, isDir });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const slice = scored.slice(0, MAX_PATH_RESULTS);
  const out = [];
  for (const c of slice) {
    const full = c.full;
    const isDir = c.isDir;
    out.push({
      id:               full,
      title:            c.name,
      subtitle:         abbreviatePath(absDir),
      source:           "files",
      payload:          { path: full, isDir },
      defaultVerb:      isDir ? "enter" : "open",
      verbs:            isDir
                          ? ["enter", "open", "reveal", "copypath", "askmuse"]
                          : ["open", "reveal", "copypath", "askmuse"],
      hideOnEmptyQuery: true,
      bypassMatcher:    true,
      matchPositions:   c.positions
    });
  }
  return out;
}
function listVisited(query) {
  if (!query) return [];
  const lower = query.toLowerCase();
  const out = [];
  const ent = recents.entries("files");
  for (const absPath in ent) {
    const base = absPath.split("/").pop() || absPath;
    if (base.toLowerCase().indexOf(lower) >= 0) {
      out.push({
        id:               absPath,
        title:            base,
        subtitle:         abbreviatePath(absPath.replace(/\/[^/]+$/, "") || "/"),
        source:           "files",
        payload:          { path: absPath, isDir: true },
        defaultVerb:      "enter",
        verbs:            ["enter", "open", "reveal", "copypath", "askmuse"],
        hideOnEmptyQuery: true
      });
      if (out.length >= MAX_VISITED_RESULTS) break;
    }
  }
  return out;
}
export const filesSource = {
  id: "files",
  dynamic: true,
  abbreviatePath,
  async list(query) {
    const q = (query || "").trim();
    if (!q) return [];
    if (isPathTrigger(q)) return await listPathDir(q);
    return listVisited(q);
  }
};
