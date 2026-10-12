'use strict';
// Coherence test without a player model. Per prematch snapshot (last price >= 20 s before kickoff) a bivariate Poisson goal law
// (home mean, away mean, correlation, 1H share = 4 params) is fitted by least squares to the de-vigged prices of every OTHER market
// block of the match (leave-one-block-out). The block whose price deviates most from that consensus gives one candidate bet per match
// (both prices > 1.05). Threshold frozen on the first half by time, judged on the second half. Part A = goal_markets.js baseline (sanity).
// Usage: node src/coherence_test.js   env: LIMIT=n (debug)
const path = require('node:path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, '..', 'data', 'odds.sqlite'), { readonly: true, fileMustExist: true });
const LIMIT = Number(process.env.LIMIT || 0), CUT = 20000, MINB = 3, MINFIT = 2, NG = 12, GG = NG * NG, TH = [0.02, 0.04, 0.06, 0.08, 0.10];
const roi = (a) => a.reduce((s, x) => s + (x.win ? x.odds - 1 : -1), 0) / a.length;
const beta = (a) => { let u = 0, v = 0; for (const x of a) { u += x.gap * (x.win - x.pm); v += x.gap * x.gap; } return u / v; };
const f1 = (x) => (100 * x).toFixed(1), f2 = (x) => x.toFixed(2);
const sig = (z) => 1 / (1 + Math.exp(-z));

// ---- A. baseline: copy of goal_markets.js player model (sanity) ----
const MING = 8, NB = 30;
const PROF = [{ name: 'cla', ETA: 0.08, HFA: -0.05, TERM: '%2x5%' }, { name: 'eb', ETA: 0.02, HFA: 0, TERM: 'esports_battle__2x4min_' }, { name: 'ebwc', ETA: 0.02, HFA: 0, TERM: 'esports_battle_world_cup__2x4_min_' }];
const player = (s) => { const m = /\(([^)]+)\)\s*$/.exec(s || ''); return m ? m[1].trim().toLowerCase() : null; };
const clampE = (x) => Math.max(-0.5, Math.min(0.5, x));
function pois(l) { const a = [Math.exp(-l)]; for (let i = 1; i < NB; i++) a.push(a[i - 1] * l / i); return a; }
function grid(lh, la) { return { ph: pois(lh), pa: pois(la) }; }
function prob(gr, f) { let s = 0; for (let i = 0; i < NB; i++) for (let j = 0; j < NB; j++) if (f(i, j)) s += gr.ph[i] * gr.pa[j]; return s; }
const qEv = db.prepare("SELECT id, home, away, start_ms, final_home fh, final_away fa FROM events WHERE finished_ms IS NOT NULL AND result_status='ok' AND term LIKE ? ORDER BY start_ms");
const qOdds = db.prepare('SELECT o.outcome_id oid, o.odds, c.market, c.label, c.line FROM odds o JOIN outcomes c ON c.id = o.outcome_id WHERE o.event_id = ? AND o.ts <= ? AND o.odds > 1000 ORDER BY o.ts');
const qScore = db.prepare('SELECT ts, home, away FROM scores WHERE event_id = ? ORDER BY ts');
const qHalf = db.prepare("SELECT MAX(ts) t FROM clock WHERE event_id = ? AND period = '1st half'");
function firstHalf(e) { const t = qHalf.get(e.id).t; if (t == null) return null; let h = 0, a = 0; for (const x of qScore.all(e.id)) { if (x.ts > t) break; h = x.home; a = x.away; } return [h, a]; }
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
const rows = [];
for (const P of PROF) {
  const A = new Map(), D = new Map(), GM = new Map();
  let sumG = 0, nM = 0, g1 = 0, gT = 0;
  const lam = (hp, ap) => { const mu = Math.log(sumG / nM / 2), g = (m, k) => m.get(k) ?? 0; return [Math.exp(mu + g(A, hp) - g(D, ap) + P.HFA / 2), Math.exp(mu + g(A, ap) - g(D, hp) - P.HFA / 2)]; };
  const learn = (hp, ap, gh, ga) => {
    if (nM > 0) { const [lh, la] = lam(hp, ap), g = (m, k) => m.get(k) ?? 0, eh = clampE(P.ETA * (gh / lh - 1)), ea = clampE(P.ETA * (ga / la - 1)); A.set(hp, g(A, hp) + eh); D.set(ap, g(D, ap) - eh); A.set(ap, g(A, ap) + ea); D.set(hp, g(D, hp) - ea); }
    GM.set(hp, (GM.get(hp) || 0) + 1); GM.set(ap, (GM.get(ap) || 0) + 1); sumG += gh + ga; nM++;
  };
  const evs = qEv.all(P.TERM);
  let jp = 0;
  for (const e of evs) {
    while (jp < evs.length && evs[jp].start_ms < e.start_ms - 13 * 60000) { const q = evs[jp++], qh = player(q.home), qa = player(q.away); if (qh && qa) { learn(qh, qa, q.fh, q.fa); const h = firstHalf(q); if (h) { g1 += h[0] + h[1]; gT += q.fh + q.fa; } } }
    const hp = player(e.home), ap = player(e.away);
    if (!(hp && ap && nM > 50 && (GM.get(hp) || 0) >= MING && (GM.get(ap) || 0) >= MING && gT > 100)) continue;
    const fh1 = firstHalf(e); if (!fh1) continue;
    const [lh, la] = lam(hp, ap), s = g1 / gT, mg = Math.min(GM.get(hp), GM.get(ap));
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
        rows.push({ ev: e.id, lg: P.name, t: e.start_ms, cls: c.cls, key: c.key, lab: c.lab, pm, pmod, gap: pmod - pm, odds: o.r.odds / 1000, win: win ? 1 : 0, mg });
      });
    }
  }
}
for (const c of ['FT 1X2', 'BTTS', 'TG']) { const a = rows.filter((r) => r.cls === c); console.log(`BASELINE ${c.padEnd(7)} matches ${new Set(a.map((r) => r.ev)).size} beta ${f2(beta(a))}`); }

// ---- B. coherence test (no player model) ----
const cellIdx = (f) => { const a = []; for (let x = 0; x < NG; x++) for (let y = 0; y < NG; y++) if (f(x, y)) a.push(x * NG + y); return Int32Array.from(a); };
const qAll = db.prepare("SELECT id, home, away, start_ms, final_home fh, final_away fa FROM events WHERE finished_ms IS NOT NULL AND result_status='ok' ORDER BY start_ms");
const M = [];
for (const e of qAll.all()) {
  if (LIMIT && M.length >= LIMIT) break;
  const last = new Map();
  for (const r of qOdds.all(e.id, e.start_ms - CUT)) last.set(r.oid, r);
  const groups = new Map();
  for (const r of last.values()) { const c = classify(r, e); if (!c) continue; const g = groups.get(c.key) || { c, outs: [] }; g.outs.push({ r, c }); groups.set(c.key, g); }
  let h1;
  const blocks = [];
  for (const g of groups.values()) {
    if (g.outs.length !== g.c.n) continue;
    if (g.c.half && h1 === undefined) h1 = firstHalf(e);
    if (g.c.half && !h1) continue;
    const inv = g.outs.map((o) => 1000 / o.r.odds), tot = inv.reduce((a, b) => a + b, 0), sc = g.c.half ? h1 : [e.fh, e.fa];
    blocks.push({ cls: g.c.cls, half: g.c.half, trad: g.outs.every((o) => o.r.odds > 1050), outs: g.outs.map((o, i) => ({ lab: o.c.lab, odds: o.r.odds / 1000, pm: inv[i] / tot, idx: cellIdx(o.c.f), win: o.c.f(sc[0], sc[1]) ? 1 : 0 })) });
  }
  if (blocks.length >= MINB) M.push({ t: e.start_ms, blocks });
}
// bivariate Poisson (X=U+W, Y=V+W): P(x,y) = sum_k A[x-k] B[y-k] C[k], normalised on the grid
const Ua = new Float64Array(NG), Ub = new Float64Array(NG), Uc = new Float64Array(NG), P0 = new Float64Array(GG), P1 = new Float64Array(GG);
function bp(l1, l2, l3, P) {
  Ua[0] = Ub[0] = Uc[0] = 1;
  for (let i = 1; i < NG; i++) { Ua[i] = Ua[i - 1] * l1 / i; Ub[i] = Ub[i - 1] * l2 / i; Uc[i] = Uc[i - 1] * l3 / i; }
  let tot = 0;
  for (let x = 0; x < NG; x++) for (let y = 0; y < NG; y++) {
    let s = 0; const m = Math.min(x, y);
    for (let k = 0; k <= m; k++) s += Ua[x - k] * Ub[y - k] * Uc[k];
    P[x * NG + y] = s; tot += s;
  }
  for (let i = 0; i < GG; i++) P[i] /= tot;
}
// th = [log muH, log muA, logit rho, logit s]; l3 = rho*min(mu) keeps l1,l2 >= 0; 1H law = s * full-time lambdas
function jointsOf(th) {
  const mh = Math.exp(th[0]), ma = Math.exp(th[1]), rho = sig(th[2]), s = sig(th[3]);
  const l3 = rho * Math.min(mh, ma), l1 = mh - l3, l2 = ma - l3;
  bp(l1, l2, l3, P0); bp(s * l1, s * l2, s * l3, P1);
}
function loss(th, bl) {
  jointsOf(th); let L = 0;
  for (const b of bl) { const P = b.half ? P1 : P0; for (const o of b.outs) { let q = 0; for (const i of o.idx) q += P[i]; const d = q - o.pm; L += d * d; } }
  return L;
}
function nm(f, x0, step, maxIt) {
  const n = x0.length; let S = [x0.slice()];
  for (let i = 0; i < n; i++) { const x = x0.slice(); x[i] += step; S.push(x); }
  let F = S.map(f);
  for (let it = 0; it < maxIt; it++) {
    const ord = F.map((_, i) => i).sort((a, b) => F[a] - F[b]);
    S = ord.map((i) => S[i]); F = ord.map((i) => F[i]);
    if (F[n] - F[0] < 1e-10) break;
    const c = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += S[i][j] / n;
    const w = S[n];
    const xr = c.map((v, j) => 2 * v - w[j]), fr = f(xr);
    if (fr < F[0]) { const xe = c.map((v, j) => 3 * v - 2 * w[j]), fe = f(xe); if (fe < fr) { S[n] = xe; F[n] = fe; } else { S[n] = xr; F[n] = fr; } }
    else if (fr < F[n - 1]) { S[n] = xr; F[n] = fr; }
    else {
      const xc = c.map((v, j) => 0.5 * (v + w[j])), fc = f(xc);
      if (fc < F[n]) { S[n] = xc; F[n] = fc; }
      else { for (let i = 1; i <= n; i++) { S[i] = S[i].map((v, j) => 0.5 * (v + S[0][j])); F[i] = f(S[i]); } }
    }
  }
  let bi = 0; for (let i = 1; i <= n; i++) if (F[i] < F[bi]) bi = i;
  return S[bi];
}
const TH0 = [Math.log(1.4), Math.log(1.4), -1.4, -0.4];
function judge(m) {
  const bl = m.blocks; let best = null, worst = null;
  for (let b = 0; b < bl.length; b++) {
    const B0 = bl[b]; if (!B0.trad) continue;
    const rest = bl.filter((_, j) => j !== b);
    if (rest.length < MINFIT || (B0.half && !rest.some((x) => x.half))) continue;
    jointsOf(nm((t) => loss(t, rest), TH0, 0.5, 150));
    const P = B0.half ? P1 : P0;
    for (const o of B0.outs) {
      let q = 0; for (const i of o.idx) q += P[i];
      const c = { gap: q - o.pm, pm: o.pm, odds: o.odds, win: o.win, cls: B0.cls, lab: o.lab };
      if (!best || c.gap > best.gap) best = c;
      if (!worst || c.gap < worst.gap) worst = c;
    }
  }
  return { best, worst };
}
const R = M.map((m) => ({ t: m.t, ...judge(m) }));
const hf = Math.floor(R.length / 2), H1 = R.slice(0, hf), H2 = R.slice(hf);
const cut = new Date(R[hf].t).toISOString();
const pick = (rs, th, side) => rs.map((r) => r[side]).filter((x) => x && (side === 'best' ? x.gap > th : x.gap < -th));
function bci(list, f, B = 1000) { const n = list.length, out = []; for (let b = 0; b < B; b++) { const s = []; for (let i = 0; i < n; i++) s.push(list[Math.floor(Math.random() * n)]); out.push(f(s)); } out.sort((a, b) => a - b); return [out[Math.floor(0.025 * B)], out[Math.floor(0.975 * B)]]; }
const summ = (a) => { if (a.length < 30) return `n=${a.length} inconcluso`; const [rl, rh] = bci(a, roi), [bl2, bh] = bci(a, beta); return `n=${a.length} ROI ${f1(roi(a))}% [${f1(rl)}, ${f1(rh)}]${a.length >= 100 && rl > 0 ? ' CI>0' : ''} beta ${f2(beta(a))} [${f2(bl2)}, ${f2(bh)}]`; };
console.log(`matches ${M.length} with candidate ${R.filter((r) => r.best).length} | H1 n=${H1.length} | H2 from ${cut} n=${H2.length}`);
const scan1 = TH.map((th) => { const a = pick(H1, th, 'best'); return { th, n: a.length, roi: a.length ? roi(a) : NaN }; });
console.log('H1 scan (best side): ' + scan1.map((s) => `>${s.th}: n=${s.n} ROI ${Number.isNaN(s.roi) ? '-' : f1(s.roi) + '%'}`).join(' | '));
const okS = scan1.filter((s) => s.n >= 100).sort((a, b) => b.roi - a.roi);
const ch = okS.length ? okS[0].th : 0.06;
console.log(`rule frozen on H1: th=${ch}${okS.length ? '' : ' (fallback: no H1 threshold with n>=100)'}`);
const mAbs = (a) => a.reduce((s, x) => s + Math.abs(x.gap), 0) / a.length;
console.log(`mean |gap| (pp) H2: best ${f1(mAbs(pick(H2, -1, 'best')))} worst ${f1(mAbs(pick(H2, -1, 'worst')))}`);
console.log(`H2 BEST th>${ch}: ${summ(pick(H2, ch, 'best'))}`);
for (const th of TH) console.log(`  H2 best >${th}: ${summ(pick(H2, th, 'best'))}`);
for (const th of TH) console.log(`  H2 PLACEBO (against consensus) >${th}: ${summ(pick(H2, th, 'worst'))}`);
const byc = new Map();
for (const b of pick(H2, ch, 'best')) { const a = byc.get(b.cls) || []; a.push(b); byc.set(b.cls, a); }
for (const [c, a] of [...byc].sort((x, y) => y[1].length - x[1].length).slice(0, 8)) console.log(`  cls ${c.padEnd(9)} ${summ(a)}`);
console.log(`comparisons counted: ${3 * TH.length} (H1 scan + H2 best + H2 placebo, ${TH.length} thresholds each)`);
