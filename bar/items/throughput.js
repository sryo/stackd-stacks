import { sd } from "sd://runtime/api.js";

let last = { rx: 0, tx: 0, ts: 0 };
let cached = "";

function human(n) {
  if (n < 1024) return `${Math.round(n)}`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}k`;
  return `${(n / (1024 * 1024)).toFixed(1)}M`;
}

async function scrape(refresh) {
  const r = await sd.proc.exec("/usr/sbin/netstat", ["-ib"]);
  if (!r || r.code !== 0 || !r.stdout) return;
  let rx = 0, tx = 0;
  for (const line of r.stdout.split("\n")) {
    const parts = line.split(/\s+/).filter(Boolean);
    // netstat -ib byte-count row: column 3 is the <Link…> token,
    // ibytes is col 7, obytes is col 10. Skip loopback (lo*).
    if (parts[0] && !parts[0].startsWith("lo") && parts[2] && parts[2].startsWith("<Link")) {
      const ib = Number(parts[6]);
      const ob = Number(parts[9]);
      if (Number.isFinite(ib)) rx += ib;
      if (Number.isFinite(ob)) tx += ob;
    }
  }
  const now = Date.now() / 1000;
  const dt = now - last.ts;
  if (last.ts > 0 && dt > 0) {
    const dRx = Math.max(0, rx - last.rx) / dt;
    const dTx = Math.max(0, tx - last.tx) / dt;
    const val = `↑ ${human(dTx)} ↓ ${human(dRx)}`;
    if (val !== cached) { cached = val; refresh(); }
  }
  last = { rx, tx, ts: now };
}

let pollHandle = null;

export default {
  id: "throughput",
  side: "right",
  order: 60,
  interval: 0,
  defaultEnabled: false,
  setup(refresh) {
    scrape(refresh);
    pollHandle = setInterval(() => scrape(refresh), 1000);
  },
  teardown() {
    if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
    last = { rx: 0, tx: 0, ts: 0 };
    cached = "";
  },
  update() { return cached; }
};
