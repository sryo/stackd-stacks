import { sd } from "sd://runtime/api.js";

const DB_FILENAME = "digup.db";

let db = null;

export async function init() {
  db = await sd.sqlite.open(DB_FILENAME);
  if (!db) throw new Error("digup: sqlite open failed");

  await db.exec("PRAGMA journal_mode = WAL");
  await db.exec("PRAGMA synchronous = NORMAL");

  await db.exec(`CREATE TABLE IF NOT EXISTS frames (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       REAL    NOT NULL,
    app_bundle      TEXT,
    app_name        TEXT,
    window_title    TEXT,
    screenshot      TEXT    NOT NULL,
    phash           TEXT    NOT NULL,
    full_text       TEXT    DEFAULT '',
    clipboard_text  TEXT    DEFAULT ''
  )`);
  await db.exec("CREATE INDEX IF NOT EXISTS idx_frames_timestamp  ON frames(timestamp)");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_frames_app_bundle ON frames(app_bundle)");

  await db.exec(`CREATE TABLE IF NOT EXISTS frame_text (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    frame_id   INTEGER NOT NULL,
    text       TEXT    NOT NULL,
    x          REAL,
    y          REAL,
    width      REAL,
    height     REAL,
    confidence REAL
  )`);
  await db.exec("CREATE INDEX IF NOT EXISTS idx_frame_text_frame_id ON frame_text(frame_id)");

  await db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS frame_fts USING fts5(
    full_text, content='frames', content_rowid='id'
  )`);
  await db.exec(`CREATE TRIGGER IF NOT EXISTS frame_fts_ai AFTER INSERT ON frames BEGIN
    INSERT INTO frame_fts(rowid, full_text) VALUES (new.id, new.full_text);
  END`);
  await db.exec(`CREATE TRIGGER IF NOT EXISTS frame_fts_ad AFTER DELETE ON frames BEGIN
    INSERT INTO frame_fts(frame_fts, rowid, full_text) VALUES('delete', old.id, old.full_text);
  END`);
  await db.exec(`CREATE TRIGGER IF NOT EXISTS frame_fts_au AFTER UPDATE OF full_text ON frames BEGIN
    INSERT INTO frame_fts(frame_fts, rowid, full_text) VALUES('delete', old.id, old.full_text);
    INSERT INTO frame_fts(rowid, full_text) VALUES (new.id, new.full_text);
  END`);

  await db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS frame_trigram USING fts5(
    full_text, content='frames', content_rowid='id', tokenize='trigram'
  )`);

  return { path: db.path };
}

export async function insertFrame(row) {
  const r = await db.query(
    `INSERT INTO frames (timestamp, app_bundle, app_name, window_title, screenshot, phash, clipboard_text)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [
      row.timestamp, row.appBundle || "", row.appName || "", row.windowTitle || "",
      row.screenshot, row.phash || "", row.clipboardText || ""
    ]
  );
  return r && r.rows && r.rows[0] ? r.rows[0].id : null;
}

export async function insertFrameText(frameId, t) {
  await db.query(
    `INSERT INTO frame_text (frame_id, text, x, y, width, height, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [frameId, t.text, t.x || 0, t.y || 0, t.width || 0, t.height || 0, t.confidence || 0]
  );
}

export async function updateFrameFullText(frameId, fullText) {
  await db.query("UPDATE frames SET full_text = ? WHERE id = ?", [fullText || "", frameId]);
  await db.query("INSERT INTO frame_trigram(frame_trigram, rowid, full_text) VALUES('delete', ?, ?)",
                 [frameId, ""]);
  await db.query("INSERT INTO frame_trigram(rowid, full_text) VALUES (?, ?)",
                 [frameId, fullText || ""]);
}

function buildMatchExpr(query) {
  const all = query.split(/\s+/).filter(Boolean);
  let words;
  if (all.length > 1) {
    words = all.map(w => w.replace(/[^\w]/g, "")).filter(w => w.length >= 2).map(w => w + "*");
  } else {
    words = all.map(w => w.replace(/[^\w]/g, "")).filter(w => w.length >= 1).map(w => w + "*");
  }
  return words.join(" ");
}

const FRAME_COLS = `f.id, f.timestamp, f.app_name, f.window_title, f.screenshot,
  CASE WHEN f.full_text = '' OR f.full_text IS NULL
       THEN (SELECT group_concat(text, ' ') FROM frame_text WHERE frame_id = f.id)
       ELSE f.full_text
  END AS matched_text`;

function rowsToResults(rows) {
  return rows.map(r => ({
    frameId:     r.id,
    timestamp:   r.timestamp,
    appName:     r.app_name,
    windowTitle: r.window_title,
    screenshot:  r.screenshot,
    matchedText: r.matched_text || ""
  }));
}

async function runFTS(matchExpr, limit) {
  if (!matchExpr) return [];
  const r = await db.query(
    `SELECT ${FRAME_COLS} FROM frame_fts fts
     JOIN frames f ON f.id = fts.rowid
     WHERE fts.full_text MATCH ?
     ORDER BY f.timestamp DESC LIMIT ?`,
    [matchExpr, limit]
  );
  return rowsToResults(r.rows);
}

async function runTrigramSearch(query, limit) {
  const q = '"' + query.replace(/"/g, "") + '"';
  const r = await db.query(
    `SELECT ${FRAME_COLS} FROM frame_trigram tri
     JOIN frames f ON f.id = tri.rowid
     WHERE frame_trigram MATCH ?
     ORDER BY f.timestamp DESC LIMIT ?`,
    [q, limit]
  );
  return rowsToResults(r.rows);
}

function mergeIntoEvents(results, mergeGap) {
  const events = [];
  let lastKey = null;
  let currentEvent = null;
  for (const r of results) {
    const key = (r.appName || "") + "\x00" + (r.windowTitle || "");
    const ts  = r.timestamp || 0;
    let shouldMerge = false;
    if (currentEvent && key === lastKey) {
      const gap = currentEvent.firstTimestamp - ts;
      if (gap >= 0 && gap <= mergeGap) shouldMerge = true;
    }
    if (shouldMerge) {
      currentEvent.firstTimestamp = ts;
      currentEvent.frameCount += 1;
      if ((!currentEvent.matchedText || currentEvent.matchedText === "") && r.matchedText) {
        currentEvent.matchedText = r.matchedText;
      }
    } else {
      currentEvent = {
        frameId:        r.frameId,
        timestamp:      r.timestamp,
        lastTimestamp:  r.timestamp,
        firstTimestamp: r.timestamp,
        appName:        r.appName,
        windowTitle:    r.windowTitle,
        screenshot:     r.screenshot,
        matchedText:    r.matchedText,
        frameCount:     1
      };
      events.push(currentEvent);
    }
    lastKey = key;
  }
  for (const e of events) e.duration = e.lastTimestamp - e.firstTimestamp;
  return events;
}

function extractTrigrams(s) {
  const set = new Set();
  const l = s.toLowerCase();
  for (let i = 0; i + 3 <= l.length; i++) set.add(l.slice(i, i + 3));
  return set;
}

function scoreAndRank(results, query) {
  const ql = query.toLowerCase();
  if (ql.length === 0) return results;
  const queryTri = extractTrigrams(ql);
  let minTs = Infinity, maxTs = 0;
  for (const r of results) {
    const ts = r.timestamp || 0;
    if (ts < minTs) minTs = ts;
    if (ts > maxTs) maxTs = ts;
  }
  const range = (maxTs - minTs) || 1;
  for (const r of results) {
    const text = (r.matchedText || "").toLowerCase();
    let triScore = 0;
    if (queryTri.size > 0) {
      let matched = 0;
      for (const t of queryTri) if (text.indexOf(t) >= 0) matched++;
      triScore = matched / queryTri.size;
    }
    const substr  = text.indexOf(ql) >= 0 ? 0.5 : 0;
    const recency = 0.1 * ((r.timestamp || 0) - minTs) / range;
    r._score = triScore + substr + recency;
  }
  results.sort((a, b) => b._score - a._score);
  return results;
}

export async function search(query, limit, mergeGap) {
  limit = limit || 50;
  mergeGap = mergeGap == null ? 10 : mergeGap;
  const expr = buildMatchExpr(query);
  const ftsRaw = await runFTS(expr, limit * 3);
  let trigramRaw = [];
  if (ftsRaw.length < limit && query.length >= 3) {
    trigramRaw = await runTrigramSearch(query, limit * 3);
  }
  const seen = new Set();
  const merged = [];
  for (const r of ftsRaw) if (!seen.has(r.frameId)) { seen.add(r.frameId); merged.push(r); }
  for (const r of trigramRaw) if (!seen.has(r.frameId)) { seen.add(r.frameId); merged.push(r); }
  merged.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  let events = mergeIntoEvents(merged, mergeGap);
  events = scoreAndRank(events, query);
  if (events.length > limit) events.length = limit;
  return events;
}

export async function findMatchInFrame(frameId, query) {
  const all = (query || "").split(/\s+/).filter(Boolean);
  if (all.length === 0) return [];
  const hasLong = all.some(w => w.length >= 4);
  const minLen = hasLong ? 4 : 3;
  let words = all.length > 1 ? all.filter(w => w.length >= minLen) : all;
  if (words.length === 0) words = all;
  const conds = words.map(() => "text LIKE ?").join(" OR ");
  const binds = [frameId, ...words.map(w => "%" + w + "%")];
  const sql = `SELECT DISTINCT x, y, width, height FROM frame_text
               WHERE frame_id = ? AND (${conds})`;
  const r = await db.query(sql, binds);
  return r.rows.map(row => ({ x: row.x, y: row.y, w: row.width, h: row.height }));
}

export async function getFrameById(frameId) {
  const r = await db.query(
    "SELECT id, timestamp, app_name, window_title, screenshot FROM frames WHERE id = ?",
    [frameId]
  );
  if (!r.rows || r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    id: row.id, timestamp: row.timestamp, appName: row.app_name,
    windowTitle: row.window_title, screenshot: row.screenshot
  };
}

export async function getAdjacentFrame(frameId, direction) {
  const sql = direction > 0
    ? "SELECT id, timestamp, app_name, window_title, screenshot FROM frames WHERE id > ? ORDER BY id ASC LIMIT 1"
    : "SELECT id, timestamp, app_name, window_title, screenshot FROM frames WHERE id < ? ORDER BY id DESC LIMIT 1";
  const r = await db.query(sql, [frameId]);
  if (!r.rows || r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    id: row.id, timestamp: row.timestamp, appName: row.app_name,
    windowTitle: row.window_title, screenshot: row.screenshot
  };
}

export async function getTimelineFrames(limit, offset) {
  limit = limit || 50; offset = offset || 0;
  const r = await db.query(
    "SELECT id, timestamp, app_name, window_title, screenshot FROM frames ORDER BY timestamp DESC LIMIT ? OFFSET ?",
    [limit, offset]
  );
  return r.rows.map(row => ({
    frameId: row.id, timestamp: row.timestamp, appName: row.app_name,
    windowTitle: row.window_title, screenshot: row.screenshot
  }));
}

export async function getStats() {
  const tf = await db.query("SELECT count(*) c FROM frames");
  const to = await db.query("SELECT count(*) c FROM frame_text");
  const da = await db.query("SELECT count(DISTINCT app_bundle) c FROM frames");
  return {
    totalFrames:  tf.rows[0].c || 0,
    totalOCR:     to.rows[0].c || 0,
    distinctApps: da.rows[0].c || 0
  };
}

export async function deleteOlderThan(timestamp) {
  const ids = await db.query("SELECT id FROM frames WHERE timestamp < ?", [timestamp]);
  if (!ids || !ids.rows || ids.rows.length === 0) return 0;

  // frame_text first (FK-style cleanup), then frames. frame_fts_ad trigger
  // mops up FTS5 contentless entries automatically.
  await db.query("DELETE FROM frame_text WHERE frame_id IN (SELECT id FROM frames WHERE timestamp < ?)",
                 [timestamp]);
  await db.query("DELETE FROM frames WHERE timestamp < ?", [timestamp]);

  // frame_trigram has no triggers (FTS5-trigger failures used to block the
  // parent INSERT — see comment on init). Per-row 'delete' commands need the
  // original indexed text to remove the right tokens; we don't have it here.
  // Mirror cleanup.lua and rebuild the whole trigram index instead.
  try {
    await db.exec("INSERT INTO frame_trigram(frame_trigram) VALUES('rebuild')");
  } catch (e) {
    console.warn("digup: trigram rebuild after prune failed:", e);
  }
  return ids.rows.length;
}
