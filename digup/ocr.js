import { sd } from "sd://runtime/api.js";
import * as db from "./db.js";

const MAX_QUEUE = 100;
const queue = [];
let processing = false;

const MENU_ITEMS = new Set([
  "File","Edit","View","Help","Window","Insert","Format","Tools",
  "Go","Run","Selection","Terminal","Debug","Navigate","Product",
  "Editor","Source","Refactor","Build","Analyze","Find","Table"
]);
const DAY_ABBREVS = new Set(["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]);

function isNoise(text) {
  if (text.length <= 1) return true;
  if (/^\s*$/.test(text)) return true;
  if (MENU_ITEMS.has(text)) return true;
  if (/^\d+$/.test(text)) return true;
  if (/^\d+:\d+/.test(text)) return true;
  if (/^\d+%$/.test(text)) return true;
  if (/^[\p{P}\p{S}]+$/u.test(text)) return true;
  if (DAY_ABBREVS.has(text)) return true;
  if (text === "AM" || text === "PM") return true;
  return false;
}

export function enqueue(item) {
  queue.push(item);
  while (queue.length > MAX_QUEUE) queue.shift();
  if (!processing) processNext();
}

export function queueSize() { return queue.length; }

async function processNext() {
  const item = queue.shift();
  if (!item) { processing = false; return; }
  processing = true;
  try {
    await runOne(item);
  } catch (e) {
    console.error("digup ocr:", e);
  }
  processNext();
}

async function runOne(item) {
  const { frameId, dataURL, clipboardText, ocrConfidence } = item;
  const r = await sd.vision.ocr({ image: dataURL, recognitionLevel: "accurate" });
  if (!r || !r.observations) return;

  const seen = new Set();
  const unique = [];

  for (const obs of r.observations) {
    const text = obs.text || "";
    const conf = obs.confidence || 0;
    if (conf < ocrConfidence) continue;
    if (isNoise(text)) continue;
    const b = obs.boundingBox || { x: 0, y: 0, w: 0, h: 0 };
    await db.insertFrameText(frameId, {
      text, confidence: conf,
      x: b.x, y: b.y, width: b.w, height: b.h
    });
    if (!seen.has(text)) { seen.add(text); unique.push(text); }
  }

  let fullText = unique.join("\n");
  if (clipboardText && clipboardText.length > 0) {
    fullText = fullText.length > 0 ? fullText + "\n" + clipboardText : clipboardText;
  }
  if (fullText.length > 0) {
    await db.updateFrameFullText(frameId, fullText);
  }
}
