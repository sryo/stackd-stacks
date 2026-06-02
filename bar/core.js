import { sd } from "sd://runtime/api.js";
import ITEMS from "./items/index.js";

const SETTINGS_KEY = "enabledOverride";

const state = {
  enabledOverride: {},
  values: Object.create(null),
  intervalHandles: Object.create(null),
  mode: "normal"
};

const items = ITEMS.slice().sort((a, b) => {
  const oa = a.order ?? 100, ob = b.order ?? 100;
  if (oa !== ob) return oa - ob;
  return a.id.localeCompare(b.id);
});

// External-stack registrations live in a separate map keyed by id so a
// re-register from the same plugin replaces (no duplicates). They merge
// with the static items at relayout time. See bar.register bang handler
// at the bottom of this file.
const externalItems = new Map();

function allItems() {
  const merged = items.concat([...externalItems.values()]);
  return merged.sort((a, b) => {
    const oa = a.order ?? 100, ob = b.order ?? 100;
    if (oa !== ob) return oa - ob;
    return a.id.localeCompare(b.id);
  });
}

function isEnabled(item) {
  const o = state.enabledOverride[item.id];
  if (o !== undefined) return !!o;
  return item.defaultEnabled !== false;
}

function isVisibleInMode(item, mode) {
  if (mode === "fullscreen-minimal" && item.hideInFullscreen !== false) return false;
  return true;
}

function labelFor(item) {
  const v = state.values[item.id] || "";
  if (item.icon && v !== "") return `${item.icon} ${v}`;
  if (v !== "") return v;
  return item.icon || "";
}

const $bar = document.getElementById("bar");
const zones = {
  left:           $bar.querySelector('[data-side="left"]'),
  "center-left":  $bar.querySelector('[data-side="center-left"]'),
  "center-right": $bar.querySelector('[data-side="center-right"]'),
  right:          $bar.querySelector('[data-side="right"]')
};

function detectNotched() {
  const screen = sd.screen.current;
  if (!screen) return false;
  const menubarH = screen.frame.h - screen.visibleFrame.h;
  return menubarH > 30;
}

function applyGeometry() {
  // The window's outer height is set by StackHost (region:"menubar" auto-grows
  // to the system menu bar height). Here we only toggle the notch class so
  // center-left / center-right zones know whether to leave a notch gap.
  $bar.classList.toggle("no-notch", !detectNotched());
}

function findItem(id) {
  return items.find((i) => i.id === id) || externalItems.get(id);
}

function relayout() {
  for (const z of Object.values(zones)) z.replaceChildren();
  const notched = detectNotched();

  // Bucket visible items per side, then render. Right + center-left zones grow
  // toward the edge they're anchored to, so we render them in reverse order
  // (highest priority outermost) to match Rebar's geometry.
  const buckets = { left: [], "center-left": [], "center-right": [], right: [] };
  for (const item of allItems()) {
    if (!isEnabled(item) || !isVisibleInMode(item, state.mode)) continue;
    if (labelFor(item) === "") continue;
    let side = item.side || "right";
    if (!notched && side === "center-left") side = "center-right";
    buckets[side].push(item);
  }
  buckets["right"].reverse();
  buckets["center-left"].reverse();

  for (const side of Object.keys(buckets)) {
    for (const item of buckets[side]) {
      const el = document.createElement("div");
      el.className = "item" + (item.bold ? " bold" : "");
      el.dataset.itemId = item.id;
      el.textContent = labelFor(item);
      el.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        handleClick(item);
      });
      zones[side].appendChild(el);
    }
  }

  // fullscreen-minimal mode hides the bar entirely unless an item opted in
  // with hideInFullscreen=false. The mouse-peek path adds .fs-peek to override.
  const anyContent = allItems().some((it) =>
    isEnabled(it) && isVisibleInMode(it, state.mode) && labelFor(it) !== ""
  );
  $bar.classList.toggle("fs-minimal",
    state.mode === "fullscreen-minimal" && !anyContent);
  $bar.classList.toggle("fs-peek", state.mode === "fullscreen-peek");
}

function setValue(item, val) {
  const next = (val == null) ? "" : String(val);
  if (state.values[item.id] === next) return;
  state.values[item.id] = next;
  relayout();
}

async function tickItem(item) {
  if (!isEnabled(item)) return;
  if (item.command) {
    const r = await sd.proc.exec("/bin/sh", ["-c", item.command]);
    let val = "";
    if (r && r.code === 0 && r.stdout) {
      val = (r.stdout.split("\n")[0] || "").trim();
    }
    setValue(item, val);
  } else if (typeof item.update === "function") {
    try {
      const val = await item.update(() => relayout());
      // setup-driven items return their cached string; we still write it so
      // visibility flips when an item goes from blank → populated.
      if (val !== undefined) setValue(item, val);
    } catch (e) {
      console.error("item update failed:", item.id, e);
    }
  }
}

function startItem(item) {
  if (typeof item.setup === "function") {
    const refresh = () => {
      // The item populated its own internal cache; pull it via update().
      tickItem(item);
    };
    try { item.setup(refresh); } catch (e) { console.error("setup", item.id, e); }
  }
  if (item.command || typeof item.update === "function") {
    tickItem(item);
    const iv = item.interval ?? 0;
    if (iv > 0) {
      state.intervalHandles[item.id] = setInterval(() => tickItem(item), iv * 1000);
    }
  }
}

function stopItem(item) {
  const h = state.intervalHandles[item.id];
  if (h) { clearInterval(h); delete state.intervalHandles[item.id]; }
  if (typeof item.teardown === "function") {
    try { item.teardown(); } catch (e) { console.error("teardown", item.id, e); }
  }
  delete state.values[item.id];
}

function handleClick(item) {
  const cb = item.onClick;
  if (typeof cb === "function") {
    try { cb(); } catch (e) { console.error("onClick", item.id, e); }
  } else if (typeof cb === "string") {
    sd.proc.exec("/bin/sh", ["-c", cb]);
  }
}

// ----- right-click context menu ------------------------------------------------

document.addEventListener("contextmenu", async (e) => {
  e.preventDefault();
  const menuItems = items.map((it) => ({
    id: it.id,
    title: it.id,
    checked: isEnabled(it)
  }));
  const picked = await sd.menu.popup(menuItems);
  if (!picked) return;
  const it = findItem(picked);
  if (!it) return;
  await toggleItem(it);
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
  const fs = !!(info && info.isFullscreen);
  // Preserve peek across space-watcher events: only drop to minimal if we
  // weren't already peeking (mirrors Rebar's behavior).
  if (fs) {
    if (state.mode !== "fullscreen-peek") state.mode = "fullscreen-minimal";
  } else {
    state.mode = "normal";
  }
  relayout();
}

function trackPeek() {
  // Use sd.mouse (30Hz polled push) for peek detection — fast enough since
  // we only care about the top 2px of the screen.
  const screen = sd.screen.current;
  if (!screen) return;
  sd.mouse.subscribe((pt) => {
    if (!pt) return;
    if (state.mode !== "fullscreen-minimal" && state.mode !== "fullscreen-peek") return;

    const onThisScreen = pt.x >= screen.frame.x && pt.x < screen.frame.x + screen.frame.w;
    if (!onThisScreen) return;

    // Window outer-height = bar height; StackHost auto-sized this to the
    // system menu bar (notched or 24px). Match Rebar's geo.h for the peek
    // hysteresis (drop-back trigger).
    const barH = window.innerHeight || 26;
    const localY = pt.y - screen.frame.y;
    if (state.mode === "fullscreen-minimal" && localY < 2) {
      state.mode = "fullscreen-peek";
      relayout();
    } else if (state.mode === "fullscreen-peek" && localY > barH + 8) {
      state.mode = "fullscreen-minimal";
      relayout();
    }
  });
}

// ----- hotkey: toggle the system menu bar -------------------------------------

let menubarSuppressed = false;
window.onHotkey_toggleSystemMenubar = async () => {
  if (menubarSuppressed) {
    await sd.menubar.restore();  menubarSuppressed = false;
  } else {
    await sd.menubar.suppress(); menubarSuppressed = true;
  }
};

// ----- plugin registration -----------------------------------------------------
//
// Any stack can plug an item into the bar by firing the bar.register bang:
//
//   sd.bang('bar.register', {
//     id:        'cloudpad-url',      // unique key (re-fire to update)
//     side:      'right',             // left | center-left | center-right | right
//     order:     50,                  // lower = closer to the screen edge
//     value:     'https://...',       // initial text
//     icon:      '☁',                 // optional prefix (matches static items)
//     bold:      false,               // optional
//     onClickBang: 'cloudpad.copy'    // bang to fire on click (optional)
//   });
//
// To update the value without re-registering:
//   sd.bang('bar.update', { id: 'cloudpad-url', value: 'new text' });
//
// On bar boot, we fire bar.requestRegister so late-loading plugin stacks
// re-fire their register call. This makes initial-state convergence
// order-independent (bar may load before or after the plugins).

window.onBang_bar_register = (detail) => {
  console.log("[bar] register fired", JSON.stringify(detail));
  if (!detail || !detail.id) return;
  const itemSpec = {
    id:        String(detail.id),
    side:      detail.side || "right",
    order:     typeof detail.order === "number" ? detail.order : 100,
    icon:      detail.icon || "",
    bold:      !!detail.bold,
    defaultEnabled: detail.defaultEnabled !== false,
    onClick:   detail.onClickBang
      ? () => sd.bang(detail.onClickBang, { id: detail.id })
      : undefined,
  };
  externalItems.set(itemSpec.id, itemSpec);
  if (detail.value != null) state.values[itemSpec.id] = String(detail.value);
  relayout();
};

window.onBang_bar_unregister = (detail) => {
  if (!detail || !detail.id) return;
  externalItems.delete(String(detail.id));
  delete state.values[String(detail.id)];
  relayout();
};

window.onBang_bar_update = (detail) => {
  if (!detail || !detail.id) return;
  const it = externalItems.get(String(detail.id));
  if (!it) return; // ignore updates for unregistered items
  setValue(it, detail.value);
};

// ----- boot --------------------------------------------------------------------

(async function init() {
  applyGeometry();
  const saved = await sd.settings.get(SETTINGS_KEY);
  if (saved && typeof saved === "object") state.enabledOverride = saved;

  for (const it of items) {
    if (isEnabled(it)) startItem(it);
  }

  sd.spaces.all.subscribe(updateModeFromSpaces);
  trackPeek();

  relayout();

  // Tell plugin stacks to re-register their items. They may have fired
  // bar.register before this bar instance booted (load order isn't
  // guaranteed); this re-collect closes that race. Plugins that listen
  // to this bang re-emit their bar.register payload.
  sd.bang('bar.requestRegister', {});
})();
