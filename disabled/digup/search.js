import { sd } from "sd://runtime/api.js";
import * as db from "./db.js";

let viewerOpen = false;
let activeQuery = "";
let currentFrame = null;
let onClose = null;

const els = {
  card:        () => document.getElementById("search-card"),
  input:       () => document.getElementById("q"),
  results:     () => document.getElementById("results"),
  empty:       () => document.getElementById("empty"),
  viewer:      () => document.getElementById("viewer"),
  shot:        () => document.getElementById("shot"),
  shotWrap:    () => document.getElementById("shot-wrap"),
  overlays:    () => document.getElementById("overlays"),
  meta:        () => document.getElementById("viewer-meta"),
  scrubber:    () => document.getElementById("scrubber")
};

let debounceTimer = null;
let lastResults = [];
let focused = 0;

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return d.toLocaleString();
}
function fmtHHMMSS(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function snippet(text, query, maxLen) {
  if (!text) return "(no text)";
  text = text.replace(/\s+/g, " ");
  if (text.length <= maxLen) return text;
  const lower = text.toLowerCase();
  let bestPos = -1;
  for (const w of (query || "").toLowerCase().split(/\s+/)) {
    if (w.length < 2) continue;
    const p = lower.indexOf(w);
    if (p >= 0 && (bestPos < 0 || p < bestPos)) bestPos = p;
  }
  if (bestPos < 0) return text.slice(0, maxLen - 3) + "...";
  const half = Math.floor(maxLen / 2);
  let start = Math.max(0, bestPos - half);
  let end   = start + maxLen;
  if (end > text.length) { end = text.length; start = Math.max(0, end - maxLen); }
  let s = text.slice(start, end);
  if (start > 0) s = "..." + s;
  if (end < text.length) s = s + "...";
  return s;
}

function highlight(text, query) {
  if (!query || !text) return escapeHTML(text);
  const words = query.split(/\s+/).filter(w => w.length >= 2);
  if (words.length === 0) return escapeHTML(text);
  const pattern = new RegExp("(" + words.map(escapeRegex).join("|") + ")", "ig");
  return escapeHTML(text).replace(pattern, "<b>$1</b>");
}
function escapeHTML(s) {
  return (s || "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function renderResults(results, query) {
  const r = els.results();
  r.innerHTML = "";
  if (results.length === 0) {
    els.empty().style.display = "";
    return;
  }
  els.empty().style.display = "none";
  results.forEach((row, i) => {
    const div = document.createElement("div");
    div.className = "row" + (i === focused ? " selected" : "");
    const thumb = document.createElement("img");
    thumb.className = "thumb";
    if (row.screenshot) thumb.src = row.screenshot;
    const text = document.createElement("div");
    text.className = "text";
    const subText = (row.appName || "") +
                    (row.windowTitle ? " — " + row.windowTitle : "") +
                    "  ·  " + fmtTime(row.timestamp) +
                    (row.frameCount > 1
                      ? "  ·  " + Math.floor(row.duration || 0) + "s · " + row.frameCount + " frames"
                      : "");
    text.innerHTML = "<div class=\"main\">" + highlight(snippet(row.matchedText, query, 140), query) +
                     "</div><div class=\"sub\">" + escapeHTML(subText) + "</div>";
    div.appendChild(thumb);
    div.appendChild(text);
    div.addEventListener("click", () => {
      focused = i;
      openViewer(row);
    });
    r.appendChild(div);
  });
}

async function doSearch(query) {
  activeQuery = query;
  if (!query || query.length === 0) {
    lastResults = [];
    renderResults(lastResults, "");
    return;
  }
  lastResults = await db.search(query, 50);
  focused = 0;
  renderResults(lastResults, query);
}

function debounceSearch(q) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => doSearch(q), 150);
}

async function openViewer(row) {
  const frame = await db.getFrameById(row.frameId);
  if (!frame) return;
  await showViewer(frame);
}

async function showViewer(frame) {
  currentFrame = frame;
  viewerOpen = true;
  els.viewer().classList.add("on");
  els.card().classList.add("dim");
  els.shot().src = frame.screenshot || "";
  els.meta().textContent = (frame.appName || "") +
                           (frame.windowTitle ? "  ·  " + frame.windowTitle : "") +
                           "  ·  " + fmtTime(frame.timestamp);
  // Bounding boxes — db has them in pixel coords (Vision returns normalized,
  // which we stored as fractions). Recompute against displayed image rect.
  await drawOverlays(frame);
  await drawScrubber(frame);
}

async function drawOverlays(frame) {
  const wrap = els.overlays();
  wrap.innerHTML = "";
  if (!activeQuery) return;
  const regions = await db.findMatchInFrame(frame.id, activeQuery);
  for (const r of regions) {
    const d = document.createElement("div");
    d.className = "obs";
    d.style.left   = (r.x * 100) + "%";
    d.style.top    = (r.y * 100) + "%";
    d.style.width  = (r.w * 100) + "%";
    d.style.height = (r.h * 100) + "%";
    wrap.appendChild(d);
  }
}

const SCRUB_HALF = 3;

async function drawScrubber(frame) {
  const left = [];
  let cur = frame.id;
  for (let i = 0; i < SCRUB_HALF; i++) {
    const prev = await db.getAdjacentFrame(cur, -1);
    if (!prev) break;
    left.unshift(prev); cur = prev.id;
  }
  const right = [];
  cur = frame.id;
  for (let i = 0; i < SCRUB_HALF; i++) {
    const nxt = await db.getAdjacentFrame(cur, 1);
    if (!nxt) break;
    right.push(nxt); cur = nxt.id;
  }
  const frames = [...left, frame, ...right];

  const wrap = els.scrubber();
  wrap.innerHTML = "";
  for (const f of frames) {
    const tile = document.createElement("div");
    tile.className = "tile" + (f.id === frame.id ? " current" : "");
    const img = document.createElement("img");
    if (f.screenshot) img.src = f.screenshot;
    tile.appendChild(img);
    const lab = document.createElement("div");
    lab.className = "label";
    lab.textContent = fmtHHMMSS(f.timestamp);
    tile.appendChild(lab);
    tile.addEventListener("click", () => { if (f.id !== currentFrame.id) showViewer(f); });
    wrap.appendChild(tile);
  }
}

async function step(direction) {
  if (!currentFrame) return;
  const adj = await db.getAdjacentFrame(currentFrame.id, direction);
  if (adj) await showViewer(adj);
}

function closeViewer() {
  viewerOpen = false;
  els.viewer().classList.remove("on");
  els.card().classList.remove("dim");
  currentFrame = null;
}

export async function open(onCloseFn) {
  onClose = onCloseFn || null;
  els.input().value = "";
  els.results().innerHTML = "";
  els.empty().style.display = "";
  focused = 0;
  lastResults = [];
  activeQuery = "";
  setTimeout(() => els.input().focus(), 50);
}

export function close() {
  if (viewerOpen) closeViewer();
  if (onClose) onClose();
}

function moveFocus(delta) {
  if (lastResults.length === 0) return;
  focused = Math.max(0, Math.min(lastResults.length - 1, focused + delta));
  renderResults(lastResults, activeQuery);
  const rows = els.results().querySelectorAll(".row");
  if (rows[focused]) rows[focused].scrollIntoView({ block: "nearest" });
}

export function bindKeys() {
  const input = els.input();
  input.addEventListener("input", () => debounceSearch(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (viewerOpen) { closeViewer(); return; }
      close();
      return;
    }
    if (viewerOpen) {
      if (e.key === "ArrowLeft")  { e.preventDefault(); step(-1); return; }
      if (e.key === "ArrowRight") { e.preventDefault(); step(1);  return; }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); moveFocus(1);  return; }
    if (e.key === "ArrowUp")   { e.preventDefault(); moveFocus(-1); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      const r = lastResults[focused];
      if (r) openViewer(r);
    }
  });
}
