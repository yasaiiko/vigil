'use strict';
// Prematch test with goals: walk-forward per-player attack/defence (Poisson) vs the prematch 1X2 and Total Goals prices. Read-only.
// Params tuned on the first half, evaluated once on the second half. Usage: node src/pre_goals.js [db]
const path = require('node:path');
const Database = require('better-sqlite3');
const { loadGaps, hits } = require('./gaps');
const db = new Database(process.argv[2] || path.join(__dirname, '..', 'data', 'odds.sqlite'), { readonly: true, fileMustExist: true });
const gaps = process.env.KEEP_GAPS ? [] : loadGaps(db);
const player = (s) => { const m = /\(([^)]+)\)\s*$/.exec(s || ''); return m ? m[1].trim().toLowerCase() : null; };
const evs = db.prepare(`SELECT id, home, away, start_ms, final_home fh, final_away fa FROM events WHERE finished_ms IS NOT NULL AND result_status='ok' AND term LIKE ? ORDER BY start_ms`).all(process.env.TERM_LIKE || '%');
const qFt = db.prepare(`SELECT o.odds, c.label FROM odds o JOIN outcomes c ON c.id=o.outcome_id WHERE o.event_id=? AND c.market='Full Time' AND o.ts<=? AND o.odds>1000 ORDER BY o.ts`);
const qTot = db.prepare(`SELECT o.odds, c.label, c.line FROM odds o JOIN outcomes c ON c.id=o.outcome_id WHERE o.event_id=? AND c.market='Total Goals' AND o.ts<=? AND o.odds>1000 ORDER BY o.ts`);

const L = [];
for (const e of evs) {
  if (hits(gaps, e.start_ms - 35 * 60000, e.start_ms + 12 * 60000)) continue;
  const hp = player(e.home), ap = player(e.away);
  if (!hp || !ap) continue;
  const px = {};
  for (const r of qFt.all(e.id, e.start_ms)) px[r.label] = r.odds;
  if (!px['1'] || !px.X || !px['2']) continue;
  const inv = [1000 / px['1'], 1000 / px.X, 1000 / px['2']], s = inv.reduce((a, x) => a + x, 0);
  const lines = {};
  for (const r of qTot.all(e.id, e.start_ms)) { (lines[r.line] || (lines[r.line] = {}))[r.label] = r.odds; }
  let main = null;
  for (const [line, o] of Object.entries(lines)) {
    if (!o.Over || !o.Under) continue;
    const io = 1000 / o.Over, iu = 1000 / o.Under, po = io / (io + iu);
    if (!main || Math.abs(po - 0.5) < Math.abs(main.po - 0.5)) main = { line: Number(line) / 1000, po, oOver: o.Over / 1000, oUnder: o.Under / 1000 };
  }
  L.push({ t: e.start_ms, hp, ap, gh: e.fh, ga: e.fa, w: e.fh > e.fa ? 0 : e.fh === e.fa ? 1 : 2, mk: inv.map((x) => x / s), odds: [px['1'] / 1000, px.X / 1000, px['2'] / 1000], tot: main });
}
const N = L.length, half = Math.floor(N / 2);
const avgGoals = L.reduce((a, m) => a + m.gh + m.ga, 0) / N;
console.log(`matches ${N} | players ${new Set(L.flatMap((m) => [m.hp, m.ap])).size} | goals/match ${avgGoals.toFixed(2)} | with a Total Goals line ${L.filter((m) => m.tot).length} | main lines: ${JSON.stringify(L.reduce((a, m) => { if (m.tot) a[m.tot.line] = (a[m.tot.line] || 0) + 1; return a; }, {}))}`);

const MU = Math.log(avgGoals / 2);
const pois = (lam, n = 26) => { const p = [Math.exp(-lam)]; for (let k = 1; k < n; k++) p.push(p[k - 1] * lam / k); return p; };
function predict(lh, la) {
  const ph = pois(lh), pa = pois(la), pt = pois(lh + la);
  let pw = 0, pdr = 0, pl = 0;
  for (let i = 0; i < ph.length; i++) for (let j = 0; j < pa.length; j++) { const p = ph[i] * pa[j]; if (i > j) pw += p; else if (i === j) pdr += p; else pl += p; }
  const s = pw + pdr + pl;
  return { x12: [pw / s, pdr / s, pl / s], cdf: (k) => pt.slice(0, k + 1).reduce((a, x) => a + x, 0) };
}
function run(eta, shrink, hfa, minG) {
  const A = new Map(), D = new Map(), G = new Map(), out = [];
  for (const m of L) {
    const ah = A.get(m.hp) ?? 0, dh = D.get(m.hp) ?? 0, aa = A.get(m.ap) ?? 0, da = D.get(m.ap) ?? 0;
    const lh = Math.exp(MU + ah - da + hfa / 2), la = Math.exp(MU + aa - dh - hfa / 2);
    const gh = G.get(m.hp) || 0, ga = G.get(m.ap) || 0;
    out.push({ lh, la, ok: gh >= minG && ga >= minG });
    const clamp = (x) => Math.max(-0.5, Math.min(0.5, x));
    const eh = clamp(eta * (m.gh / lh - 1)), ea = clamp(eta * (m.ga / la - 1));
    A.set(m.hp, (ah + eh) * (1 - shrink)); D.set(m.ap, (da - eh) * (1 - shrink));
    A.set(m.ap, (aa + ea) * (1 - shrink)); D.set(m.hp, (dh - ea) * (1 - shrink));
    G.set(m.hp, gh + 1); G.set(m.ap, ga + 1);
  }
  return out;
}
const ll3 = (p, w) => -Math.log(Math.max(1e-9, p[w]));
const MING = 8;
let best = null;
for (const eta of [0.01, 0.02, 0.04, 0.08, 0.12]) for (const sh of [0, 0.002, 0.01]) for (const hfa of [-0.05, 0, 0.05]) {
  const o = run(eta, sh, hfa, MING);
  let s = 0, n = 0;
  for (let i = 0; i < half; i++) if (o[i].ok) { s += ll3(predict(o[i].lh, o[i].la).x12, L[i].w); n++; }
  if (n && (!best || s / n < best.ll)) best = { eta, sh, hfa, ll: s / n, n };
}
console.log(`tuned on first half: eta=${best.eta} shrink=${best.sh} hfa=${best.hfa} (n=${best.n})`);
const o = run(best.eta, best.sh, best.hfa, MING);
const T = [];
for (let i = half; i < N; i++) if (o[i].ok) T.push({ ...L[i], ...o[i] });
function boot(d, B = 4000) {
  const n = d.length, m = d.reduce((a, x) => a + x, 0) / n, bs = [];
  for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < n; i++) s += d[Math.floor(Math.random() * n)]; bs.push(s / n); }
  bs.sort((a, b) => a - b);
  return { m, lo: bs[Math.floor(0.025 * B)], hi: bs[Math.floor(0.975 * B)] };
}
const verdict = (b) => (b.hi < 0 ? 'model BEATS market' : b.lo > 0 ? 'model LOSES to market' : 'not distinguishable');

// 1X2
const d1 = boot(T.map((m) => ll3(predict(m.lh, m.la).x12, m.w) - ll3(m.mk, m.w)));
console.log(`\n1X2 TEST n=${T.length}: log-loss diff (model - market) ${d1.m.toFixed(4)} 95%CI [${d1.lo.toFixed(4)}, ${d1.hi.toFixed(4)}] => ${verdict(d1)}`);
// Totals on the main line
const TT = T.filter((m) => m.tot);
const lloss = (p, y) => -Math.log(Math.max(1e-9, y ? p : 1 - p));
const dT = boot(TT.map((m) => { const k = Math.floor(m.tot.line); const po = 1 - predict(m.lh, m.la).cdf(k); const y = m.gh + m.ga > m.tot.line ? 1 : 0; return lloss(po, y) - lloss(m.tot.po, y); }));
console.log(`TOTALS (main line, over/under) n=${TT.length}: log-loss diff (model - market) ${dT.m.toFixed(4)} 95%CI [${dT.lo.toFixed(4)}, ${dT.hi.toFixed(4)}] => ${verdict(dT)}`);
console.log('Bets on TEST (one per match; offered prematch odds):');
for (const th of [0.03, 0.06, 0.10]) {
  const side = [], tot = [];
  for (const m of T) {
    let pick = -1, g = th;
    const x = predict(m.lh, m.la).x12;
    for (let k = 0; k < 3; k++) { const d = x[k] - m.mk[k]; if (d > g) { g = d; pick = k; } }
    if (pick >= 0) side.push(m.w === pick ? m.odds[pick] - 1 : -1);
    if (m.tot) {
      const po = 1 - predict(m.lh, m.la).cdf(Math.floor(m.tot.line)), y = m.gh + m.ga > m.tot.line;
      if (po - m.tot.po > th) tot.push(y ? m.tot.oOver - 1 : -1);
      else if (m.tot.po - po > th) tot.push(!y ? m.tot.oUnder - 1 : -1);
    }
  }
  const f = (a) => { if (a.length < 20) return `n=${a.length} (too few)`; const b = boot(a); return `n=${a.length} ROI=${(b.m * 100).toFixed(1)}% CI=[${(b.lo * 100).toFixed(0)}%, ${(b.hi * 100).toFixed(0)}%]`; };
  console.log(`  gap>${th}: sides ${f(side)} | totals ${f(tot)}`);
}
db.close();
