// Bootloader — equivalent to init.lua. Wires the modules and starts watchers.

import { sd } from "sd://runtime/api.js";
import { state, loadList, updateWindowOrder } from "./core.js";
import { start as startEvents } from "./events.js";
import { bind as bindKeybinds } from "./keybinds.js";
import { tileWindows } from "./tiler.js";
import { scheduleSave, loadLayout } from "./restore.js";
import { drawOutlineForFocused } from "./outline.js";

async function init() {
  await loadList();
  startEvents();
  bindKeybinds();

  // Wait one tick for signals (windowsAll / displays / spaces) to populate
  // before we restore + tile. The signal subscriptions in startEvents replay
  // their last value synchronously into the callback, but spaces/displays
  // are populated asynchronously by the daemon's startup polls.
  setTimeout(async () => {
    await loadLayout();
    updateWindowOrder();
    state.onLayoutChange = scheduleSave;
    await tileWindows();
    drawOutlineForFocused();
    console.log("[WindowScape] initialized");
  }, 500);
}

init().catch((e) => console.error("[WindowScape] init failed:", e));
