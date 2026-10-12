'use strict';
// Read-only walk-forward test of the per-player Poisson goal model (same as the (unpublished) betting bot, 13-min learning lag) on EVERY prematch market whose result follows from the score:
// FT 1X2, HT 1X2, Handicap, BTTS (FT/1H), Odd/Even (FT/1H), Total Goals (FT/1H, all lines), "X to win and BTTS". Bets at the last prematch price (kickoff-30 s) when model p - de-vigged market p > TH.
// 1H markets use lambda_1H = share * lambda (share learned walk-forward per league). Exploratory (many markets): read beta and ROI CIs, expect false positives. Usage: node src/goal_markets.js   env: MING=8
const path = require('node:path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, '..', 'data', 'odds.sqlite'), { readonly: true, fileMustExist: true });
const MING = Number(process.env.MING || 8), N = 30;
const PROF = [
  { name: 'cla', ETA: 0.08, HFA: -0.05, TERM: '%2x5%' }, { name: 'eb', ETA: 0.02, HFA: 0, TERM: 'esports_battle__2x4min_' }, { name: 'ebwc', ETA: 0.02, HFA: 0, TERM: 'esports_battle_world_cup__2x4_min_' },
];
const player = (s) => { const m = /\(([^)]+)\)\s*$/.exec(s || ''); return m ? m[1].trim().toLowerCase() : null; };
const clampE = (x) => Math.max(-0.5, Math.min(0.5, x));
function pois(l) { const a = [Math.exp(-l)]; for (let i = 1; i < N; i++) a.push(a[i - 1] * l / i); return a; }
function grid(lh, la) { const ph = pois(lh), pa = pois(la); return { ph, pa }; }
function prob(gr, f) { let s = 0; for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (f(i, j)) s += gr.ph[i] * gr.pa[j]; return s; }

const qEv = db.prepare("SELECT id, home, away, start_ms, final_home fh, final_away fa FROM events WHERE finished_ms IS NOT NULL AND result_status='ok' AND term LIKE ? ORDER BY start_ms");
const qOdds = db.prepare('SELECT o.outcome_id oid, o.odds, c.market, c.label, c.line FROM odds o JOIN outcomes c ON c.id = o.outcome_id WHERE o.event_id = ? AND o.ts <= ? AND o.odds > 1000 ORDER BY o.ts');
const qScore = db.prepare('SELECT ts, home, away FROM scores WHERE event_id = ? ORDER BY ts');
const qHalf = db.prepare("SELECT MAX(ts) t FROM clock WHERE event_id = ? AND period = '1st half'");
const qClock = db.prepare('SELECT MAX(minute*60+second) mc FROM clock WHERE event_id = ?');

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
    for (const r of last.values()) {
      const cls = classify(r, e);
      if (!cls) continue;
      const g = groups.get(cls.key) || { cls, outs: [] };
      g.outs.push({ r, cls }); groups.set(cls.key, g);
    }
    for (const g of groups.values()) {
      const need = g.cls.n; if (g.outs.length !== need) continue;
      const inv = g.outs.map((o) => 1000 / o.r.odds), tot = inv.reduce((a, b) => a + b, 0);
      g.outs.forEach((o, i) => {
        const pm = inv[i] / tot, c = o.cls, gr = c.half ? Gh : G1, sc = c.half ? fh1 : [e.fh, e.fa];
        const pmod = prob(gr, (x, y) => c.f(x, y)), win = c.f(sc[0], sc[1]);
        rows.push({ ev: e.id, lg: P.name, t: e.start_ms, cls: c.cls, key: c.key, lab: c.lab, pm, pmod, gap: pmod - pm, odds: o.r.odds / 1000, win: win ? 1 : 0, mg });
      });
    }
  }
}
function firstHalf(e) {
  const t = qHalf.get(e.id).t; if (t == null) return null;
  const sc = qScore.all(e.id); let h = 0, a = 0;
  for (const x of sc) { if (x.ts > t) break; h = x.home; a = x.away; }
  return [h, a];
}
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

// ---- stats: cluster bootstrap by match ----
function boot(list, f, B = 1000) {
  const by = new Map(); for (const x of list) { const a = by.get(x.ev) || []; a.push(x); by.set(x.ev, a); }
  const cl = [...by.values()], n = cl.length, out = [];
  for (let b = 0; b < B; b++) { const s = []; for (let i = 0; i < n; i++) s.push(...cl[Math.floor(Math.random() * n)]); out.push(f(s)); }
  out.sort((a, b) => a - b); return [f(list), out[Math.floor(0.025 * B)], out[Math.floor(0.975 * B)]];
}
const roi = (a) => a.reduce((s, x) => s + (x.win ? x.odds - 1 : -1), 0) / a.length;
const beta = (a) => { let u = 0, v = 0; for (const x of a) { u += x.gap * (x.win - x.pm); v += x.gap * x.gap; } return u / v; };
const f1 = (x) => (100 * x).toFixed(1), f2 = (x) => x.toFixed(2);
console.log(`outcomes ${rows.length} | matches ${new Set(rows.map((r) => r.ev)).size} (prematch price at kickoff-30 s, model learned with 13-min lag, both players >= ${MING} games)`);
const classes = [...new Set(rows.map((r) => r.cls))].sort();
for (const c of classes) {
  const a = rows.filter((r) => r.cls === c), nm = new Set(a.map((r) => r.ev)).size;
  let s = `${c.padEnd(8)} matches ${String(nm).padStart(4)} | beta ${(() => { const [e, lo, hi] = boot(a, beta, 400); return `${f2(e)} [${f2(lo)}, ${f2(hi)}]`; })()}`;
  for (const th of [0.04, 0.06, 0.08]) {
    const b = a.filter((r) => r.gap > th);
    s += ` | >${th}: ` + (b.length < 40 ? `n=${b.length}` : (() => { const [e, lo, hi] = boot(b, roi, 400); return `n=${b.length} ROI ${f1(e)}% [${f1(lo)}, ${f1(hi)}]`; })());
  }
  console.log(s);
}
const lg = (l) => rows.filter((r) => r.lg === l);
for (const l of ['cla', 'eb', 'ebwc']) { const a = lg(l).filter((r) => r.cls !== 'TG'), b = a.filter((r) => r.gap > 0.08); if (b.length >= 40) { const [e, lo, hi] = boot(b, roi, 400); console.log(`${l} non-TG markets >0.08: n=${b.length} ROI ${f1(e)}% [${f1(lo)}, ${f1(hi)}]`); } }
// Pre-registered 2026-10-11T18:00Z (BTTS was the only market besides TG with beta CI > 0 and a positive post-hoc ROI): confirmatory = BTTS matches kicking off after TB; primary gap > 0.06, secondary > 0.08. Do not tune.
const TB = Date.parse('2026-10-11T18:00:00Z'), fb = rows.filter((r) => r.cls === 'BTTS' && r.t > TB);
for (const th of [0.06, 0.08]) { const b = fb.filter((r) => r.gap > th); console.log(`BTTS CONFIRMATORY (after 10-11T18:00Z) gap>${th}: ` + (b.length < 20 ? `n=${b.length} (too few)` : (() => { const [e, lo, hi] = boot(b, roi, 1000); return `n=${b.length} ROI ${f1(e)}% [${f1(lo)}, ${f1(hi)}]`; })())); }
for (const l of ['cla', 'eb', 'ebwc']) { const a = rows.filter((r) => r.cls === 'BTTS' && r.lg === l), b = a.filter((r) => r.gap > 0.06); if (b.length >= 30) { const [e, lo, hi] = boot(b, roi, 600), [be, bl, bh] = boot(a, beta, 600); console.log(`BTTS ${l}: matches ${new Set(a.map((r) => r.ev)).size} beta ${f2(be)} [${f2(bl)}, ${f2(bh)}] | >0.06 n=${b.length} ROI ${f1(e)}% [${f1(lo)}, ${f1(hi)}]`); } else console.log(`BTTS ${l}: matches ${new Set(a.map((r) => r.ev)).size} bets>0.06 n=${b.length}`); }
{ // BTTS bets by price band and side (gap > 0.06); "both>1.05" = what the (unpublished) BTTS bot can actually bet (it needs both Yes and No priced above 1.05)
  const B = rows.filter((r) => r.cls === 'BTTS'), mo = new Map();
  for (const r of B) { const m = mo.get(r.ev) || {}; m[r.lab] = r.odds; mo.set(r.ev, m); }
  const tr = (r) => { const m = mo.get(r.ev); return m.Yes > 1.05 && m.No > 1.05; };
  const show = (nm, a) => { const b = a.filter((r) => r.gap > 0.06); console.log(`BTTSBAND ${nm}: ` + (b.length < 20 ? `n=${b.length}` : (() => { const [e, lo, hi] = boot(b, roi, 600); return `n=${b.length} ROI ${f1(e)}% [${f1(lo)}, ${f1(hi)}] win ${f1(b.reduce((s, x) => s + x.win, 0) / b.length)}% avg odds ${(b.reduce((s, x) => s + x.odds, 0) / b.length).toFixed(2)}`; })())); };
  show('all', B); show('both>1.05', B.filter(tr)); show('not tradable', B.filter((r) => !tr(r)));
  show('tradable Yes', B.filter((r) => tr(r) && r.lab === 'Yes')); show('tradable No', B.filter((r) => tr(r) && r.lab === 'No'));
  show('tradable cla', B.filter((r) => tr(r) && r.lg === 'cla')); show('tradable eb', B.filter((r) => tr(r) && r.lg === 'eb'));
  console.log(`BTTSBAND share of matches with both>1.05: ${f1([...mo.values()].filter((m) => m.Yes > 1.05 && m.No > 1.05).length / mo.size)}%`);
}
{ // what the (unpublished) BTTS bot really bets (both Yes and No priced > 1.05): confirmatory after TB, gap > 0.06
  const mo = new Map(); for (const r of rows.filter((x) => x.cls === 'BTTS')) { const m = mo.get(r.ev) || {}; m[r.lab] = r.odds; mo.set(r.ev, m); }
  const b = rows.filter((r) => r.cls === 'BTTS' && r.t > TB && r.gap > 0.06 && mo.get(r.ev).Yes > 1.05 && mo.get(r.ev).No > 1.05);
  console.log('BTTS CONFIRMATORY tradable (both>1.05, after 10-11T18:00Z) gap>0.06: ' + (b.length < 20 ? `n=${b.length} (too few)` : (() => { const [e, lo, hi] = boot(b, roi, 1000); return `n=${b.length} ROI ${f1(e)}% [${f1(lo)}, ${f1(hi)}]`; })()));
}
