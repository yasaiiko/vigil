'use strict';
// Frozen forward test of the in-play rule found in-sample on 2026-09-30: bet the DRAW (Full Time) when the score is tied from game-minute 4.
// Rule, cutoff and latency are fixed before looking at post-cutoff data; the confirmatory set is matches kicked off after CUTOFF. Read-only.
// Usage: node src/live_ev.js [db]   env: LAT_S=10 (execution latency, s)  KEEP_GAPS=1 (keep events overlapping capture gaps)
const path = require('node:path');
const Database = require('better-sqlite3');
const { loadGaps, hits } = require('./gaps');

const CUTOFF_MS = Date.parse(process.env.CUTOFF || '2026-09-30T15:53:04.834Z');
const MIN_ELAPSED_S = 240;
const LAT_MS = Number(process.env.LAT_S ?? 10) * 1000;
const TARGET_BETS = 1000;
const db = new Database(process.argv[2] || path.join(__dirname, '..', 'data', 'odds.sqlite'), { readonly: true, fileMustExist: true });
const now = Date.now();
const gaps = process.env.KEEP_GAPS ? [] : loadGaps(db);

const qOdds = db.prepare(`SELECT o.ts, o.odds, o.status, c.label, c.betoffer_id bo FROM odds o JOIN outcomes c ON c.id = o.outcome_id WHERE o.event_id = ? AND c.market = 'Full Time' ORDER BY o.ts`);
const qScore = db.prepare('SELECT ts, home, away FROM scores WHERE event_id = ? ORDER BY ts');
const qClock = db.prepare('SELECT ts, minute, second FROM clock WHERE event_id = ? ORDER BY ts');
const qBo = db.prepare('SELECT ts, betoffer_id bo, status FROM bo_status WHERE event_id = ? ORDER BY ts');
const events = db.prepare(`SELECT id, term, start_ms, final_home fh, final_away fa FROM events WHERE finished_ms IS NOT NULL AND result_status = 'ok' AND term LIKE 'esports_battle%' ORDER BY start_ms`).all();

const lastLE = (arr, ts) => { let lo = 0, hi = arr.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].ts <= ts) { r = m; lo = m + 1; } else hi = m - 1; } return r; };

// State of the Full Time market at time ts, or null when it is not bettable (unknown score/clock, missing or suspended price).
function market(ev, ts) {
  const si = lastLE(ev.scores, ts), ki = lastLE(ev.clock, ts);
  if (si < 0 || ki < 0) return null;
  const k = ev.clock[ki];
  const el = k.minute * 60 + k.second + Math.min(30, (ts - k.ts) / 1000);
  const odds = {};
  for (const label of ['1', 'X', '2']) {
    const a = ev.px[label];
    const i = a ? lastLE(a, ts) : -1;
    if (i < 0 || !(a[i].odds > 1000) || a[i].status === 'SUSPENDED') return null;
    odds[label] = a[i].odds;
  }
  const b = ev.bo.get(ev.boId);
  if (b) { const j = lastLE(b, ts); if (j >= 0 && b[j].status !== 'OPEN') return null; }
  return { diff: ev.scores[si].home - ev.scores[si].away, el, odds };
}

function evaluate(e, controlRule) {
  const rows = qOdds.all(e.id);
  if (!rows.length) return null;
  const ev = { scores: qScore.all(e.id), clock: qClock.all(e.id), px: {}, bo: new Map(), boId: rows[0].bo };
  for (const r of rows) (ev.px[r.label] || (ev.px[r.label] = [])).push(r);
  for (const r of qBo.all(e.id)) (ev.bo.get(r.bo) || ev.bo.set(r.bo, []).get(r.bo)).push(r);
  if (!ev.scores.length || !ev.clock.length) return { skip: 'no_state' };
  const ok = (m) => m && m.diff === 0 && (controlRule ? m.el < MIN_ELAPSED_S : m.el >= MIN_ELAPSED_S);
  let first = null;
  for (const r of rows) {
    if (r.ts <= e.start_ms) continue;
    const m = market(ev, r.ts);
    if (ok(m)) { first = { ts: r.ts, m }; break; }
  }
  if (!first) return { skip: 'never_qualified' };
  const win = e.fh === e.fa;
  const instant = win ? first.m.odds.X / 1000 - 1 : -1;
  const m2 = market(ev, first.ts + LAT_MS);
  const lat = ok(m2) ? (win ? m2.odds.X / 1000 - 1 : -1) : null;
  return { ts: first.ts, instant, lat, win, oddsInstant: first.m.odds.X / 1000, oddsLat: lat === null ? null : m2.odds.X / 1000, term: e.term };
}

function boot(list, B = 4000) {
  const n = list.length, m = list.reduce((a, x) => a + x, 0) / n, bs = [];
  for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < n; i++) s += list[Math.floor(Math.random() * n)]; bs.push(s / n); }
  bs.sort((a, b) => a - b);
  return { n, m, lo: bs[Math.floor(0.025 * B)], hi: bs[Math.floor(0.975 * B)], p: bs.filter((x) => x <= 0).length / B };
}
const fmt = (b, wins, odds) => `bets=${String(b.n).padStart(4)} wins=${String(wins).padStart(3)} (${(100 * wins / b.n).toFixed(0)}%) avgOdds=${odds.toFixed(2)} ROI=${(b.m * 100).toFixed(1).padStart(6)}% 95%CI=[${(b.lo * 100).toFixed(0)}%, ${(b.hi * 100).toFixed(0)}%] P(ROI<=0)=${b.p.toFixed(3)}`;

function run(label, pick, controlRule) {
  const res = { instant: [], lat: [], skipped: 0, rejected: 0, excl: 0, matches: 0, byTerm: {} };
  for (const e of events) {
    if (!pick(e)) continue;
    if (hits(gaps, e.start_ms - 35 * 60000, e.start_ms + 12 * 60000)) { res.excl++; continue; }
    res.matches++;
    const r = evaluate(e, controlRule);
    if (!r || r.skip) { res.skipped++; continue; }
    res.instant.push({ pnl: r.instant, win: r.win, odds: r.oddsInstant });
    if (r.lat === null) res.rejected++;
    else { res.lat.push({ pnl: r.lat, win: r.win, odds: r.oddsLat, ts: r.ts, o0: r.oddsInstant }); (res.byTerm[r.term] || (res.byTerm[r.term] = [])).push(r.lat); }
  }
  const line = (arr, name) => (arr.length >= 8 ? `${name.padEnd(9)} ${fmt(boot(arr.map((x) => x.pnl)), arr.filter((x) => x.win).length, arr.reduce((a, x) => a + x.odds, 0) / arr.length)}` : `${name.padEnd(9)} bets=${arr.length} (too few)`);
  console.log(`${label}: matches=${res.matches} (excluded for capture gaps: ${res.excl}, no qualifying state: ${res.skipped}, rejected at +${LAT_MS / 1000}s latency: ${res.rejected})`);
  console.log('  ' + line(res.instant, 'instant'));
  console.log('  ' + line(res.lat, `+${LAT_MS / 1000}s lat`));
  return res;
}

console.log(`FROZEN RULE: bet DRAW (Full Time) when tied from ${MIN_ELAPSED_S / 60}:00, first qualifying quote per match; cutoff ${new Date(CUTOFF_MS).toISOString()}; latency ${LAT_MS / 1000}s`);
run('IN-SAMPLE (kickoff before cutoff; rule was chosen on these, optimistic)', (e) => e.start_ms <= CUTOFF_MS, false);
const fwd = run('FORWARD   (kickoff after cutoff; the only confirmatory set)', (e) => e.start_ms > CUTOFF_MS, false);
for (const [t, arr] of Object.entries(fwd.byTerm)) if (arr.length >= 8) console.log(`    ${t.slice(0, 24).padEnd(25)} ${(100 * arr.reduce((a, x) => a + x, 0) / arr.length).toFixed(1)}% ROI over ${arr.length} bets (descriptive)`);
{ // stability check (descriptive): ROI per chronological block of forward bets
  const arr = fwd.lat.slice().sort((a, b) => a.ts - b.ts), B = 150, out = [];
  for (let i = 0; i < arr.length; i += B) { const blk = arr.slice(i, i + B); if (blk.length < 50) continue; const m = blk.reduce((a, x) => a + x.pnl, 0) / blk.length; const sd = Math.sqrt(blk.reduce((a, x) => a + (x.pnl - m) ** 2, 0) / (blk.length - 1)); out.push(`${new Date(blk[0].ts).toISOString().slice(5, 13)}h n=${blk.length} ROI=${(m * 100).toFixed(0)}%(+-${(196 * sd / Math.sqrt(blk.length)).toFixed(0)})`); }
  console.log('  blocks (chronological, ROI +-95% half-width):', out.join(' | '));
}
{ const hi = fwd.lat.filter((x) => x.odds >= x.o0), lo = fwd.lat.filter((x) => x.odds < x.o0); console.log('  by price move during latency (accepted only if price did not fall = HIGHER policy):'); console.log('   ' + (hi.length >= 8 ? `not fallen ${fmt(boot(hi.map((x) => x.pnl)), hi.filter((x) => x.win).length, hi.reduce((a, x) => a + x.odds, 0) / hi.length)}` : 'not fallen too few')); console.log('   ' + (lo.length >= 8 ? `fallen     ${fmt(boot(lo.map((x) => x.pnl)), lo.filter((x) => x.win).length, lo.reduce((a, x) => a + x.odds, 0) / lo.length)}` : 'fallen too few')); }
if (process.env.HOURS) { const W = Number(process.env.HOURS), by = new Map(); for (const x of fwd.lat) { const k = Math.floor(new Date(x.ts).getUTCHours() / W) * W; (by.get(k) || by.set(k, []).get(k)).push(x.pnl); } let chi = 0, mAll = fwd.lat.reduce((a, x) => a + x.pnl, 0) / fwd.lat.length, df = -1; const out = []; for (const [k, a] of [...by].sort((p, q) => p[0] - q[0])) { const m = a.reduce((p, x) => p + x, 0) / a.length, sd = Math.sqrt(a.reduce((p, x) => p + (x - m) ** 2, 0) / (a.length - 1)), se = sd / Math.sqrt(a.length); chi += ((m - mAll) / se) ** 2; df++; out.push(`${String(k).padStart(2, '0')}-${String((k + W) % 24).padStart(2, '0')}h UTC n=${a.length} ROI=${(m * 100).toFixed(0)}%(+-${(196 * se).toFixed(0)})`); } console.log('  BY HOUR BLOCK (descriptive):', out.join(' | ')); console.log(`  heterogeneity chi2=${chi.toFixed(1)} df=${df} (>${[0,3.8,6,7.8,9.5,11.1,12.6,14.1,15.5][Math.min(df,8)] || '?'} would be p<0.05)`); }
run('CONTROL forward (tied before 4:00; the effect should NOT appear)', (e) => e.start_ms > CUTOFF_MS, true);

const n = fwd.lat.length;
const hoursFwd = Math.max(1, (now - CUTOFF_MS) / 3600000);
const usable = fwd.matches / Math.max(1, fwd.matches + fwd.excl) * hoursFwd;
const rate = n / usable;
console.log(`\nPROGRESS: ${n}/${TARGET_BETS} latency-adjusted bets (${(100 * n / TARGET_BETS).toFixed(0)}%) | ~${(rate * 24).toFixed(0)} bets/day of clean capture | ETA ~${Math.max(0, (TARGET_BETS - n) / (rate * 24)).toFixed(1)} days`);
console.log(n >= TARGET_BETS ? 'DECISION: evaluate once now. Proceed only if the 95% CI lower bound is > 0 (then extend to ~2500 bets before real money).' : 'DECISION: too early. Do not act on these numbers; evaluate once at the target size.');
db.close();
