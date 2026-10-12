'use strict';
// Post-hoc exploration (read-only) of the draw rule: does the draw price falling right after the first qualifying quote predict a better ROI
// when the bet can only be decided from information available BEFORE placing it? Decide at t0+W from the fall since the first quote, execute at t0+W+LAT.
// Usage: node src/draw_mom.js   env: CUTOFF (default frozen 2026-09-30T15:53:04Z)  LAT_S=2.5
const path = require('node:path');
const Database = require('better-sqlite3');
const { loadGaps, hits } = require('./gaps');

const CUTOFF_MS = Date.parse(process.env.CUTOFF || '2026-09-30T15:53:04.834Z'), MIN_EL = 240, LAT = Number(process.env.LAT_S ?? 2.5) * 1000;
const db = new Database(path.join(__dirname, '..', 'data', 'odds.sqlite'), { readonly: true, fileMustExist: true });
const gaps = loadGaps(db);
const qOdds = db.prepare(`SELECT o.ts, o.odds, o.status, c.label, c.betoffer_id bo FROM odds o JOIN outcomes c ON c.id = o.outcome_id WHERE o.event_id = ? AND c.market = 'Full Time' ORDER BY o.ts`);
const qScore = db.prepare('SELECT ts, home, away FROM scores WHERE event_id = ? ORDER BY ts');
const qClock = db.prepare('SELECT ts, minute, second FROM clock WHERE event_id = ? ORDER BY ts');
const qBo = db.prepare('SELECT ts, betoffer_id bo, status FROM bo_status WHERE event_id = ? ORDER BY ts');
const events = db.prepare(`SELECT id, term, start_ms, final_home fh, final_away fa FROM events WHERE finished_ms IS NOT NULL AND result_status = 'ok' AND term LIKE 'esports_battle%' AND start_ms > ? ORDER BY start_ms`).all(CUTOFF_MS)
  .filter((e) => !hits(gaps, e.start_ms - 35 * 60000, e.start_ms + 12 * 60000));
const lastLE = (arr, ts) => { let lo = 0, hi = arr.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].ts <= ts) { r = m; lo = m + 1; } else hi = m - 1; } return r; };
function market(ev, ts) {
  const si = lastLE(ev.scores, ts), ki = lastLE(ev.clock, ts);
  if (si < 0 || ki < 0) return null;
  const k = ev.clock[ki], el = k.minute * 60 + k.second + Math.min(30, (ts - k.ts) / 1000), odds = {};
  for (const label of ['1', 'X', '2']) { const a = ev.px[label], i = a ? lastLE(a, ts) : -1; if (i < 0 || !(a[i].odds > 1000) || a[i].status === 'SUSPENDED') return null; odds[label] = a[i].odds; }
  const b = ev.bo.get(ev.boId);
  if (b) { const j = lastLE(b, ts); if (j >= 0 && b[j].status !== 'OPEN') return null; }
  return { diff: ev.scores[si].home - ev.scores[si].away, el, odds };
}
const ok = (m) => m && m.diff === 0 && m.el >= MIN_EL;
const WS = [1000, 2500, 5000], BK = [[-1, -0.10], [-0.10, -0.05], [-0.05, -0.02], [-0.02, 0.02], [0.02, 9]], BL = ['<=-10%', '-10..-5%', '-5..-2%', '-2..+2%', '>=+2%'];
const acc = {}; // key W|bucket -> [{pnl, win, tm}]
const FQ = [];
let n0 = 0;
for (const e of events) {
  const rows = qOdds.all(e.id);
  if (!rows.length) continue;
  const ev = { scores: qScore.all(e.id), clock: qClock.all(e.id), px: {}, bo: new Map(), boId: rows[0].bo };
  for (const r of rows) (ev.px[r.label] || (ev.px[r.label] = [])).push(r);
  for (const r of qBo.all(e.id)) (ev.bo.get(r.bo) || ev.bo.set(r.bo, []).get(r.bo)).push(r);
  if (!ev.scores.length || !ev.clock.length) continue;
  let first = null;
  for (const r of rows) { if (r.ts <= e.start_ms) continue; const m = market(ev, r.ts); if (ok(m)) { first = { ts: r.ts, m }; break; } }
  if (!first) continue;
  n0++;
  const win = e.fh === e.fa, P0 = first.m.odds.X;
  FQ.push({ ev, first, win, P0 });
  for (const W of WS) {
    const mw = market(ev, first.ts + W);
    if (!ok(mw)) continue;
    const fall = mw.odds.X / P0 - 1, mE = market(ev, first.ts + W + LAT);
    if (!ok(mE)) continue;
    const k = BK.findIndex(([lo, hi]) => fall > lo && fall <= hi) ;
    const kk = k < 0 ? (fall <= -0.10 ? 0 : 4) : k;
    const m10 = market(ev, first.ts + 10000), si = lastLE(ev.scores, first.ts);
    (acc[`${W}|${kk}`] || (acc[`${W}|${kk}`] = [])).push({ pnl: win ? mE.odds.X / 1000 - 1 : -1, win, o: mE.odds.X / 1000, g: ev.scores[si].home + ev.scores[si].away, term: e.term.slice(0, 22), el0: first.m.el, p0: P0 / 1000, drift: ok(m10) ? m10.odds.X / mE.odds.X - 1 : null });
  }
}
function boot(l, B = 3000) { const n = l.length, m = l.reduce((a, x) => a + x, 0) / n, bs = []; for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < n; i++) s += l[(Math.random() * n) | 0]; bs.push(s / n); } bs.sort((a, b) => a - b); return [m, bs[Math.floor(0.025 * B)], bs[Math.floor(0.975 * B)]]; }
console.log(`forward events=${events.length} with qualifying quote=${n0}; execution latency ${LAT / 1000}s after the decision time t0+W (W = wait after the first qualifying quote)`);
for (const W of WS) {
  console.log(`--- decide at t0+${W / 1000}s from the price fall since the first quote, execute ${LAT / 1000}s later`);
  for (let k = 0; k < 5; k++) {
    const l = acc[`${W}|${k}`] || [];
    if (l.length < 20) { console.log(`  fall ${BL[k].padEnd(9)} n=${l.length} (too few)`); continue; }
    const [m, lo, hi] = boot(l.map((x) => x.pnl));
    console.log(`  fall ${BL[k].padEnd(9)} n=${String(l.length).padStart(4)} win=${(100 * l.filter((x) => x.win).length / l.length).toFixed(0)}% avgOdds=${(l.reduce((a, x) => a + x.o, 0) / l.length).toFixed(2)} ROI=${(m * 100).toFixed(1).padStart(6)}% CI=[${(lo * 100).toFixed(0)}%, ${(hi * 100).toFixed(0)}%]`);
  }
}
{ // detail of the big-fall group (W=1 s)
  const l = acc['1000|0'] || [], by = (fn) => { const m = {}; for (const x of l) { const k = fn(x); (m[k] || (m[k] = [])).push(x); } return m; };
  const show = (name, m) => console.log(`  by ${name}: ` + Object.entries(m).map(([k, a]) => `${k}: n=${a.length} win=${(100 * a.filter((x) => x.win).length / a.length).toFixed(0)}% ROI=${(100 * a.reduce((s, x) => s + x.pnl, 0) / a.length).toFixed(0)}%`).join(' | '));
  console.log(`--- big-fall group (W=1 s, n=${l.length}): meanP0=${(l.reduce((s, x) => s + x.p0, 0) / l.length).toFixed(2)} meanExecOdds=${(l.reduce((s, x) => s + x.o, 0) / l.length).toFixed(2)} medianEl0=${l.map((x) => x.el0).sort((a, b) => a - b)[l.length >> 1].toFixed(0)}s`);
  show('goals at tie', by((x) => (x.g === 0 ? '0' : x.g === 2 ? '2' : '4+')));
  show('term', by((x) => x.term));
  const d = l.filter((x) => x.drift !== null); console.log(`  further drift exec -> +10s: mean ${(100 * d.reduce((s, x) => s + x.drift, 0) / d.length).toFixed(1)}% (n=${d.length}; negative = price kept falling)`);
}
{ // split all W=1 s bets by entry type: tie already there at the start of the 2nd half (el0<250) vs tie reached by a later equalizer (el0>=250), and by fall bucket
  const all = [0, 1, 2, 3, 4].flatMap((k) => (acc[`1000|${k}`] || []).map((x) => ({ ...x, k })));
  const row = (name, a) => { if (a.length < 15) return console.log(`  ${name.padEnd(34)} n=${a.length} (too few)`); const [m, lo, hi] = boot(a.map((x) => x.pnl), 2000); console.log(`  ${name.padEnd(34)} n=${String(a.length).padStart(4)} win=${(100 * a.filter((x) => x.win).length / a.length).toFixed(0)}% avgOdds=${(a.reduce((s, x) => s + x.o, 0) / a.length).toFixed(2)} ROI=${(m * 100).toFixed(1).padStart(6)}% CI=[${(lo * 100).toFixed(0)}%, ${(hi * 100).toFixed(0)}%]`); };
  console.log('--- entry type (W=1 s, exec +2.5 s)');
  row('tie at 2nd-half start (el0<250)', all.filter((x) => x.el0 < 250));
  row('  of which 0-0', all.filter((x) => x.el0 < 250 && x.g === 0));
  row('  of which 1-1+', all.filter((x) => x.el0 < 250 && x.g >= 2));
  row('tie after equalizer (el0>=250)', all.filter((x) => x.el0 >= 250));
  row('  equalizer, big fall (<=-10%)', all.filter((x) => x.el0 >= 250 && x.k === 0));
  row('  equalizer, no big fall', all.filter((x) => x.el0 >= 250 && x.k !== 0));
  row('  equalizer, el0 250-300', all.filter((x) => x.el0 >= 250 && x.el0 < 300));
  row('  equalizer, el0 300-360', all.filter((x) => x.el0 >= 300 && x.el0 < 360));
  row('  equalizer, el0 >=360', all.filter((x) => x.el0 >= 360));
}
{ // ROI vs execution latency L after the first qualifying quote, by entry type (no price-fall conditioning, so nothing here uses future information)
  const types = [['all first quotes', () => true], ['tie at 2nd-half start (el0<250)', (q) => q.first.m.el < 250], ['tie after equalizer (el0>=250)', (q) => q.first.m.el >= 250]];
  console.log('--- ROI by execution latency L (bet taken at the price L s after the first qualifying quote; dropped if no longer tied/open)');
  for (const [name, fn] of types) {
    const sel = FQ.filter(fn), out = [];
    for (const L of [0, 500, 1000, 1500, 2000, 2500, 3500]) {
      const l = [];
      for (const q of sel) { const m = L === 0 ? q.first.m : market(q.ev, q.first.ts + L); if (!ok(m)) continue; l.push(q.win ? m.odds.X / 1000 - 1 : -1); }
      const [m, lo, hi] = boot(l, 1500);
      out.push(`${L / 1000}s: ${(m * 100).toFixed(1)}%[${(lo * 100).toFixed(0)},${(hi * 100).toFixed(0)}] n=${l.length}`);
    }
    console.log(`  ${name}: ` + out.join(' | '));
  }
}
