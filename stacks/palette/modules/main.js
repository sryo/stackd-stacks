// Palette — faithful port of the user's Hammerspoon Palette.
// Two-stage noun→verb command palette with subsequence matcher + frecency
// boost + row quickpicks + verb quickpicks. Sources: menuitems / apps /
// installedapps / calc / shellrunner / files. Mirrors the lua structure at
// ~/.hammerspoon/Palette/.
//
// Trigger: Ctrl+Cmd+Space hotkey, or `sd.bang('palette.open')` from any
// stack.
import { sd } from "sd://runtime/api.js";
import { rank } from "./matcher.js";
import { createGeneration, digitPicksRow, clampToScreen } from "./logic.js";
import { recents } from "./recents.js";
import {
  SELF, appsSource, menuItemsSource, installedSource, calcSource,
  shellSource, filesSource, rebuildInstalled, abbreviatePath,
  getPriorFront, resetMenuCache,
} from "./sources.js";
import { VERBS } from "./verbs.js";
import { initRender } from "./render.js";

// ───────────────────────────── state ─────────────────────────────────────
const state = {
  open: false,
  stage: "noun",                   // "noun" | "verb"
  query: "",
  raw: [],
  items: [],
  focused: 0,
  selectedItem: null,
  history: [],
  // Index of the first row currently scrolled into view. Bare-digit 1..9
  // hotkeys pick the Nth row STARTING FROM here, not from absolute index
  // 0 — so as you arrow-scroll past row 9, the numbers shown next to the
  // currently-visible rows still go 1..9 and the hotkeys follow.
  visibleStart: 0,
  // App that owned focus at the moment open() ran. Used by the
  // frontmost-change watcher below to detect "user switched away" and
  // auto-dismiss — the equivalent of init.lua's click-outside dismissTap.
  openOwnerApp: null,
  // Set true one tick after invoke() so the blur listener doesn't
  // dismiss during the panel's own focus handover.
  armedForDismiss: false
};

const $q = document.getElementById("q");
const { render } = initRender({
  state, VERBS,
  onRow: (i) => { state.focused = i; activateFocused(); }
});

// Clicks anywhere on the panel chrome (footer, header, gaps between rows)
// must not steal focus from the input — otherwise the window-blur
// dismiss-guard fires while the user thought they were clicking dead
// space inside the palette. Rows preventDefault their own mousedown in
// render.js.
document.body.addEventListener("mousedown", (e) => {
  if (e.target === $q) return;
  e.preventDefault();
});

// ───────────────────────────── stage ops ─────────────────────────────────
async function buildPool(query) {
  if (state.stage === "verb") return state.raw;
  const pool = state.raw.slice();
  // Dynamic sources re-evaluate per query.
  const dyn = [calcSource, shellSource, filesSource];
  for (const src of dyn) {
    try {
      const list = await src.list(query);
      if (Array.isArray(list)) for (const it of list) pool.push(it);
    } catch (e) { console.error("palette: dynamic source", src.id, e); }
  }
  return pool;
}
// Keystrokes overlap refreshes (files/shell sources await IPC); only the
// newest one may write state.items, and Enter waits for it to land.
const refreshGen = createGeneration();
function refresh() {
  const token = refreshGen.next();
  const query = state.query;
  return refreshGen.track((async () => {
    const pool = await buildPool(query);
    if (!refreshGen.isCurrent(token)) return;
    state.items = rank(pool, query, recents.score);
    state.focused = Math.min(Math.max(0, state.focused), Math.max(0, state.items.length - 1));
    render();
  })());
}
function pushStage(newStage, newRaw, opts) {
  state.history.push({
    stage: state.stage, query: state.query, raw: state.raw, items: state.items,
    focused: state.focused, selectedItem: state.selectedItem
  });
  state.stage = newStage;
  state.query = "";
  state.raw = newRaw;
  state.focused = 0;
  if (opts && opts.selectedItem) state.selectedItem = opts.selectedItem;
  $q.value = "";
  $q.setSelectionRange(0, 0);
  refresh();
}
function popStage() {
  const prev = state.history.pop();
  if (!prev) return false;
  refreshGen.next();
  Object.assign(state, prev);
  $q.value = state.query;
  const n = state.query.length;
  $q.setSelectionRange(n, n);
  render();
  return true;
}
function verbItemsFor(item) {
  const declared = item.verbs || [item.defaultVerb || "activate"];
  const out = [];
  for (const vid of declared) {
    const v = VERBS[vid];
    if (v) out.push({
      id: "verb:" + v.id, title: v.label, subtitle: "",
      source: "verbs", payload: { verb: v }, defaultVerb: null,
      matchPositions: []
    });
  }
  return out;
}
function advanceFromNoun() {
  if (state.stage !== "noun") return;
  const item = state.items[state.focused];
  if (!item) return;
  const list = verbItemsFor(item);
  if (list.length === 0) return;
  pushStage("verb", list, { selectedItem: item });
}

async function runVerb(verb, item) {
  if (!verb || !item) return;
  if (verb.keepOpen) {
    let directive = null;
    try { directive = await verb.run(item); }
    catch (e) { console.error("palette: verb failed", e); }
    recents.record(item.source, item.id);
    recents.record("verb:" + item.source, verb.id);
    if (directive && directive.rewriteQuery != null) {
      state.query = directive.rewriteQuery;
      state.focused = 0;
      $q.value = state.query;
      // Park the caret at end of the rewritten query so the next
      // keystroke continues typing forward (HS: textbuf.charLen).
      const n = state.query.length;
      $q.setSelectionRange(n, n);
      await refresh();
    }
    return;
  }
  try { await verb.run(item); } catch (e) { console.error("palette: verb failed", e); }
  recents.record(item.source, item.id);
  recents.record("verb:" + item.source, verb.id);
  dismiss();
}

// Fallback when Enter lands on an empty result list (typed something the
// matcher rejected). Mirrors init.lua:270-272 / askMuseWithQuery — ship
// the raw query off to Muse as a free-form question so the user never
// hits a "nothing to do" dead end.
async function askMuseWithQuery(query) {
  await runVerb(VERBS.askmuse, { title: query, payload: {}, source: "ask" });
}
async function activateFocused() {
  if (state.stage === "noun") {
    if (state.items.length === 0 && state.query !== "") {
      await askMuseWithQuery(state.query);
      return;
    }
    const item = state.items[state.focused];
    if (!item) return;
    const verb = VERBS[item.defaultVerb || "activate"];
    if (verb) await runVerb(verb, item);
  } else if (state.stage === "verb") {
    const row = state.items[state.focused];
    if (!row || !row.payload || !row.payload.verb) return;
    await runVerb(row.payload.verb, state.selectedItem);
  }
}

// ──────────────────── mouse-anchored placement ───────────────────────────
// Mirrors canvas.lua mouseAnchorFrame(). Lands the cursor on row 1's
// center so scroll / click work without moving the mouse. Clamps inside
// the cursor's screen with 8px margin.
// The panel's size comes from the manifest; the WebView fills it, so the
// viewport is the panel size.
const LEFT_BOX_W = 520, Y_OFFSET = 90, MARGIN = 8;
function moveClamped(x, y, sf) {
  const p = clampToScreen(x, y, window.innerWidth, window.innerHeight, sf, MARGIN);
  return sd.window.setFrame(p);
}
async function placePanel() {
  const m = await sd.mouse.first();
  const scr = m.display || (sd.display.all.peek() || [])[0] || null;
  await moveClamped(m.x - LEFT_BOX_W / 2, m.y - Y_OFFSET, scr ? scr.frame : null);
}

// Bar-anchored placement. Used by `sd.bang('palette.open', { under: 'bar' })`
// — typically a click on the Rebar frontmost-app item. Drops the palette
// one bar-height below the menubar at the click's x. The gap scales with
// the bar (vf.y - sf.y), so notched displays (~38px bar) get more
// breathing room than regular ones (~24px), and the panel never collides
// with the bar regardless of display.
async function placePanelUnderBar() {
  const m = await sd.mouse.first();
  const scr = m.display || (sd.display.all.peek() || [])[0] || null;
  const sf = scr ? scr.frame : null;
  const vf = scr ? scr.visibleFrame : null;
  const barH = (sf && vf) ? Math.max(0, vf.y - sf.y) : 24;
  const y = (vf ? vf.y : (sf ? sf.y + barH : 0)) + barH;
  await moveClamped(m.x - LEFT_BOX_W / 2, y, sf);
}

async function open(opts) {
  // Rebuild the menu tree every open (matches menuitems.lua, which
  // re-walks the AX menu bar each time). Caching across opens would
  // surface stale enabled/marked state when the user toggles "View >
  // Show X" outside the palette and re-opens.
  resetMenuCache();
  // Snapshot the owner app BEFORE walking the menu (so menuitemsSource
  // and the dismiss watcher agree on which app this session belongs to).
  // Anything else becoming frontmost is a switch-away → dismiss. Fall
  // back to a fresh peek() in case the priorFront subscriber hasn't
  // fired yet (palette opened on launch).
  const priorFront = getPriorFront();
  let owner = (priorFront && priorFront.name) || null;
  if (!owner) {
    const peeked = sd.app.frontmost.peek();
    if (peeked && peeked.name && peeked.name !== SELF) owner = peeked.name;
  }
  state.openOwnerApp = owner;
  // Static sources fan out concurrently.
  const [menuItems, apps, installed] = await Promise.all([
    menuItemsSource.list().catch(() => []),
    appsSource.list().catch(() => []),
    installedSource.list().catch(() => [])
  ]);
  const raw = menuItems.concat(apps).concat(installed);
  state.open = true; state.stage = "noun"; state.query = ""; state.raw = raw;
  state.focused = 0; state.history = []; state.selectedItem = null;
  $q.value = "";
  await refresh();
  // Placement BEFORE invoke so the panel materializes at its final spot
  // — no flash-then-jump. `opts.under === 'bar'` (fired by Rebar's
  // frontmost-app item) snaps below the menubar instead of centering on
  // the cursor.
  if (opts && opts.under === "bar") await placePanelUnderBar();
  else await placePanel();
  await sd.window.invoke();
  $q.focus();
  // Arm the focus-loss dismiss guard one tick AFTER focus lands. Earlier
  // blur transitions during invoke would otherwise dismiss the panel
  // before the user has a chance to type.
  requestAnimationFrame(() => { state.armedForDismiss = true; });
}
async function dismiss() {
  state.open = false; state.armedForDismiss = false; state.history = [];
  await sd.window.dismiss();
}

// ──────────────────────────── keyboard ────────────────────────────────────
$q.addEventListener("input", () => { state.query = $q.value; state.focused = 0; refresh(); });
$q.addEventListener("keydown", async (e) => {
  const item = state.items[state.focused];
  if (e.key === "ArrowDown") { e.preventDefault();
    if (state.focused < state.items.length - 1) { state.focused += 1; render(); }
    return;
  }
  if (e.key === "ArrowUp") { e.preventDefault();
    if (state.focused > 0) { state.focused -= 1; render(); }
    return;
  }
  if (e.key === "Enter") { e.preventDefault(); await refreshGen.settled(); await activateFocused(); return; }
  if (e.key === "Tab") {
    e.preventDefault();
    if (e.shiftKey) { if (!popStage()) await dismiss(); }
    else {
      // Files-source items: Tab autocompletes the query (HS behavior).
      if (state.stage === "noun" && item && item.source === "files"
          && item.payload && item.payload.path) {
        let nq = abbreviatePath(item.payload.path);
        if (item.payload.isDir) {
          nq += "/";
          recents.record("files", item.payload.path);
        }
        state.query = nq;
        state.focused = 0;
        $q.value = nq;
        $q.setSelectionRange(nq.length, nq.length);
        await refresh();
        return;
      }
      advanceFromNoun();
    }
    return;
  }
  if (e.key === "Escape") { e.preventDefault();
    if (!popStage()) await dismiss();
    return;
  }
  if (e.key === "Backspace" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    if (state.stage === "noun" && item && item.fromHistory) {
      recents.forget(item.source, item.id);
      refresh();
    }
    return;
  }
  // Cmd+1..9 — pick alternate verb for focused noun.
  if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
    e.preventDefault();
    if (state.stage !== "noun" || !item) return;
    const n = parseInt(e.key, 10);
    const default_ = item.defaultVerb || "activate";
    let count = 0;
    for (const vid of (item.verbs || [])) {
      if (vid === default_) continue;
      count += 1;
      if (count === n) {
        const v = VERBS[vid];
        if (v) await runVerb(v, item);
        return;
      }
    }
    return;
  }
  // Bare 1..9 — pick the Nth visible row and run its default verb
  // (keys.lua's itemQuickPick: no modifier). Inside an arithmetic query
  // the digit is typed instead, so the calculator stays reachable.
  if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
      && /^[1-9]$/.test(e.key) && digitPicksRow(state.stage, state.query)) {
    e.preventDefault();
    await refreshGen.settled();
    const n = parseInt(e.key, 10);
    // Pick the Nth currently-visible row (relative to scroll), not the
    // Nth absolute item — matches the 1..9 badge the user sees.
    const idx = (state.visibleStart || 0) + (n - 1);
    const row = state.items[idx];
    if (!row) return;
    state.focused = idx;
    if (state.stage === "noun") {
      const verb = VERBS[row.defaultVerb || "activate"];
      if (verb) await runVerb(verb, row);
    } else if (state.stage === "verb" && row.payload && row.payload.verb) {
      await runVerb(row.payload.verb, state.selectedItem);
    }
  }
});

// ───────────────────────────── lifecycle ──────────────────────────────────
// Theme follows the system appearance. The attribute goes on <html>, not
// body — index.css derives its color tokens from --base on :root.
sd.appearance.subscribe((a) => {
  document.documentElement.dataset.theme = (a && a.dark) ? "dark" : "light";
});

sd.hotkey.on("open", () => open());

// External entry: any stack can fire `sd.bang('palette.open', { under: 'bar' })`
// — Rebar's frontmost-app item does this on click so the palette drops
// directly below the menubar instead of jumping to the cursor.
sd.bang.declare("palette.open").on((detail) => open(detail || {}));

// Close on focus-loss — two paths, both equivalent to init.lua's
// dismissTap closing the palette when a click lands outside its frame:
//
//   1. Window blur (catches same-app click-outside). The palette runs in
//      a .nonactivatingPanel, so the prior frontmost app stays frontmost
//      throughout — clicking into THAT app's window doesn't fire any
//      app-change notification. But the panel loses key status, and
//      `window` (the WKWebView's owning NSWindow) fires the JS `blur`
//      event. We defer the dismiss one tick so a row-click handler can
//      run first (mousedown → blur → click order means blur races click
//      otherwise).
//   2. Frontmost change (catches Cmd+Tab and clicking another app). When
//      the frontmost app becomes something OTHER than the open-owner and
//      OTHER than stackd, the user switched away.
window.addEventListener("blur", () => {
  if (!state.open || !state.armedForDismiss) return;
  setTimeout(() => { if (state.open) dismiss(); }, 0);
});
sd.app.frontmost.subscribe((a) => {
  if (!a || !a.name) return;
  if (a.name === SELF) return;
  if (!state.open) return;
  // No baseline owner recorded → don't guess; skip rather than risk
  // dismissing during the palette's own bring-up.
  if (!state.openOwnerApp) return;
  if (a.name === state.openOwnerApp) return;
  dismiss();
});

(async () => {
  await recents.init();
  // Fire and forget — mdfind ~500ms; we don't block opening.
  rebuildInstalled();
})();
