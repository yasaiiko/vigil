'use strict';
// Post-goal repricing study (read-only). After each goal, look at quotes that were freshly repriced (positive evidence they were open) at goal+d seconds
// and measure realized ROI by how much each outcome's price moved vs the pre-goal price (r = odds_now / odds_before), plus the drift to goal+40 s.
// Under efficient repricing every r-bin loses ~ the margin; under-reaction shows as r<1 bins beating the baseline, over-reaction as r>1 bins.
// Usage: node src/lag.js [db]   env: TERM_LIKE='esports_battle%'  SINCE=2026-09-30  KEEP_GAPS=1
const path = require('node:path');
const Database = require('better-sqlite3');
const { loadGaps, hits } = require('./gaps');

const TERM_LIKE = process.env.TERM_LIKE || 'esports_battle%';
const db = new Database(process.argv[2] || path.join(__dirname, '..', 'data', 'odds.sqlite'), { readonly: true, fileMustExist: true });
const gaps = process.env.KEEP_GAPS ? [] : loadGaps(db);
const evs = db.prepare(`SELECT id, start_ms, final_home fh, final_away fa FROM events WHERE finished_ms IS NOT NULL AND result_status='ok' AND term LIKE ? AND start_ms >= ? ORDER BY start_ms`).all(TERM_LIKE, Date.parse(process.env.SINCE || '2000-01-01'))
  .filter((e) => !hits(gaps, e.start_ms - 35 * 60000, e.start_ms + 12 * 60000));
const qOut = db.prepare('SELECT id, betoffer_id bo, market, label, line, type FROM outcomes WHERE event_id=?');
const qOdds = db.prepare('SELECT ts, outcome_id oid, odds, status FROM odds WHERE event_id=? ORDER BY ts');
const qScore = db.prepare('SELECT ts, home, away FROM scores WHERE event_id=? ORDER BY ts');
const GROUP = { 'Full Time': 'FT', 'Total Goals': 'TG', 'Total Goals Odd/Even': 'OE', Handicap: 'HC', 'Both Teams To Score': 'BTTS' };
const DS = [1.5, 3, 5, 10, 20], RB = [0.6, 0.8, 0.95, 1.05, 1.25, 1.6], RL = ['<.6', '.6-.8', '.8-.95', '.95-1.05', '1.05-1.25', '1.25-1.6', '>1.6'];
const lastLE = (arr, ts) => { let lo = 0, hi = arr.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].ts <= ts) { r = m; lo = m + 1; } else hi = m - 1; } return r; };
const half = (x) => Math.abs(x % 1) === 0.5;
const rbin = (r) => { let i = 0; while (i < RB.length && r >= RB[i]) i++; return i; };
function settle(c, grp, F) {
  const [h, a] = F, tot = h + a, ln = c.line / 1000;
  switch (grp) {
    case 'FT': return c.label === '1' ? +(h > a) : c.label === 'X' ? +(h === a) : c.label === '2' ? +(h < a) : null;
    case 'TG': return !half(ln) ? null : c.label === 'Over' ? +(tot > ln) : c.label === 'Under' ? +(tot < ln) : null;
    case 'OE': return c.label === 'Odd' ? +(tot % 2 === 1) : c.label === 'Even' ? +(tot % 2 === 0) : null;
    case 'BTTS': return c.label === 'Yes' ? +(h > 0 && a > 0) : c.label === 'No' ? +!(h > 0 && a > 0) : null;
    case 'HC': return !half(ln) ? null : c.type === 'OT_ONE' ? +(h + ln > a) : c.type === 'OT_TWO' ? +(a + ln > h) : null;
    default: return null;
  }
}
const cells = new Map(); // key -> {ev: Map(evId -> [n, sumPnl]), drift: [sum, n]}
function add(key, evId, pnl, lt) {
  let c = cells.get(key);
  if (!c) cells.set(key, (c = { ev: new Map(), dr: [0, 0] }));
  let a = c.ev.get(evId);
  if (!a) c.ev.set(evId, (a = [0, 0]));
  a[0]++; a[1] += pnl;
  if (lt !== null) { c.dr[0] += lt; c.dr[1]++; }
}
const lagSamples = [];
let goals = 0;
for (const e of evs) {
  const outs = qOut.all(e.id), bos = new Map();
  for (const c of outs) {
    const grp = GROUP[c.market];
    if (!grp) continue;
    (bos.get(c.bo) || bos.set(c.bo, { grp, outs: [] }).get(c.bo)).outs.push(c);
  }
  const px = new Map();
  for (const r of qOdds.all(e.id)) (px.get(r.oid) || px.set(r.oid, []).get(r.oid)).push(r);
  const sc = qScore.all(e.id), F = [e.fh, e.fa];
  for (let i = 1; i < sc.length; i++) {
    if (sc[i].home + sc[i].away <= sc[i - 1].home + sc[i - 1].away) continue;
    const tg = sc[i].ts;
    goals++;
    // lag diagnostic: first price change in any Total Goals outcome within [tg-10 s, tg+60 s], relative to tg
    let first = Infinity;
    for (const b of bos.values()) {
      if (b.grp !== 'TG') continue;
      for (const c of b.outs) {
        const a = px.get(c.id);
        if (!a) continue;
        const j0 = lastLE(a, tg - 10000);
        if (j0 < 0) continue;
        for (let j = j0 + 1; j < a.length && a[j].ts <= tg + 60000; j++) if (a[j].odds !== a[j0].odds) { first = Math.min(first, a[j].ts - tg); break; }
      }
    }
    if (first < Infinity) lagSamples.push(first / 1000);
    for (const d of DS) {
      const te = tg + d * 1000;
      for (const b of bos.values()) {
        let ok = true, upd = 0, inv = 0;
        const q = [];
        for (const c of b.outs) {
          const a = px.get(c.id), k = a ? lastLE(a, te) : -1, k0 = a ? lastLE(a, tg - 5000) : -1;
          if (k < 0 || k0 < 0 || a[k].status === 'SUSPENDED' || !(a[k].odds > 1050) || a[k0].status === 'SUSPENDED' || !(a[k0].odds > 1050)) { ok = false; break; }
          if (a[k].ts > upd) upd = a[k].ts;
          const kl = lastLE(a, tg + 40000);
          q.push({ c, o: a[k].odds, o0: a[k0].odds, ol: kl >= 0 && a[kl].status !== 'SUSPENDED' && a[kl].odds > 1050 ? a[kl].odds : null });
          inv += 1000 / a[k].odds;
        }
        if (!ok || upd <= tg) continue; // no positive evidence of a post-goal open quote
        for (const x of q) {
          const y = settle(x.c, b.grp, F);
          if (y === null) continue;
          const o = x.o / 1000, r = x.o / x.o0, lt = x.ol ? Math.log(x.o / x.ol) : null, pnl = y ? o - 1 : -1;
          add(`${d}|all|${rbin(r)}`, e.id, pnl, lt);
          add(`${d}|${b.grp}|${rbin(r)}`, e.id, pnl, lt);
        }
      }
    }
  }
}
function boot(c, B = 600) {
  const a = [...c.ev.values()], n = a.reduce((s, x) => s + x[0], 0), sp = a.reduce((s, x) => s + x[1], 0), roi = sp / n, rs = [];
  for (let b = 0; b < B; b++) { let sn = 0, ss = 0; for (let i = 0; i < a.length; i++) { const x = a[(Math.random() * a.length) | 0]; sn += x[0]; ss += x[1]; } rs.push(ss / sn); }
  rs.sort((x, y) => x - y);
  const mu = rs.reduce((u, v) => u + v, 0) / B;
  return { n, m: a.length, roi, lo: rs[Math.floor(B * 0.025)], hi: rs[Math.floor(B * 0.975)], se: Math.sqrt(rs.reduce((s, x) => s + (x - mu) ** 2, 0) / B) };
}
lagSamples.sort((x, y) => x - y);
const qt = (p) => lagSamples[Math.floor((lagSamples.length - 1) * p)];
console.log(`events=${evs.length} goals=${goals} | first Total-Goals price change vs goal-observation (s): n=${lagSamples.length} p10=${qt(0.1)} p50=${qt(0.5)} p90=${qt(0.9)} p99=${qt(0.99)}`);
const pct = (x) => (x * 100).toFixed(1).padStart(6) + '%';
for (const d of DS) {
  console.log(`--- d=${d}s after goal (all markets pooled): r=odds_now/odds_before`);
  for (let k = 0; k < RL.length; k++) {
    const c = cells.get(`${d}|all|${k}`);
    if (!c) continue;
    const s = boot(c);
    console.log(`  r ${RL[k].padEnd(9)} n=${String(s.n).padStart(7)} m=${String(s.m).padStart(5)} ROI=${pct(s.roi)} CI=[${pct(s.lo)},${pct(s.hi)}] drift(odds_now/odds_t+40)=${c.dr[1] ? (Math.exp(c.dr[0] / c.dr[1]) - 1 >= 0 ? '+' : '') + ((Math.exp(c.dr[0] / c.dr[1]) - 1) * 100).toFixed(2) + '%' : 'na'}`);
  }
}
console.log('--- notable cells by market (|ROI - pooled-all-r mean| in t units >= 3), d in {3,10}');
const base = {};
for (const d of DS) { let n = 0, s = 0; for (let k = 0; k < RL.length; k++) { const c = cells.get(`${d}|all|${k}`); if (c) for (const x of c.ev.values()) { n += x[0]; s += x[1]; } } base[d] = s / n; }
for (const [key, c] of cells) {
  const [d, g] = key.split('|');
  if (g === 'all' || (d !== '3' && d !== '10')) continue;
  const s = boot(c, 300);
  if (s.n < 300) continue;
  const t = (s.roi - base[d]) / (s.se || 1);
  if (Math.abs(t) >= 3) console.log(`  ${key} n=${s.n} m=${s.m} ROI=${pct(s.roi)} vs base ${pct(base[d])} t=${t.toFixed(1)}`);
}
