'use strict';
// Large pattern search with strict walk-forward. Read-only.
// Every observation (market outcome at a decision time) gets 12 features; every (market-outcome context) x (1 or 2 features) cell is a candidate rule
// (~80 cells per observation, ~100k populated cells). First 40% of matches only train; the rest is tested in expanding-window blocks:
// a cell is bet only if, on PAST matches, n>=MIN_N and its one-sided t of ROI >= THR; a bet fires if any selected cell matches. Execution = price LAT_S later,
// rejected if the market is closed, stale (not updated within FRESH_S) or the score changed.
// Usage: node src/scan2.js [db]   env: LAT_S=10 FRESH_S=20 SINCE=ISO TERM_LIKE='%' DIAG=1 KEEP_GAPS=1
const path = require('node:path');
const Database = require('better-sqlite3');
const { loadGaps, hits } = require('./gaps');

const LAT_MS = Number(process.env.LAT_S ?? 10) * 1000, FRESH_MS = Number(process.env.FRESH_S ?? 20) * 1000;
const MIN_SG = Number(process.env.MIN_SG ?? 0); // phantom guard: skip in-play observations less than MIN_SG s after a score change (stale quotes after goals are not tradable)
const TERM_LIKE = process.env.TERM_LIKE || '%';
const THRS = [3, 4], MIN_N = 100, TRAIN_FRAC = 0.4, BLOCKS = 8, PHASES = [1, 2, 3, 4, 5, 6, 7, 8, 9], B = 1000, NF = 12;
const db = new Database(process.argv[2] || path.join(__dirname, '..', 'data', 'odds.sqlite'), { readonly: true, fileMustExist: true });
const gaps = process.env.KEEP_GAPS ? [] : loadGaps(db);
const evs = db.prepare(`SELECT id, term, home, away, start_ms, final_home fh, final_away fa FROM events WHERE finished_ms IS NOT NULL AND result_status='ok' AND term LIKE ? AND start_ms >= ? ORDER BY start_ms`)
  .all(TERM_LIKE, Date.parse(process.env.SINCE || '2000-01-01')).filter((e) => !hits(gaps, e.start_ms - 35 * 60000, e.start_ms + 12 * 60000));
const qOut = db.prepare('SELECT id, betoffer_id bo, market, label, line, type FROM outcomes WHERE event_id=?');
const qOdds = db.prepare('SELECT ts, outcome_id oid, odds, status FROM odds WHERE event_id=? ORDER BY ts');
const qScore = db.prepare('SELECT ts, home, away FROM scores WHERE event_id=? ORDER BY ts');
const qClock = db.prepare('SELECT ts, period, minute, second FROM clock WHERE event_id=? ORDER BY ts');
const qBo = db.prepare('SELECT ts, betoffer_id bo, status FROM bo_status WHERE event_id=? ORDER BY ts');
const qStats = db.prepare('SELECT ts, json FROM stats WHERE event_id=? ORDER BY ts');

const GROUP = { 'Full Time': 'FT', 'Total Goals': 'TG', 'Total Goals Odd/Even': 'OE', Handicap: 'HC', 'Half Time': 'HT', 'Total Goals - 1st Half': 'TG1H', 'Total Goals Odd/Even - 1st Half': 'OE1H', 'Both Teams To Score': 'BTTS', 'Both Teams To Score - 1st Half': 'BTTS1H' };
const HALF = new Set(['HT', 'TG1H', 'OE1H', 'BTTS1H']);
const FNAME = ['phase', 'position', 'pbin', 'sinceGoal', 'goalDiff', 'goals', 'cornerDiff', 'momentum', 'playerElo', 'playerGoals', 'league', 'oddsLevel'];
const lastLE = (arr, ts) => { let lo = 0, hi = arr.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].ts <= ts) { r = m; lo = m + 1; } else hi = m - 1; } return r; };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const bn = (x, th) => { let i = 0; while (i < th.length && x >= th[i]) i++; return i; };
const half = (x) => Math.abs(x % 1) === 0.5;
const player = (s) => { const m = /\(([^)]+)\)\s*$/.exec(s || ''); return m ? m[1].trim().toLowerCase() : null; };
const LEAGUE = { esports_battle__2x4min_: 0, esports_battle_world_cup__2x4_min_: 1, cyber_live_arena__2x5_min_: 2, cla_world_cup__2x5_min_: 3 };

function settle(c, grp, F, H) {
  const S = HALF.has(grp) ? H : F;
  if (!S) return null;
  const [h, a] = S, tot = h + a, ln = c.line / 1000;
  switch (grp) {
    case 'FT': case 'HT': return c.label === '1' ? +(h > a) : c.label === 'X' ? +(h === a) : c.label === '2' ? +(h < a) : null;
    case 'TG': case 'TG1H': return !half(ln) ? null : c.label === 'Over' ? +(tot > ln) : c.label === 'Under' ? +(tot < ln) : null;
    case 'OE': case 'OE1H': return c.label === 'Odd' ? +(tot % 2 === 1) : c.label === 'Even' ? +(tot % 2 === 0) : null;
    case 'BTTS': case 'BTTS1H': return c.label === 'Yes' ? +(h > 0 && a > 0) : c.label === 'No' ? +!(h > 0 && a > 0) : null;
    case 'HC': return !half(ln) ? null : c.type === 'OT_ONE' ? +(h + ln > a) : c.type === 'OT_TWO' ? +(a + ln > h) : null;
    default: return null;
  }
}
function positionBin(grp, c, hcLine, gh, ga) {
  const g = gh + ga;
  switch (grp) {
    case 'FT': case 'HT': return clamp(gh - ga, -3, 3) + 3;
    case 'TG': case 'TG1H': return clamp(Math.floor(c.line / 1000) + 1 - g, 1, 8) - 1;
    case 'OE': case 'OE1H': return g % 2;
    case 'BTTS': case 'BTTS1H': return (gh > 0) + (ga > 0);
    case 'HC': return clamp(Math.round(hcLine + gh - ga), -4, 4) + 4;
    default: return 0;
  }
}

// Player state (walk-forward): Elo and an exponentially weighted total-goals rate per player nickname.
const P = new Map(), termMean = new Map();
const pget = (n) => P.get(n) || P.set(n, { R: 1500, g: 0, tg: null }).get(n);
function playerBins(e) {
  const hp = player(e.home), ap = player(e.away);
  if (!hp || !ap) return [7, 7];
  const h = pget(hp), a = pget(ap);
  if (h.g < 8 || a.g < 8) return [7, 7];
  const mean = termMean.get(e.term) || [0, 0];
  const lm = mean[1] ? mean[0] / mean[1] : 6;
  return [bn(h.R - a.R, [-150, -60, -20, 20, 60, 150]), bn((h.tg + a.tg) / 2 - lm, [-1, -0.5, -0.15, 0.15, 0.5, 1])];
}
function playerUpdate(e) {
  const hp = player(e.home), ap = player(e.away);
  const tot = e.fh + e.fa, m = termMean.get(e.term) || [0, 0];
  m[0] += tot; m[1]++; termMean.set(e.term, m);
  if (!hp || !ap) return;
  const h = pget(hp), a = pget(ap), E = 1 / (1 + Math.pow(10, -(h.R - a.R) / 400)), S = e.fh > e.fa ? 1 : e.fh === e.fa ? 0.5 : 0;
  h.R += 16 * (S - E); a.R -= 16 * (S - E);
  for (const x of [h, a]) { x.g++; x.tg = x.tg === null ? tot : 0.9 * x.tg + 0.1 * tot; }
}

const CTX = new Map(), CTXN = [];
const ctxId = (k) => { let i = CTX.get(k); if (i === undefined) { i = CTX.size; CTX.set(k, i); CTXN.push(k); } return i; };

function buildEvent(e, pb) {
  const outs = qOut.all(e.id), bos = new Map();
  for (const c of outs) {
    const grp = GROUP[c.market];
    if (!grp) continue;
    let b = bos.get(c.bo);
    if (!b) bos.set(c.bo, (b = { grp, outs: [], hcLine: 0 }));
    b.outs.push(c);
    if (grp === 'HC' && c.type === 'OT_ONE') b.hcLine = c.line / 1000;
  }
  const px = new Map(), ts = [];
  let last = -1;
  for (const r of qOdds.all(e.id)) {
    let a = px.get(r.oid);
    if (!a) px.set(r.oid, (a = []));
    a.push(r);
    if (r.ts !== last) { ts.push(r.ts); last = r.ts; }
  }
  const scores = qScore.all(e.id), clock = qClock.all(e.id), boSt = new Map();
  for (const r of qBo.all(e.id)) (boSt.get(r.bo) || boSt.set(r.bo, []).get(r.bo)).push(r);
  if (!scores.length || !clock.length) return null;
  const stats = [];
  for (const r of qStats.all(e.id)) { try { const j = JSON.parse(r.json); stats.push({ ts: r.ts, ch: j.home.corners || 0, ca: j.away.corners || 0 }); } catch { /* skip malformed */ } }
  const t2 = clock.find((k) => k.period === '2nd half');
  let H = null;
  if (t2) { const i = lastLE(scores, t2.ts); H = i < 0 ? [0, 0] : [scores[i].home, scores[i].away]; }
  const FIN = [e.fh, e.fa], league = LEAGUE[e.term] ?? 0;

  const snap = (t, live) => {
    const res = new Map();
    for (const [boId, b] of bos) {
      const s = boSt.get(boId);
      if (s) { const j = lastLE(s, t); if (j >= 0 && s[j].status !== 'OPEN') continue; }
      const m = new Map();
      let ok = true, upd = 0;
      for (const c of b.outs) {
        const a = px.get(c.id), i = a ? lastLE(a, t) : -1;
        if (i < 0 || !(a[i].odds > 1050) || a[i].status === 'SUSPENDED') { ok = false; break; }
        m.set(c.id, a[i].odds);
        if (a[i].ts > upd) upd = a[i].ts;
      }
      if (ok && (!live || t - upd <= FRESH_MS)) res.set(boId, m);
    }
    return res;
  };
  const obs = [];
  const emit = (phi, t, tx, gh, ga, period, sg) => {
    if (sg < MIN_SG) return;
    const live = phi > 0, s1 = snap(t, live), s2 = tx === t ? s1 : snap(tx, live), s0 = live ? snap(t - 30000, false) : null;
    const si = stats.length ? lastLE(stats, t) : -1, cd = si >= 0 ? stats[si].ch - stats[si].ca : 0;
    for (const [boId, m1] of s1) {
      const m2 = s2.get(boId);
      if (!m2) continue;
      const b = bos.get(boId);
      if (live && HALF.has(b.grp) && period !== '1st half') continue;
      let inv = 0;
      for (const o of m1.values()) inv += 1000 / o;
      const m0 = s0 && s0.get(boId);
      let inv0 = 0;
      if (m0) for (const o of m0.values()) inv0 += 1000 / o;
      const ovr = bn(inv, [1.05, 1.10]);
      for (const c of b.outs) {
        const y = settle(c, b.grp, FIN, H);
        if (y === null) continue;
        const p = 1000 / m1.get(c.id) / inv, odds = m2.get(c.id) / 1000;
        const label = b.grp === 'HC' ? (c.type === 'OT_ONE' ? 'home' : 'away') : c.label;
        const mom = m0 && m0.has(c.id) ? bn(p - 1000 / m0.get(c.id) / inv0, [-0.05, -0.02, 0.02, 0.05]) : 5;
        const F = [phi, positionBin(b.grp, c, b.hcLine, live ? gh : 0, live ? ga : 0), Math.min(9, Math.floor(p * 10)),
          !live || sg >= 9999 ? 0 : sg < 10 ? 1 : sg < 30 ? 2 : sg < 60 ? 3 : 4, live ? clamp(gh - ga, -3, 3) + 3 : 3, live ? Math.min(gh + ga, 7) : 0, live ? clamp(cd, -3, 3) + 3 : 3,
          mom, pb[0], pb[1], league, bn(odds, [1.3, 1.6, 2, 2.5, 3.5, 5, 8])];
        obs.push({ ctx: ctxId(`${b.grp}|${label}`), grp: b.grp, live, F, pnl: y ? odds - 1 : -1 });
      }
    }
  };
  emit(0, e.start_ms - 30000, e.start_ms - 30000, 0, 0, null, 9999);
  let pi = 0;
  for (const t of ts) {
    if (pi >= PHASES.length) break;
    if (t <= e.start_ms) continue;
    const ki = lastLE(clock, t), si = lastLE(scores, t);
    if (ki < 0 || si < 0) continue;
    const el = clock[ki].minute * 60 + clock[ki].second + Math.min(30, (t - clock[ki].ts) / 1000);
    while (pi < PHASES.length && el >= PHASES[pi] * 60 + 40) pi++;
    if (pi >= PHASES.length) break;
    if (el < PHASES[pi] * 60) continue;
    const tx = t + LAT_MS, sx = lastLE(scores, tx);
    if (sx === si) emit(PHASES[pi], t, tx, scores[si].home, scores[si].away, clock[ki].period, si > 0 ? (t - scores[si].ts) / 1000 : 9999);
    pi++;
  }
  return obs;
}

const SIZE = 40 * (NF + 1) * 16 * (NF + 1) * 16;
const cellIdx = (ctx, fi, bi, fj, bj) => (((ctx * (NF + 1) + fi) * 16 + bi) * (NF + 1) + fj) * 16 + bj;
const cN = new Float64Array(SIZE), cS = new Float64Array(SIZE), cS2 = new Float64Array(SIZE);
const NONE = NF;
function cellsOf(o, out) {
  let k = 0;
  out[k++] = cellIdx(o.ctx, NONE, 0, NONE, 0);
  for (let i = 0; i < NF; i++) {
    out[k++] = cellIdx(o.ctx, i, o.F[i], NONE, 0);
    for (let j = i + 1; j < NF; j++) out[k++] = cellIdx(o.ctx, i, o.F[i], j, o.F[j]);
  }
  return k;
}
const decode = (k) => {
  const bj = k % 16; k = (k - bj) / 16; const fj = k % (NF + 1); k = (k - fj) / (NF + 1);
  const bi = k % 16; k = (k - bi) / 16; const fi = k % (NF + 1); const ctx = (k - fi) / (NF + 1);
  return `${CTXN[ctx]}${fi < NF ? ` ${FNAME[fi]}=${bi}` : ''}${fj < NF ? ` ${FNAME[fj]}=${bj}` : ''}`;
};

const N = evs.length, t0 = Math.floor(N * TRAIN_FRAC), nTest = N - t0, blockLen = Math.ceil(nTest / BLOCKS);
const sel = THRS.map(() => new Uint8Array(SIZE));
const mkAcc = () => ({ pnl: new Float64Array(nTest), n: new Float64Array(nTest) });
const accs = new Map(), base = new Map(), blk = THRS.map(() => Array.from({ length: BLOCKS }, () => ({ pnl: 0, n: 0 })));
const oN = new Float64Array(SIZE), oS = new Float64Array(SIZE);
const getAcc = (k) => { let a = accs.get(k); if (!a) accs.set(k, (a = mkAcc())); return a; };
let nSel = THRS.map(() => []), nCells = 0, used = 0, skipped = 0;
const buf = new Int32Array(1 + NF + NF * (NF - 1) / 2 + NF);

function select() {
  sel.forEach((s) => s.fill(0));
  const cnt = THRS.map(() => 0);
  nCells = 0;
  for (let k = 0; k < SIZE; k++) {
    const n = cN[k];
    if (n < MIN_N) continue;
    nCells++;
    const m = cS[k] / n;
    if (m <= 0) continue;
    const sd = Math.sqrt(Math.max(1e-12, (cS2[k] - n * m * m) / (n - 1))), t = m / (sd / Math.sqrt(n));
    THRS.forEach((thr, i) => { if (t >= thr) { sel[i][k] = 1; cnt[i]++; } });
  }
  THRS.forEach((_, i) => nSel[i].push(cnt[i]));
}
for (let i = 0; i < N; i++) {
  if (i >= t0 && (i - t0) % blockLen === 0) select();
  const e = evs[i], pb = playerBins(e);
  const obs = buildEvent(e, pb);
  playerUpdate(e);
  if (!obs || !obs.length) { skipped++; continue; }
  used++;
  const test = i >= t0, ti = i - t0, bi = Math.floor(ti / blockLen);
  for (const o of obs) {
    const k = cellsOf(o, buf);
    if (test) {
      const gs = [`${o.grp}:${o.live ? 'live' : 'pre'}`, `ALL:${o.live ? 'live' : 'pre'}`, 'ALL'];
      for (const g of gs) { const b = base.get(g) || base.set(g, { s: 0, n: 0 }).get(g); b.s += o.pnl; b.n++; }
      THRS.forEach((_, q) => {
        let fire = false;
        for (let c = 0; c < k; c++) if (sel[q][buf[c]]) { fire = true; if (q === 0) { oN[buf[c]]++; oS[buf[c]] += o.pnl; } }
        if (!fire) return;
        for (const g of gs) { const a = getAcc(`${q}|${g}`); a.pnl[ti] += o.pnl; a.n[ti]++; }
        blk[q][bi].pnl += o.pnl; blk[q][bi].n++;
      });
    }
    for (let c = 0; c < k; c++) { const x = buf[c]; cN[x]++; cS[x] += o.pnl; cS2[x] += o.pnl * o.pnl; }
  }
}

let seed = 987654;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
function bootRatio(num, den, n) {
  const sn = num.reduce((a, x) => a + x, 0), sd = den.reduce((a, x) => a + x, 0), rs = [];
  for (let b = 0; b < B; b++) { let a = 0, d = 0; for (let j = 0; j < n; j++) { const k = Math.floor(rnd() * n); a += num[k]; d += den[k]; } rs.push(d ? a / d : 0); }
  rs.sort((x, y) => x - y);
  return { m: sd ? sn / sd : 0, lo: rs[Math.floor(0.025 * B)], hi: rs[Math.floor(0.975 * B)], p: rs.filter((x) => x <= 0).length / B };
}
const pc = (x) => `${(x * 100).toFixed(1)}%`;
const termsUsed = [...new Set(evs.map((e) => e.term))].join(',');
console.log(`matches used ${used}/${N} (${termsUsed}) | train ${t0}, test ${nTest} in ${BLOCKS} blocks | latency ${LAT_MS / 1000}s fresh ${FRESH_MS / 1000}s | contexts ${CTX.size} | populated cells (n>=${MIN_N}) at last refit: ${nCells}`);
THRS.forEach((thr, q) => {
  console.log(`\nRULES t>=${thr}: selected cells per refit avg ${Math.round(nSel[q].reduce((a, x) => a + x, 0) / nSel[q].length)} (of ${nCells}); OOS bets (test matches only, flat 1 unit, CI resampling matches; p_adj Bonferroni over groups):`);
  const rows = [...accs].filter(([key]) => key.startsWith(`${q}|`)).map(([key, a]) => ({ g: key.slice(key.indexOf('|') + 1), a }));
  const K = Math.max(1, rows.filter((r) => r.a.n.reduce((s, x) => s + x, 0) >= 30).length);
  for (const { g, a } of rows.sort((x, y) => x.g.localeCompare(y.g))) {
    const nb = a.n.reduce((s, x) => s + x, 0), bs = base.get(g), bl = bs ? ` | all-obs baseline ${pc(bs.s / bs.n)} (${bs.n})` : '';
    if (nb < 30) { console.log(`  ${g.padEnd(11)} bets=${nb} (too few)${bl}`); continue; }
    const r = bootRatio(a.pnl, a.n, nTest);
    console.log(`  ${g.padEnd(11)} bets=${String(nb).padStart(6)} ROI=${pc(r.m).padStart(7)} CI=[${pc(r.lo)}, ${pc(r.hi)}] p_adj=${Math.min(1, r.p * K).toFixed(3)}${bl}`);
  }
  console.log('  by block:', blk[q].map((x, i) => `#${i + 1} n=${x.n} ${x.n ? pc(x.pnl / x.n) : '-'}`).join(' | '));
});
if (process.env.DIAG) {
  const top = [];
  for (let k = 0; k < SIZE; k++) if (oN[k] >= 150) top.push([k, oN[k], oS[k] / oN[k]]);
  top.sort((a, b) => b[1] - a[1]);
  console.log('\nMost-fired selected cells (t>=3; descriptive, an obs can fire several cells):');
  for (const [k, n, m] of top.slice(0, 12)) console.log(`  n=${n} ROI=${pc(m)}  ${decode(k)}`);
}
db.close();
