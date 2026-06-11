import { sd } from "sd://runtime/api.js";
import * as db from "./db.js";
import * as ocr from "./ocr.js";

const SENSITIVE_PATTERNS = [
  "private browsing", "incognito", "private window",
  "password", "keychain", "credential", "ssh ", "sudo "
];

const DEFAULT_BLACKLIST = new Set([
  "com.1password.1password",
  "com.apple.keychainaccess",
  "com.apple.Passwords",
  "org.keepassxc.keepassxc",
  "com.bitwarden.desktop"
]);

let cfg = null;
let blacklist = new Set();
let paused = false;
let timer = null;
let nilSnapshotCount = 0;

let lastPHash   = null;
let lastBundle  = null;
let lastTitle   = null;
let lastClip    = null;

const PHASH_SIZE = 8;
const PHASH_MAX_DIFF_BITS = PHASH_SIZE * PHASH_SIZE;

let _hashCanvas = null;
function getHashCanvas() {
  if (!_hashCanvas) {
    _hashCanvas = document.createElement("canvas");
    _hashCanvas.width = PHASH_SIZE;
    _hashCanvas.height = PHASH_SIZE;
  }
  return _hashCanvas;
}

// 8x8 average-hash: downscale, grayscale, threshold against the mean.
// Returns a 64-bit hash as a string of 16 hex chars. Hamming-distance compare.
function pHash(dataURL) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = getHashCanvas();
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, PHASH_SIZE, PHASH_SIZE);
      const data = ctx.getImageData(0, 0, PHASH_SIZE, PHASH_SIZE).data;
      const grays = new Uint8Array(PHASH_SIZE * PHASH_SIZE);
      let sum = 0;
      for (let i = 0, j = 0; i < data.length; i += 4, j++) {
        const g = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
        grays[j] = g;
        sum += g;
      }
      const avg = sum / grays.length;
      let bits = 0n;
      for (let j = 0; j < grays.length; j++) {
        if (grays[j] >= avg) bits |= 1n << BigInt(j);
      }
      let hex = bits.toString(16);
      while (hex.length < 16) hex = "0" + hex;
      resolve(hex);
    };
    img.onerror = () => resolve(null);
    img.src = dataURL;
  });
}

function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return PHASH_MAX_DIFF_BITS;
  let aBig = BigInt("0x" + a);
  let bBig = BigInt("0x" + b);
  let xor = aBig ^ bBig;
  let count = 0;
  while (xor !== 0n) { xor &= xor - 1n; count++; }
  return count;
}

export function setConfig(c) {
  cfg = c;
  blacklist = new Set([...DEFAULT_BLACKLIST]);
  for (const b of (cfg.blacklist || [])) blacklist.add(b);
}

export function addBlacklist(bundleId) {
  if (!bundleId) return;
  blacklist.add(bundleId);
  saveBlacklist();
}
export function removeBlacklist(bundleId) {
  if (!bundleId || DEFAULT_BLACKLIST.has(bundleId)) return;
  blacklist.delete(bundleId);
  saveBlacklist();
}
export function isBlacklisted(bundleId) { return blacklist.has(bundleId); }
export function listBlacklist() { return [...blacklist]; }

async function saveBlacklist() {
  const extras = [...blacklist].filter(b => !DEFAULT_BLACKLIST.has(b));
  await sd.settings.set("blacklist", extras);
}
export async function loadBlacklist() {
  const extras = (await sd.settings.get("blacklist")) || [];
  blacklist = new Set([...DEFAULT_BLACKLIST]);
  for (const b of extras) blacklist.add(b);
}

export function start() {
  stop();
  timer = setInterval(tick, (cfg.captureInterval || 2) * 1000);
}
export function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}
export function pause()  { paused = true; }
export function resume() {
  paused = false;
  lastPHash = null; lastBundle = null; lastTitle = null; lastClip = null;
}
export function isPaused()    { return paused; }
export function isRecording() { return timer !== null && !paused; }

// Bring the rest of the world into the capture loop:
//  - frontmost app (sd.app.frontmost), focused window (sd.windows.focused).
//  - battery (sd.battery), caffeinate (sd.caffeinate.locked / sleeping).
//  - pasteboard (sd.pasteboard.changed) for the optional clipboard column.
async function tick() {
  if (paused) return;

  const front = sd.app.frontmost.peek();
  if (!front || !front.bundleId) return;
  if (blacklist.has(front.bundleId)) return;

  if (cfg.minBatteryPct && cfg.minBatteryPct > 0) {
    const b = sd.battery.peek();
    if (b && !b.charging && typeof b.percent === "number" && b.percent < cfg.minBatteryPct) return;
  }
  const caff = sd.caffeinate.peek();
  if (caff && (caff.locked || caff.sleeping)) return;

  const focused = sd.windows.focused.peek();
  if (!focused || !focused.id) return;
  const winTitle = focused.title || "";

  const titleLower = winTitle.toLowerCase();
  for (const pat of SENSITIVE_PATTERNS) {
    if (titleLower.indexOf(pat) >= 0) return;
  }

  // Capture the focused WINDOW (mirrors HS `win:snapshot()`), not a display
  // region. sd.display.snapshot with a window-bounding rect would also pick
  // up anything overlapping that rect (other apps' windows, the menubar,
  // overlay stacks) and bake it into the OCR index. sd.windows.snapshot
  // uses CGSHWCaptureWindowList against the specific window id.
  let snap = null;
  try {
    snap = await sd.windows.snapshot(focused.id, { format: "jpeg", quality: 0.75 });
  } catch (e) {
    console.error("digup capture: snapshot error", e);
    return;
  }
  if (!snap || !snap.dataURL) {
    nilSnapshotCount++;
    if (nilSnapshotCount === 15) {
      console.warn("digup: 15 consecutive nil snapshots — Screen Recording permission?");
    }
    return;
  }
  nilSnapshotCount = 0;

  const appChanged = (front.bundleId !== lastBundle) || (winTitle !== lastTitle);
  lastBundle = front.bundleId;
  lastTitle  = winTitle;

  // Skip near-duplicate frames when nothing about the active window changed.
  // Hamming distance >= 5 over a 64-bit aHash is a sane "something visible
  // moved" threshold (matches the pHash:5 heuristic in similar tools).
  let phash;
  try { phash = await pHash(snap.dataURL); } catch (e) { phash = null; }
  if (!appChanged && lastPHash && phash) {
    const d = hammingDistance(lastPHash, phash);
    if (d < 5) return;
  }
  if (phash) lastPHash = phash;
  else if (appChanged) lastPHash = null;

  let clipText = "";
  if (cfg.captureClipboard) {
    const clip = sd.pasteboard.changed.peek();
    const t = clip && typeof clip.text === "string" ? clip.text : "";
    if (t && t !== lastClip) {
      clipText = t;
      lastClip = t;
    }
  }

  const frameId = await db.insertFrame({
    timestamp:     Date.now() / 1000,
    appBundle:     front.bundleId || "",
    appName:       front.name || "",
    windowTitle:   winTitle,
    screenshot:    snap.dataURL,
    phash:         phash || "",
    clipboardText: clipText
  });
  if (frameId == null) return;

  ocr.enqueue({
    frameId,
    dataURL:       snap.dataURL,
    clipboardText: clipText,
    ocrConfidence: cfg.ocrConfidence || 0.35
  });
}

