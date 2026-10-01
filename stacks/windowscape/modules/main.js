// Bootloader. Wires the modules and starts watchers.

import { sd } from "sd://runtime/api.js";
import { cfg } from "./config.js";
import { state, loadList, loadFixedWidthApps, updateWindowOrder, emitInclusion } from "./core.js";
import { start as startEvents, startDragBracket, endDragBracket } from "./events.js";
import { bind as bindKeybinds } from "./keybinds.js";
import { bind as bindGestures } from "./gestures.js";
import { tileWindows } from "./tiler.js";
import { scheduleSave, loadLayout } from "./restore.js";
import {
  init as initSnapshots,
  updateLayout as updateSnapshotsLayout,
  onLeftClickEvent
} from "./snapshots.js";

async function init() {
  await loadList();
  await loadFixedWidthApps();
  startEvents();
  bindKeybinds();
  bindGestures();

  // Hook the manifest-declared eventtap callbacks (see stack.json's
  // `eventtap` array). The Bridge invokes onTap_<name> for each match.
  // These are global, non-consuming observers: the snapshot rail and its
  // context menu take their own clicks (snapshots.js).
  // leftMouseDown does TWO things: (1) dismisses the snapshot context menu
  // on a click elsewhere, and (2) opens the drag bracket so the next leftMouseUp can close it and
  // we decide resize-vs-reorder ONCE per drag instead of once per intra-
  // drag synth-poll bang. Sharing the eventtap callback so the daemon
  // doesn't install two taps for the same event.
  sd.events.on("snapshotsLeftClick", (payload) => {
    // Payload carries the global click point. If it is a snapshot interaction
    // (a tile, or anything while the context menu is open), onLeftClickEvent
    // returns true — do NOT also open the drag bracket, whose deferred tile pass otherwise fights the
    // restore (window deminimizes, then the bracket re-tiles it — logged as
    // via=bracket-deferred). Only open the bracket for clicks that MISS the
    // strip (real window drags), where it detects titlebar double-clicks
    // (macOS zoom) vs a user drag-resize.
    if (onLeftClickEvent(payload)) return;
    startDragBracket(payload);
  });
  sd.events.on("dragMouseUp", (payload) => { endDragBracket(payload); });
  // No mouseMoved eventtap: firing at ~120Hz it starved every other stack's
  // sd.mouse / sd.windows.all push. Snapshot-tile hover rides the 30Hz
  // sd.mouse channel instead (snapshots.js init).

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
    if (cfg.minimizeRail) await initSnapshots();
    state.booting = false;
    state.tileReason = "boot";
    await tileWindows();
    // Push the focused window's inclusion verdict to overlay-border so it
    // can paint the right palette before its own first focusedChanged tick
    // resolves. Without this, the boot border briefly shows the default
    // "included" color for an excluded window.
    const fid = sd.windows.focused.peek()?.id;
    if (fid != null) emitInclusion(state.windowsById[fid]);
    console.log("[WindowScape] initialized");
  }, 500);
}

init().catch((e) => console.error("[WindowScape] init failed:", e));
