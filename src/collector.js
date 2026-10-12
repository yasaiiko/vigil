'use strict';
// Kambi-powered sportsbook collector: prematch odds by polling, live odds/score/clock by WebSocket push. Run with Node 22.
// Flags: --init-only (create DB and exit). Self-checks, gap bookkeeping and fallbacks live in health.js / ws-client.js.
const path = require('node:path');
const { openDb } = require('./schema');
const { createPushClient } = require('./ws-client');
const { startHealth, recoverGaps } = require('./health');
const { makeAlert } = require('./alerts');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.resolve(process.env.SB_DB || path.join(ROOT, 'data', 'odds.sqlite'));
const OFFERING = process.env.KAMBI_OFFERING || 'YOUR_OFFERING_ID'; // operator-specific id of a Kambi-powered sportsbook (public API, no login)
const BASE = process.env.SB_BASE || `https://eu.offering-api.kambicdn.com/offering/v2018/${OFFERING}`;
const Q = 'channel_id=1&client_id=200&lang=en_GB&market=ES';
const WS_URL = process.env.SB_WS_URL || 'wss://push-eu.offering-api.kambicdn.com/socket.io/?EIO=4&transport=websocket';
const TERMS = (process.env.SB_TERMS || 'esports_battle__2x4min_,esports_battle_world_cup__2x4_min_,cyber_live_arena__2x5_min_,cla_world_cup__2x5_min_,esports_battle__2x6min_').split(',');
const POLL_MS = Number(process.env.SB_POLL_MS || 20000);
const COLD = process.env.SB_COLD_ROOT || path.join(ROOT, 'cold');
const ALERT_FILE = process.env.SB_ALERT_FILE || path.join(ROOT, 'logs', 'vigil-alerts.log');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const log = (...a) => console.log(new Date().toISOString(), ...a);
let lastErr = '', errRepeat = 0;
const logErr = (...a) => {
  const k = a.join(' ');
  if (k === lastErr) { if (++errRepeat % 30 !== 0) return; return log(...a, `(repeated x${errRepeat})`); }
  lastErr = k; errRepeat = 0; log(...a);
};
const alert = makeAlert(ALERT_FILE, log);

const db = openDb(DB_PATH);
if (process.argv.includes('--init-only')) { db.close(); log('db ready', DB_PATH); process.exit(0); }

const S = {
  ev: db.prepare('INSERT INTO events(id,term,group_id,home,away,start_ms,state,first_seen,last_seen) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,last_seen=excluded.last_seen,start_ms=excluded.start_ms'),
  oc: db.prepare('INSERT OR IGNORE INTO outcomes(id,event_id,betoffer_id,market,label,line,participant,type) VALUES(?,?,?,?,?,?,?,?)'),
  odds: db.prepare('INSERT INTO odds(ts,event_id,outcome_id,odds,status,src) VALUES(?,?,?,?,?,?)'),
  score: db.prepare('INSERT INTO scores(ts,event_id,home,away) VALUES(?,?,?,?)'),
  clock: db.prepare('INSERT INTO clock(ts,event_id,period,minute,second) VALUES(?,?,?,?,?)'),
  state: db.prepare('INSERT INTO ev_state(ts,event_id,state) VALUES(?,?,?)'),
  stats: db.prepare('INSERT INTO stats(ts,event_id,json) VALUES(?,?,?)'),
  bo: db.prepare('INSERT INTO bo_status(ts,event_id,betoffer_id,status) VALUES(?,?,?,?)'),
};

const cnt = { odds: 0, scores: 0, ws: 0, pollErr: 0, polls: 0, rows: 0, unknownMt: 0 };
const queue = [];
let flushFails = 0;
const put = (stmt, ...args) => { cnt.rows++; if (queue.length < 500000) queue.push([stmt, args]); };
const flush = db.transaction((items) => { for (const [s, a] of items) s.run(...a); });
setInterval(() => {
  if (!queue.length) return;
  const items = queue.splice(0);
  try { flush(items); flushFails = 0; } catch (e) { flushFails++; log('flush error', e.message); queue.unshift(...items); }
}, 1000);

const tracked = new Map(); // eventId -> {groupId, startMs}
const knownOutcomes = new Set();
const lastOdds = new Map();
const lastScore = new Map();
const lastState = new Map();
const unknownSeen = new Set();
const pollState = { lastOk: Date.now(), emptyCycles: 0, delay: POLL_MS };
let skewMs = null;
let lastPushData = Date.now();

// Startup recovery: record downtime, close dangling gaps, and rebuild dedupe caches so a restart does not re-insert current prices.
function recover() {
  const now = Date.now();
  recoverGaps(db, now, log);
  const recent = db.prepare('SELECT id, term t, group_id g, start_ms s FROM events WHERE start_ms > ?').all(now - 3 * 3600000);
  const qo = db.prepare('SELECT id FROM outcomes WHERE event_id=?');
  const qd = db.prepare('SELECT outcome_id id, odds, status FROM odds WHERE event_id=? ORDER BY ts');
  const qs = db.prepare('SELECT home, away FROM scores WHERE event_id=? ORDER BY ts DESC LIMIT 1');
  const qt = db.prepare('SELECT state FROM ev_state WHERE event_id=? ORDER BY ts DESC LIMIT 1');
  for (const e of recent) {
    tracked.set(e.id, { groupId: e.g, startMs: e.s, term: e.t });
    for (const r of qo.all(e.id)) knownOutcomes.add(r.id);
    for (const r of qd.all(e.id)) lastOdds.set(r.id, `${r.odds ?? ''}|${r.status}`);
    const sc = qs.get(e.id); if (sc) lastScore.set(e.id, `${sc.home}-${sc.away}`);
    const st = qt.get(e.id); if (st) lastState.set(e.id, st.state);
  }
  log(`recovery: preloaded ${recent.length} recent events, ${lastOdds.size} prices`);
}

function recordOdds(eventId, id, odds, status, src, ts) {
  const key = `${odds ?? ''}|${status}`;
  if (lastOdds.get(id) === key) return;
  lastOdds.set(id, key);
  put(S.odds, ts, eventId, id, odds ?? null, status, src);
  cnt.odds++;
}
function ingestBetOffer(bo, ts, src) {
  const status = bo.suspended ? 'SUSPENDED' : null;
  for (const o of bo.outcomes || []) {
    if (!knownOutcomes.has(o.id)) {
      knownOutcomes.add(o.id);
      put(S.oc, o.id, bo.eventId, bo.id, bo.criterion && bo.criterion.label, o.label ?? null, o.line ?? null, o.participant ?? null, o.type ?? null);
    }
    recordOdds(bo.eventId, o.id, o.odds, status || o.status || 'OPEN', src, ts);
  }
}
// A bet offer that vanishes from the group poll is closed even if no push said so; record it (absence of rows means open).
const boPresent = new Map();
function markPresence(evId, ids, ts) {
  let m = boPresent.get(evId);
  if (!m) boPresent.set(evId, (m = new Map()));
  for (const id of ids) { if (m.get(id) === 'REMOVED') put(S.bo, ts, evId, id, 'OPEN'); m.set(id, 'OPEN'); }
  for (const [id, st] of m) if (st === 'OPEN' && !ids.has(id)) { m.set(id, 'REMOVED'); put(S.bo, ts, evId, id, 'REMOVED'); }
}
function recordScore(id, h, a, ts) {
  const k = `${h}-${a}`;
  if (lastScore.get(id) === k) return;
  lastScore.set(id, k);
  put(S.score, ts, id, Number(h), Number(a));
  cnt.scores++;
}
function recordState(id, state, ts) {
  if (lastState.get(id) === state) return;
  lastState.set(id, state);
  put(S.state, ts, id, state);
}
function ingestLive(id, ld, ts) {
  if (!ld) return;
  if (ld.score) recordScore(id, ld.score.home, ld.score.away, ts);
  if (ld.matchClock) put(S.clock, ts, id, ld.matchClock.period, ld.matchClock.minute, ld.matchClock.second);
  if (ld.statistics) put(S.stats, ts, id, JSON.stringify(ld.statistics.football || ld.statistics));
}

async function getJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) { const e = new Error(`HTTP ${r.status} ${url.split('?')[0].slice(-50)}`); e.status = r.status; throw e; }
  return r.json();
}

async function pollOnce() {
  const now = Date.now();
  const groups = new Set();
  let listOk = 0, listEvents = 0, blocked = false;
  for (const term of TERMS) {
    try {
      const l = await getJson(`${BASE}/listView/football/esports_football/${term}/all/matches.json?${Q}&useCombined=true&useCombinedLive=true`);
      listOk++;
      for (const x of l.events || []) {
        const e = x.event;
        if (!e) continue;
        listEvents++;
        const startMs = Date.parse(e.start);
        tracked.set(e.id, { groupId: e.groupId, startMs, term });
        put(S.ev, e.id, term, e.groupId, e.homeName, e.awayName, startMs, e.state, now, now);
        recordState(e.id, e.state, now);
        groups.add(e.groupId);
      }
    } catch (err) {
      cnt.pollErr++;
      if (err.status === 403 || err.status === 429) blocked = true;
      logErr('list', term, err.message);
    }
  }
  if (listOk === 0) { pollState.delay = Math.min(pollState.delay * 2, 60000); return; } // network/API down: back off, skip dependent calls
  pollState.lastOk = Date.now();
  pollState.emptyCycles = listEvents === 0 ? pollState.emptyCycles + 1 : 0;
  for (const gid of groups) {
    try {
      const b = await getJson(`${BASE}/betoffer/group/${gid}.json?${Q}&includeParticipants=true`);
      const seen = new Map();
      for (const bo of b.betOffers || []) if (tracked.has(bo.eventId)) { ingestBetOffer(bo, now, 0); (seen.get(bo.eventId) || seen.set(bo.eventId, new Set()).get(bo.eventId)).add(bo.id); }
      for (const [evId, ids] of seen) markPresence(evId, ids, now);
    } catch (err) { cnt.pollErr++; logErr('group', gid, err.message); }
  }
  for (const [id, t] of tracked) {
    if (t.startMs > now || now - t.startMs > 20 * 60000) continue;
    try {
      const d = await getJson(`${BASE}/event/${id}/livedata.json?lang=en_GB&market=ES&client_id=200&channel_id=1`);
      ingestLive(id, d.liveData, now);
    } catch (err) { if (!/404/.test(err.message)) { cnt.pollErr++; logErr('live', id, err.message); } }
  }
  for (const [id, t] of tracked) if (now - t.startMs > 3 * 3600000) { tracked.delete(id); boPresent.delete(id); }
  if (lastOdds.size > 300000) lastOdds.clear();
  cnt.polls++;
  if (blocked) { pollState.delay = Math.min(Math.max(pollState.delay * 2, POLL_MS), 120000); alert('rate-limited', `API answered 403/429; polling every ${pollState.delay / 1000}s`); }
  else pollState.delay = push.up ? POLL_MS : Math.min(POLL_MS, 8000); // push down: poll faster to keep some live resolution
}

function handleUpdate(u) {
  const ts = Number(u.t) || Date.now();
  switch (u.mt) {
    case 11: if (u.boou && tracked.has(u.boou.eventId)) for (const o of u.boou.outcomes || []) recordOdds(u.boou.eventId, o.id, o.odds, 'OPEN', 1, ts); break;
    case 6: if (u.boa && u.boa.betOffer && tracked.has(u.boa.betOffer.eventId)) ingestBetOffer(u.boa.betOffer, ts, 1); break;
    case 16: if (u.score && tracked.has(u.score.eventId)) recordScore(u.score.eventId, u.score.score.home, u.score.score.away, ts); break;
    case 15: if (u.mcu && tracked.has(u.mcu.eventId)) put(S.clock, ts, u.mcu.eventId, u.mcu.matchClock.period, u.mcu.matchClock.minute, u.mcu.matchClock.second); break;
    case 17: if (u.stats && tracked.has(u.stats.eventId)) put(S.stats, ts, u.stats.eventId, JSON.stringify(u.stats.statistics)); break;
    case 34: if (u.esu && tracked.has(u.esu.id)) recordState(u.esu.id, u.esu.state, ts); break;
    case 18: if (u.er && tracked.has(u.er.eventId)) recordState(u.er.eventId, 'REMOVED', ts); break;
    case 8: if (u.bosu && tracked.has(u.bosu.eventId)) put(S.bo, ts, u.bosu.eventId, u.bosu.betOfferId, u.bosu.suspended ? 'SUSPENDED' : 'OPEN'); break;
    case 7: if (u.bor && tracked.has(u.bor.eventId)) put(S.bo, ts, u.bor.eventId, u.bor.betOfferId, 'REMOVED'); break;
    case 4: case 5: break; // event / live event added: tracked via the list poll
    default:
      cnt.unknownMt++;
      if (!unknownSeen.has(u.mt)) { unknownSeen.add(u.mt); log(`unknown ws message type mt=${u.mt}: ${JSON.stringify(u).slice(0, 160)}`); }
  }
}

const push = createPushClient({
  url: WS_URL,
  topics: [`v2018.${OFFERING}.ev.json`, `v2018.${OFFERING}.en.ev.json`],
  log,
  staleMs: Number(process.env.SB_WS_STALE_MS || 120000),
  onUpdates: (arr) => {
    cnt.ws += arr.length;
    lastPushData = Date.now();
    const t = Number(arr[0] && arr[0].t);
    if (t) { const d = Date.now() - t; skewMs = skewMs === null ? d : skewMs * 0.98 + d * 0.02; }
    for (const u of arr) handleUpdate(u);
  },
});

function probe() {
  const now = Date.now();
  let live = 0;
  for (const [id, t] of tracked) if (t.startMs <= now && now - t.startMs < (/2x6/.test(t.term || '') ? 14 : /2x5/.test(t.term || '') ? 12 : 8) * 60000 && lastState.get(id) === 'STARTED') live++;
  return { wsUp: push.up, wsDataAgeMs: now - lastPushData, wsAgeMs: push.ageMs, dataRows: cnt.odds + cnt.scores, lastPollOk: pollState.lastOk, pollErr: cnt.pollErr, rows: cnt.rows, queue: queue.length, live, tracked: tracked.size, skewMs: skewMs ?? 0, flushFails, apiEmptyCycles: pollState.emptyCycles };
}
function shutdown() {
  try { if (queue.length) flush(queue.splice(0)); db.close(); } catch { /* best effort */ }
  process.exit(0);
}

recover();
const health = startHealth({ db, probe, log, alert, dataDir: path.dirname(DB_PATH), coldRoot: COLD, actions: { reconnectWs: () => push.reconnectNow(), restart: () => { log('health: restarting process'); shutdown(); } } });
setInterval(() => {
  const p = probe();
  log(`hb tracked=${p.tracked} odds=${cnt.odds} scores=${cnt.scores} wsMsgs=${cnt.ws} wsUp=${p.wsUp} wsConns=${push.reconnects} polls=${cnt.polls} pollErr=${cnt.pollErr} skew=${Math.round(p.skewMs)}ms queue=${p.queue} gaps=${health.openGaps.join('+') || '-'}`);
}, 300000);

async function loop() {
  for (;;) {
    try { await pollOnce(); } catch (e) { cnt.pollErr++; logErr('poll', e.message); }
    await new Promise((r) => setTimeout(r, pollState.delay));
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('message', (m) => { if (m && m.type === 'shutdown') shutdown(); });
process.on('uncaughtException', (e) => { log('uncaught exception', e.stack || e.message); alert('crash', e.message); shutdown(); });
if (process.env.SB_TEST_HANG_AFTER_S) { // test hook: freeze the event loop (SB_TEST_HANG_FOR_S seconds, or forever)
  const forS = Number(process.env.SB_TEST_HANG_FOR_S || 0);
  setTimeout(() => { const end = forS ? Date.now() + forS * 1000 : Infinity; while (Date.now() < end); }, Number(process.env.SB_TEST_HANG_AFTER_S) * 1000);
}
log('vigil collector start', DB_PATH, 'terms', TERMS.join(','));
push.start();
loop();
