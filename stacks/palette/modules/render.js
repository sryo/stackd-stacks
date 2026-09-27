// DOM rendering: header lead-glyph + noun chip, sectioned results, inline
// calc card, keycap chips, footer, edge dissolve, 1..9 badges. Selection
// stays a FLAT index over state.items — section headers are display-only
// interleavings, never selectable; the calc card is state.items[0] rendered
// in card form, so keyboard nav treats it like any other row.
import { sd } from "sd://runtime/api.js";
import { titleRuns } from "./logic.js";

const MAG_SVG = `<svg viewBox="0 0 16 16" width="15" height="15" fill="none"
  stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
  <circle cx="7" cy="7" r="4.6"/><line x1="10.6" y1="10.6" x2="14" y2="14"/></svg>`;

export function initRender(ctx) {
  const { state, VERBS, onRow } = ctx;
  const $q       = document.getElementById("q");
  const $results = document.getElementById("results");
  const $lead    = document.getElementById("lead");
  const $chip    = document.getElementById("nounchip");
  const $hints   = document.getElementById("hints");
  const $primary = document.getElementById("primary");
  const iconCache = new Map();

  // Wheel / trackpad scroll: keep the 1..9 badges (and the row-pick
  // hotkey's target window) in sync with what's visible, and drive the
  // edge-dissolve masks. Arrow-key nav calls updateVisibleNumbers from
  // inside render(), so no double-fire.
  $results.addEventListener("scroll", () => {
    updateVisibleNumbers();
    updateFades();
  }, { passive: true });

  function appendHighlighted(el, title, positions) {
    for (const run of titleRuns(title, positions)) {
      if (run.bold) {
        const b = document.createElement("b");
        b.textContent = run.text;
        el.append(b);
      } else {
        el.append(document.createTextNode(run.text));
      }
    }
  }

  async function iconFor(item) {
    const key = item.id;
    if (iconCache.has(key)) return iconCache.get(key);
    let url = null;
    // Menu items: no icon, matching HS canvas.lua (menuitems.lua sets
    // icon=nil). The 24px slot is still reserved so titles align across
    // mixed-source result lists.
    if (item.source === "menuitems") {
      // leave url null
    } else if (item.payload && item.payload.bundleId) {
      url = await sd.icons.app(item.payload.bundleId, { size: 32 });
    } else if (item.payload && item.payload.path) {
      url = await sd.icons.file(item.payload.path, { size: 32 });
    }
    iconCache.set(key, url);
    return url;
  }

  // ── header ────────────────────────────────────────────────────────────
  function renderHeader() {
    $lead.innerHTML = state.stage === "noun" ? MAG_SVG : "‹";
    $lead.className = "lead" + (state.stage === "noun" ? "" : " back");
    if (state.stage !== "noun" && state.selectedItem) {
      $chip.textContent = state.selectedItem.title;
      $chip.hidden = false;
    } else {
      $chip.hidden = true;
    }
    let p = "Search…";
    if (state.stage === "noun") {
      const appName = (state.openOwnerApp || "").trim();
      if (appName) p = "Search " + appName;
    } else if (state.stage === "verb") {
      p = "Verb…";
    }
    $q.placeholder = p;
  }

  // ── keycap chips ──────────────────────────────────────────────────────
  // Menu shortcut strings ("⇧⌘S") split into one chip per glyph; footer
  // hints stay one chip per hint ("⌘1", "esc").
  function keycaps(str, style) {
    const wrap = document.createElement("span");
    wrap.className = "keys";
    for (const ch of Array.from(str)) {
      const k = document.createElement("span");
      k.className = "key " + style;
      k.textContent = ch;
      wrap.append(k);
    }
    return wrap;
  }

  // ── sections ──────────────────────────────────────────────────────────
  // Headers only where the flat ranking already reads as groups: the verb
  // stage (one "Actions" run) and the empty-query noun stage (frecency
  // sorts history items first → "Recents" run, then native runs per
  // source). Typed queries rank across sources, so headers would
  // interleave — flat list there.
  function sectionLabelFor(item) {
    if (state.stage === "verb") return "Actions";
    if (item.fromHistory) return "Recents";
    if (item.source === "menuitems") return (state.openOwnerApp || "App") + " menus";
    if (item.source === "apps") return "Open apps";
    if (item.source === "installedapps") return "Applications";
    if (item.source === "files") return "Files";
    if (item.source === "shellrunner") return "Shell";
    return null;
  }

  // ── rows ──────────────────────────────────────────────────────────────
  function buildCalcCard(item, i) {
    const card = document.createElement("div");
    card.className = "row card" + (i === state.focused ? " selected" : "");
    const expr = document.createElement("span");
    expr.className = "expr";
    expr.textContent = item.payload.expression;
    const arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.textContent = "→";
    const val = document.createElement("span");
    val.className = "val";
    val.textContent = item.payload.formatted;
    card.append(expr, arrow, val);
    return card;
  }

  function buildRow(item, i) {
    if (item.source === "calc") return buildCalcCard(item, i);
    const row = document.createElement("div");
    row.className = "row" + (i === state.focused ? " selected" : "");
    if (item.enabled === false) row.classList.add("disabled");
    // Left blank by default; updateVisibleNumbers() fills 1..9 for the
    // rows currently scrolled into view.
    const num = document.createElement("span"); num.className = "num"; num.textContent = "";
    const ic = document.createElement("span"); ic.className = "icon";
    iconFor(item).then(u => {
      if (!u) return;
      const img = document.createElement("img");
      img.src = u;
      ic.append(img);
    });
    // Menu state mark (✓ on) — canvas.lua:519-527.
    const mark = document.createElement("span"); mark.className = "mark";
    if (item.markChar) mark.textContent = item.markChar;
    const name = document.createElement("span"); name.className = "name";
    appendHighlighted(name, item.title || "", item.matchPositions);
    // Subtitle = menu path (menuitems) / window count (apps) / parent dir
    // (files). Trailing edge, tertiary.
    const sub = document.createElement("span"); sub.className = "sub";
    sub.textContent = item.subtitle || "";
    // History mark — HS canvas.lua:531-538 ("↺" on trailing edge).
    const hist = document.createElement("span"); hist.className = "hist";
    if (item.fromHistory) hist.textContent = "↺";
    row.append(num, ic, mark, name, sub, hist);
    // Accessory = menu keyboard shortcut, one outline keycap per glyph.
    if (item.accessory) row.append(keycaps(item.accessory, "outline"));
    return row;
  }

  function buildEmptyState() {
    const box = document.createElement("div");
    box.className = "empty";
    if (state.query !== "") {
      const msg = document.createElement("div");
      msg.className = "msg";
      msg.textContent = "No matches for “" + state.query + "”";
      const pill = document.createElement("div");
      pill.className = "pill";
      const k = document.createElement("span"); k.className = "key filled"; k.textContent = "↵";
      const l = document.createElement("span"); l.textContent = "Ask Muse";
      pill.append(k, l);
      box.append(msg, pill);
    } else {
      const msg = document.createElement("div");
      msg.className = "msg";
      msg.textContent = "Type to search";
      box.append(msg);
    }
    return box;
  }

  // ── footer ────────────────────────────────────────────────────────────
  function renderFooter() {
    $hints.innerHTML = "";
    $primary.innerHTML = "";
    const item = state.items[state.focused];
    const hints = [];
    let primary = null;
    if (state.items.length === 0) {
      if (state.query !== "") primary = ["Ask Muse", "↵"];
    } else if (state.stage === "noun") {
      const default_ = (item && item.defaultVerb) || "activate";
      if (item && VERBS[default_]) primary = [VERBS[default_].label, "↵"];
      let n = 0;
      for (const vid of ((item && item.verbs) || [])) {
        if (vid === default_) continue;
        const v = VERBS[vid];
        if (!v) continue;
        n += 1;
        if (n > 3) break;
        hints.push(["⌘" + n, v.label]);
      }
      if (item && item.fromHistory) hints.push(["⌘⌫", "Forget"]);
      hints.push(["⇥", "verbs"]);
    } else if (state.stage === "verb") {
      primary = ["Run", "↵"];
      hints.push(["⇧⇥", "back"]);
    }
    hints.push(["esc", state.stage === "noun" ? "close" : "back"]);
    for (const [k, l] of hints) {
      const w = document.createElement("span"); w.className = "hint";
      const kk = document.createElement("span"); kk.className = "key filled"; kk.textContent = k;
      const ll = document.createElement("span"); ll.textContent = l;
      w.append(kk, ll); $hints.append(w);
    }
    if (primary) {
      const ll = document.createElement("span"); ll.className = "plabel"; ll.textContent = primary[0];
      const kk = document.createElement("span"); kk.className = "key filled"; kk.textContent = primary[1];
      $primary.append(ll, kk);
    }
  }

  // ── main render ───────────────────────────────────────────────────────
  function render() {
    renderHeader();
    $results.innerHTML = "";
    let focusedRow = null;
    const showSections = state.stage === "verb"
      || (state.stage === "noun" && state.query === "");
    let lastLabel = null;
    if (state.items.length === 0) {
      $results.append(buildEmptyState());
    }
    state.items.forEach((item, i) => {
      if (showSections) {
        const label = sectionLabelFor(item);
        if (label && label !== lastLabel) {
          const h = document.createElement("div");
          h.className = "section";
          h.textContent = label;
          $results.append(h);
          lastLabel = label;
        }
      }
      const row = buildRow(item, i);
      row.addEventListener("mousedown", (e) => { e.preventDefault(); });
      row.addEventListener("click", () => onRow(i));
      $results.append(row);
      if (i === state.focused) focusedRow = row;
    });
    // Keep the highlighted row inside the visible viewport so ↑/↓ never
    // strands the selection off-screen. `nearest` avoids the jarring
    // center-on-every-keystroke that `smooth`/`center` would cause.
    if (focusedRow) focusedRow.scrollIntoView({ block: "nearest" });
    // scrollIntoView may have changed scrollTop synchronously; update the
    // 1..9 badges + visibleStart pointer now so the row-pick hotkey lines
    // up with what the user actually sees.
    updateVisibleNumbers();
    updateFades();
    renderFooter();
  }

  // 1..9 badges reset to the visible window every time scroll changes.
  // Rows are variable-height now (sections, calc card), so the first
  // visible row comes from offsets, not a fixed row-height division.
  // Latches `state.visibleStart` so bare-digit hotkey N picks the Nth
  // VISIBLE row (not the Nth absolute item).
  function updateVisibleNumbers() {
    const rows = $results.querySelectorAll(".row");
    if (rows.length === 0) { state.visibleStart = 0; return; }
    const top = $results.scrollTop;
    let start = 0;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].offsetTop + rows[i].offsetHeight > top + 1) { start = i; break; }
    }
    state.visibleStart = start;
    rows.forEach((row, i) => {
      const num = row.querySelector(".num");
      if (!num) return;
      const visIdx = i - start;
      num.textContent = (visIdx >= 0 && visIdx < 9) ? String(visIdx + 1) : "";
    });
  }

  // Edge dissolve: rows fade out approaching the header/footer instead of
  // hard-clipping. Mask bands activate only when there is actually content
  // past the edge, so a short list renders unmasked.
  function updateFades() {
    const top = $results.scrollTop;
    const max = $results.scrollHeight - $results.clientHeight;
    $results.style.setProperty("--fade-top", (top > 2 ? 20 : 0) + "px");
    $results.style.setProperty("--fade-bottom", (max - top > 2 ? 24 : 0) + "px");
  }

  return { render };
}
