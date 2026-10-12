'use strict';
// Read-only walk-forward test: per-player corners/cards signal added to the Poisson goal model.
// log lambda_team += k * (signal attack - signal defence), k in {0.25, 0.5}; base k=0 must reproduce goal_markets.js.
// Signal effects learned walk-forward (13-min lag, same ETA/HFA as the profile) ONLY from matches with usable stats.
// Usable = stats kept up with match clock (last stats >= last clock -2 min), game time >=90% nominal (480 s; 600 s for 2x5), first stats <=10 min after kickoff, no capture_gaps overlap.
// Markets: TG, FT 1X2, BTTS, HC. Usage: node src/corners_test.js
const path = require('node:path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, '..', 'data', 'odds.sqlite'), { readonly: true, fileMustExist: true });
const MING = 8, N = 30, LAG = 13 * 60000, B = 3000;
const MARKETS = ['TG', 'FT 1X2', 'BTTS', 'HC'];
const VARS = [{ name: 'base k0', sig: null, k: 0 }, { name: 'corners k.25', sig: 'corners', k: 0.25 }, { name: 'corners k.5', sig: 'corners', k: 0.5 }, { name: 'cards k.25', sig: 'cards', k: 0.25 }, { name: 'cards k.5', sig: 'cards', k: 0.5 }];
const PROF = [
  { name: 'cla', ETA: 0.08, HFA: -0.05, TERM: '%2x5%' }, { name: 'eb', ETA: 0.02, HFA: 0, TERM: 'esports_battle__2x4min_' }, { name: 'ebwc', ETA: 0.02, HFA: 0, TERM: 'esports_battle_world_cup__2x4_min_' },
];
const player = (s) => { const m = /\(([^)]+)\)\s*$/.exec(s || ''); return m ? m[1].trim().toLowerCase() : null; };
const clampE = (x) => Math.max(-0.5, Math.min(0.5, x));
const g0 = (m, k) => m.get(k) ?? 0;
function pois(l) { const a = [Math.exp(-l)]; for (let i = 1; i < N; i++) a.push(a[i - 1] * l / i); return a; }
const grid = (lh, la) => ({ ph: pois(lh), pa: pois(la) });
function prob(gr, f) { let s = 0; for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (f(i, j)) s += gr.ph[i] * gr.pa[j]; return s; }

const qEv = db.prepare("SELECT id, term, home, away, start_ms, finished_ms, final_home fh, final_away fa FROM events WHERE finished_ms IS NOT NULL AND result_status='ok' AND term LIKE ? ORDER BY start_ms");
const qOdds = db.prepare('SELECT o.outcome_id oid, o.odds, c.market, c.label, c.line FROM odds o JOIN outcomes c ON c.id = o.outcome_id WHERE o.event_id = ? AND o.ts <= ? AND o.odds > 1000 ORDER BY o.ts');
const qScore = db.prepare('SELECT ts, home, away FROM scores WHERE event_id = ? ORDER BY ts');
const qHalf = db.prepare("SELECT MAX(ts) t FROM clock WHERE event_id = ? AND period = '1st half'");
const qSF = db.prepare('SELECT MIN(ts) t FROM stats WHERE event_id = ?');
const qSL = db.prepare('SELECT ts, json FROM stats WHERE event_id = ? ORDER BY ts DESC LIMIT 1');
const qCL = db.prepare('SELECT MAX(ts) l, MAX(minute*60+second) g FROM clock WHERE event_id = ?');
const GAPS = db.prepare('SELECT start_ms s, end_ms e FROM capture_gaps').all();

function firstHalf(e) {
  const t = qHalf.get(e.id).t; if (t == null) return null;
  const sc = qScore.all(e.id); let h = 0, a = 0;
  for (const x of sc) { if (x.ts > t) break; h = x.home; a = x.away; }
  return [h, a];
}
function classify(r, e) {
  const m = r.market, L = r.line == null ? null : r.line / 1000;
  const T = (cls, key, lab, f, n) => ({ cls, key, lab, f, n });
  if (m === 'Full Time') return T('FT 1X2', m, r.label, r.label === '1' ? (x, y) => x > y : r.label === '2' ? (x, y) => x < y : (x, y) => x === y, 3);
  if (m === 'Both Teams To Score') return T('BTTS', m, r.label, r.label === 'Yes' ? (x, y) => x > 0 && y > 0 : (x, y) => !(x > 0 && y > 0), 2);
  if (m === 'Total Goals') { if (L == null || Math.abs(L % 1) !== 0.5) return null; return T('TG', `${m}|${L}`, `${r.label} ${L}`, r.label === 'Over' ? (x, y) => x + y > L : (x, y) => x + y < L, 2); }
  if (m === 'Handicap') { if (L == null || Math.abs(L % 1) !== 0.5) return null; const isH = r.label === e.home, isA = r.label === e.away; if (!isH && !isA) return null; const LH = isH ? L : -L; return T('HC', `HC|${LH}`, `${isH ? 'H' : 'A'}${L}`, isH ? (x, y) => x - y + L > 0 : (x, y) => y - x + L > 0, 2); }
  return null;
}

const UC = new Map(), diag = { withStats: 0, lastOk: 0, firstOk: 0, dl: [], df: [] };
function getU(e) {
  if (UC.has(e.id)) return UC.get(e.id);
  let r = null;
  const f = qSF.get(e.id).t, l = qSL.get(e.id);
  if (l && f != null) {
    const cl = qCL.get(e.id), end = Math.max(l.ts, cl.l ?? 0), nom = /2x5/.test(e.term) ? 600 : 480;
    diag.withStats++; diag.dl.push((l.ts - cl.l) / 6e4); diag.df.push((f - e.start_ms) / 6e4);
    const okL = l.ts >= cl.l - 2 * 6e4, okG = cl.g >= 0.9 * nom, okF = f <= e.start_ms + 10 * 6e4;
    if (okL) { diag.lastOk++; }
    if (okF) { diag.firstOk++; }
    const gap = GAPS.some((g) => g.s <= end && (g.e ?? Infinity) >= e.start_ms);
    let j = null; try { j = JSON.parse(l.json); } catch { j = null; }
    const H = j && j.home, A = j && j.away;
    const ok = (x) => !!x && [x.corners, x.yellowCards, x.redCards].every(Number.isFinite);
    if (okL && okG && okF && !gap && ok(H) && ok(A)) r = { c: [H.corners, A.corners], k: [H.yellowCards + H.redCards, A.yellowCards + A.redCards] };
  }
  UC.set(e.id, r); return r;
}

const st0 = () => ({ A: new Map(), D: new Map(), sum: 0, n: 0 });
const rows = [], pairs = [], cov = { total: 0, usable: 0 };
for (const P of PROF) {
  const A = new Map(), D = new Map(), G = new Map(), S = { corners: st0(), cards: st0() };
  let sumG = 0, nM = 0, g1 = 0, gT = 0;
  const lam = (hp, ap) => { const mu = Math.log(sumG / nM / 2); return [Math.exp(mu + g0(A, hp) - g0(D, ap) + P.HFA / 2), Math.exp(mu + g0(A, ap) - g0(D, hp) - P.HFA / 2)]; };
  const learn = (hp, ap, gh, ga) => {
    if (nM > 0) { const [lh, la] = lam(hp, ap), eh = clampE(P.ETA * (gh / lh - 1)), ea = clampE(P.ETA * (ga / la - 1)); A.set(hp, g0(A, hp) + eh); D.set(ap, g0(D, ap) - eh); A.set(ap, g0(A, ap) + ea); D.set(hp, g0(D, hp) - ea); }
    G.set(hp, (G.get(hp) || 0) + 1); G.set(ap, (G.get(ap) || 0) + 1); sumG += gh + ga; nM++;
  };
  const learnS = (s, hp, ap, sh, sa) => {
    if (s.n > 0) {
      const mu = Math.log(Math.max(s.sum, 1) / s.n), eh = Math.exp(mu + g0(s.A, hp) - g0(s.D, ap) + P.HFA / 2), ea = Math.exp(mu + g0(s.A, ap) - g0(s.D, hp) - P.HFA / 2);
      const rh = clampE(P.ETA * (sh / eh - 1)), ra = clampE(P.ETA * (sa / ea - 1));
      s.A.set(hp, g0(s.A, hp) + rh); s.D.set(ap, g0(s.D, ap) - rh); s.A.set(ap, g0(s.A, ap) + ra); s.D.set(hp, g0(s.D, hp) - ra);
    }
    s.sum += sh + sa; s.n += 2;
  };
  const evs = qEv.all(P.TERM);
  let jp = 0;
  for (const e of evs) {
    while (jp < evs.length && evs[jp].start_ms < e.start_ms - LAG) {
      const q = evs[jp++], qh = player(q.home), qa = player(q.away);
      if (qh && qa) {
        learn(qh, qa, q.fh, q.fa);
        const h = firstHalf(q); if (h) { g1 += h[0] + h[1]; gT += q.fh + q.fa; }
        const u = getU(q);
        if (u) { learnS(S.corners, qh, qa, u.c[0], u.c[1]); learnS(S.cards, qh, qa, u.k[0], u.k[1]); pairs.push([u.c[0] + u.c[1], q.fh + q.fa]); }
      }
    }
    const hp = player(e.home), ap = player(e.away);
    if (!(hp && ap && nM > 50 && (G.get(hp) || 0) >= MING && (G.get(ap) || 0) >= MING && gT > 100)) continue;
    if (!firstHalf(e)) continue;
    const [lh, la] = lam(hp, ap), sub = !!getU(e);
    const GR = VARS.map((V) => {
      if (!V.sig) return grid(lh, la);
      const s = S[V.sig], dH = g0(s.A, hp) - g0(s.D, ap), dA = g0(s.A, ap) - g0(s.D, hp);
      return grid(lh * Math.exp(V.k * dH), la * Math.exp(V.k * dA));
    });
    const last = new Map();
    for (const r of qOdds.all(e.id, e.start_ms - 30000)) last.set(r.oid, r);
    const groups = new Map();
    for (const r of last.values()) { const cls = classify(r, e); if (!cls) continue; const g = groups.get(cls.key) || { cls, outs: [] }; g.outs.push({ r, cls }); groups.set(cls.key, g); }
    for (const g of groups.values()) {
      if (g.outs.length !== g.cls.n || !MARKETS.includes(g.cls.cls)) continue;
      const inv = g.outs.map((o) => 1000 / o.r.odds), tot = inv.reduce((a, b) => a + b, 0);
      g.outs.forEach((o, i) => {
        const c = o.cls, win = c.f(e.fh, e.fa) ? 1 : 0;
        rows.push({ ev: e.id, mk: c.cls, sub, pm: inv[i] / tot, win, odds: o.r.odds / 1000, p: GR.map((gr) => prob(gr, c.f)) });
      });
    }
  }
  for (const e of evs) { cov.total++; if (getU(e)) cov.usable++; }
}

// cluster bootstrap by match; returns [estimate, 95% lo, 95% hi, 99.7% lo, 99.7% hi]
function bootRatio(list, numF, denF) {
  const by = new Map();
  for (const r of list) { let c = by.get(r.ev); if (!c) { c = [0, 0]; by.set(r.ev, c); } c[0] += numF(r); c[1] += denF(r); }
  const cs = [...by.values()], n = cs.length, x = new Float64Array(n), y = new Float64Array(n);
  let S0 = 0, S1 = 0;
  cs.forEach((c, i) => { x[i] = c[0]; y[i] = c[1]; S0 += c[0]; S1 += c[1]; });
  const out = new Float64Array(B);
  for (let b = 0; b < B; b++) { let s = 0, d = 0; for (let i = 0; i < n; i++) { const j = (Math.random() * n) | 0; s += x[j]; d += y[j]; } out[b] = d ? s / d : NaN; }
  out.sort();
  return [S1 ? S0 / S1 : NaN, out[Math.floor(0.025 * B)], out[Math.floor(0.975 * B)], out[Math.floor(0.0015625 * B)], out[Math.floor(0.9984375 * B)]];
}
const ll = (p, w) => { const q = Math.min(Math.max(p, 1e-6), 1 - 1e-6); return -Math.log(w ? q : 1 - q); };
const f2 = (x) => x.toFixed(2), f4 = (x) => x.toFixed(4), f1p = (x) => (100 * x).toFixed(1);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

console.log(`coverage: finished ${cov.total} | with stats ${diag.withStats} | last stats >= clock-2min ${diag.lastOk} | first <=10 min after kickoff ${diag.firstOk} | usable (no gap) ${cov.usable}`);
console.log(`median min: last snapshot vs end ${f2(med(diag.dl))} | first snapshot vs kickoff ${f2(med(diag.df))}`);
{
  const n = pairs.length, mx = pairs.reduce((s, p) => s + p[0], 0) / n, my = pairs.reduce((s, p) => s + p[1], 0) / n;
  let sxy = 0, sxx = 0, syy = 0; for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  console.log(`corr(corners total, goals total) learned usable matches n=${n}: r=${f2(sxy / Math.sqrt(sxx * syy))}`);
}
const EXP = { TG: [8192, '0.35'], 'FT 1X2': [8162, '0.10'], BTTS: [3966, '0.51'], HC: [8195, '0.33'] }; // goal_markets.js run 2026-10-12, same DB snapshot
let sanityOk = true;
console.log('SANITY full set base k=0 vs goal_markets.js:');
for (const M of MARKETS) {
  const a = rows.filter((r) => r.mk === M), nm = new Set(a.map((r) => r.ev)).size;
  const [be, lo, hi] = bootRatio(a, (r) => (r.p[0] - r.pm) * (r.win - r.pm), (r) => (r.p[0] - r.pm) ** 2);
  const ok = nm === EXP[M][0] && f2(be) === EXP[M][1];
  sanityOk = sanityOk && ok;
  console.log(`  ${M} matches ${nm} beta ${f2(be)} [${f2(lo)}, ${f2(hi)}] ${ok ? 'OK' : 'MISMATCH'}`);
}
console.log(`SANITY_OK ${sanityOk}`);
console.log(`SUBSET usable stats matches ${new Set(rows.filter((r) => r.sub).map((r) => r.ev)).size} | Bonferroni family = ${MARKETS.length * (VARS.length - 1)} (market x variant, primary beta)`);
for (const M of MARKETS) {
  const a = rows.filter((r) => r.mk === M && r.sub), nm = new Set(a.map((r) => r.ev)).size;
  console.log(`${M} matches ${nm}`);
  VARS.forEach((V, v) => {
    const gp = (r) => r.p[v] - r.pm;
    const [be, bl, bh, bl3] = bootRatio(a, (r) => gp(r) * (r.win - r.pm), (r) => gp(r) ** 2);
    const [re, rl, rh, rl3] = bootRatio(a, (r) => (gp(r) > 0.08 ? (r.win ? r.odds - 1 : -1) : 0), (r) => (gp(r) > 0.08 ? 1 : 0));
    const nb = a.filter((r) => gp(r) > 0.08).length;
    let s = `  ${V.name.padEnd(12)} beta ${f2(be)} [${f2(bl)}, ${f2(bh)}]${bl3 > 0 ? ' *Bonf' : ''} | >0.08 n=${nb} ROI ${f1p(re)}% [${f1p(rl)}, ${f1p(rh)}]${nb >= 100 && rl > 0 ? ' +' : ''}`;
    if (v > 0) { const [dl, dlo, dhi] = bootRatio(a, (r) => ll(r.p[v], r.win) - ll(r.p[0], r.win), () => 1); s += ` | dLL ${f4(dl)} [${f4(dlo)}, ${f4(dhi)}]`; }
    console.log(s);
  });
}
