// Concurrency helpers for async work that must not overlap. No sd:// imports,
// so they run under plain node.

/// Wraps `fn` so calls run one at a time in call order; none is dropped.
/// Each call's promise settles with its own result, and a throwing call
/// doesn't stop the ones queued behind it.
export function serialQueue(fn) {
  let tail = Promise.resolve();
  return (...args) => {
    const run = tail.then(() => fn(...args));
    tail = run.catch(() => {});
    return run;
  };
}

/// Wraps `pass` so runs never overlap. A call while a run is in flight
/// returns at once and marks one more run, which starts when the current one
/// finishes; any number of such calls collapse into that single rerun. An
/// idle call resolves once the run and its rerun are done. A pass that throws
/// still gets its pending rerun; the last error is rethrown at the end.
export function coalescingRunner(pass) {
  let running = false, rerun = false;
  return async () => {
    if (running) { rerun = true; return; }
    running = true;
    let error = null;
    try {
      do {
        rerun = false;
        try { await pass(); } catch (e) { error = e; }
      } while (rerun);
    } finally {
      running = false;
    }
    if (error) throw error;
  };
}

/// Keyed overlays created once and repainted in place.
///   create(value)       → Promise<handle | null>
///   paint(entry, value) : entry.handle is live; entry is the slot's scratch
///                         object for memoizing what was last drawn
///   dispose(handle)
/// sync(key, value) creates the key's overlay on first use and otherwise
/// paints it. Syncs that arrive while the create is in flight only record
/// their value, and the newest one is painted when the handle lands. A
/// create that yields no handle leaves the key empty, so the next sync
/// retries. A key removed mid-create disposes the late handle.
export function overlaySlots({ create, paint, dispose }) {
  const slots = new Map();
  async function sync(key, value) {
    const cur = slots.get(key);
    if (cur) {
      if (cur.handle) paint(cur, value);
      else cur.pending = value;
      return;
    }
    const entry = { handle: null, pending: value };
    slots.set(key, entry);
    let h = null;
    try { h = await create(value); } catch (_) {}
    if (slots.get(key) !== entry) { if (h) dispose(h); return; }
    if (!h) { slots.delete(key); return; }
    entry.handle = h;
    paint(entry, entry.pending);
  }
  function remove(key) {
    const e = slots.get(key);
    if (!e) return;
    slots.delete(key);
    if (e.handle) dispose(e.handle);
  }
  return { sync, remove, keys: () => [...slots.keys()], handle: (key) => slots.get(key)?.handle ?? null };
}
