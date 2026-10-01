// Stand-in for sd://runtime/api.js: every channel counts its live
// subscribers so tests can check that items let go of them.
function channel() {
  const subs = new Set();
  return {
    subscribe(fn) { subs.add(fn); fn(null); return () => subs.delete(fn); },
    push(v) { for (const s of subs) s(v); },
    get subscribers() { return subs.size; }
  };
}

const request = () => Promise.resolve({ code: 1, stdout: "" });

export const sd = {
  battery: channel(),
  display: { all: channel() },
  app: { frontmost: channel() },
  input: { layout: channel() },
  net: { wifi: channel(), lan: channel(), path: channel(), throughput: channel() },
  spaces: { all: channel() },
  audio: { output: channel(), processes: channel(), devices: () => Promise.resolve([]) },
  media: { nowPlaying: channel(), command: request },
  apps: { focus: request },
  proc: { exec: request },
  screen: { current: { index: 0, uuid: "U", displayID: 1 } },
  bang: () => Promise.resolve(true)
};

export function liveSubscribers() {
  let n = 0;
  const walk = (o) => {
    for (const v of Object.values(o)) {
      if (v && typeof v === "object" && "subscribers" in v) n += v.subscribers;
      else if (v && typeof v === "object" && v !== sd.screen) walk(v);
    }
  };
  walk(sd);
  return n;
}
