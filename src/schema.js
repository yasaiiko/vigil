'use strict';
// the sportsbook DB. Units: odds = decimal odds x1000; line = goal/handicap line x1000; every ts / *_ms = epoch milliseconds (UTC).
// Hot tables are partitioned by event_id so a finished event can be archived and pruned as a unit; event_summary is permanent.
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const VERSION = 3;
const DDL = `
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY, term TEXT NOT NULL, group_id INTEGER, home TEXT, away TEXT,
  start_ms INTEGER NOT NULL, state TEXT, first_seen INTEGER, last_seen INTEGER,
  final_home INTEGER, final_away INTEGER, finished_ms INTEGER, result_status TEXT, archived_ms INTEGER);
CREATE INDEX IF NOT EXISTS events_start ON events(start_ms);
CREATE TABLE IF NOT EXISTS outcomes(
  id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL, betoffer_id INTEGER, market TEXT, label TEXT,
  line INTEGER, participant TEXT, type TEXT);
CREATE INDEX IF NOT EXISTS outcomes_ev ON outcomes(event_id);
CREATE TABLE IF NOT EXISTS odds(
  ts INTEGER NOT NULL, event_id INTEGER NOT NULL, outcome_id INTEGER NOT NULL, odds INTEGER, status TEXT, src INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS odds_ev ON odds(event_id, ts);
CREATE TABLE IF NOT EXISTS scores(ts INTEGER NOT NULL, event_id INTEGER NOT NULL, home INTEGER, away INTEGER);
CREATE INDEX IF NOT EXISTS scores_ev ON scores(event_id, ts);
CREATE TABLE IF NOT EXISTS clock(ts INTEGER NOT NULL, event_id INTEGER NOT NULL, period TEXT, minute INTEGER, second INTEGER);
CREATE INDEX IF NOT EXISTS clock_ev ON clock(event_id, ts);
CREATE TABLE IF NOT EXISTS ev_state(ts INTEGER NOT NULL, event_id INTEGER NOT NULL, state TEXT);
CREATE INDEX IF NOT EXISTS ev_state_ev ON ev_state(event_id, ts);
CREATE TABLE IF NOT EXISTS stats(ts INTEGER NOT NULL, event_id INTEGER NOT NULL, json TEXT);
CREATE INDEX IF NOT EXISTS stats_ev ON stats(event_id, ts);
CREATE TABLE IF NOT EXISTS bo_status(ts INTEGER NOT NULL, event_id INTEGER NOT NULL, betoffer_id INTEGER, status TEXT);
CREATE INDEX IF NOT EXISTS bo_status_ev ON bo_status(event_id, ts);
CREATE TABLE IF NOT EXISTS event_summary(
  event_id INTEGER PRIMARY KEY, term TEXT, home TEXT, away TEXT, start_ms INTEGER, final_home INTEGER, final_away INTEGER,
  result_status TEXT, pre_1 INTEGER, pre_x INTEGER, pre_2 INTEGER, live_1 INTEGER, live_x INTEGER, live_2 INTEGER,
  n_odds INTEGER, created_ms INTEGER);
CREATE TABLE IF NOT EXISTS archive_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_ms INTEGER, path TEXT, sha256 TEXT, events INTEGER, rows INTEGER, start_from INTEGER, start_to INTEGER, deleted INTEGER);
CREATE TABLE IF NOT EXISTS health(
  ts INTEGER NOT NULL, ws_up INTEGER, ws_age_s INTEGER, poll_age_s INTEGER, rows INTEGER, queue INTEGER, poll_err INTEGER, skew_ms INTEGER, free_gb REAL, loop_lag_ms INTEGER);
CREATE INDEX IF NOT EXISTS health_ts ON health(ts);
CREATE TABLE IF NOT EXISTS capture_gaps(
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER, note TEXT);
CREATE INDEX IF NOT EXISTS gaps_start ON capture_gaps(start_ms);
`;

function openDb(dbPath, { readonly = false } = {}) {
  const p = path.resolve(dbPath);
  if (readonly) return new Database(p, { readonly: true, fileMustExist: true });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const isNew = !fs.existsSync(p);
  const db = new Database(p);
  if (isNew) db.pragma('auto_vacuum = INCREMENTAL');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 30000');
  if (db.pragma('user_version', { simple: true }) < VERSION) {
    db.exec(DDL);
    db.pragma(`user_version = ${VERSION}`);
  }
  return db;
}

module.exports = { openDb, VERSION };
