'use strict';
// Read-only walk-forward scan: per-player Poisson model priced on the REMAINING time vs live Total Goals prices, at pre-declared in-play states
// (after each goal, mid-game without goal, uneven score, final stretch). No lookahead: decision uses data with ts <= entry; fill = latest OPEN price <= entry + 3 s;
// quiet-state filter (no goal in the last 20 s / line odds unchanged in the last 8-12 s) removes score-feed-lag phantoms. Learning lags 13 min like the live bot.
// Usage: node src/inplay_states.js   (no network, no writes)
const Database = require('better-sqlite3');
const path = require('node:path');

const db = new Database(path.join(path.resolve(__dirname, '..'), 'data', 'odds.sqlite'), { readonly: true, fileMustExist: true });
const CFG = {
  cla: { ETA: 0.08, HFA: -0.05, TERM: '%2x5%' },
  eb: { ETA: 0.02, HFA: 0, TERM: 'esports_battle__2x4min_' },
  ebwc: { ETA: 0.02, HFA: 0, TERM: 'esports_battle_world_cup__2x4_min_' },
};
const MING = 8, FILL_MS = Number(process.env.FILL_MS || 3000), LAG_MS = 13 * 60000, GRID = [60, 90, 120, 150, 180, 210, 270, 330, 390, 450];
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
    pOver(hp, ap, line, goals, rem) {
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
const qScoreAll = db.prepare('SELECT ts, home h, away a FROM scores WHERE event_id=? ORDER BY ts');
const qBo = db.prepare('SELECT ts, betoffer_id bo, status FROM bo_status WHERE event_id=? ORDER BY ts');
const boAt = (rows, bo, t) => { let s = 'OPEN'; for (const r of rows) { if (r.ts > t) break; if (r.bo === bo) s = r.status; } return s; }; // no row = open
const qOdds = db.prepare(`SELECT o.ts, o.outcome_id oid, o.odds, o.status, c.label, c.line, c.betoffer_id bo FROM odds o JOIN outcomes c ON c.id=o.outcome_id WHERE o.event_id=? AND c.market='Total Goals' AND o.ts<=? ORDER BY o.ts`);
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
function boot(rows, f, B = 1500, q = 0.025) {
  const by = new Map();
  for (const r of rows) (by.get(r.ev) || by.set(r.ev, []).get(r.ev)).push(r);
  const g = [...by.values()], bs = [];
  for (let b = 0; b < B; b++) { const s = []; for (let i = 0; i < g.length; i++) s.push(...g[(Math.random() * g.length) | 0]); bs.push(f(s)); }
  bs.sort((a, b) => a - b);
  return [f(rows), bs[Math.floor(B * q)], bs[Math.floor(B * (1 - q))]];
}
const roi = (a) => a.reduce((s, x) => s + x.pnl, 0) / a.length;
const beta = (a) => { let u = 0, v = 0; for (const x of a) { u += x.gap * (x.y - x.pk); v += x.gap * x.gap; } return u / v; };
const line = (name, rows) => {
  if (rows.length < 40) return `${name}: n=${rows.length} (too few)`;
  const [e, lo, hi] = boot(rows, roi), [, blo, bhi] = boot(rows, roi, 1500, 0.0031);
  return `${name}: n=${rows.length} (matches ${new Set(rows.map((r) => r.ev)).size}) ROI=${pc(e)} CI95=[${pc(lo)}, ${pc(hi)}] Bonf=[${pc(blo)}, ${pc(bhi)}]`;
};

const recs = [], boCache = new Map();
for (const [prof, cfg] of Object.entries(CFG)) {
  const evs = db.prepare(`SELECT id, home, away, start_ms, final_home fh, final_away fa FROM events WHERE finished_ms IS NOT NULL AND result_status='ok' AND term LIKE ? ORDER BY start_ms`).all(cfg.TERM);
  const times = []; let totGoals = 0; const scoreCache = new Map();
  for (const e of evs) {
    const rows = qScoreAll.all(e.id); scoreCache.set(e.id, rows);
    let prev = 0; for (const r of rows) { const t = r.h + r.a; if (t > prev) for (let i = prev; i < t; i++) times.push((r.ts - e.start_ms) / 1000); prev = Math.max(prev, t); }
    totGoals += e.fh + e.fa;
  }
  times.sort((a, b) => a - b);
  const F = (s) => { let lo = 0, hi = times.length; while (lo < hi) { const m = (lo + hi) >> 1; if (times[m] <= s) lo = m + 1; else hi = m; } return Math.min(1, lo / Math.max(1, totGoals)); };
  const model = makeModel(cfg);
  let jp = 0;
  for (const e of evs) {
    const hp = player(e.home), ap = player(e.away);
    while (jp < evs.length && evs[jp].start_ms < e.start_ms - LAG_MS) { const q = evs[jp++], qh = player(q.home), qa = player(q.away); if (qh && qa) model.learn(qh, qa, q.fh, q.fa); }
    if (!model.ready(hp, ap) || inGap(e.start_ms - 120000, e.start_ms + 780000)) continue;
    const sc = scoreCache.get(e.id), tot = e.fh + e.fa;
    const entries = GRID.map((D) => ({ kind: 'grid', D, te: e.start_ms + D * 1000, tg: null }));
    let prev = 0;
    for (let i = 0; i < sc.length; i++) { const t = sc[i].h + sc[i].a; if (t > prev) { const nxt = sc[i + 1] ? sc[i + 1].ts : Infinity; if (nxt > sc[i].ts + 12000 && sc[i].ts + 12000 < e.start_ms + 600000) entries.push({ kind: 'goal', D: null, te: sc[i].ts + 12000, tg: sc[i].ts }); } prev = Math.max(prev, t); }
    const rows = qOdds.all(e.id, e.start_ms + 780000);
    for (const en of entries) {
      const te = en.te, cur = {}, fill = {}, last = {};
      for (const r of rows) { if (r.ts > te + FILL_MS) break; fill[r.oid] = r; if (r.ts <= te) { cur[r.oid] = r; last[r.oid] = r.ts; } }
      let at = null; for (const s of sc) { if (s.ts <= te) at = s; else break; }
      const goals = at ? at.h + at.a : 0, diff = at ? Math.abs(at.h - at.a) : 0;
      if (en.kind === 'grid' && sc.some((s) => s.ts > te - 20000 && s.ts <= te)) continue; // goal in the last 20 s: score feed may lag the price
      const ladder = {};
      for (const r of Object.values(cur)) if (r.status === 'OPEN' && r.odds > 1050) { const l = (ladder[r.line] = ladder[r.line] || { line: r.line / 1000, bo: r.bo }); l[r.label === 'Over' ? 'over' : 'under'] = { id: r.oid, odds: r.odds }; }
      const m = pickMain(ladder);
      if (!m || m.line < goals) continue;
      const boRows = boCache.get(e.id) || boCache.set(e.id, qBo.all(e.id)).get(e.id), boTe = boAt(boRows, m.bo, te), boFill = boAt(boRows, m.bo, te + FILL_MS);
      const qw = en.kind === 'grid' ? 12000 : 8000;
      if ((last[m.over.id] || 0) > te - qw || (last[m.under.id] || 0) > te - qw) continue; // line still repricing
      const el = (te - e.start_ms) / 1000, pm = model.pOver(hp, ap, m.line, goals, 1 - F(el)), gap = pm - m.po;
      const side = gap > 0 ? 'Over' : 'Under', pick = gap > 0 ? m.over : m.under, fl = fill[pick.id], filled = fl && fl.status === 'OPEN' && fl.odds > 1050;
      const win = side === 'Over' ? tot > m.line : tot < m.line;
      recs.push({ prof, kind: en.kind, D: en.D, t: e.start_ms, ev: e.id, goals, diff, el, gap, pk: m.po, y: tot > m.line ? 1 : 0, filled, side, line: m.line, boTe, boFill, o: filled ? fl.odds / 1000 : 0, age: (te - Math.max(last[m.over.id] || 0, last[m.under.id] || 0)) / 1000, pnl: filled ? (win ? fl.odds / 1000 - 1 : -1) : 0 });
    }
  }
}
if (process.env.DIAG) { // breakdown of the after-goal bets (gap > 0.10) to look for artifacts
  const b = recs.filter((r) => r.kind === 'goal' && Math.abs(r.gap) > 0.1 && r.filled);
  const cut = (name, f) => console.log(`  ${line(name, b.filter(f))}`);
  console.log(`DIAG after-goal gap>0.10, FILL_MS=${FILL_MS}: ${line('all', b)}`);
  console.log('  bo status values at entry:', [...new Set(b.map((r) => r.boTe))].join(','), '| at fill:', [...new Set(b.map((r) => r.boFill))].join(','));
  cut('bet offer OPEN at entry and at fill', (r) => r.boTe === 'OPEN' && r.boFill === 'OPEN');
  cut('bet offer NOT open at entry or fill', (r) => r.boTe !== 'OPEN' || r.boFill !== 'OPEN');
  for (const [a, z] of [[8, 15], [15, 1e9]]) cut(`  open offers only, age ${a}-${z}s`, (r) => r.boTe === 'OPEN' && r.boFill === 'OPEN' && r.age >= a && r.age < z);
  for (const s of ['Over', 'Under']) cut(`side ${s}`, (r) => r.side === s);
  for (const p of ['cla', 'eb', 'ebwc']) cut(`league ${p}`, (r) => r.prof === p);
  for (const [a, z] of [[1, 1.3], [1.3, 1.6], [1.6, 2.1], [2.1, 3], [3, 99]]) cut(`odds ${a}-${z}`, (r) => r.o >= a && r.o < z);
  for (const [a, z] of [[8, 15], [15, 30], [30, 90], [90, 1e9]]) cut(`age of last quote ${a}-${z}s`, (r) => r.age >= a && r.age < z);
  for (const [a, z] of [[0, 120], [120, 240], [240, 330], [330, 700]]) cut(`elapsed ${a}-${z}s`, (r) => r.el >= a && r.el < z);
  for (const g of [1, 2, 3, 4]) cut(`goals so far ${g}${g === 4 ? '+' : ''}`, (r) => (g === 4 ? r.goals >= 4 : r.goals === g));
  const ex = b.slice(0, 400).filter((_, i) => i % 40 === 0).map((r) => `${r.prof} g=${r.goals} el=${Math.round(r.el)}s ${r.side} ${r.line}@${r.o} gap=${r.gap.toFixed(2)} age=${Math.round(r.age)}s ${r.pnl > 0 ? 'W' : 'L'}`);
  console.log('  samples:', ex.join(' | '));
  process.exit(0);
}
const G = {
  'G1 after-goal': (r) => r.kind === 'goal',
  'G2 mid 0-0 (2:00-3:00)': (r) => r.kind === 'grid' && [120, 150, 180].includes(r.D) && r.goals === 0,
  'G3 uneven score (diff>=2)': (r) => r.kind === 'grid' && r.diff >= 2,
  'G4 final stretch (>=390 s)': (r) => r.kind === 'grid' && r.D >= 390,
  'ALL states (reference)': () => true,
};
const tcut = recs.map((r) => r.t).sort((a, b) => a - b)[Math.floor(recs.length * 0.6)];
console.log(`states ${recs.length} over ${new Set(recs.map((r) => r.ev)).size} matches; last-40% cut ${new Date(tcut).toISOString()}`);
for (const [name, f] of Object.entries(G)) {
  const rs = recs.filter(f);
  const [b, lo, hi] = rs.length > 40 ? boot(rs, beta, 600) : [NaN, NaN, NaN];
  console.log(`\n== ${name}: states ${rs.length}; beta(all states) ${b.toFixed(2)} [${lo.toFixed(2)}, ${hi.toFixed(2)}]`);
  for (const th of [0.08, 0.1]) {
    const bets = rs.filter((r) => Math.abs(r.gap) > th && r.filled);
    console.log(`  TH ${th}: ${line('all', bets)}`);
    console.log(`        ${line('last40%', bets.filter((r) => r.t > tcut))}`);
  }
}
