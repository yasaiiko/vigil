'use strict';
// Read-only: parlays (disjoint, independent matches), same-match structures (ladders, middles, hedges, 1X2+TG) and best-of-two books.
// Model copied from goal_markets.js (not modified): 13-min learning lag, prematch price at kickoff-30 s, cluster bootstrap by match.
// Usage: node src/combo_test.js   env: MING=8 RULE_GAP=0.08 RULE_MG=50 WIN_MIN=60 B=400 SEED=1
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const db = new Database(path.join(ROOT, 'data', 'odds.sqlite'), { readonly: true, fileMustExist: true });
const bw = new Database(path.join(ROOT, 'data', 'books.sqlite'), { readonly: true, fileMustExist: true });
const MING = Number(process.env.MING || 8), N = 30;
const RULE_GAP = Number(process.env.RULE_GAP || 0.08), RULE_MG = Number(process.env.RULE_MG || 50);
const WIN_MS = Number(process.env.WIN_MIN || 60) * 60000, B = Number(process.env.B || 400);
let seed = Number(process.env.SEED || 1) >>> 0;
function rnd() { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }

// ---- model (copied from goal_markets.js) ----
const PROF = [
  { name: 'cla', ETA: 0.08, HFA: -0.05, TERM: '%2x5%' }, { name: 'eb', ETA: 0.02, HFA: 0, TERM: 'esports_battle__2x4min_' }, { name: 'ebwc', ETA: 0.02, HFA: 0, TERM: 'esports_battle_world_cup__2x4_min_' },
];
const player = (s) => { const m = /\(([^)]+)\)\s*$/.exec(s || ''); return m ? m[1].trim().toLowerCase() : null; };
const clampE = (x) => Math.max(-0.5, Math.min(0.5, x));
function pois(l) { const a = [Math.exp(-l)]; for (let i = 1; i < N; i++) a.push(a[i - 1] * l / i); return a; }
function grid(lh, la) { return { ph: pois(lh), pa: pois(la) }; }
function prob(gr, f) { let s = 0; for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (f(i, j)) s += gr.ph[i] * gr.pa[j]; return s; }
const qEv = db.prepare("SELECT id, home, away, start_ms, final_home fh, final_away fa FROM events WHERE finished_ms IS NOT NULL AND result_status='ok' AND term LIKE ? ORDER BY start_ms");
const qOdds = db.prepare('SELECT o.outcome_id oid, o.odds, c.market, c.label, c.line FROM odds o JOIN outcomes c ON c.id = o.outcome_id WHERE o.event_id = ? AND o.ts <= ? AND o.odds > 1000 ORDER BY o.ts');
const qScore = db.prepare('SELECT ts, home, away FROM scores WHERE event_id = ? ORDER BY ts');
const qHalf = db.prepare("SELECT MAX(ts) t FROM clock WHERE event_id = ? AND period = '1st half'");
function firstHalf(e) { const t = qHalf.get(e.id).t; if (t == null) return null; const sc = qScore.all(e.id); let h = 0, a = 0; for (const x of sc) { if (x.ts > t) break; h = x.home; a = x.away; } return [h, a]; }
function classify(r, e) {
  const m = r.market, L = r.line == null ? null : r.line / 1000;
  const T = (cls, key, lab, f, n, half) => ({ cls, key, lab, f, n, half });
  if (m === 'Full Time' || m === 'Half Time') { const half = m === 'Half Time', f = r.label === '1' ? (x, y) => x > y : r.label === '2' ? (x, y) => x < y : (x, y) => x === y; return T(half ? 'HT 1X2' : 'FT 1X2', m, r.label, f, 3, half); }
  if (m === 'Both Teams To Score' || m === 'Both Teams To Score - 1st Half') { const half = m.endsWith('Half'); return T(half ? 'BTTS 1H' : 'BTTS', m, r.label, r.label === 'Yes' ? (x, y) => x > 0 && y > 0 : (x, y) => !(x > 0 && y > 0), 2, half); }
  if (m === 'Total Goals Odd/Even' || m === 'Total Goals Odd/Even - 1st Half') { const half = m.endsWith('Half'); return T(half ? 'OE 1H' : 'OE', m, r.label, r.label === 'Odd' ? (x, y) => (x + y) % 2 === 1 : (x, y) => (x + y) % 2 === 0, 2, half); }
  if (m === 'Total Goals' || m === 'Total Goals - 1st Half') { if (L == null || Math.abs(L % 1) !== 0.5) return null; const half = m.endsWith('Half'); return T(half ? 'TG 1H' : 'TG', `${m}|${L}`, `${r.label} ${L}`, r.label === 'Over' ? (x, y) => x + y > L : (x, y) => x + y < L, 2, half); }
  { const tt = /^Total Goals by (.+)$/.exec(m); if (tt) { if (L == null || Math.abs(L % 1) !== 0.5) return null; const isH = tt[1] === e.home, isA = tt[1] === e.away; if (!isH && !isA) return null; const g = isH ? (x) => x : (x, y) => y; return T('TT', `${m}|${L}`, `${r.label} ${L}`, r.label === 'Over' ? (x, y) => g(x, y) > L : (x, y) => g(x, y) < L, 2, false); } }
  if (m === 'Handicap') { if (L == null || Math.abs(L % 1) !== 0.5) return null; const isH = r.label === e.home, isA = r.label === e.away; if (!isH && !isA) return null; const LH = isH ? L : -L; return T('HC', `HC|${LH}`, `${isH ? 'H' : 'A'}${L}`, isH ? (x, y) => x - y + L > 0 : (x, y) => y - x + L > 0, 2, false); }
  const w = / to Win and Both Teams To Score$/.exec(m);
  if (w) { const nm = m.slice(0, w.index), isH = nm === e.home, isA = nm === e.away; if (!isH && !isA) return null; const yes = isH ? (x, y) => x > y && y > 0 : (x, y) => y > x && x > 0; return T('WIN+BTTS', m, r.label, r.label === 'Yes' ? yes : (x, y) => !yes(x, y), 2, false); }
  return null;
}

const rows = []; // one row per outcome with a prematch price
for (const P of PROF) {
  const A = new Map(), D = new Map(), G = new Map();
  let sumG = 0, nM = 0, g1 = 0, gT = 0;
  const lam = (hp, ap) => { const mu = Math.log(sumG / nM / 2), g = (m, k) => m.get(k) ?? 0; return [Math.exp(mu + g(A, hp) - g(D, ap) + P.HFA / 2), Math.exp(mu + g(A, ap) - g(D, hp) - P.HFA / 2)]; };
  const learn = (hp, ap, gh, ga) => {
    if (nM > 0) { const [lh, la] = lam(hp, ap), g = (m, k) => m.get(k) ?? 0, eh = clampE(P.ETA * (gh / lh - 1)), ea = clampE(P.ETA * (ga / la - 1)); A.set(hp, g(A, hp) + eh); D.set(ap, g(D, ap) - eh); A.set(ap, g(A, ap) + ea); D.set(hp, g(D, hp) - ea); }
    G.set(hp, (G.get(hp) || 0) + 1); G.set(ap, (G.get(ap) || 0) + 1); sumG += gh + ga; nM++;
  };
  const evs = qEv.all(P.TERM);
  let jp = 0;
  for (const e of evs) {
    while (jp < evs.length && evs[jp].start_ms < e.start_ms - 13 * 60000) { const q = evs[jp++], qh = player(q.home), qa = player(q.away); if (qh && qa) { learn(qh, qa, q.fh, q.fa); const h = firstHalf(q); if (h) { g1 += h[0] + h[1]; gT += q.fh + q.fa; } } }
    const hp = player(e.home), ap = player(e.away);
    if (!(hp && ap && nM > 50 && (G.get(hp) || 0) >= MING && (G.get(ap) || 0) >= MING && gT > 100)) continue;
    const fh1 = firstHalf(e); if (!fh1) continue;
    const [lh, la] = lam(hp, ap), s = g1 / gT, mg = Math.min(G.get(hp), G.get(ap));
    const G1 = grid(lh, la), Gh = grid(lh * s, la * s);
    const last = new Map();
    for (const r of qOdds.all(e.id, e.start_ms - 30000)) last.set(r.oid, r);
    const groups = new Map();
    for (const r of last.values()) { const cls = classify(r, e); if (!cls) continue; const g = groups.get(cls.key) || { cls, outs: [] }; g.outs.push({ r, cls }); groups.set(cls.key, g); }
    for (const g of groups.values()) {
      if (g.outs.length !== g.cls.n) continue;
      const inv = g.outs.map((o) => 1000 / o.r.odds), tot = inv.reduce((a, b) => a + b, 0);
      g.outs.forEach((o, i) => {
        const pm = inv[i] / tot, c = o.cls, gr = c.half ? Gh : G1, sc = c.half ? fh1 : [e.fh, e.fa];
        const pmod = prob(gr, (x, y) => c.f(x, y)), win = c.f(sc[0], sc[1]);
        rows.push({ ev: e.id, lg: P.name, t: e.start_ms, cls: c.cls, key: c.key, lab: c.lab, lb: o.r.label, L: c.cls === 'TG' ? Number(c.key.slice(c.key.lastIndexOf('|') + 1)) : null, hp, ap, pm, pmod, gap: pmod - pm, odds: o.r.odds / 1000, win: win ? 1 : 0, mg });
      });
    }
  }
}

// ---- stats ----
function boot(list, f, key = 'ev', nb = B) {
  const by = new Map();
  for (const x of list) { const a = by.get(x[key]); if (a) a.push(x); else by.set(x[key], [x]); }
  const cl = [...by.values()], n = cl.length;
  if (!n) return [NaN, NaN, NaN];
  const out = [];
  for (let b = 0; b < nb; b++) { const s = []; for (let i = 0; i < n; i++) for (const x of cl[Math.floor(rnd() * n)]) s.push(x); out.push(f(s)); }
  out.sort((a, b) => a - b);
  return [f(list), out[Math.floor(0.025 * nb)], out[Math.floor(0.975 * nb)]];
}
const meanOf = (a, k) => (a.length ? a.reduce((s, x) => s + x[k], 0) / a.length : NaN);
const roiOf = (a) => meanOf(a, 'net');
const betaOf = (a) => { let u = 0, v = 0; for (const x of a) { u += x.gap * (x.win - x.pm); v += x.gap * x.gap; } return u / v; };
function tstat(a) { const n = a.length; if (n < 2) return NaN; const m = meanOf(a, 'net'), v = a.reduce((s, x) => s + (x.net - m) ** 2, 0) / (n - 1); return m / Math.sqrt(v) * Math.sqrt(n); }
const legsMargin = (a) => meanOf(a.map((x) => ({ m: 1 - x.odds * x.pm })), 'm');
const pc = (x) => (Number.isFinite(x) ? (100 * x).toFixed(1) + '%' : 'NA');
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : 'NA');
const ci = (t) => `${pc(t[0])} [${pc(t[1])}, ${pc(t[2])}]`;
const ci2 = (t) => `${f2(t[0])} [${f2(t[1])}, ${f2(t[2])}]`;
const nEv = (a) => new Set(a.map((x) => x.ev)).size;

// ---- sanity: reproduce goal_markets.js baseline in the same DB snapshot ----
function refGoalMarkets() {
  let out = '';
  try { out = execFileSync(process.execPath, [path.join(__dirname, 'goal_markets.js')], { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 900000 }); } catch (e) { out = String(e.stdout || ''); }
  const ref = new Map();
  for (const line of out.split('\n')) { const m = /^(.+?)\s+matches (\d+) \| beta (-?[\d.]+)/.exec(line); if (m && !ref.has(m[1].trim())) ref.set(m[1].trim(), { n: Number(m[2]), beta: Number(m[3]) }); }
  return ref;
}
{
  const ref = refGoalMarkets();
  let ok = true; const parts = [];
  for (const c of ['TG', 'BTTS', 'FT 1X2']) {
    const a = rows.filter((r) => r.cls === c), n = nEv(a), be = betaOf(a), R = ref.get(c);
    const good = !!R && R.n === n && Number(be.toFixed(2)) === R.beta; ok = ok && good;
    parts.push(`${c} matches ${n} (ref ${R ? R.n : 'NA'}) beta ${be.toFixed(2)} (ref ${R ? R.beta : 'NA'})`);
  }
  console.log(`SANITY ${ok ? 'OK' : 'FAIL'} | ${parts.join(' | ')}`);
}

// ---- 1) v3 legs and parlays ----
const cand = rows.filter((r) => (r.cls === 'TG' || r.cls === 'BTTS' || r.cls === 'HC') && r.gap > RULE_GAP && r.mg >= RULE_MG);
const pick = new Map();
for (const r of cand) { const b = pick.get(r.ev); if (!b || r.gap > b.gap) pick.set(r.ev, r); }
const legs = [...pick.values()].sort((a, b) => a.t - b.t).map((r) => ({ ...r, net: r.win ? r.odds - 1 : -1 }));
console.log(`LEGS v3 (TG/BTTS/HC, gap>${RULE_GAP}, min games>=${RULE_MG}, 1 per match): n=${legs.length} (TG ${legs.filter((x) => x.cls === 'TG').length}) | singles ROI ${ci(boot(legs, roiOf))} | t ${f2(tstat(legs))} | avg leg margin ${pc(legsMargin(legs))}`);

{ const od = legs.map((x) => x.odds).sort((a, b) => a - b); console.log(`DIAG legs hit real ${pc(meanOf(legs, 'win'))} vs model ${pc(meanOf(legs, 'pmod'))} vs market ${pc(meanOf(legs, 'pm'))} | odds p50 ${f2(od[od.length >> 1])} p90 ${f2(od[Math.floor(od.length * 0.9)])} max ${f2(od[od.length - 1])}`); }
function build(k) { // greedy disjoint tickets of k legs, kickoffs within WIN_MS, no shared player
  const used = new Uint8Array(legs.length), out = [];
  for (let i = 0; i < legs.length; i++) {
    if (used[i]) continue;
    const grp = [i], pl = new Set([legs[i].hp, legs[i].ap]);
    for (let j = i + 1; j < legs.length && grp.length < k && legs[j].t - legs[i].t <= WIN_MS; j++) {
      if (used[j] || pl.has(legs[j].hp) || pl.has(legs[j].ap)) continue;
      grp.push(j); pl.add(legs[j].hp); pl.add(legs[j].ap);
    }
    if (grp.length === k) { for (const x of grp) used[x] = 1; out.push(grp.map((x) => legs[x])); }
  }
  return out.map((L, idx) => {
    const win = L.every((x) => x.win) ? 1 : 0, odds = L.reduce((p, x) => p * x.odds, 1), rtp = L.reduce((p, x) => p * x.odds * x.pm, 1);
    return { ev: idx, win, odds, rtp, net: win ? odds - 1 : -1, legs: L };
  });
}
for (const k of [2, 3]) {
  const P = build(k), U = P.flatMap((p) => p.legs);
  if (!P.length) { console.log(`PARLAY k=${k}: no tickets`); continue; }
  const rS = roiOf(U), g = meanOf(U.map((x) => ({ v: x.win ? x.odds : 0 })), 'v'), s2 = meanOf(U.map((x) => ({ v: x.win ? x.odds * x.odds : 0 })), 'v');
  const mL = legsMargin(U), rtpP = meanOf(P, 'rtp');
  const hitM = meanOf(P.map((p) => ({ v: p.legs.reduce((q, x) => q * x.pmod, 1) })), 'v'), hitK = meanOf(P.map((p) => ({ v: p.legs.reduce((q, x) => q * x.pm, 1) })), 'v');
  const srt = P.map((p) => p.net).sort((a, b) => b - a), totN = srt.reduce((s, x) => s + x, 0), top3 = srt.slice(0, 3).reduce((s, x) => s + x, 0);
  console.log(`  DIAG hit real ${pc(meanOf(P, 'win'))} vs model ${pc(hitM)} vs market ${pc(hitK)} | top3 nets ${srt.slice(0, 3).map((x) => x.toFixed(0)).join(', ')} of total ${totN.toFixed(0)} | ROI ex-top3 ${pc((totN - top3) / P.length)}`);
  const tTheo = Math.sqrt(P.length) * (g ** k - 1) / Math.sqrt(s2 ** k - g ** (2 * k)), tSTheo = Math.sqrt(U.length) * (g - 1) / Math.sqrt(s2 - g * g);
  console.log(`PARLAY k=${k}: tickets ${P.length} (legs ${U.length}, disjoint, window ${WIN_MS / 60000} min)`);
  console.log(`  ROI parlay ${ci(boot(P, roiOf))} | same legs singles ${ci(boot(U, roiOf))} | (1+r)^k-1 = ${pc((1 + rS) ** k - 1)} | ROI mercado indep. ${pc(rtpP - 1)}`);
  console.log(`  margen leg ${pc(mL)} -> 1-(1-m)^k ${pc(1 - (1 - mL) ** k)} | empirico 1-mean(prod RTP) ${pc(1 - rtpP)} | t tickets ${f2(tstat(P))} vs singles ${f2(tstat(U))} | t teorico ${f2(tTheo)} vs singles ${f2(tSTheo)}`);
}

// ---- 2) same-match structures ----
const tg = new Map();
for (const r of rows) if (r.cls === 'TG') { let m = tg.get(r.ev); if (!m) tg.set(r.ev, m = new Map()); let x = m.get(r.L); if (!x) m.set(r.L, x = {}); x[r.lb] = r; }
const both = (m) => [...m.keys()].filter((L) => m.get(L).Over && m.get(L).Under).sort((a, b) => a - b);
let nLad = 0, pr = 0, vRaw = 0, vPm = 0, uV = 0, cov = 0, covArb = 0, same = 0, sameArb = 0;
const mid = { 1: [], 2: [], 3: [] }, hedge = [];
for (const [ev, m] of tg) {
  const Ls = both(m);
  if (Ls.length >= 2) nLad++;
  for (const L of Ls) {
    const x = m.get(L); same++;
    if (1 / x.Over.odds + 1 / x.Under.odds < 1) sameArb++;
    const net = ((x.Over.win ? x.Over.odds - 1 : -1) + (x.Under.win ? x.Under.odds - 1 : -1)) / 2;
    hedge.push({ ev, net, exp: (x.Over.pm * x.Over.odds + x.Under.pm * x.Under.odds) / 2 - 1 });
  }
  for (let i = 0; i < Ls.length; i++) for (let j = i + 1; j < Ls.length; j++) {
    const a = m.get(Ls[i]), b = m.get(Ls[j]);
    pr++;
    if (1 / a.Over.odds < 1 / b.Over.odds) vRaw++;
    if (a.Over.pm < b.Over.pm) vPm++;
    if (a.Under.pm > b.Under.pm) uV++;
    cov++; if (1 / a.Over.odds + 1 / b.Under.odds < 1) covArb++;
    const d = Math.round(Ls[j] - Ls[i]);
    if (d <= 3) { // Over a + Under b: both win on totals strictly inside (a, b)
      const net = ((a.Over.win ? a.Over.odds - 1 : -1) + (b.Under.win ? b.Under.odds - 1 : -1)) / 2;
      mid[d].push({ ev, net, exp: (a.Over.pm * a.Over.odds + b.Under.pm * b.Under.odds) / 2 - 1 });
    }
  }
}
console.log(`LADDER events>=2 lines ${nLad} | pairs ${pr}: raw-odds Over non-monotone ${vRaw}, pm Over ${vPm}, pm Under ${uV} | cover arb (1/O_a+1/U_b<1, b>a) ${covArb}/${cov} | same-line arb ${sameArb}/${same}`);
for (const d of [1, 2, 3]) { const a = mid[d]; console.log(`MIDDLE Over a + Under a+${d}: matches ${nEv(a)} lines ${a.length} | ROI ${ci(boot(a, roiOf))} | ROI a mercado (lineal) ${pc(meanOf(a, 'exp'))}`); }
console.log(`HEDGE Over L + Under L: matches ${nEv(hedge)} lines ${hedge.length} | ROI ${ci(boot(hedge, roiOf))} | ROI a mercado ${pc(meanOf(hedge, 'exp'))}`);

// 1X2 + TG same match (lines 2.5/3.5/4.5): joint hit vs independence at market prices
const ft = new Map();
for (const r of rows) if (r.cls === 'FT 1X2') { let m = ft.get(r.ev); if (!m) ft.set(r.ev, m = {}); m[r.lb] = r; }
const sg = [];
for (const [ev, m] of tg) {
  const f = ft.get(ev); if (!f) continue;
  for (const L of [2.5, 3.5, 4.5]) {
    const x = m.get(L); if (!x || !x.Over || !x.Under) continue;
    for (const lb of ['1', 'X', '2']) {
      const o = f[lb]; if (!o) continue;
      for (const side of ['Over', 'Under']) {
        const t = x[side];
        sg.push({ ev, lb, side, w1: o.win, wT: t.win, wj: o.win * t.win, net: o.win && t.win ? o.odds * t.odds - 1 : -1, exp: o.pm * o.odds * t.pm * t.odds - 1 });
      }
    }
  }
}
const lift = (z) => meanOf(z, 'wj') / (meanOf(z, 'w1') * meanOf(z, 'wT'));
// lift is only informative within a cell (label x side): pooling complementary outcomes makes it identically 1
for (const lb of ['1', 'X', '2']) for (const side of ['Over', 'Under']) {
  const a = sg.filter((x) => x.lb === lb && x.side === side);
  console.log(`SGP 1X2+TG ${lb} & ${side} (L 2.5/3.5/4.5): items ${a.length} matches ${nEv(a)} | ROI ${ci(boot(a, roiOf, 'ev', 200))} | ROI si indep. ${pc(meanOf(a, 'exp'))} | lift P(joint)/(P1*PTG) ${ci2(boot(a, lift, 'ev', 200))}`);
}

// ---- 3) best of two books (bwin vs Kambi), v3 TG legs ----
const fx = bw.prepare('SELECT DISTINCT fid, home, away, start_ms FROM bwin WHERE start_ms < ? ORDER BY start_ms').all(Date.now() - 12 * 60000);
const qKev = db.prepare("SELECT id FROM events WHERE home = ? AND away = ? AND ABS(start_ms - ?) < 120000 AND finished_ms IS NOT NULL AND result_status = 'ok'");
const qBw = bw.prepare('SELECT market, opt, odds FROM bwin WHERE fid = ? AND ts <= ? ORDER BY ts');
const bwEv = new Map();
for (const f of fx) {
  const e = qKev.get(f.home, f.away, f.start_ms); if (!e) continue;
  const b = new Map(); for (const r of qBw.all(f.fid, f.start_ms - 20000)) b.set(`${r.market}|${r.opt}`, r.odds / 1000);
  bwEv.set(e.id, b);
}
const tl = legs.filter((x) => x.cls === 'TG').map((x) => {
  const b = bwEv.get(x.ev), ob = b ? (b.get(`Total de goles|${x.lb === 'Over' ? 'Más de' : 'Menos de'} ${x.L.toFixed(1).replace('.', ',')}`) ?? null) : null;
  const best = ob && ob > x.odds ? ob : x.odds;
  return { ...x, ob, netB: x.win ? best - 1 : -1 };
});
const wb = tl.filter((x) => x.ob);
console.log(`BOOKS bwin matched events ${bwEv.size} | v3 TG legs with bwin price ${wb.length}/${tl.length} | bwin better in ${wb.filter((x) => x.ob > x.odds).length}`);
console.log(`  ROI Kambi ${ci(boot(wb, roiOf))} | ROI best-of-two ${ci(boot(wb.map((x) => ({ ev: x.ev, net: x.netB })), roiOf))}`);
