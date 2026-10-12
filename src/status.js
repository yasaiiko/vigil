'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./schema');
const { loadGaps, hits } = require('./gaps');
const db = openDb(process.env.SB_DB || 'data/odds.sqlite', { readonly: true });
const now = Date.now();
const one = (s, ...a) => db.prepare(s).get(...a);
const ev = one('SELECT COUNT(*) n, MIN(start_ms) a, MAX(start_ms) b, SUM(finished_ms IS NOT NULL) fin, SUM(result_status=\'ok\') ok, SUM(result_status=\'no_score\') ns FROM events');
const hrs = (ev.b - ev.a) / 3600000;
console.log(`EVENTS ${ev.n} over ${hrs.toFixed(1)}h (${(ev.n / hrs).toFixed(0)}/h => ~${Math.round(24 * ev.n / hrs)}/day) | finished ${ev.fin} | score ok ${ev.ok} | no_score ${ev.ns}`);
const byTerm = db.prepare('SELECT term, COUNT(*) n FROM events GROUP BY term').all().map((r) => `${r.term.slice(0, 22)}=${r.n}`).join(' ');
console.log('by category:', byTerm);
const gaps = db.prepare('SELECT start_ms FROM events ORDER BY start_ms').all().map((r) => r.start_ms);
let maxGap = 0, gapAt = 0;
for (let i = 1; i < gaps.length; i++) if (gaps[i] - gaps[i - 1] > maxGap) { maxGap = gaps[i] - gaps[i - 1]; gapAt = gaps[i - 1]; }
console.log(`largest gap between consecutive kickoffs: ${(maxGap / 60000).toFixed(0)} min (after ${new Date(gapAt).toISOString().slice(11, 16)}Z)`);
const c = (t) => one(`SELECT COUNT(*) n FROM ${t}`).n;
console.log('ROWS', ['odds', 'outcomes', 'scores', 'clock', 'ev_state', 'stats', 'bo_status'].map((t) => `${t}=${c(t)}`).join(' '), '| odds src poll/ws:', db.prepare('SELECT src, COUNT(*) n FROM odds GROUP BY src').all().map((r) => r.n).join('/'));
const gb = (f) => { try { return (fs.statSync(f).size / 2 ** 30).toFixed(3); } catch { return '0'; } };
console.log(`DB ${gb('data/odds.sqlite')} GB + WAL ${gb('data/odds.sqlite-wal')} GB | growth ~${(fs.statSync('data/odds.sqlite').size / 2 ** 20 / Math.max(hrs, 0.1) * 24).toFixed(0)} MB/day (main file only)`);
try {
  const dir = path.join(process.env.SB_COLD_ROOT || path.join(path.resolve(__dirname, '..'), 'cold'), 'backups');
  const bk = fs.readdirSync(dir).filter((f) => /^vigil-\d{8}-\d{6}\.sqlite$/.test(f));
  const last = bk.sort().pop();
  console.log(`COLD backups=${bk.length} latest=${last} age=${last ? Math.round((now - fs.statSync(dir + '\\' + last).mtimeMs) / 60000) : '?'}min free D:=${(fs.statfsSync('D:\\').bavail * fs.statfsSync('D:\\').bsize / 2 ** 30).toFixed(0)}GB`);
} catch (e) { console.log('COLD unavailable', e.message); }
// quality on finished events
const q = one(`SELECT COUNT(*) n,
  SUM(EXISTS(SELECT 1 FROM odds o JOIN outcomes c ON c.id=o.outcome_id WHERE o.event_id=e.id AND c.market='Full Time' AND o.ts<=e.start_ms)) pre,
  SUM(EXISTS(SELECT 1 FROM odds o JOIN outcomes c ON c.id=o.outcome_id WHERE o.event_id=e.id AND c.market='Full Time' AND o.ts>e.start_ms)) live,
  SUM((SELECT COUNT(*) FROM scores s WHERE s.event_id=e.id)>0) sc,
  SUM((SELECT COUNT(*) FROM clock k WHERE k.event_id=e.id)>0) ck
  FROM events e WHERE e.finished_ms IS NOT NULL`);
const p = (x) => `${Math.round(100 * x / q.n)}%`;
console.log(`QUALITY (finished ${q.n}): prematch FT ${p(q.pre)} | live FT ${p(q.live)} | score ${p(q.sc)} | clock ${p(q.ck)}`);
const clk = db.prepare('SELECT event_id, COUNT(*) n, MIN(ts) a, MAX(ts) b FROM clock GROUP BY event_id HAVING n>3 LIMIT 300').all();
const dens = clk.map((r) => (r.b - r.a) / (r.n - 1) / 1000).sort((x, y) => x - y);
console.log(`clock rows/event median ${clk.map((r) => r.n).sort((x, y) => x - y)[Math.floor(clk.length / 2)]} | median gap ${dens.length ? dens[Math.floor(dens.length / 2)].toFixed(1) : '?'}s`);

const gsum = db.prepare('SELECT kind, COUNT(*) n, SUM(COALESCE(end_ms, ?) - start_ms) ms FROM capture_gaps WHERE start_ms > ? GROUP BY kind').all(now, now - 86400000).map((g) => `${g.kind}=${g.n}x/${Math.round(g.ms / 60000)}min`).join(' ') || 'none';
const hl = db.prepare('SELECT * FROM health ORDER BY ts DESC LIMIT 1').get();
console.log(`GAPS last 24h: ${gsum} | last health: ${hl ? `${Math.round((now - hl.ts) / 1000)}s ago ws_up=${hl.ws_up} poll_age=${hl.poll_age_s}s skew=${hl.skew_ms}ms free=${hl.free_gb == null ? '?' : hl.free_gb.toFixed(0)}GB lag=${hl.loop_lag_ms}ms` : 'none yet'}`);
// --- in-play state observations (FT market, quote+score+clock at the same instant) ---
const gapList = process.env.KEEP_GAPS ? [] : loadGaps(db);
const finAll = db.prepare(`SELECT id, start_ms, final_home fh, final_away fa FROM events WHERE finished_ms IS NOT NULL AND result_status='ok'`).all();
const fin = finAll.filter((e) => !hits(gapList, e.start_ms - 35 * 60000, e.start_ms + 12 * 60000));
console.log(`events excluded for capture gaps: ${finAll.length - fin.length}`);
const qO = db.prepare(`SELECT o.ts, o.odds, c.label, c.betoffer_id bo FROM odds o JOIN outcomes c ON c.id=o.outcome_id WHERE o.event_id=? AND c.market='Full Time' AND o.ts>? ORDER BY o.ts`);
const qS = db.prepare('SELECT ts, home, away FROM scores WHERE event_id=? ORDER BY ts');
const qK = db.prepare('SELECT ts, minute, second FROM clock WHERE event_id=? ORDER BY ts');
const qB = db.prepare('SELECT ts, betoffer_id bo, status FROM bo_status WHERE event_id=? ORDER BY ts');
const obs = [];
for (const e of fin) {
  const rows = qO.all(e.id, e.start_ms), sc = qS.all(e.id), ck = qK.all(e.id), bs = qB.all(e.id);
  if (!rows.length || !sc.length || !ck.length) continue;
  const latest = {}, suspended = new Set();
  let si = -1, ki = -1, bi = 0;
  const lastEmit = {};
  for (const r of rows) {
    if (r.odds > 1000) latest[r.label] = r.odds;
    while (si + 1 < sc.length && sc[si + 1].ts <= r.ts) si++;
    while (ki + 1 < ck.length && ck[ki + 1].ts <= r.ts) ki++;
    while (bi < bs.length && bs[bi].ts <= r.ts) { if (bs[bi].status === 'OPEN') suspended.delete(bs[bi].bo); else suspended.add(bs[bi].bo); bi++; }
    if (si < 0 || ki < 0 || suspended.has(r.bo)) continue;
    if (!('1' in latest && 'X' in latest && '2' in latest)) continue;
    const el = ck[ki].minute * 60 + ck[ki].second + Math.min(30, (r.ts - ck[ki].ts) / 1000);
    const b = Math.floor(el / 60);
    if (lastEmit[b] === undefined || r.ts - lastEmit[b].ts > 20000) {
      const inv = [1000 / latest['1'], 1000 / latest.X, 1000 / latest['2']], s = inv.reduce((a, x) => a + x, 0);
      lastEmit[b] = { ts: r.ts, ev: e.id, b, diff: sc[si].home - sc[si].away, tot: sc[si].home + sc[si].away, p: inv.map((x) => x / s), odds: [latest['1'], latest.X, latest['2']], w: e.fh > e.fa ? 0 : e.fh < e.fa ? 2 : 1 };
    }
  }
  for (const o of Object.values(lastEmit)) obs.push(o);
}
console.log(`\nIN-PLAY FT observations (1 per event per game-minute, unsuspended, score+clock known): ${obs.length} from ${new Set(obs.map((o) => o.ev)).size} matches`);
const st = new Map();
for (const o of obs) {
  const k = `${Math.min(o.b, 7)}|${Math.max(-1, Math.min(1, o.diff))}`;
  const s = st.get(k) || { n: 0, mk: [0, 0, 0], act: [0, 0, 0], evs: new Set() };
  s.n++; s.evs.add(o.ev);
  for (let j = 0; j < 3; j++) { s.mk[j] += o.p[j]; if (o.w === j) s.act[j]++; }
  st.set(k, s);
}
console.log('min|diff(home-away, clipped +-1)   n  matches | home mkt/act | draw mkt/act | away mkt/act');
for (const [k, s] of [...st.entries()].sort()) {
  if (s.n < 25) continue;
  const f = (j) => `${(s.mk[j] / s.n).toFixed(2)}/${(s.act[j] / s.n).toFixed(2)}`;
  console.log(`  ${k.padEnd(8)} ${String(s.n).padStart(6)} ${String(s.evs.size).padStart(7)} | ${f(0).padEnd(10)} | ${f(1).padEnd(10)} | ${f(2)}`);
}
function ci(list, B = 4000) {
  const n = list.length, m = list.reduce((a, x) => a + x, 0) / n, bs = [];
  for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < n; i++) s += list[Math.floor(Math.random() * n)]; bs.push(s / n); }
  bs.sort((a, b) => a - b);
  return `n=${n} wins=${list.filter((x) => x > -1).length} ROI=${(m * 100).toFixed(1)}% 95%CI=[${(bs[Math.floor(0.025 * B)] * 100).toFixed(0)}%, ${(bs[Math.floor(0.975 * B)] * 100).toFixed(0)}%]`;
}
console.log('\nIN-SAMPLE rules (first qualifying observation per match, offered odds). Chosen AFTER seeing the table => optimistic:');
const rule = (name, pick) => {
  const seen = new Set(), list = [];
  for (const o of obs.slice().sort((a, b) => a.ts - b.ts)) {
    if (seen.has(o.ev)) continue;
    const k = pick(o);
    if (k < 0) continue;
    seen.add(o.ev);
    list.push(o.w === k ? o.odds[k] / 1000 - 1 : -1);
  }
  console.log(' ', name.padEnd(38), list.length >= 8 ? ci(list) : `n=${list.length}`);
};
rule('draw when tied, minute>=4', (o) => (o.diff === 0 && o.b >= 4 ? 1 : -1));
rule('draw when tied, minute 0-3 (control)', (o) => (o.diff === 0 && o.b <= 3 ? 1 : -1));
rule('leader when ahead by 1, minute>=5', (o) => (o.b >= 5 ? (o.diff === 1 ? 0 : o.diff === -1 ? 2 : -1) : -1));
rule('leader when ahead by 1, minute<=3 (control)', (o) => (o.b <= 3 ? (o.diff === 1 ? 0 : o.diff === -1 ? 2 : -1) : -1));
console.log('data cutoff for a frozen forward test:', new Date(now).toISOString());
db.close();
