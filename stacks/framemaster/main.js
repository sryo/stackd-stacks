// FrameMaster — port of ~/Documents/Spoons/FrameMaster.lua. Hot corners,
// shift-modified alternates, hover tooltips.
//
// Corner map (mirror of FrameMaster.md):
//   top-left      click → close window (Cmd+W); shift → kill9 + reopen prompt
//   top-right     click → toggle fullscreen (WindowScape sim-fullscreen if loaded);
//                 shift → zoom (fill visibleFrame without entering fullscreen)
//   bottom-right  click → minimize (WindowScape snapshot-minimize if loaded);
//                 shift → hide entire app
//   bottom-left   click → new Finder window (or focus Finder);
//                 shift → open / focus System Settings
//
// Daemon-side gaps (faithful-as-possible, not faithful-to-the-letter):
//   * Menu-bar edge consume + dock edge consume: the FrameMaster.lua approach
//     consumed mouseMoved inside a position band along each screen edge.
//     The current EventTapPredicate only matches on keyCode / flagsMask /
//     flagsAny — there's no x/y zone match. A consuming eventtap with no `if` would
//     swallow every mouseMoved (cursor frozen), so this is deferred until
//     the daemon ships a generic `inRect` predicate. `sd.menubar.suppress()`
//     exists but it hides the bar entirely rather than blocking the hover-
//     reveal, which is a different behavior.
//   * `hs.dialog.blockAlert` (modal "Reopen?" prompt) → AppleScript
//     `display dialog` via sd.applescript.run, same UX (modal Reopen / Ignore).

import { sd } from "sd://runtime/api.js";

const FLAGS = { shift: 0x020000 };
// Width of the corner trigger band, in points. Matches FrameMaster.lua's
// `cfg.buffer = 4`. Bigger bands cause accidental fires near the menu bar.
const CORNER_BAND = 4;
const TIP_HIDE_MS = 750;
const TOOLTIP_MAX_LEN = 50;
const REOPEN_AFTER_KILL = true;

// WindowScape integration. Same `pcall(require, "WindowScape")` shape as the
// Spoon: probe for a loaded sibling stack at startup, fall back gracefully
// when absent. The bus is sd.bang — WindowScape (if loaded) handles
// `sd.windowscape.simulatedFullscreen.toggle` / `.snapshotMinimize` and
// returns whether the call succeeded. We assume the bangs may not be
// registered and fall back to native if `sd.bang` rejects.
let windowScapeProbed = false;
let windowScapeAvailable = false;
async function probeWindowScape() {
  if (windowScapeProbed) return windowScapeAvailable;
  windowScapeProbed = true;
  try {
    const r = await sd.bang("sd.windowscape.ping", {});
    windowScapeAvailable = r === true || (r && r.ok === true);
  } catch (_) {
    windowScapeAvailable = false;
  }
  return windowScapeAvailable;
}

const tip = document.getElementById("tip");
let armed = null;
let armedPoint = null;
let lastFlags = 0;
let hideTimer = null;
let displays = [];
let lastKilledBundleId = null;
let lastKilledAppName = null;

// Push the 4-per-display corner band rects to the daemon so the consuming
// leftMouseDown tap only swallows clicks inside a hot corner — anything
// outside passes through to the focused app normally. Re-pushed on every
// display change so dock moves / resolution changes don't leave stale gates.
function computeCornerRects() {
  const out = [];
  const b = CORNER_BAND;
  for (const d of displays) {
    const f = d.frame; if (!f) continue;
    out.push({ x: f.x,             y: f.y,             w: b, h: b });   // top-left
    out.push({ x: f.x + f.w - b,   y: f.y,             w: b, h: b });   // top-right
    out.push({ x: f.x,             y: f.y + f.h - b,   w: b, h: b });   // bottom-left
    out.push({ x: f.x + f.w - b,   y: f.y + f.h - b,   w: b, h: b });   // bottom-right
  }
  return out;
}

sd.display.all.subscribe(list => {
  displays = list || [];
  const rects = computeCornerRects();
  // Both the leftMouseDown consume tap (click→action) and the mouseMoved
  // observer tap (hover→enter/leave) gate on the same corner-band rects.
  // The mouseMoved tap is opted into emitLeave so it fires {phase:"enter"}
  // when the cursor crosses INTO a corner and {phase:"leave"} on the way out.
  sd.events.setTapRects("click", rects);
  sd.events.setTapRects("hover", rects);
});

function shiftHeld() { return (lastFlags & FLAGS.shift) !== 0; }

function displayForPoint(x, y) {
  return sd.display.forPoint(x, y) || displays[0] || null;
}

// JS-side classifier — given a point already known to be inside SOME corner
// rect (the daemon's rect gate did the "in/out" test), tell us WHICH corner.
// Returns null if the point isn't inside any corner band on any display,
// which can happen during the leave-phase event (point is now outside) and
// for transient race cases when displays change mid-event.
function cornerForPoint(x, y) {
  for (const d of displays) {
    const f = d.frame; if (!f) continue;
    const onLeft   = x >= f.x && x <= f.x + CORNER_BAND;
    const onRight  = x >= f.x + f.w - 1 - CORNER_BAND && x <= f.x + f.w - 1;
    const onTop    = y >= f.y && y <= f.y + CORNER_BAND;
    const onBottom = y >= f.y + f.h - 1 - CORNER_BAND && y <= f.y + f.h - 1;
    if (onLeft  && onTop)    return "top-left";
    if (onRight && onTop)    return "top-right";
    if (onLeft  && onBottom) return "bottom-left";
    if (onRight && onBottom) return "bottom-right";
  }
  return null;
}

// FrameMaster.lua's hasActionableWindow gates on subrole — only AXStandardWindow
// and AXDialog get to be acted on. Curated reader sd.windows.subrole(id) saves
// the round-trip through sd.ax.*.
async function isActionableWindow(win) {
  if (!win || typeof win.id !== "number") return false;
  const subrole = await sd.windows.subrole(win.id);
  if (subrole && subrole !== "AXStandardWindow" && subrole !== "AXDialog") {
    return false;
  }
  return true;
}

// FittsQuit.lua's isDesktop() — when Finder is frontmost and the focused
// "window" is actually the Desktop scroll area, all corners go inert.
async function isDesktop(win) {
  if (!win || typeof win.id !== "number") return false;
  const role = await sd.windows.role(win.id);
  return role === "AXScrollArea";
}

function truncate(s, maxLength) {
  const max = maxLength || TOOLTIP_MAX_LEN;
  if (s.length <= max) return s;
  const part = Math.floor(max / 2);
  return s.slice(0, part - 2) + "..." + s.slice(-part);
}

function windowName(win) {
  return (win && win.title) || "Window";
}
function appName(app) {
  return (app && app.name) || "App";
}

// ---------------------------------------------------------------------------
// Tooltips — message() variants mirror FrameMaster.lua's per-corner message.
// Note: synchronous reads (peek()) for tooltip text. The action() side does
// the full async AX check; the tooltip is a hover hint and getting it
// transiently wrong (e.g. showing "Close Foo" on the Desktop for ~50ms) is
// preferable to a 100ms AX round-trip per mouseMoved sample.

function tooltipText(corner) {
  const win = sd.windows.focused.peek();
  const app = sd.app.frontmost.peek();
  const winN = windowName(win);
  const appN = appName(app);
  const sh = shiftHeld();
  switch (corner) {
    case "top-left":
      return sh ? `Kill ${appN}` : `Close ${winN}`;
    case "top-right":
      return sh ? `Zoom ${winN}` : `Toggle Fullscreen for ${winN}`;
    case "bottom-right":
      return sh ? `Hide ${winN}` : `Minimize ${winN}`;
    case "bottom-left":
      return sh ? "Open System Settings" : "New Finder Window";
  }
  return "";
}

function placeTip(corner, x, y) {
  const d = displayForPoint(x, y);
  if (!d) return;
  // Use visibleFrame, not frame — matches HS FrameMaster.lua which calls
  // hs.screen:frame() (which in HS-land already excludes the menu bar and
  // dock). Using the full d.frame puts top tooltips at y=0 (behind the
  // system menu bar), so they're either invisible or clipped.
  const f = d.visibleFrame || d.frame;
  tip.dataset.corner = corner;
  tip.style.removeProperty("left");
  tip.style.removeProperty("right");
  tip.style.removeProperty("top");
  tip.style.removeProperty("bottom");
  switch (corner) {
    case "top-left":
      tip.style.left = `${f.x}px`;
      tip.style.top  = `${f.y}px`;
      tip.style.transform = "none";
      break;
    case "top-right":
      tip.style.left = `${f.x + f.w}px`;
      tip.style.top  = `${f.y}px`;
      tip.style.transform = "translateX(-100%)";
      break;
    case "bottom-left":
      tip.style.left = `${f.x}px`;
      tip.style.top  = `${f.y + f.h}px`;
      tip.style.transform = "translateY(-100%)";
      break;
    case "bottom-right":
      tip.style.left = `${f.x + f.w}px`;
      tip.style.top  = `${f.y + f.h}px`;
      tip.style.transform = "translate(-100%, -100%)";
      break;
  }
}

function showTip(corner, x, y, customText) {
  const text = customText != null ? customText : tooltipText(corner);
  if (!text) { hideTip(); return; }
  placeTip(corner, x, y);
  tip.textContent = truncate(text);
  tip.classList.add("show");
  // No auto-hide timer — the cursor-leave handler in the `hover` eventtap
  // callback (phase === "leave") calls hideTip when the cursor exits the
  // corner band. Auto-hiding mid-hover would make the tooltip flicker out
  // while the user is still on the corner.
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
}

function hideTip() {
  tip.classList.remove("show");
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
}

// ---------------------------------------------------------------------------
// Actions — one per corner. Each returns the toast string the Spoon showed
// in its tooltip after the click (e.g. "Closed Foo", "Killed Bar"). An empty
// string means "no action fired" (desktop / non-actionable / fullscreen
// minimize block).

async function showReopenDialog() {
  if (!REOPEN_AFTER_KILL || !lastKilledAppName || !lastKilledBundleId) return;
  const name = lastKilledAppName;
  const bundleId = lastKilledBundleId;
  // AppleScript display dialog blocks until the user clicks. Mirrors
  // hs.dialog.blockAlert in the Spoon. 5s timeout matches FrameMaster.md.
  const script = `display dialog "You just killed ${name.replace(/"/g, '\\"')}. Reopen it?" buttons {"Ignore", "Reopen"} default button "Reopen" with title "Reopen?" with icon note giving up after 5`;
  try {
    const r = await sd.applescript.run(script);
    if (r && r.ok && r.result && /Reopen/.test(String(r.result))) {
      await sd.apps.launch(bundleId);
    }
  } catch (_) { /* user dismissed or AppleScript denied */ }
}

async function doTopLeft(win, app) {
  if (!(await isActionableWindow(win))) return "";
  if (shiftHeld()) {
    const killed = appName(app);
    const bundleId = app && app.bundleId;
    if (bundleId) await sd.apps.kill(bundleId, true);
    lastKilledAppName = killed;
    lastKilledBundleId = bundleId;
    showReopenDialog();
    return `Killed ${killed}`;
  }
  // Cmd+W close. After the keystroke settles, check whether the app still
  // has visible windows; if not, quit the app (matches Spoon behavior).
  await sd.events.key("cmd+w");
  await new Promise(r => setTimeout(r, 100));
  if (app && app.pid != null) {
    const visible = await sd.apps.visibleWindows(app.pid);
    if (Array.isArray(visible) && visible.length === 0) {
      const quitted = appName(app);
      if (app.bundleId) await sd.apps.kill(app.bundleId, false);
      return `Quitted ${quitted}`;
    }
  }
  return `Closed ${windowName(win)}`;
}

async function doTopRight(win) {
  if (!(await isActionableWindow(win))) return "";
  if (shiftHeld()) {
    // Zoom — fill visibleFrame without entering native fullscreen, same as
    // hs.window:toggleZoom. visibleFrame already accounts for menu bar + dock.
    if (win && win.frame) {
      const d = displayForPoint(win.frame.x, win.frame.y);
      const target = (d && d.visibleFrame) || (d && d.frame);
      if (target) await sd.windows.setFrame(win.id, target);
    }
    return `Zoomed ${windowName(win)}`;
  }
  if (await probeWindowScape()) {
    try { await sd.bang("sd.windowscape.simulatedFullscreen.toggle", {}); }
    catch (_) { /* fall through to native */ }
    return `Toggled Fullscreen for ${windowName(win)}`;
  }
  // Native fullscreen via Ctrl+Cmd+F (matches FrameMaster.lua line 170).
  await sd.events.key("ctrl+cmd+f");
  return `Toggled Fullscreen for ${windowName(win)}`;
}

async function doBottomRight(win, app) {
  if (!(await isActionableWindow(win))) return "";
  // Spoon refuses to minimize a fullscreen window — same here.
  if (win && typeof win.id === "number") {
    const fs = await sd.windows.isFullscreen(win.id);
    if (fs) return "";
  }
  if (shiftHeld()) {
    if (app && app.bundleId) await sd.apps.hide(app.bundleId);
    return `Hid ${windowName(win)}`;
  }
  if (await probeWindowScape()) {
    try { await sd.bang("sd.windowscape.snapshotMinimize", {}); }
    catch (_) { /* fall through to native */ }
    return `Minimized ${windowName(win)}`;
  }
  await sd.windows.minimize(win.id, true);
  return `Minimized ${windowName(win)}`;
}

async function doBottomLeft() {
  if (shiftHeld()) {
    await sd.apps.launch("com.apple.systempreferences");
    await sd.apps.focus("com.apple.systempreferences");
    return "Opened System Settings";
  }
  // Spoon used `tell application "Finder" to make new Finder window`.
  await sd.applescript.run('tell application "Finder" to make new Finder window');
  await sd.apps.focus("com.apple.finder");
  return "Opened Finder window";
}

const actions = {
  "top-left":     doTopLeft,
  "top-right":    doTopRight,
  "bottom-right": doBottomRight,
  "bottom-left":  doBottomLeft,
};

// ---------------------------------------------------------------------------
// Corner latch — daemon-driven hover state.
//
// `phase` rides on the payload thanks to the `emitLeave: true` opt-in on the
// `hover` eventtap entry. `enter` fires the first time mouseMoved crosses
// INTO any corner rect; `leave` fires once when mouseMoved exits (point is
// now outside all rects, but the previous event was inside — the daemon
// synthesizes the fire at the boundary so JS hears about it). `move` fires
// for subsequent in-rect events; we ignore it here because the tooltip
// placement is set on enter and tracks the armed corner via lastFlags
// re-renders.
//
// CORNER_BAND-thin rects mean enter/leave fires at the rising/falling edge
// of a 4px band — same shape sd.mouse polling produced, minus the 30Hz
// idle wake-up. Multi-monitor: each display contributes 4 corner rects, so
// crossing from one display's bottom-right to another's top-left fires
// leave-then-enter naturally.
sd.events.on("hover", (e) => {
  if (!e) return;
  if (e.phase === "enter") {
    const corner = cornerForPoint(e.x, e.y);
    if (!corner) return;   // race: displays changed between rect push and event
    armed = corner;
    armedPoint = { x: e.x, y: e.y };
    showTip(corner, e.x, e.y);
  } else if (e.phase === "leave") {
    armed = null;
    armedPoint = null;
    hideTip();
  }
  // phase === "move": no-op. The tooltip is already placed at the enter
  // point; flagsChanged re-renders the text when shift is held.
});

// ---------------------------------------------------------------------------
// Eventtap handlers. flagsChanged tracks Shift state and re-renders the
// tooltip text live (matches FrameMaster.lua's `cornerHover` flagsChanged
// branch). leftMouseDown fires the action of the armed corner.

sd.events.on("click", async () => {
  if (!armed) return;
  const win = sd.windows.focused.peek();
  const app = sd.app.frontmost.peek();
  // Bottom-left has no window/app requirement; the other three skip on the
  // Desktop (Finder's AXScrollArea) like FittsQuit.lua did.
  if (armed !== "bottom-left" && win && await isDesktop(win)) return;
  const fn = actions[armed];
  if (!fn) return;
  const corner = armed;
  const where = armedPoint;
  let result;
  try { result = await fn(win, app); } catch (e) { result = ""; }
  if (result && where) showTip(corner, where.x, where.y, result);
});

sd.events.on("flags", (e) => {
  if (!e) return;
  lastFlags = e.flags;
  if (armed && armedPoint) showTip(armed, armedPoint.x, armedPoint.y);
});
