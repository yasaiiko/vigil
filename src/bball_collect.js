'use strict';
// Standalone read-only capture of EsportsBattle basketball 4x5 (Kambi public API, no login) into data/bball.sqlite: prematch odds changes, live score, final score.
// Separate from collector.js on purpose (no restart, no risk to the football capture). Stop: create data/bball.stop. Usage: node src/bball_collect.js
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const root = path.join(__dirname, '..');
const OFFERING = process.env.KAMBI_OFFERING || 'YOUR_OFFERING_ID';
const BASE = `https://eu.offering-api.kambicdn.com/offering/v2018/${OFFERING}`;
const Q = 'channel_id=1&client_id=200&lang=en_GB&market=ES';
const LIST = `${BASE}/listView/esports_basketball/esports_battle__4x5min_/all/all/matches.json?${Q}&useCombined=true&useCombinedLive=true`;
const db = new Database(path.join(root, 'data', 'bball.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, home TEXT, away TEXT, start_ms INTEGER, state TEXT, first_seen INTEGER, last_seen INTEGER, last_live INTEGER, sc_home INTEGER, sc_away INTEGER, info TEXT, final_home INTEGER, final_away INTEGER, final_info TEXT, final_src TEXT, finished_ms INTEGER);
CREATE TABLE IF NOT EXISTS outcomes(id INTEGER PRIMARY KEY, event_id INTEGER, market TEXT, label TEXT, line INTEGER);
CREATE TABLE IF NOT EXISTS odds(ts INTEGER, event_id INTEGER, outcome_id INTEGER, odds INTEGER, status TEXT);
CREATE INDEX IF NOT EXISTS odds_ev ON odds(event_id, ts);`);
const upEv = db.prepare('INSERT INTO events(id,home,away,start_ms,state,first_seen,last_seen) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, start_ms=excluded.start_ms, last_seen=excluded.last_seen');
const upLive = db.prepare('UPDATE events SET last_live=?, sc_home=?, sc_away=?, info=? WHERE id=?');
const insOut = db.prepare('INSERT OR IGNORE INTO outcomes VALUES(?,?,?,?,?)');
const insOdds = db.prepare('INSERT INTO odds VALUES(?,?,?,?,?)');
const pending = db.prepare('SELECT id, sc_home, sc_away, info FROM events WHERE finished_ms IS NULL AND last_live IS NOT NULL AND last_seen < ? AND start_ms < ?');
const fin = db.prepare('UPDATE events SET final_home=?, final_away=?, final_info=?, final_src=?, finished_ms=? WHERE id=? AND finished_ms IS NULL');
const getJson = async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
const lastOdds = new Map(), lastFetch = new Map();
let nOdds = 0, nFin = 0, errs = 0, lastLog = Date.now();

async function captureOffers(id, now) {
  const b = await getJson(`${BASE}/betoffer/event/${id}.json?${Q}&includeParticipants=true`);
  db.transaction(() => {
    for (const o of b.betOffers || []) for (const c of o.outcomes || []) {
      insOut.run(c.id, id, o.criterion.label, c.label, c.line ?? null);
      const k = `${c.odds}|${c.status}`;
      if (lastOdds.get(c.id) !== k) { lastOdds.set(c.id, k); insOdds.run(now, id, c.id, c.odds ?? null, c.status || null); nOdds++; }
    }
  })();
}

async function tick() {
  const now = Date.now(), j = await getJson(LIST);
  for (const x of j.events || []) {
    const e = x.event || x, start = Date.parse(e.start);
    upEv.run(e.id, e.homeName, e.awayName, start, e.state, now, now);
    const s = x.liveData && x.liveData.score;
    if (e.state === 'STARTED' && s) upLive.run(now, Number(s.home), Number(s.away), s.info || null, e.id);
    if (e.state === 'NOT_STARTED' && start - now < 45 * 60000 && now - (lastFetch.get(e.id) || 0) > 60000) { lastFetch.set(e.id, now); await captureOffers(e.id, now); }
  }
  for (const r of pending.all(now - 40000, now - 22 * 60000)) { // gone from the list for 40 s and 22+ min after start: take the final score
    let h = r.sc_home, a = r.sc_away, info = r.info, src = 'lastseen';
    try { const l = (await getJson(`${BASE}/event/${r.id}/livedata.json?lang=en_GB&market=ES&client_id=200&channel_id=1`)).liveData; if (l && l.score && l.score.home != null) { h = Number(l.score.home); a = Number(l.score.away); info = l.score.info || info; src = 'livedata'; } } catch { /* keep last seen */ }
    fin.run(h, a, info, src, now, r.id); nFin++;
  }
}

(async () => {
  console.log(new Date().toISOString(), 'bball collector start');
  for (;;) {
    if (fs.existsSync(path.join(root, 'data', 'bball.stop'))) { console.log('stop file found'); break; }
    try { await tick(); } catch (e) { errs++; console.log(new Date().toISOString(), 'tick error', e.message); }
    if (Date.now() - lastLog > 300000) { lastLog = Date.now(); console.log(new Date().toISOString(), `hb odds+${nOdds} finals+${nFin} errs ${errs}`); }
    await new Promise((r) => setTimeout(r, 10000));
  }
})();
