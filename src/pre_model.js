'use strict';
// Prematch test: does a walk-forward per-player Elo add information to the (static) prematch Full Time price? Read-only.
// Players are the nicknames in "Club (Player)". Params tuned on the first half, evaluated once on the second half. Usage: node src/pre_model.js [db]
const path = require('node:path');
const Database = require('better-sqlite3');
const { loadGaps, hits } = require('./gaps');
const db = new Database(process.argv[2] || path.join(__dirname, '..', 'data', 'odds.sqlite'), { readonly: true, fileMustExist: true });
const gaps = process.env.KEEP_GAPS ? [] : loadGaps(db);
const player = (s) => { const m = /\(([^)]+)\)\s*$/.exec(s || ''); return m ? m[1].trim().toLowerCase() : null; };

const evs = db.prepare(`SELECT id, term, home, away, start_ms, final_home fh, final_away fa FROM events WHERE finished_ms IS NOT NULL AND result_status='ok' ORDER BY start_ms`).all();
const qOdds = db.prepare(`SELECT o.ts, o.odds, c.label FROM odds o JOIN outcomes c ON c.id=o.outcome_id WHERE o.event_id=? AND c.market='Full Time' AND o.ts<=? AND o.odds>1000 ORDER BY o.ts`);
const L = [];
let skipGap = 0, skipOdds = 0;
for (const e of evs) {
  if (hits(gaps, e.start_ms - 35 * 60000, e.start_ms + 12 * 60000)) { skipGap++; continue; }
  const hp = player(e.home), ap = player(e.away);
  if (!hp || !ap) continue;
  const px = {};
  for (const r of qOdds.all(e.id, e.start_ms)) px[r.label] = r.odds;
  if (!px['1'] || !px.X || !px['2']) { skipOdds++; continue; }
  const inv = [1000 / px['1'], 1000 / px.X, 1000 / px['2']], s = inv.reduce((a, x) => a + x, 0);
  L.push({ id: e.id, t: e.start_ms, hp, ap, w: e.fh > e.fa ? 0 : e.fh === e.fa ? 1 : 2, mk: inv.map((x) => x / s), odds: [px['1'] / 1000, px.X / 1000, px['2'] / 1000], over: s });
}
const N = L.length, half = Math.floor(N / 2);
const players = new Set(L.flatMap((m) => [m.hp, m.ap]));
console.log(`matches ${N} (skipped: gaps ${skipGap}, no prematch quote ${skipOdds}) | distinct players ${players.size} | avg overround ${(L.reduce((a, m) => a + m.over, 0) / N).toFixed(3)} | outcomes 1/X/2: ${[0, 1, 2].map((k) => (100 * L.filter((m) => m.w === k).length / N).toFixed(0) + '%').join('/')}`);

const sig = (x) => 1 / (1 + Math.exp(-x));
function run(K, theta, hfa, minG) {
  const R = new Map(), G = new Map(), out = [];
  for (const m of L) {
    const rh = R.get(m.hp) ?? 0, ra = R.get(m.ap) ?? 0, d = (rh - ra) / 400 * Math.LN10 + hfa;
    const ph = sig(d - theta), pa = sig(-d - theta), pd = Math.max(1e-4, 1 - ph - pa), s = ph + pd + pa;
    const pr = [ph / s, pd / s, pa / s];
    const gh = G.get(m.hp) || 0, ga = G.get(m.ap) || 0;
    out.push({ pr, ok: gh >= minG && ga >= minG });
    const E = pr[0] + 0.5 * pr[1], S = m.w === 0 ? 1 : m.w === 1 ? 0.5 : 0;
    R.set(m.hp, rh + K * (S - E)); R.set(m.ap, ra - K * (S - E));
    G.set(m.hp, gh + 1); G.set(m.ap, ga + 1);
  }
  return out;
}
const ll = (p, w) => -Math.log(Math.max(1e-9, p[w]));
const MING = 8;
let best = null;
for (const K of [4, 8, 12, 16, 24, 32, 48]) for (const th of [0.1, 0.3, 0.5, 0.7, 0.9, 1.1]) for (const hfa of [-0.1, 0, 0.1]) {
  const o = run(K, th, hfa, MING);
  let s = 0, n = 0;
  for (let i = 0; i < half; i++) if (o[i].ok) { s += ll(o[i].pr, L[i].w); n++; }
  if (n && (!best || s / n < best.ll)) best = { K, th, hfa, ll: s / n, n };
}
console.log(`tuned on first half: K=${best.K} theta=${best.th} hfa=${best.hfa} (n=${best.n})`);
const o = run(best.K, best.th, best.hfa, MING);
const T = [];
for (let i = half; i < N; i++) if (o[i].ok) T.push({ ...L[i], el: o[i].pr });
const base = [0, 1, 2].map((k) => L.slice(0, half).filter((m) => m.w === k).length / half);
const avg = (f) => T.reduce((a, m) => a + f(m), 0) / T.length;
console.log(`\nTEST (second half, both players >= ${MING} prior games) n=${T.length}: log-loss  market ${avg((m) => ll(m.mk, m.w)).toFixed(4)} | Elo ${avg((m) => ll(m.el, m.w)).toFixed(4)} | base rate ${avg((m) => ll(base, m.w)).toFixed(4)}  (lower = better)`);

function boot(d, B = 4000) {
  const n = d.length, m = d.reduce((a, x) => a + x, 0) / n, bs = [];
  for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < n; i++) s += d[Math.floor(Math.random() * n)]; bs.push(s / n); }
  bs.sort((a, b) => a - b);
  return { m, lo: bs[Math.floor(0.025 * B)], hi: bs[Math.floor(0.975 * B)], p: bs.filter((x) => x <= 0).length / B };
}
const dd = boot(T.map((m) => ll(m.el, m.w) - ll(m.mk, m.w)));
console.log(`log-loss diff (Elo - market): ${dd.m.toFixed(4)} 95%CI [${dd.lo.toFixed(4)}, ${dd.hi.toFixed(4)}] => ${dd.hi < 0 ? 'Elo BEATS market' : dd.lo > 0 ? 'Elo LOSES to market' : 'not distinguishable'}`);
const c = Math.floor(T.length / 2), A = T.slice(0, c), B2 = T.slice(c);
const bl = (w) => (m) => m.mk.map((x, i) => (1 - w) * x + w * m.el[i]);
const sc = (arr, f) => arr.reduce((a, m) => a + ll(f(m), m.w), 0) / arr.length;
let bw = 0, bv = 1e9;
for (let w = 0; w <= 1.0001; w += 0.05) { const v = sc(A, bl(w)); if (v < bv) { bv = v; bw = w; } }
console.log(`blend weight on Elo (fit on 1st half of test): ${bw.toFixed(2)} | 2nd-half n=${B2.length}: market ${sc(B2, bl(0)).toFixed(4)} vs blend ${sc(B2, bl(bw)).toFixed(4)}`);
console.log('\nElo-selected bets on TEST (one per match: outcome with the largest Elo-minus-market gap above the threshold; offered prematch odds):');
for (const th of [0.03, 0.06, 0.10]) {
  const pn = [];
  let wins = 0;
  for (const m of T) {
    let pick = -1, g = th;
    for (let k = 0; k < 3; k++) { const d = m.el[k] - m.mk[k]; if (d > g) { g = d; pick = k; } }
    if (pick >= 0) { const w = m.w === pick; if (w) wins++; pn.push(w ? m.odds[pick] - 1 : -1); }
  }
  if (pn.length < 20) { console.log(`  gap>${th} bets=${pn.length} (too few)`); continue; }
  const b = boot(pn);
  console.log(`  gap>${th} bets=${pn.length} win=${(100 * wins / pn.length).toFixed(0)}% ROI=${(b.m * 100).toFixed(1)}% 95%CI=[${(b.lo * 100).toFixed(0)}%, ${(b.hi * 100).toFixed(0)}%]`);
}
db.close();
