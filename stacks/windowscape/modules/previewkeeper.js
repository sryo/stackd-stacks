// One gesture-preview panel reused across gestures. Creating an overlay
// panel (a WKWebView) holds the daemon's main thread long enough that
// back-to-back swipes stall it, and the touch recognizer reads the stall as
// fingers lifted — one swipe splits into many one-step gestures. A gesture's
// end hides the panel; the next gesture shows it again; a quiet spell of
// `idleMs` removes it. No sd import: the overlay calls are injected, so node
// tests drive it with fakes.

export function createPreviewKeeper({ create, show, hide, remove, setFrame, schedule, cancel, idleMs = 4000 }) {
  let handle = null;
  let creating = null;
  let active = false;
  let removal = null;

  const cancelRemoval = () => {
    if (removal != null) { cancel(removal); removal = null; }
  };
  const park = () => {
    hide(handle);
    cancelRemoval();
    removal = schedule(() => {
      removal = null;
      if (active || !handle) return;
      const h = handle;
      handle = null;
      remove(h);
    }, idleMs);
  };

  return {
    async begin(rect) {
      active = true;
      cancelRemoval();
      if (handle) { show(handle, rect); return; }
      if (!creating) creating = Promise.resolve(create(rect)).catch(() => null);
      const h = await creating;
      creating = null;
      if (!h) return;
      handle = h;
      if (!active) park();
    },
    move(rect) {
      if (active && handle) setFrame(handle, rect);
    },
    end() {
      active = false;
      if (handle) park();
    },
  };
}
