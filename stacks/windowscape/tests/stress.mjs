// Fuzz/stress harness for resolveFlex — throws random valid scenarios at the
// solver and checks the load-bearing invariants. Reproducible: pass a seed as
// argv[2], set ITER for the count.  Run:  node tests/stress.mjs [seed]
import { resolveFlex, PIN_MIN_PX } from "../modules/flex.js";

let seed = (Number(process.argv[2]) || 0x1234abcd) >>> 0;
function rnd() { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));

function scenario() {
  const n = ri(1, 8);
  const total = ri(200, 6000);
  const gap = rnd() < 0.5 ? 0 : ri(0, 12);
  const items = [];
  let activeAssigned = false;
  for (let i = 0; i < n; i++) {
    const it = { weight: ri(1, 4) };
    if (rnd() < 0.5) it.basis = ri(20, total);
    if (rnd() < 0.6) it.min = ri(0, 900);
    if (it.basis != null && !activeAssigned && rnd() < 0.4) { it.active = true; activeAssigned = true; }
    items.push(it);
  }
  return { items, total, gap };
}

function check(s, out) {
  const { items, total, gap } = s;
  const n = items.length;
  const inner = total - Math.max(0, n - 1) * gap;
  const errs = [];
  if (out.length !== n) errs.push(`length ${out.length} != ${n}`);
  for (let i = 0; i < out.length; i++) {
    const v = out[i];
    if (!Number.isFinite(v)) errs.push(`out[${i}] not finite: ${v}`);
    else if (!Number.isInteger(v)) errs.push(`out[${i}] not integer: ${v}`);
    else if (v < 0) errs.push(`out[${i}] negative: ${v}`);
  }
  const sum = out.reduce((a, b) => a + b, 0);
  if (sum !== inner) errs.push(`sum ${sum} != inner ${inner} (gap/overlap)`);

  // Feasible minimums must be honored (allow 1px rounding slack). Only when the
  // mins actually fit and there's more than one tile (n==1 fills regardless).
  const minSum = items.reduce((a, it) => a + (it.min || 0), 0);
  if (n > 1 && minSum <= inner) {
    for (let i = 0; i < n; i++) {
      if (out[i] < (items[i].min || 0) - 1) errs.push(`out[${i}]=${out[i]} < min ${items[i].min}`);
    }
  }
  // Determinism: same input → same output.
  const out2 = resolveFlex(items, total, gap);
  for (let i = 0; i < n; i++) if (out2[i] !== out[i]) errs.push(`non-deterministic at ${i}: ${out[i]} vs ${out2[i]}`);
  return errs;
}

const N = Number(process.env.ITER) || 300000;
let fails = 0, firstFail = null;
for (let k = 0; k < N; k++) {
  const s = scenario();
  let out;
  try { out = resolveFlex(s.items, s.total, s.gap); }
  catch (e) { fails++; if (!firstFail) firstFail = { s, err: String(e && e.stack || e) }; continue; }
  const errs = check(s, out);
  if (errs.length) { fails++; if (!firstFail) firstFail = { s, out, errs }; }
}
console.log(`resolveFlex fuzz: ${N} scenarios, ${fails} failure(s)`);
if (firstFail) { console.log("first failure:\n" + JSON.stringify(firstFail, null, 2)); process.exit(1); }
