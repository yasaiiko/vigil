'use strict';
// Read-only walk-forward backtest of the per-player Poisson model on the PREMATCH "Total Goals - 1st Half" main line (same rule/timing as the (unpublished) betting bot: odds at kickoff-30 s).
// First-half goals = score received by (first '2nd half' clock row + DELTA s); DELTA is chosen ONLY by market calibration (mean of y - de-vigged P(over) closest to 0), never by ROI.
// Model: lambda_total * h (h = share of all goals scored in the first half, all history). HONEST_LAG learning (13 min). Usage: node src/total1h.js
const Database = require('better-sqlite3');
const path = require('node:path');

const db = new Database(path.join(path.resolve(__dirname, '..'), 'data', 'odds.sqlite'), { readonly: true, fileMustExist: true });
const CFG = {
  cla: { ETA: 0.08, HFA: -0.05, TERM: '%2x5%', FREEZE: Date.parse('2026-10-06T14:45:00Z') },
  eb: { ETA: 0.02, HFA: 0, TERM: 'esports_battle__2x4min_', FREEZE: Date.parse('2026-10-07T03:40:00Z') },
  ebwc: { ETA: 0.02, HFA: 0, TERM: 'esports_battle_world_cup__2x4_min_', FREEZE: Date.parse('2026-10-07T07:40:00Z') },
};
const MING = 8, LAG_MS = 13 * 60000;
const player = (s) => { const m = /\(([^)]+)\)\s*$/.exec(s || ''); return m ? m[1].trim().toLowerCase() : null; };
function makeModel(cfg) {
  const A = new Map(), Dm = new Map(), G = new Map();
  let sumGoals = 0, nM = 0;
  const g = (m, k) => m.get(k) ?? 0, clampE = (x) => Math.max(-0.5, Math.min(0.5, x));
  const lambdas = (hp, ap) => { const mu = Math.log(sumGoals / nM / 2); return [Math.exp(mu + g(A, hp) - g(Dm, ap) + cfg.HFA / 2), Math.exp(mu + g(A, ap) - g(Dm, hp) - cfg.HFA / 2)]; };
  return {
    learn(hp, ap, gh, ga) {
      if (nM > 0) {
        const [lh, la] = lambdas(hp, ap), eh = clampE(cfg.ETA * (gh / lh - 1)), ea = clampE(cfg.ETA * (ga / la - 1));
        const ah = g(A, hp), dh = g(Dm, hp), aa = g(A, ap), da = g(Dm, ap);
        A.set(hp, ah + eh); Dm.set(ap, da - eh); A.set(ap, aa + ea); Dm.set(hp, dh - ea);
      }
      G.set(hp, (G.get(hp) || 0) + 1); G.set(ap, (G.get(ap) || 0) + 1); sumGoals += gh + ga; nM++;
    },
    ready: (hp, ap) => hp && ap && nM > 50 && (G.get(hp) || 0) >= MING && (G.get(ap) || 0) >= MING,
    lam: (hp, ap) => { const [a, b] = lambdas(hp, ap); return a + b; },
  };
}
const pOverLam = (lam, line) => { const k = Math.floor(line); let p = Math.exp(-lam), cdf = p; for (let i = 1; i <= k; i++) { p *= lam / i; cdf += p; } return 1 - cdf; };
const gaps = db.prepare('SELECT start_ms s, end_ms e FROM capture_gaps').all();
const inGap = (a, b) => gaps.some((x) => x.s < b && x.e > a);
const qHalf = db.prepare(`SELECT MIN(ts) t FROM clock WHERE event_id=? AND period='2nd half'`);
const qScoreAt = db.prepare('SELECT home+away g FROM scores WHERE event_id=? AND ts<=? ORDER BY ts DESC LIMIT 1');
const qOdds = db.prepare(`SELECT o.odds, c.id cid, c.label, c.line FROM odds o JOIN outcomes c ON c.id=o.outcome_id WHERE o.event_id=? AND c.market='Total Goals - 1st Half' AND o.ts<=? AND o.odds>1000 ORDER BY o.ts`);
const half = (x) => Math.abs(x % 1) === 0.5;
function pickMain(by) {
  let main = null;
  for (const l of Object.values(by)) {
    if (!l.over || !l.under || !half(l.line)) continue;
    const io = 1000 / l.over.odds, iu = 1000 / l.under.odds, po = io / (io + iu);
    if (!main || Math.abs(po - 0.5) < Math.abs(main.po - 0.5)) main = { ...l, po };
  }
  return main;
}
const pc = (v) => `${(100 * v).toFixed(1)}%`;
function boot(rows, f, B = 1500) {
  const bs = [];
  for (let b = 0; b < B; b++) { const s = []; for (let i = 0; i < rows.length; i++) s.push(rows[(Math.random() * rows.length) | 0]); bs.push(f(s)); }
  bs.sort((a, b) => a - b);
  return [f(rows), bs[Math.floor(B * 0.025)], bs[Math.floor(B * 0.975)]];
}
const roi = (a) => a.reduce((s, x) => s + x.pnl, 0) / a.length;
const beta = (a) => { let u = 0, v = 0; for (const x of a) { u += x.gap * (x.y - x.pk); v += x.gap * x.gap; } return u / v; };
const line = (name, rows) => { if (rows.length < 40) return `${name}: n=${rows.length} (too few)`; const [e, lo, hi] = boot(rows, roi); return `${name}: n=${rows.length} ROI=${pc(e)} [${pc(lo)}, ${pc(hi)}] win=${pc(rows.filter((x) => x.pnl > 0).length / rows.length)}`; };

// pass 1: collect events with a 1H ladder and first-half goal candidates for each DELTA
const DELTAS = [-3, 0, 3, 6, 9, 12];
const all = [];
for (const [prof, cfg] of Object.entries(CFG)) {
  const evs = db.prepare(`SELECT id, home, away, start_ms, final_home fh, final_away fa FROM events WHERE finished_ms IS NOT NULL AND result_status='ok' AND term LIKE ? ORDER BY start_ms`).all(cfg.TERM);
  const model = makeModel(cfg);
  let jp = 0;
  for (const e of evs) {
    const hp = player(e.home), ap = player(e.away);
    while (jp < evs.length && evs[jp].start_ms < e.start_ms - LAG_MS) { const q = evs[jp++], qh = player(q.home), qa = player(q.away); if (qh && qa) model.learn(qh, qa, q.fh, q.fa); }
    if (!model.ready(hp, ap) || inGap(e.start_ms - 120000, e.start_ms + 660000)) continue;
    const th = qHalf.get(e.id).t;
    if (!th) continue;
    const by = {};
    for (const r of qOdds.all(e.id, e.start_ms - 30000)) { const l = (by[r.line] = by[r.line] || { line: r.line / 1000 }); l[r.label === 'Over' ? 'over' : 'under'] = { id: r.cid, odds: r.odds }; }
    const m = pickMain(by);
    if (!m) continue;
    const fhg = {}; for (const d of DELTAS) { const s = qScoreAt.get(e.id, th + d * 1000); fhg[d] = s ? s.g : 0; }
    all.push({ prof, t: e.start_ms, ev: e.id, lam: model.lam(hp, ap), m, fhg, tot: e.fh + e.fa });
  }
}
// DELTA by market calibration only
const cal = DELTAS.map((d) => ({ d, bias: all.reduce((s, r) => s + ((r.fhg[d] > r.m.line ? 1 : 0) - r.m.po), 0) / all.length }));
console.log('1H events with ladder:', all.length, '| market calibration by DELTA (mean y - pMkt):', cal.map((c) => `${c.d}s:${(c.bias * 100).toFixed(2)}%`).join(' '));
const DELTA = cal.reduce((b, c) => (Math.abs(c.bias) < Math.abs(b.bias) ? c : b)).d;
const H = all.reduce((s, r) => s + r.fhg[DELTA], 0) / all.reduce((s, r) => s + r.tot, 0);
console.log(`chosen DELTA=${DELTA}s (calibration only); first-half goal share h=${H.toFixed(3)}`);
const recs = all.map((r) => { const pm = pOverLam(r.lam * H, r.m.line), gap = pm - r.m.po, side = gap > 0 ? 'Over' : 'Under', o = (gap > 0 ? r.m.over.odds : r.m.under.odds) / 1000, y = r.fhg[DELTA] > r.m.line ? 1 : 0, win = side === 'Over' ? y === 1 : y === 0; return { prof: r.prof, t: r.t, ev: r.ev, gap, pk: r.m.po, y, o, pnl: win ? o - 1 : -1 }; });
console.log('beta (all matches):', (() => { const [b, lo, hi] = boot(recs, beta, 800); return `${b.toFixed(2)} [${lo.toFixed(2)}, ${hi.toFixed(2)}]`; })());
const tcut = recs.map((r) => r.t).sort((a, b) => a - b)[Math.floor(recs.length * 0.6)];
for (const th of [0.06, 0.1]) {
  const b = recs.filter((r) => Math.abs(r.gap) > th);
  console.log(`TH ${th}: ${line('all', b)}`);
  console.log(`   first60% ${line('', b.filter((r) => r.t <= tcut))} | last40% ${line('', b.filter((r) => r.t > tcut))}`);
  for (const p of ['cla', 'eb', 'ebwc']) console.log(`   ${line(p, b.filter((r) => r.prof === p))}`);
  console.log(`   after each league's freeze: ${line('fwd', b.filter((r) => r.t > CFG[r.prof].FREEZE))} | Over ${line('', b.filter((r) => r.gap > 0))} | Under ${line('', b.filter((r) => r.gap < 0))}`);
}
