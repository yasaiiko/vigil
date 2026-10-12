'use strict';
// Blind walk-forward scan of every settleable market, prematch and in-play (game minutes 1-7). Read-only.
// Procedure fixed before looking at any result: the first 40% of matches only train; the rest is tested in 6 expanding-window blocks.
// A cell (market, outcome, phase, position vs the line, probability bin) is bet only if, on PAST matches only, n>=60 and the one-sided t of its ROI >= THR.
// Execution uses the price LAT_S seconds after the decision and is rejected if the market is closed or the score changed.
// Usage: node src/scan.js [db]   env: LAT_S=10  TERM_LIKE='esports_battle%'  KEEP_GAPS=1
const path = require('node:path');
const Database = require('better-sqlite3');
const { loadGaps, hits } = require('./gaps');

const LAT_MS = Number(process.env.LAT_S ?? 10) * 1000;
const MIN_SG = Number(process.env.MIN_SG ?? 0); // phantom guard: skip in-play observations less than MIN_SG s after a score change (quotes just after a goal are stale and not tradable; set 45 for the periodic review)
const FRESH_MS = Number(process.env.FRESH_S ?? 45) * 1000; // an in-play price counts only if its market was updated this recently (otherwise it may be closed)
const TERM_LIKE = process.env.TERM_LIKE || 'esports_battle%';
const THRS = [2, 3], MIN_N = 60, TRAIN_FRAC = 0.4, BLOCKS = 6, PHASES = [1, 2, 3, 4, 5, 6, 7], B = 1500;
const db = new Database(process.argv[2] || path.join(__dirname, '..', 'data', 'odds.sqlite'), { readonly: true, fileMustExist: true });
const gaps = process.env.KEEP_GAPS ? [] : loadGaps(db);
const evs = db.prepare(`SELECT id, start_ms, final_home fh, final_away fa FROM events WHERE finished_ms IS NOT NULL AND result_status='ok' AND term LIKE ? AND start_ms >= ? ORDER BY start_ms`).all(TERM_LIKE, Date.parse(process.env.SINCE || '2000-01-01'))
  .filter((e) => !hits(gaps, e.start_ms - 35 * 60000, e.start_ms + 12 * 60000));
const qOut = db.prepare('SELECT id, betoffer_id bo, market, label, line, type FROM outcomes WHERE event_id=?');
const qOdds = db.prepare('SELECT ts, outcome_id oid, odds, status FROM odds WHERE event_id=? ORDER BY ts');
const qScore = db.prepare('SELECT ts, home, away FROM scores WHERE event_id=? ORDER BY ts');
const qClock = db.prepare('SELECT ts, period, minute, second FROM clock WHERE event_id=? ORDER BY ts');
const qBo = db.prepare('SELECT ts, betoffer_id bo, status FROM bo_status WHERE event_id=? ORDER BY ts');

const GROUP = { 'Full Time': 'FT', 'Total Goals': 'TG', 'Total Goals Odd/Even': 'OE', Handicap: 'HC', 'Half Time': 'HT', 'Total Goals - 1st Half': 'TG1H', 'Total Goals Odd/Even - 1st Half': 'OE1H', 'Both Teams To Score': 'BTTS', 'Both Teams To Score - 1st Half': 'BTTS1H' };
const HALF = new Set(['HT', 'TG1H', 'OE1H', 'BTTS1H']);
const lastLE = (arr, ts) => { let lo = 0, hi = arr.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].ts <= ts) { r = m; lo = m + 1; } else hi = m - 1; } return r; };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const half = (x) => Math.abs(x % 1) === 0.5;

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
// Position of the bet relative to its threshold at the decision time, so that all lines of a market pool into one cell.
function position(grp, c, hcLine, gh, ga) {
  const g = gh + ga;
  switch (grp) {
    case 'FT': case 'HT': return clamp(gh - ga, -3, 3);
    case 'TG': case 'TG1H': return clamp(Math.floor(c.line / 1000) + 1 - g, 1, 12);
    case 'OE': case 'OE1H': return g % 2;
    case 'BTTS': case 'BTTS1H': return (gh > 0) + (ga > 0);
    case 'HC': return clamp(hcLine + gh - ga, -6.5, 6.5);
    default: return 0;
  }
}

function buildEvent(e) {
  const outs = qOut.all(e.id);
  const bos = new Map();
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
  const t2 = clock.find((k) => k.period === '2nd half');
  let H = null;
  if (t2) { const i = lastLE(scores, t2.ts); H = i < 0 ? [0, 0] : [scores[i].home, scores[i].away]; }
  const F = [e.fh, e.fa];

  const snap = (t, live) => { // betoffer -> {odds:Map(outcomeId->odds)} for fully priced, open betoffers
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
  const emit = (ph, t, tx, gh, ga, period, sg) => {
    if (sg < MIN_SG) return;
    const live = ph !== 'pre', s1 = snap(t, live), s2 = tx === t ? s1 : snap(tx, live);
    for (const [boId, m1] of s1) {
      const m2 = s2.get(boId);
      if (!m2) continue;
      const b = bos.get(boId);
      if (ph !== 'pre' && HALF.has(b.grp) && period !== '1st half') continue;
      let inv = 0;
      for (const o of m1.values()) inv += 1000 / o;
      for (const c of b.outs) {
        const y = settle(c, b.grp, F, H);
        if (y === null) continue;
        const p = 1000 / m1.get(c.id) / inv, odds = m2.get(c.id) / 1000;
        const label = b.grp === 'HC' ? (c.type === 'OT_ONE' ? 'home' : 'away') : c.label;
        const st = ph === 'pre' ? position(b.grp, c, b.hcLine, 0, 0) : position(b.grp, c, b.hcLine, gh, ga);
        obs.push({ ev: e.id, t, gh, ga, H, F, lbl: label, ln: c.line, odds, grp: b.grp, ph, sg, key: `${b.grp}|${label}|${ph}|${st}|${Math.min(4, Math.floor(p * 5))}`, p, y, pnl: y ? odds - 1 : -1 });
      }
    }
  };
  emit('pre', e.start_ms - 30000, e.start_ms - 30000, 0, 0, null, 9999);
  let pi = 0;
  for (const t of ts) {
    if (pi >= PHASES.length) break;
    if (t <= e.start_ms) continue;
    const ki = lastLE(clock, t), si = lastLE(scores, t);
    if (ki < 0 || si < 0) continue;
    const el = clock[ki].minute * 60 + clock[ki].second + Math.min(30, (t - clock[ki].ts) / 1000);
    while (pi < PHASES.length && el >= PHASES[pi] * 60 + 40) pi++; // stale: this phase had no fresh quote
    if (pi >= PHASES.length) break;
    if (el < PHASES[pi] * 60) continue;
    const tx = t + LAT_MS, sx = lastLE(scores, tx);
    if (sx === si) emit(`m${PHASES[pi]}`, t, tx, scores[si].home, scores[si].away, clock[ki].period, si > 0 ? (t - scores[si].ts) / 1000 : 9999);
    pi++;
  }
  return obs;
}

// Walk-forward
const N = evs.length, t0 = Math.floor(N * TRAIN_FRAC), nTest = N - t0, blockLen = Math.ceil(nTest / BLOCKS);
const cells = new Map();
const mkAcc = () => ({ pnl: new Float64Array(nTest), n: new Float64Array(nTest) });
const accs = new Map(), base = new Map(), cal = new Map(), blk = THRS.map(() => Array.from({ length: BLOCKS }, () => ({ pnl: 0, n: 0 })));
const getAcc = (m, k) => { let a = m.get(k); if (!a) m.set(k, (a = mkAcc())); return a; };
const calArr = (k) => { let a = cal.get(k); if (!a) cal.set(k, (a = new Float64Array(5 * N))); return a; };
const gnames = (o) => { const l = o.ph === 'pre' ? 'pre' : 'live'; return [`${o.grp}:${l}`, `ALL:${l}`, 'ALL']; };
const diag = new Map(), smp = {};
let sel = THRS.map(() => new Set()), used = 0, skipped = 0;

function select() {
  sel = THRS.map(() => new Set());
  for (const [k, c] of cells) {
    if (c[0] < MIN_N) continue;
    const m = c[1] / c[0], sd = Math.sqrt(Math.max(1e-12, (c[2] - c[0] * m * m) / (c[0] - 1)));
    const t = m / (sd / Math.sqrt(c[0]));
    THRS.forEach((thr, i) => { if (m > 0 && t >= thr) sel[i].add(k); });
  }
}
for (let i = 0; i < N; i++) {
  if (i >= t0 && (i - t0) % blockLen === 0) select();
  const obs = buildEvent(evs[i]);
  if (!obs || !obs.length) { skipped++; continue; }
  used++;
  const test = i >= t0, ti = i - t0, bi = Math.floor(ti / blockLen);
  for (const o of obs) {
    for (const g of gnames(o)) { const a = calArr(g); a[5 * i] += 1; a[5 * i + 1] += o.p; a[5 * i + 2] += o.y; a[5 * i + 3] += o.p * o.p; a[5 * i + 4] += o.p * o.y; }
    if (test) {
      for (const g of gnames(o)) { const b = base.get(g) || base.set(g, { s: 0, n: 0 }).get(g); b.s += o.pnl; b.n++; }
      THRS.forEach((_, k) => {
        if (!sel[k].has(o.key)) return;
        for (const g of gnames(o)) { const a = getAcc(accs, `${k}|${g}`); a.pnl[ti] += o.pnl; a.n[ti]++; }
        blk[k][bi].pnl += o.pnl; blk[k][bi].n++;
        if (k === 0 && process.env.DIAG && o.grp === process.env.DIAG && o.ph !== 'pre' && (smp[o.grp] = (smp[o.grp] || 0) + 1) <= 14) console.log(`  SAMPLE ev=${o.ev} t+${Math.round((o.t - evs[i].start_ms) / 1000)}s ${o.ph} ${o.lbl} line=${o.ln} odds=${o.odds} score@t=${o.gh}-${o.ga} HT=${o.H} FT=${o.F} y=${o.y} key=${o.key}`);
        if (k === 0) for (const dk of [`ph ${o.ph}`, `sinceGoal ${o.sg < 15 ? '<15s' : o.sg < 40 ? '15-40s' : o.sg < 9999 ? '>40s' : 'nogoal'}`]) { const d = diag.get(dk) || diag.set(dk, { s: 0, n: 0 }).get(dk); d.s += o.pnl; d.n++; }
      });
    }
  }
  for (const o of obs) { const c = cells.get(o.key) || cells.set(o.key, [0, 0, 0]).get(o.key); c[0]++; c[1] += o.pnl; c[2] += o.pnl * o.pnl; }
}

let seed = 12345;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
function bootRatio(num, den, n) {
  const sn = num.reduce((a, x) => a + x, 0), sd = den.reduce((a, x) => a + x, 0);
  const rs = [];
  for (let b = 0; b < B; b++) { let a = 0, d = 0; for (let j = 0; j < n; j++) { const k = Math.floor(rnd() * n); a += num[k]; d += den[k]; } rs.push(d ? a / d : 0); }
  rs.sort((x, y) => x - y);
  return { m: sd ? sn / sd : 0, n: sd, lo: rs[Math.floor(0.025 * B)], hi: rs[Math.floor(0.975 * B)], p: rs.filter((x) => x <= 0).length / B };
}
const pc = (x) => `${(x * 100).toFixed(1)}%`;

console.log(`matches used ${used}/${N} (no state: ${skipped}) | train ${t0}, test ${nTest} in ${BLOCKS} blocks | latency ${LAT_MS / 1000}s | terms ${TERM_LIKE} | cells seen ${cells.size}`);
console.log('\nCALIBRATION (all matches; slope of outcome on de-vigged market probability, 1.00 = calibrated):');
for (const [g, a] of [...cal].sort()) {
  const slope = (idx) => { let n = 0, sp = 0, sy = 0, spp = 0, spy = 0; for (const i of idx) { n += a[5 * i]; sp += a[5 * i + 1]; sy += a[5 * i + 2]; spp += a[5 * i + 3]; spy += a[5 * i + 4]; } return { s: (n * spy - sp * sy) / (n * spp - sp * sp), n, p: sp / n, y: sy / n }; };
  const all = Array.from({ length: N }, (_, i) => i), r = slope(all), bs = [];
  for (let b = 0; b < 300; b++) bs.push(slope(Array.from({ length: N }, () => Math.floor(rnd() * N))).s);
  bs.sort((x, y) => x - y);
  console.log(`  ${g.padEnd(11)} obs=${String(r.n).padStart(7)} meanP=${r.p.toFixed(3)} meanY=${r.y.toFixed(3)} slope=${r.s.toFixed(2)} [${bs[7].toFixed(2)}, ${bs[292].toFixed(2)}]`);
}
THRS.forEach((thr, k) => {
  console.log(`\nWALK-FORWARD BETS thr t>=${thr} (test matches only; flat 1 unit; CI by resampling matches; p_adj = Bonferroni over groups with >=30 bets):`);
  const rows = [...accs].filter(([key]) => key.startsWith(`${k}|`)).map(([key, a]) => ({ g: key.slice(key.indexOf('|') + 1), a }));
  const K = rows.filter((r) => r.a.n.reduce((s, x) => s + x, 0) >= 30).length;
  for (const { g, a } of rows.sort((x, y) => x.g.localeCompare(y.g))) {
    const nb = a.n.reduce((s, x) => s + x, 0);
    const bs = base.get(g), bl = bs ? ` | all-obs baseline ${pc(bs.s / bs.n)} (${bs.n})` : '';
    if (nb < 30) { console.log(`  ${g.padEnd(11)} bets=${nb} (too few)${bl}`); continue; }
    const r = bootRatio(a.pnl, a.n, nTest);
    console.log(`  ${g.padEnd(11)} bets=${String(nb).padStart(6)} ROI=${pc(r.m).padStart(7)} CI=[${pc(r.lo)}, ${pc(r.hi)}] p_adj=${Math.min(1, r.p * K).toFixed(3)}${bl}`);
  }
  console.log('  by block:', blk[k].map((x, i) => `#${i + 1} n=${x.n} ${x.n ? pc(x.pnl / x.n) : '-'}`).join(' | '));
});
if (process.env.DIAG) for (const [k, d] of [...diag].sort()) console.log(`  DIAG ${k.padEnd(18)} bets=${d.n} ROI=${pc(d.s / d.n)}`);
db.close();
