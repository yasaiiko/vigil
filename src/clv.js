'use strict';
// Prematch price vs early-live price test (same market, before the first goal). Read-only. Run with Node 22.
// Usage: node src/clv.js [db]   env: MIN_EVENTS=20  THR=0.03
// EV_pre = p_live(de-vigged, at kickoff) * odds_pre - 1. Positive & significant => prematch prices beat the live re-pricing.
const path = require('node:path');
const Database = require('better-sqlite3');
const { loadGaps, hits } = require('./gaps');
const DB = process.argv[2] || path.join(__dirname, '..', 'data', 'odds.sqlite');
const MIN_EVENTS = Number(process.env.MIN_EVENTS || 20);
const THR = Number(process.env.THR || 0.03);
const db = new Database(DB, { readonly: true, fileMustExist: true });
const now = Date.now();
let events = db.prepare('SELECT id, start_ms FROM events WHERE start_ms < ? AND start_ms > ? ORDER BY start_ms').all(now - 12 * 60000, now - Number(process.env.SINCE_H || 1e5) * 3600000);
const gaps = process.env.KEEP_GAPS ? [] : loadGaps(db);
const nAll = events.length;
events = events.filter((e) => !hits(gaps, e.start_ms - 35 * 60000, e.start_ms + 12 * 60000));
const nGap = nAll - events.length;
const qOdds = db.prepare('SELECT o.ts, o.odds, c.market, c.label, c.line FROM odds o JOIN outcomes c ON c.id = o.outcome_id WHERE o.event_id = ? ORDER BY o.ts');
const qScore = db.prepare('SELECT ts, home, away FROM scores WHERE event_id = ? ORDER BY ts');
const LIVE_MAX_MS = 120000;

const acc = new Map(); // market -> Map(event -> {s,n})
const ovr = new Map(); // market -> {pre:[],live:[]}
const moved = { total: 0, moved: 0 };
const ft = { ev: [], llPre: [], llLive: [], roi: [], flagged: [], n: 0 };
let used = 0, noLive = 0;
for (const ev of events) {
  const rows = qOdds.all(ev.id);
  const scores = qScore.all(ev.id);
  const groups = new Map(); // market|line -> Map(label -> {pre:[], live:[]})
  for (const r of rows) {
    const g = groups.get(r.market + '|' + (r.line ?? '')) || { market: r.market, outs: new Map() };
    const o = g.outs.get(r.label) || { pre: [], live: [] };
    (r.ts <= ev.start_ms ? o.pre : o.live).push(r);
    g.outs.set(r.label, o);
    groups.set(r.market + '|' + (r.line ?? ''), g);
  }
  let evUsed = false;
  for (const g of groups.values()) {
    const outs = [...g.outs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (outs.length < 2 || outs.length > 3) continue;
    const pre = outs.map(([, o]) => { let v = null; for (const r of o.pre) if (r.odds > 1000) v = r.odds; return v; });
    if (pre.some((x) => x == null)) continue;
    for (const [, o] of outs) { const d = new Set(o.pre.filter((r) => r.odds > 1000).map((r) => r.odds)); moved.total++; if (d.size > 1) moved.moved++; }
    const firstLive = outs.map(([, o]) => o.live.find((r) => r.odds > 1000));
    if (firstLive.some((x) => !x)) { noLive++; continue; }
    const tLive = Math.max(...firstLive.map((r) => r.ts));
    if (tLive > ev.start_ms + LIVE_MAX_MS) { noLive++; continue; }
    if (scores.some((s) => s.ts <= tLive && s.home + s.away > 0)) continue;
    const live = outs.map(([, o]) => { let v = null; for (const r of o.live) { if (r.ts > tLive) break; if (r.odds > 1000) v = r.odds; } return v; });
    if (live.some((x) => x == null)) continue;
    const invP = pre.map((x) => 1000 / x), sP = invP.reduce((a, x) => a + x, 0);
    const invL = live.map((x) => 1000 / x), sL = invL.reduce((a, x) => a + x, 0);
    if (sP > 1.5 || sL > 1.5 || sP < 0.98 || sL < 0.98) continue;
    const pL = invL.map((x) => x / sL), pP = invP.map((x) => x / sP);
    const m = acc.get(g.market) || new Map();
    const cur = m.get(ev.id) || { s: 0, n: 0 };
    for (let i = 0; i < outs.length; i++) { cur.s += pL[i] * pre[i] / 1000 - 1; cur.n += 1; }
    m.set(ev.id, cur);
    acc.set(g.market, m);
    const o = ovr.get(g.market) || { pre: [], live: [] };
    o.pre.push(sP); o.live.push(sL);
    ovr.set(g.market, o);
    evUsed = true;
    const fin = scores.length ? scores[scores.length - 1] : null;
    if (g.market === 'Full Time' && outs.length === 3 && fin) {
      const res = fin.home > fin.away ? '1' : fin.home < fin.away ? '2' : 'X';
      const w = outs.findIndex(([label]) => label === res);
      if (w >= 0) {
        ft.n++;
        ft.llPre.push(-Math.log(pP[w])); ft.llLive.push(-Math.log(pL[w]));
        for (let i = 0; i < 3; i++) {
          const pnl = i === w ? pre[i] / 1000 - 1 : -1;
          ft.roi.push({ ev: ev.id, pnl });
          if (pL[i] * pre[i] / 1000 - 1 > THR) ft.flagged.push({ ev: ev.id, pnl });
        }
      }
    }
  }
  if (evUsed) used++;
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
console.log(`finished events: ${events.length} (excluded ${nGap} overlapping capture gaps) | comparable prematch vs early-live: ${used} | prematch outcomes that moved before kickoff: ${moved.total ? (100 * moved.moved / moved.total).toFixed(1) : 'n/a'}% | markets without early-live quote: ${noLive}`);
if (used < Number(process.env.MIN_USED || 5)) { console.log('Too little data: keep the collector running.'); process.exit(0); }

function bootRatio(list, key = (x) => x.ev, B = 1000) {
  const by = new Map();
  for (const x of list) { const c = by.get(key(x)) || { s: 0, n: 0 }; c.s += x.pnl; c.n += 1; by.set(key(x), c); }
  const cl = [...by.values()], N = cl.length, out = [];
  for (let b = 0; b < B; b++) { let s = 0, n = 0; for (let i = 0; i < N; i++) { const c = cl[Math.floor(Math.random() * N)]; s += c.s; n += c.n; } out.push(s / n); }
  out.sort((a, b) => a - b);
  return { ev: N, n: list.length, mean: mean(list.map((x) => x.pnl)), lo: out[Math.floor(0.025 * B)], hi: out[Math.floor(0.975 * B)], lo99: out[Math.floor(0.005 * B)] };
}
console.log('\nEV of betting PREMATCH odds if the early-live price is the truth (1 unit/outcome). Flag = 99% CI lower bound > 0');
console.log('market                          events   n      EV     95% CI            overround pre->live  flag');
let tests = 0, flagged = 0;
for (const [mk, m] of [...acc.entries()].sort()) {
  if (m.size < MIN_EVENTS) continue;
  const list = [...m.entries()].map(([ev, c]) => ({ ev, pnl: c.s / c.n, w: c.n }));
  // per-event means weighted by n via expansion
  const exp = []; for (const x of list) for (let i = 0; i < x.w; i++) exp.push({ ev: x.ev, pnl: x.pnl });
  const r = bootRatio(exp);
  const o = ovr.get(mk);
  tests++;
  const flag = r.lo99 > 0 ? 'EDGE?' : '';
  if (flag) flagged++;
  console.log(mk.slice(0, 30).padEnd(31), String(r.ev).padStart(6), String(r.n).padStart(6), (r.mean * 100).toFixed(1).padStart(6) + '%', `[${(r.lo * 100).toFixed(1)}%, ${(r.hi * 100).toFixed(1)}%]`.padEnd(18), `${mean(o.pre).toFixed(3)}->${mean(o.live).toFixed(3)}`.padEnd(20), flag);
}
console.log(`tests shown: ${tests} | flagged: ${flagged} (expect ~${(tests * 0.01).toFixed(1)} false flags by chance)`);
if (ft.n >= 20) {
  const r = bootRatio(ft.roi), f = ft.flagged.length >= 10 ? bootRatio(ft.flagged) : null;
  console.log(`Full Time (n=${ft.n} matches): log-loss prematch ${mean(ft.llPre).toFixed(4)} vs early-live ${mean(ft.llLive).toFixed(4)} | flat ROI at prematch odds ${(r.mean * 100).toFixed(1)}%`
    + (f ? ` | bets with EV_pre>${THR * 100}%: n=${f.n} ROI ${(f.mean * 100).toFixed(1)}% CI [${(f.lo * 100).toFixed(0)}%, ${(f.hi * 100).toFixed(0)}%]` : ' | flagged bets: too few'));
}
