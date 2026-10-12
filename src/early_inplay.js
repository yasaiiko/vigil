'use strict';
// Walk-forward backtest (read-only) of an EARLY IN-PLAY entry for the frozen per-player Poisson totals rule (the (unpublished) betting bot), for when the feed lists matches only after kickoff.
// Entry = first seconds of the match (fixed delay D after kickoff, or "first": the first odds that ever appear for a late-listed match). Decision uses only data with ts <= entry; fill = latest OPEN price <= entry + 3 s.
// Model: same per-player attack/defence Poisson (HONEST_LAG: learns a match 13 min after its kickoff), goals already scored g (score feed as received) and remaining share of goals 1-F(elapsed), F estimated from receipt times of goals.
// Usage: node src/early_inplay.js   (no network, no writes)
const Database = require('better-sqlite3');
const path = require('node:path');

const db = new Database(path.join(path.resolve(__dirname, '..'), 'data', 'odds.sqlite'), { readonly: true, fileMustExist: true });
const CFG = {
  cla: { ETA: 0.08, HFA: -0.05, TERM: '%2x5%' },
  eb: { ETA: 0.02, HFA: 0, TERM: 'esports_battle__2x4min_' },
  ebwc: { ETA: 0.02, HFA: 0, TERM: 'esports_battle_world_cup__2x4_min_' },
};
const MING = 8, FILL_MS = 3000, LAG_MS = 13 * 60000;
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
    pOver(hp, ap, line, goals, rem) { // P(final total > line | goals so far, share of goals still to come)
      const [lh, la] = lambdas(hp, ap), lam = (lh + la) * rem, need = Math.ceil(line) - goals;
      if (need <= 0) return 1;
      let p = Math.exp(-lam), cdf = 0;
      for (let i = 0; i < need; i++) { cdf += p; p *= lam / (i + 1); }
      return 1 - cdf;
    },
  };
}

const gaps = db.prepare('SELECT start_ms s, end_ms e FROM capture_gaps').all();
const inGap = (a, b) => gaps.some((x) => x.s < b && x.e > a);
const qScore = db.prepare('SELECT home+away g FROM scores WHERE event_id=? AND ts<=? ORDER BY ts DESC LIMIT 1');
const qScoreAll = db.prepare('SELECT ts, home+away g FROM scores WHERE event_id=? ORDER BY ts');
const qOdds = db.prepare(`SELECT o.ts, o.outcome_id oid, o.odds, o.status, c.label, c.line FROM odds o JOIN outcomes c ON c.id=o.outcome_id WHERE o.event_id=? AND c.market='Total Goals' AND o.ts<=? ORDER BY o.ts`);
const qFirst = db.prepare(`SELECT MIN(o.ts) t FROM odds o JOIN outcomes c ON c.id=o.outcome_id WHERE o.event_id=? AND c.market='Total Goals'`);

const half = (x) => Math.abs(x % 1) === 0.5;
function pickMain(ladder) {
  let main = null;
  for (const l of Object.values(ladder)) {
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
const line = (name, rows) => { if (rows.length < 30) return `${name}: n=${rows.length} (too few)`; const [e, lo, hi] = boot(rows, roi); return `${name}: n=${rows.length} ROI=${pc(e)} [${pc(lo)}, ${pc(hi)}] win=${pc(rows.filter((x) => x.pnl > 0).length / rows.length)}`; };

const SPECS = [{ k: 'D30', D: 30 }, { k: 'D60', D: 60 }, { k: 'first', D: null }];
const recs = []; // one per (event, spec) with a decision-able state
const diag = {};
for (const [prof, cfg] of Object.entries(CFG)) {
  const evs = db.prepare(`SELECT id, home, away, start_ms, final_home fh, final_away fa FROM events WHERE finished_ms IS NOT NULL AND result_status='ok' AND term LIKE ? ORDER BY start_ms`).all(cfg.TERM);
  // F(elapsed): share of all goals whose score row was received by `elapsed` seconds after kickoff
  const times = []; let totGoals = 0;
  for (const e of evs) { let prev = 0; for (const r of qScoreAll.all(e.id)) { if (r.g > prev) { for (let i = prev; i < r.g; i++) times.push((r.ts - e.start_ms) / 1000); } prev = Math.max(prev, r.g); } totGoals += e.fh + e.fa; }
  times.sort((a, b) => a - b);
  const F = (s) => { let lo = 0, hi = times.length; while (lo < hi) { const m = (lo + hi) >> 1; if (times[m] <= s) lo = m + 1; else hi = m; } return Math.min(1, lo / Math.max(1, totGoals)); };
  diag[prof] = { events: evs.length, F30: +F(30).toFixed(3), F60: +F(60).toFixed(3), F120: +F(120).toFixed(3) };
  const model = makeModel(cfg);
  let jp = 0;
  for (const e of evs) {
    const hp = player(e.home), ap = player(e.away);
    while (jp < evs.length && evs[jp].start_ms < e.start_ms - LAG_MS) { const q = evs[jp++], qh = player(q.home), qa = player(q.away); if (qh && qa) model.learn(qh, qa, q.fh, q.fa); }
    if (!model.ready(hp, ap) || inGap(e.start_ms - 120000, e.start_ms + 660000)) continue;
    const tot = e.fh + e.fa;
    for (const sp of SPECS) {
      let te;
      if (sp.D !== null) te = e.start_ms + sp.D * 1000;
      else { const f = qFirst.get(e.id).t; if (!f || f <= e.start_ms) continue; te = f + FILL_MS; if (te - e.start_ms > 150000) continue; } // late-listed matches only
      const cur = {}, fill = {};
      for (const r of qOdds.all(e.id, te + FILL_MS)) { fill[r.oid] = r; if (r.ts <= te) cur[r.oid] = r; }
      const ladder = {};
      for (const r of Object.values(cur)) if (r.status === 'OPEN' && r.odds > 1050) { const l = (ladder[r.line] = ladder[r.line] || { line: r.line / 1000 }); l[r.label === 'Over' ? 'over' : 'under'] = { id: r.oid, odds: r.odds }; }
      const m = pickMain(ladder);
      if (!m) continue;
      const sc = qScore.get(e.id, te), goals = sc ? sc.g : 0, el = (te - e.start_ms) / 1000;
      if (m.line < goals) continue;
      const pm = model.pOver(hp, ap, m.line, goals, 1 - F(el)), gap = pm - m.po, side = gap > 0 ? 'Over' : 'Under', pick = gap > 0 ? m.over : m.under, fl = fill[pick.id];
      const filled = fl && fl.status === 'OPEN' && fl.odds > 1050;
      const win = side === 'Over' ? tot > m.line : tot < m.line;
      recs.push({ prof, spec: sp.k, t: e.start_ms, ev: e.id, goals, el, gap, pk: m.po, y: tot > m.line ? 1 : 0, filled, o: filled ? fl.odds / 1000 : 0, pnl: filled ? (win ? fl.odds / 1000 - 1 : -1) : 0 });
    }
  }
}
console.log('goal-share F(30s/60s/120s) by league:', JSON.stringify(diag));
for (const sp of SPECS) {
  const rs = recs.filter((r) => r.spec === sp.k);
  console.log(`\n== ${sp.k}: usable states ${rs.length} (cla ${rs.filter((r) => r.prof === 'cla').length}, eb ${rs.filter((r) => r.prof === 'eb').length}, ebwc ${rs.filter((r) => r.prof === 'ebwc').length}); beta (all states) ${(() => { const [b, lo, hi] = boot(rs, beta, 800); return `${b.toFixed(2)} [${lo.toFixed(2)}, ${hi.toFixed(2)}]`; })()}`);
  for (const th of [0.06, 0.1]) {
    const b = rs.filter((r) => Math.abs(r.gap) > th && r.filled);
    console.log(`  TH ${th}: ${line('pooled', b)}`);
    const tcut = rs.length ? rs.map((r) => r.t).sort((x, y) => x - y)[Math.floor(rs.length * 0.6)] : 0;
    console.log(`     first60% ${line('', b.filter((r) => r.t <= tcut))} | last40% ${line('', b.filter((r) => r.t > tcut))}`);
    for (const p of ['cla', 'eb', 'ebwc']) console.log(`     ${line(p, b.filter((r) => r.prof === p))}`);
    console.log(`     ${line('score 0-0 only', b.filter((r) => r.goals === 0))} | ${line('goals>=1', b.filter((r) => r.goals >= 1))}`);
  }
  const base = rs.filter((r) => r.filled);
  console.log(`  base (no model): always Over/Under at the offered price are not recorded; skipped-fill share ${pc(1 - base.length / rs.length)}`);
}
