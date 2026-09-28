import { sd } from "sd://runtime/api.js";
import ITEMS from "./items/index.js";
import { isPrimaryScreen, nextPeekMode, interactiveRects, isNotched, zoneItems, centerZoneMax } from "./logic.js";

const SETTINGS_KEY = "enabledOverride";

const state = {
  enabledOverride: {},
  values: Object.create(null),
  running: Object.create(null),   // item id → stop()
  mode: "normal"
};

// Items added at runtime (bar.register, or an item's own bar.register call)
// keyed by id, so re-registering replaces instead of duplicating.
const externalItems = new Map();

function allItems() {
  return ITEMS.concat([...externalItems.values()]);
}

function findItem(id) {
  return ITEMS.find((i) => i.id === id) || externalItems.get(id);
}

function isEnabled(item) {
  const o = state.enabledOverride[item.id];
  if (o !== undefined) return !!o;
  return item.defaultEnabled !== false;
}

function labelFor(item) {
  const v = state.values[item.id] || "";
  if (item.icon && v !== "") return `${item.icon} ${v}`;
  if (v !== "") return v;
  return item.icon || "";
}

// SF Symbol support: a `{sf:name}` token in any label (item.icon or value)
// renders as a mask tinted by the item's text color. The daemon's sd.symbol
// RPC returns { dataURL, width, height }; we cache per name and re-lay-out
// once a fetch lands. null = known-bad name (don't re-fetch); undefined =
// still in flight (render nothing for that one frame).
const sfCache = new Map();      // name → {dataURL,width,height} | null
const sfPending = new Set();

function getSf(name) {
  if (sfCache.has(name)) return sfCache.get(name);
  if (!sfPending.has(name)) {
    sfPending.add(name);
    sd.symbol.render(name, { size: 15 })
      .then((res) => { sfCache.set(name, res || null); sfPending.delete(name); relayout(); })
      .catch(() => { sfCache.set(name, null); sfPending.delete(name); });
  }
  return undefined;
}

const SF_TOKEN = /\{sf:([a-z0-9.]+)\}/gi;

function renderLabel(el, str) {
  el.replaceChildren();
  let last = 0, m;
  SF_TOKEN.lastIndex = 0;
  while ((m = SF_TOKEN.exec(str)) !== null) {
    if (m.index > last) el.appendChild(document.createTextNode(str.slice(last, m.index)));
    const sf = getSf(m[1]);
    if (sf) {
      const span = document.createElement("span");
      span.className = "sf";
      span.style.setProperty("--sf-url", `url("${sf.dataURL}")`);
      span.style.setProperty("--sf-aspect", String(sf.width / sf.height));
      el.appendChild(span);
    }
    last = m.index + m[0].length;
  }
  if (last < str.length) el.appendChild(document.createTextNode(str.slice(last)));
}

const $bar = document.getElementById("bar");
const zones = {
  left:           $bar.querySelector('[data-side="left"]'),
  "center-left":  $bar.querySelector('[data-side="center-left"]'),
  "center-right": $bar.querySelector('[data-side="center-right"]'),
  right:          $bar.querySelector('[data-side="right"]')
};

// The window's height is the system menu bar's (region:"menubar"); here the
// center zones are fitted around this display's notch, if it has one.
function applyGeometry() {
  const screen = sd.screen.current;
  const notched = isNotched(screen);
  $bar.classList.toggle("no-notch", !notched);
  if (notched) {
    document.documentElement.style.setProperty("--bar-notch-pad-w", screen.notch.width + "px");
  }
}

function relayout() {
  const visible = allItems().filter((it) => isEnabled(it) && labelFor(it) !== "");
  const byZone = zoneItems(visible, isNotched(sd.screen.current));
  for (const [side, list] of Object.entries(byZone)) {
    zones[side].replaceChildren(...list.map((item) => {
      const el = document.createElement("div");
      el.className = "item" + (item.bold ? " bold" : "");
      el.dataset.itemId = item.id;
      renderLabel(el, labelFor(item));
      el.addEventListener("mousedown", (e) => {
        if (e.button === 0) handleClick(item);
      });
      return el;
    }));
  }
  capCenterZones();
  $bar.classList.toggle("fs-minimal", state.mode === "fullscreen-minimal");
  scheduleInteractiveRects();
}

// The zones are positioned independently, so a center zone would otherwise
// draw over the side zone it grows toward. Its items ellipsize instead.
function capCenterZones() {
  const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--bar-item-gap")) || 0;
  const cap = (zone, side, anchorKey, sideKey) => {
    zone.style.maxWidth = "";
    if (!side.childElementCount) return;
    const max = centerZoneMax(zone.getBoundingClientRect()[anchorKey], side.getBoundingClientRect()[sideKey], gap);
    zone.style.maxWidth = max + "px";
  };
  cap(zones["center-right"], zones.right, "left", "left");
  cap(zones["center-left"], zones.left, "right", "right");
}

function setValue(id, val) {
  const next = (val == null) ? "" : String(val);
  if (state.values[id] === next) return;
  state.values[id] = next;
  relayout();
}

// ----- plugin registration -----------------------------------------------------
//
// Any stack can plug an item into the bar by firing the bar.register bang:
//
//   sd.bang('bar.register', {
//     id:        'cloudpad-url',      // unique key (re-fire to update)
//     side:      'right',             // left | center-left | center-right | right
//     order:     50,                  // lower = closer to the screen edge
//     value:     'https://...',       // initial text
//     icon:      '{sf:cloud}',        // optional prefix; {sf:name} renders an SF Symbol
//     bold:      false,               // optional
//     onClickBang: 'cloudpad.copy'    // bang to fire on click (optional)
//   });
//
// To update the value without re-registering:
//   sd.bang('bar.update', { id: 'cloudpad-url', value: 'new text' });
//
// On boot the bar fires bar.requestRegister so plugin stacks that loaded
// first re-fire their register call.
//
// Built-in items with several entries (now playing) get the same three
// calls as `bar`, the second argument to setup(), with a local onClick.

const bar = {
  register(spec) {
    externalItems.set(spec.id, {
      id: spec.id,
      side: spec.side || "right",
      order: typeof spec.order === "number" ? spec.order : 100,
      icon: spec.icon || "",
      bold: !!spec.bold,
      defaultEnabled: spec.defaultEnabled !== false,
      onClick: spec.onClick
    });
    if (spec.value != null) state.values[spec.id] = String(spec.value);
    relayout();
  },
  unregister(id) {
    externalItems.delete(id);
    delete state.values[id];
    relayout();
  },
  update(id, value) {
    if (externalItems.has(id)) setValue(id, value);
  }
};

sd.bang.declare("bar.register").on((detail) => {
  if (!detail || !detail.id) return;
  const id = String(detail.id);
  bar.register({
    ...detail,
    id,
    onClick: detail.onClickBang ? () => sd.bang(detail.onClickBang, { id }) : undefined
  });
});

sd.bang.declare("bar.unregister").on((detail) => {
  if (detail && detail.id) bar.unregister(String(detail.id));
});

sd.bang.declare("bar.update").on((detail) => {
  if (detail && detail.id) bar.update(String(detail.id), detail.value);
});

// ----- item lifecycle ----------------------------------------------------------
//
// setup(set, bar) pushes the item's label through set() and may return a
// cleanup function, run when the item is toggled off. A set() that lands
// after that (a fetch in flight) is ignored.

function startItem(item) {
  let live = true;
  let cleanup;
  try {
    cleanup = item.setup((val) => { if (live) setValue(item.id, val); }, bar);
  } catch (e) {
    console.error("setup", item.id, e);
  }
  state.running[item.id] = () => {
    live = false;
    if (typeof cleanup === "function") cleanup();
  };
}

function stopItem(item) {
  const stop = state.running[item.id];
  delete state.running[item.id];
  try { if (stop) stop(); } catch (e) { console.error("cleanup", item.id, e); }
  delete state.values[item.id];
}

function handleClick(item) {
  if (typeof item.onClick !== "function") return;
  try { item.onClick(); } catch (e) { console.error("onClick", item.id, e); }
}

// ----- click-through routing ---------------------------------------------------
//
// The panel covers the whole menu bar strip and is click-through, so the
// system menu bar stays usable. The daemon turns click-through off while the
// pointer is over one of these rects. They are viewport coordinates the
// daemon maps through the panel frame, so they are re-sent after every
// relayout and whenever the panel moves.

let rectsScheduled = false;

function scheduleInteractiveRects() {
  if (rectsScheduled) return;
  rectsScheduled = true;
  requestAnimationFrame(() => {
    rectsScheduled = false;
    const boxes = [...document.querySelectorAll(".item")].map((el) => el.getBoundingClientRect());
    sd.window.setInteractiveRects(interactiveRects(boxes));
  });
}

window.addEventListener("stackd:frame", scheduleInteractiveRects);

// ----- right-click context menu ------------------------------------------------

document.addEventListener("contextmenu", async (e) => {
  e.preventDefault();
  const picked = await sd.menu.popup(ITEMS.map((it) => ({
    id: it.id,
    title: it.id,
    checked: isEnabled(it)
  })));
  const it = picked && findItem(picked);
  if (it) await toggleItem(it);
});

async function toggleItem(it) {
  const next = !isEnabled(it);
  state.enabledOverride[it.id] = next;
  await sd.settings.set(SETTINGS_KEY, state.enabledOverride);
  if (next) startItem(it); else stopItem(it);
  relayout();
}

// ----- fullscreen mode tracking ------------------------------------------------

function updateModeFromSpaces(all) {
  if (!all) return;
  const uuid = sd.screen.current && sd.screen.current.uuid;
  const info = uuid && all[uuid];
  if (info && info.isFullscreen) {
    // A space event while peeking keeps the peek.
    if (state.mode !== "fullscreen-peek") state.mode = "fullscreen-minimal";
  } else {
    state.mode = "normal";
  }
  relayout();
}

function trackPeek(pt) {
  const next = nextPeekMode(state.mode, pt, sd.screen.current, window.innerHeight);
  if (next === state.mode) return;
  state.mode = next;
  relayout();
}

// ----- system menu bar ---------------------------------------------------------
//
// The bar is transparent, so the system menu bar would show through it. It stays
// suppressed while the bar is loaded (the daemon restores it on unload); the
// hotkey brings it back on demand. Suppression is global, so only the instance
// on the primary display owns it. A chord shared by every instance reaches only
// the one that bound it first, so the hotkey broadcasts and the owner acts.

let menubarSuppressed = false;
const menubarToggle = sd.bang.declare("bar.menubar.toggle");
sd.hotkey.on("toggleSystemMenubar", () => sd.bang("bar.menubar.toggle"));
menubarToggle.on(async () => {
  if (!isPrimaryScreen(sd.screen.current)) return;
  if (menubarSuppressed) {
    await sd.menubar.restore();  menubarSuppressed = false;
  } else {
    await sd.menubar.suppress(); menubarSuppressed = true;
  }
});

// ----- boot --------------------------------------------------------------------

window.addEventListener("sd:screen", () => {
  applyGeometry();
  relayout();
});

(async function init() {
  applyGeometry();
  if (isPrimaryScreen(sd.screen.current)) {
    menubarSuppressed = !!(await sd.menubar.suppress());
  }
  const saved = await sd.settings.get(SETTINGS_KEY);
  if (saved && typeof saved === "object") state.enabledOverride = saved;

  for (const it of ITEMS) {
    if (isEnabled(it)) startItem(it);
  }

  sd.spaces.all.subscribe(updateModeFromSpaces);
  sd.mouse.subscribe(trackPeek);

  // Follow the system menubar: dark text over a bright wallpaper, light
  // text over a dark one. Light text until the daemon reports otherwise.
  sd.bind([document.documentElement, "data-menubar"], sd.appearance,
    (a) => a?.menubarDark === false ? "light" : "dark");

  relayout();

  sd.bang.declare("bar.requestRegister").emit({});
})();
