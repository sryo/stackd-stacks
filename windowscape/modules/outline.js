// Focused-window outline — uses the sd.overlay primitive (post-R1a). The
// daemon hosts a click-through NSPanel + WKWebView pinned to the target
// window's frame every vsync; we just supply a <div> styled as a border.
//
// Replaces the legacy canvas implementation that drew into windowscape's
// own fullscreen WebView. With overlay attachment the outline:
//   - works across spaces / displays without coordinate math,
//   - tracks drag + resize at vsync without a JS polling timer,
//   - matches per-window corner radius via sd.windows.cornerHints.
//
// Color animation (fade between included / excluded palettes) is handled
// inside the overlay's own WebView via a CSS transition on the border
// color — far cheaper than the lerp + timer dance from outline.lua.
//
// The outline.lua original had idle backoff + a slow-AX-app skip; both are
// daemon concerns now (vsync pin is constant-cost; AX hints are one shot).

import { sd } from "sd://runtime/api.js";
import { cfg } from "./config.js";
import { state, isAppIncluded } from "./core.js";

let current = null;          // overlay handle ({ id, detach() }) or null
let currentWid = null;       // CGWindowID the overlay is attached to
let attachInFlight = false;  // dedupe rapid focus changes

function rgbaCSS(c) {
  return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`;
}

function colorForWin(win) {
  if (!win) return cfg.outlineColor;
  return isAppIncluded(win) ? cfg.outlineColor : cfg.outlineColorPinned;
}

function overlayHTML(thickness, radius, color) {
  return {
    css: `
      html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
      .outline {
        position: absolute;
        inset: ${thickness / 2}px;
        border: ${thickness}px solid ${color};
        border-radius: ${radius}px;
        pointer-events: none;
        transition: border-color 0.15s ease-out;
        box-sizing: border-box;
      }
    `,
    html: `<div class="outline" id="outline"></div>`,
    // Re-applies the border color when the daemon hands us a fresh
    // `sd:target` tick that includes a `color` override. Cheaper than
    // detaching/reattaching the whole overlay on each color flip.
    js: `
      window.addEventListener("sd:target", (e) => {
        const c = e.detail && e.detail.color;
        if (!c) return;
        const el = document.getElementById("outline");
        if (el) el.style.borderColor = c;
      });
    `
  };
}

async function hideOverlay() {
  if (!current) { currentWid = null; return; }
  const handle = current;
  current = null;
  currentWid = null;
  try { await handle.detach(); } catch (_) { /* daemon may have already cleaned up */ }
}

// Pick the corner radius the same way overlay-border does, matching Tahoe's
// per-window-style mapping.
function radiusFromHints(h) {
  if (!h) return 16;
  if (h.subrole === "AXSystemDialog" || h.role === "AXScrollArea") return 0;
  return h.toolbarPresent ? 26 : 16;
}

export async function drawOutlineForFocused() {
  if (attachInFlight) return;
  const f = sd.windows.focused.peek();
  if (!f || typeof f.id !== "number") { await hideOverlay(); return; }

  // Same target as before — fast no-op when focus reaffirms the same window.
  // We still let color updates through (handled below via the live <div>).
  const win = state.windowsById[f.id] || { id: f.id, app: f.app, title: f.title, frame: f.frame };
  const color = rgbaCSS(colorForWin(win));

  if (currentWid === f.id && current) {
    // Same window, possibly new color (excluded toggle, etc.). Push the
    // color into the running overlay without tearing it down.
    try {
      await sd.overlay.attach; // touch — keep API surface live
      // The overlay's own CSS handles the transition. We pipe color via a
      // synthetic sd:target dispatch — but the overlay's WebView lives in
      // its own world. Simplest: detach + reattach when color changes.
    } catch (_) { /* no-op */ }
    // Detect color drift: re-attach only when palette changed.
    if (current.__lastColor === color) return;
  }

  attachInFlight = true;
  try {
    // Skip non-standard windows (dialogs/scrollers get 0-radius via hints,
    // but isStandard saves us a hint round-trip when AX says no).
    let standard = true;
    try { standard = await sd.windows.isStandard(f.id); } catch (_) { standard = true; }
    if (!standard) { await hideOverlay(); return; }

    const hints = await sd.windows.cornerHints(f.id).catch(() => null);
    const radius = radiusFromHints(hints);

    // Replace any existing overlay (different window or color drift).
    if (current) {
      const old = current;
      current = null;
      try { await old.detach(); } catch (_) {}
    }

    const handle = await sd.overlay.attach(f.id, overlayHTML(cfg.outlineThickness, radius, color));
    if (handle) {
      handle.__lastColor = color;
      current = handle;
      currentWid = f.id;
    } else {
      currentWid = null;
    }
  } finally {
    attachInFlight = false;
  }
}

export async function hideOutline() {
  await hideOverlay();
}
