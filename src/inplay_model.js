'use strict';
// Read-only walk-forward test of the per-player goal model IN PLAY: prematch lambdas (same model as the (unpublished) betting bot, 13-min learning lag) scaled by the share of goals still to come at the current clock
// (league goal-time curve learned walk-forward), added to the current score; compared with de-vigged live prices (Total Goals all lines, Full Time 1X2, BTTS, Odd/Even).
// Decision at snapshot time t from the price at t; bet executes at the price at t + LAT_S (default 3 s) and must still be OPEN. Snapshots skipped for 45 s after any goal (MIN_SG: post-goal stale quotes).
// FRESH_S (default 20): only prices updated within the last 20 s count (stale last prices of closed offers are phantoms). Exploratory. Usage: node src/inplay_model.js   env: LAT_S=3 MIN_SG=45 STEP_S=15 MING=8
const path = require('node:path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, '..', 'data', 'odds.sqlite'), { readonly: true, fileMustExist: true });
const LAT = Number(process.env.LAT_S || 3) * 1000, MIN_SG = Number(process.env.MIN_SG ?? 45) * 1000, STEP = Number(process.env.STEP_S || 15) * 1000, MING = Number(process.env.MING || 8), FRESH = Number(process.env.FRESH_S || 20) * 1000, N = 30, BIN = 10;
const PROF = [
  { name: 'cla', ETA: 0.08, HFA: -0.05, TERM: '%2x5%', DUR: 600 }, { name: 'eb', ETA: 0.02, HFA: 0, TERM: 'esports_battle__2x4min_', DUR: 480 }, { name: 'ebwc', ETA: 0.02, HFA: 0, TERM: 'esports_battle_world_cup__2x4_min_', DUR: 480 },
];
const MK = new Set(['Total Goals', 'Full Time', 'Both Teams To Score', 'Total Goals Odd/Even']);
const player = (s) => { const m = /\(([^)]+)\)\s*$/.exec(s || ''); return m ? m[1].trim().toLowerCase() : null; };
const clampE = (x) => Math.max(-0.5, Math.min(0.5, x));
const pois = (l) => { const a = [Math.exp(-l)]; for (let i = 1; i < N; i++) a.push(a[i - 1] * l / i); return a; };
const qEv = db.prepare("SELECT id, home, away, start_ms, final_home fh, final_away fa FROM events WHERE finished_ms IS NOT NULL AND result_status='ok' AND term LIKE ? ORDER BY start_ms");
const qClock = db.prepare('SELECT ts, minute*60+second c FROM clock WHERE event_id = ? ORDER BY ts');
const qScore = db.prepare('SELECT ts, home, away FROM scores WHERE event_id = ? ORDER BY ts');
const qOdds = db.prepare('SELECT o.ts, o.outcome_id oid, o.odds, o.status, c.market, c.label, c.line FROM odds o JOIN outcomes c ON c.id = o.outcome_id WHERE o.event_id = ? AND o.ts >= ? ORDER BY o.ts');
function clockAt(ck, ts) { // linear interpolation between clock rows (clock freezes at the break)
  let lo = -1; for (let i = 0; i < ck.length; i++) { if (ck[i].ts <= ts) lo = i; else break; }
  if (lo < 0) return null;
  const a = ck[lo], b = ck[lo + 1];
  if (!b) return a.c + Math.min(30, (ts - a.ts) / 1000);
  if (b.ts - a.ts > 60000 && b.c - a.c < 5) return a.c; // pause
  return a.c + (b.c - a.c) * (ts - a.ts) / (b.ts - a.ts);
}
const rows = [];
let nSnap = 0, nEv = 0;
for (const P of PROF) {
  const A = new Map(), D = new Map(), G = new Map(), hist = new Array(Math.ceil(P.DUR / BIN) + 2).fill(0);
  let sumG = 0, nM = 0, totGoals = 0;
  const lam = (hp, ap) => { const mu = Math.log(sumG / nM / 2), g = (m, k) => m.get(k) ?? 0; return [Math.exp(mu + g(A, hp) - g(D, ap) + P.HFA / 2), Math.exp(mu + g(A, ap) - g(D, hp) - P.HFA / 2)]; };
  const learn = (hp, ap, gh, ga) => {
    if (nM > 0) { const [lh, la] = lam(hp, ap), g = (m, k) => m.get(k) ?? 0, eh = clampE(P.ETA * (gh / lh - 1)), ea = clampE(P.ETA * (ga / la - 1)); A.set(hp, g(A, hp) + eh); D.set(ap, g(D, ap) - eh); A.set(ap, g(A, ap) + ea); D.set(hp, g(D, hp) - ea); }
    G.set(hp, (G.get(hp) || 0) + 1); G.set(ap, (G.get(ap) || 0) + 1); sumG += gh + ga; nM++;
  };
  const evs = qEv.all(P.TERM);
  const goalClocks = (e) => { const ck = qClock.all(e.id), sc = qScore.all(e.id), out = []; let h = 0, a = 0; for (const x of sc) { const d = (x.home - h) + (x.away - a); if (d > 0 && (h + a > 0 || x.home + x.away > 0)) { const c = clockAt(ck, x.ts); if (c != null) for (let i = 0; i < d; i++) out.push(c); } h = x.home; a = x.away; } return out; };
  const remaining = (c) => { if (totGoals < 300) return null; const b = Math.min(hist.length - 1, Math.floor(c / BIN)); let after = 0; for (let i = b + 1; i < hist.length; i++) after += hist[i]; const inb = hist[b] * (1 - (c - b * BIN) / BIN); return (after + inb) / totGoals; };
  let jp = 0;
  for (const e of evs) {
    while (jp < evs.length && evs[jp].start_ms < e.start_ms - 13 * 60000) { const q = evs[jp++], qh = player(q.home), qa = player(q.away); if (qh && qa) { learn(qh, qa, q.fh, q.fa); for (const c of goalClocks(q)) { hist[Math.min(hist.length - 1, Math.floor(c / BIN))]++; totGoals++; } } }
    const hp = player(e.home), ap = player(e.away);
    if (!(hp && ap && nM > 50 && (G.get(hp) || 0) >= MING && (G.get(ap) || 0) >= MING && totGoals >= 300)) continue;
    const ck = qClock.all(e.id); if (ck.length < 10) continue;
    const sc = qScore.all(e.id), [lh, la] = lam(hp, ap);
    const scoreAt = (ts) => { let h = 0, a = 0, tg = null; for (const x of sc) { if (x.ts > ts) break; if (x.home + x.away > h + a) tg = x.ts; h = x.home; a = x.away; } return { h, a, tg }; };
    // snapshot times: every STEP ms from kickoff while the clock is running and not at the very start / end
    const snaps = [];
    for (let t = e.start_ms + 20000; t < e.start_ms + 700000; t += STEP) { const c = clockAt(ck, t), c2 = clockAt(ck, t + 8000); if (c == null || c2 == null || c < 15 || c > P.DUR - 25 || c2 - c < 3) continue; const s = scoreAt(t); if (s.tg != null && t - s.tg < MIN_SG) continue; snaps.push({ t, c, s }); }
    if (!snaps.length) continue;
    nEv++;
    const times = []; for (const s of snaps) { times.push({ t: s.t, k: s, dec: true }); times.push({ t: s.t + LAT, k: s, dec: false }); }
    times.sort((x, y) => x.t - y.t);
    const cur = new Map(), odds = qOdds.all(e.id, e.start_ms - 1);
    let ri = 0;
    const copy = (t) => { const m = new Map(); for (const [k, v] of cur) if (v.status === 'OPEN' && t - v.ts <= FRESH) m.set(k, v); return m; }; // FRESH: Kambi removes closed offers silently, so an old last price is a phantom
    for (const T of times) {
      while (ri < odds.length && odds[ri].ts <= T.t) { const r = odds[ri++]; if (MK.has(r.market)) cur.set(r.oid, { market: r.market, label: r.label, line: r.line, odds: r.odds, status: r.status, ts: r.ts }); }
      if (T.dec) T.k.dm = copy(T.t); else T.k.em = copy(T.t);
    }
    for (const s of snaps) {
      nSnap++;
      const rem = remaining(s.c); if (rem == null) continue;
      const ph = pois(lh * rem), pa = pois(la * rem), gh0 = s.s.h, ga0 = s.s.a;
      const groups = new Map();
      for (const [oid, r] of s.dm) { if (r.odds <= 1050) continue; const key = `${r.market}|${r.line == null ? '' : r.line}`; const g = groups.get(key) || []; g.push({ oid, ...r }); groups.set(key, g); }
      for (const [key, g] of groups) {
        const mkt = g[0].market, L = g[0].line == null ? null : g[0].line / 1000;
        const need = mkt === 'Full Time' ? 3 : 2; if (g.length !== need) continue;
        if (mkt === 'Total Goals' && (L == null || Math.abs(L % 1) !== 0.5)) continue;
        const inv = g.map((o) => 1000 / o.odds), tot = inv.reduce((a, b) => a + b, 0);
        g.forEach((o, i) => {
          let f;
          if (mkt === 'Total Goals') f = o.label === 'Over' ? (x, y) => gh0 + x + ga0 + y > L : (x, y) => gh0 + x + ga0 + y < L;
          else if (mkt === 'Full Time') f = o.label === '1' ? (x, y) => gh0 + x > ga0 + y : o.label === '2' ? (x, y) => gh0 + x < ga0 + y : (x, y) => gh0 + x === ga0 + y;
          else if (mkt === 'Both Teams To Score') f = o.label === 'Yes' ? (x, y) => gh0 + x > 0 && ga0 + y > 0 : (x, y) => !(gh0 + x > 0 && ga0 + y > 0);
          else f = o.label === 'Odd' ? (x, y) => (gh0 + x + ga0 + y) % 2 === 1 : (x, y) => (gh0 + x + ga0 + y) % 2 === 0;
          let pm = 0; for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) if (f(x, y)) pm += ph[x] * pa[y];
          const pk = inv[i] / tot, ex = s.em.get(o.oid);
          const win = f(e.fh - gh0, e.fa - ga0) ? 1 : 0; // final score decides
          rows.push({ ev: e.id, lg: P.name, cls: mkt === 'Total Goals' ? 'TG' : mkt === 'Full Time' ? '1X2' : mkt === 'Both Teams To Score' ? 'BTTS' : 'OE', c: s.c, dur: P.DUR, pk, gap: pm - pk, odds: ex ? ex.odds / 1000 : null, win, lead: Math.abs(gh0 - ga0) });
        });
      }
    }
  }
}
function boot(list, f, B = 400) {
  const by = new Map(); for (const x of list) { const a = by.get(x.ev) || []; a.push(x); by.set(x.ev, a); }
  const cl = [...by.values()], n = cl.length, out = [];
  for (let b = 0; b < B; b++) { const s = []; for (let i = 0; i < n; i++) s.push(...cl[Math.floor(Math.random() * n)]); out.push(f(s)); }
  out.sort((a, b) => a - b); return [f(list), out[Math.floor(0.025 * B)], out[Math.floor(0.975 * B)]];
}
const roi = (a) => a.reduce((s, x) => s + (x.win ? x.odds - 1 : -1), 0) / a.length;
const beta = (a) => { let u = 0, v = 0; for (const x of a) { u += x.gap * (x.win - x.pk); v += x.gap * x.gap; } return u / v; };
const f1 = (x) => (100 * x).toFixed(1), f2 = (x) => x.toFixed(2);
console.log(`in-play snapshots ${nSnap} | matches ${nEv} | outcome-observations ${rows.length} (decision at price t, execution at t+${LAT / 1000}s, no bets for ${MIN_SG / 1000}s after a goal)`);
const stat = (nm, a) => { const b = a.filter((r) => r.odds != null); let s = `${nm.padEnd(16)} obs ${String(a.length).padStart(6)} | beta ${a.length > 100 ? (() => { const [e, lo, hi] = boot(a, beta, 200); return `${f2(e)} [${f2(lo)}, ${f2(hi)}]`; })() : 'n/a'}`; for (const th of [0.04, 0.06, 0.08, 0.10]) { const x = b.filter((r) => r.gap > th); s += ` | >${th}: ` + (x.length < 40 ? `n=${x.length}` : (() => { const [e, lo, hi] = boot(x, roi); return `n=${x.length} ${f1(e)}% [${f1(lo)}, ${f1(hi)}]`; })()); } console.log(s); };
for (const c of ['TG', '1X2', 'BTTS', 'OE']) stat(c, rows.filter((r) => r.cls === c));
for (const [nm, lo, hi] of [['clock<25%', 0, 0.25], ['25-50%', 0.25, 0.5], ['50-75%', 0.5, 0.75], ['>75%', 0.75, 1]]) stat(`TG ${nm}`, rows.filter((r) => r.cls === 'TG' && r.c / r.dur >= lo && r.c / r.dur < hi));
for (const l of ['cla', 'eb', 'ebwc']) stat(`all ${l}`, rows.filter((r) => r.lg === l));
console.log('baseline (bet every observation at execution price): ' + (() => { const b = rows.filter((r) => r.odds != null); const [e, lo, hi] = boot(b, roi, 200); return `n=${b.length} ROI ${f1(e)}% [${f1(lo)}, ${f1(hi)}]`; })());
