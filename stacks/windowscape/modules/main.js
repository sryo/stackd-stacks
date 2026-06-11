// Bootloader — equivalent to init.lua. Wires the modules and starts watchers.

import { sd } from "sd://runtime/api.js";
import { state, loadList, updateWindowOrder, isAppIncluded } from "./core.js";
import { start as startEvents, startDragBracket, endDragBracket } from "./events.js";
import { bind as bindKeybinds } from "./keybinds.js";
import { bind as bindGestures } from "./gestures.js";
import { tileWindows } from "./tiler.js";
import { scheduleSave, loadLayout } from "./restore.js";
import {
  init as initSnapshots,
  updateLayout as updateSnapshotsLayout,
  onScrollWheelEvent,
  onRightClickEvent,
  onLeftClickEvent
} from "./snapshots.js";
import { onButtonClick as onButtonClickEvent, refresh as refreshButtons } from "./buttons.js";

async function init() {
  await loadList();
  startEvents();
  bindKeybinds();
  bindGestures();

  // Hook the manifest-declared eventtap callbacks (see stack.json's
  // `eventtap` array). The Bridge invokes onTap_<name> for each match.
  // Left-click + mouse-move are routed here (not via DOM) because the
  // stack panel is clickThrough:true and the WebView never receives the
  // events natively.
  sd.events.on("snapshotsScroll",     onScrollWheelEvent);
  sd.events.on("snapshotsRightClick", onRightClickEvent);
  // Traffic-light button intercept. Consuming tap registered in stack.json;
  // the daemon's cursor-rect gate (sd.events.setTapRects, pushed by
  // buttons.js refresh) decides whether to actually swallow the click. The
  // callback below only fires after a consume — see modules/buttons.js.
  sd.events.on("windowscapeButtonClick", onButtonClickEvent);
  // leftMouseDown does TWO things: (1) snapshots strip click-handling, and
  // (2) opens the drag bracket so the next leftMouseUp can close it and
  // we decide resize-vs-reorder ONCE per drag instead of once per intra-
  // drag synth-poll bang. Sharing the eventtap callback so the daemon
  // doesn't install two taps for the same event.
  sd.events.on("snapshotsLeftClick", (payload) => {
    startDragBracket();
    onLeftClickEvent(payload);
  });
  sd.events.on("dragMouseUp", () => { endDragBracket(); });
  // mouseMoved eventtap was firing the hover handler at ~120Hz, blocking
  // every other stack's sd.mouse / sd.windows.all push. The 30Hz sd.mouse
  // signal that timetrail / focus / etc. depend on was getting starved.
  // Dropping the hover-indicator cost (snapshots tiles still work; they
  // just no longer scale up on cursor-over) buys back the fluidity.

  // Wait one tick for signals (windowsAll / displays / spaces) to populate
  // before we restore + tile. The signal subscriptions in startEvents replay
  // their last value synchronously into the callback, but spaces/displays
  // are populated asynchronously by the daemon's startup polls.
  setTimeout(async () => {
    await loadLayout();
    updateWindowOrder();
    state.onLayoutChange = () => { scheduleSave(); updateSnapshotsLayout(); };
    // Boot the snapshot subsystem — loads persisted tiles, paints strip(s),
    // starts the refresh + save timers, wires the OS minimize/deminimize
    // bangs so externally-driven minimize doesn't desync.
    await initSnapshots();
    await tileWindows();
    // Prime the button-rect cache + daemon gate so the first click after
    // boot is interceptable (without this, the cache is empty until the
    // first focus change fires a refresh).
    refreshButtons();
    // Push the focused window's inclusion verdict to overlay-border so it
    // can paint the right palette before its own first focusedChanged tick
    // resolves. Without this, the boot border briefly shows the default
    // "included" color for an excluded window.
    const fid = sd.windows.focused.peek()?.id;
    if (fid != null) {
      const w = state.windowsById[fid];
      if (w) sd.bang.declare('overlay-border.inclusion').emit({ winId: fid, included: isAppIncluded(w) });
    }
    console.log("[WindowScape] initialized");
  }, 500);
}

init().catch((e) => console.error("[WindowScape] init failed:", e));
