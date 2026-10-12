'use strict';
// the sportsbook maintenance: finalize results (1 min), verified backup + rotation (hourly), quality/cleanse (hourly),
// verified archive of old finished events to cold storage + prune (daily), checkpoint/optimize (daily). Run with Node 22.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFile } = require('node:child_process');
const { openDb } = require('./schema');
const { makeAlert } = require('./alerts');

const DB_PATH = path.resolve(process.env.SB_DB || path.join(__dirname, '..', 'data', 'odds.sqlite'));
const COLD = path.resolve(process.env.SB_COLD_ROOT || path.join(path.resolve(__dirname, '..'), 'cold'));
const BACKUP_DIR = path.join(COLD, 'backups');
const ARCHIVE_DIR = path.join(COLD, 'archive');
const STATE_FILE = path.join(COLD, 'maintenance-state.json');
const BACKUP_SCRIPT = path.join(__dirname, '..', 'src', 'ops', 'backup.js');
const BACKUP_EVERY = Number(process.env.SB_BACKUP_INTERVAL_MIN || 60) * 60000;
const ARCHIVE_EVERY = Number(process.env.SB_ARCHIVE_INTERVAL_H || 24) * 3600000;
const RETENTION_MS = Number(process.env.SB_RETENTION_DAYS || 30) * 86400000;
const DELETE_AFTER_ARCHIVE = process.env.SB_DELETE !== '0';
const FINALIZE_AFTER = 20 * 60000;
const TABLES = ['outcomes', 'odds', 'scores', 'clock', 'ev_state', 'stats', 'bo_status'];
const log = (...a) => console.log(new Date().toISOString(), '[maint]', ...a);
const alert = makeAlert(process.env.SB_ALERT_FILE || path.join(__dirname, '..', 'logs', 'vigil-alerts.log'), log);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ph = (n) => new Array(n).fill('?').join(',');

const db = openDb(DB_PATH);
let state = {};
function loadState() { try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { state = {}; } }
function saveState() { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1)); } catch (e) { log('state write failed', e.message); } }
function coldReady() {
  try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); fs.mkdirSync(ARCHIVE_DIR, { recursive: true }); return true; }
  catch (e) { log('cold storage unavailable:', e.message); return false; }
}

const finalizeStmt = db.prepare(`UPDATE events SET
  final_home=(SELECT home FROM scores s WHERE s.event_id=events.id ORDER BY ts DESC LIMIT 1),
  final_away=(SELECT away FROM scores s WHERE s.event_id=events.id ORDER BY ts DESC LIMIT 1),
  result_status=CASE WHEN NOT EXISTS(SELECT 1 FROM scores s WHERE s.event_id=events.id) THEN 'no_score'
    WHEN COALESCE((SELECT MAX(minute*60+second) FROM clock k WHERE k.event_id=events.id),0) < CASE WHEN events.term LIKE '%2x6%' THEN 670 WHEN events.term LIKE '%2x5%' THEN 560 ELSE 450 END THEN 'abandoned' ELSE 'ok' END,
  finished_ms=? WHERE finished_ms IS NULL AND start_ms<?`);
function finalize(now) {
  const r = finalizeStmt.run(now, now - FINALIZE_AFTER);
  if (r.changes) log(`finalized ${r.changes} events`);
}

function quality(now) {
  const q = db.prepare(`SELECT COUNT(*) n, SUM(result_status='ok') ok, SUM(finished_ms IS NOT NULL) fin FROM events WHERE start_ms>?`).get(now - 86400000);
  const ft = db.prepare(`SELECT COUNT(DISTINCT o.event_id) n FROM odds o JOIN outcomes c ON c.id=o.outcome_id JOIN events e ON e.id=o.event_id
    WHERE e.start_ms>? AND e.finished_ms IS NOT NULL AND c.market='Full Time' AND o.ts<=e.start_ms`).get(now - 86400000);
  const sz = (f) => { try { return fs.statSync(f).size / 2 ** 30; } catch { return 0; } };
  const gp = db.prepare('SELECT kind, COUNT(*) n, SUM(MIN(COALESCE(end_ms, ?), ?) - MAX(start_ms, ?)) ms FROM capture_gaps WHERE COALESCE(end_ms, ?) > ? GROUP BY kind').all(now, now, now - 86400000, now, now - 86400000);
  const gtxt = gp.map((g) => `${g.kind}=${g.n}x/${Math.round(g.ms / 60000)}min`).join(' ') || 'none';
  if (sz(DB_PATH + '-wal') > 0.25) alert('wal-large', `WAL is ${(sz(DB_PATH + '-wal') * 1024).toFixed(0)} MB (checkpoint starved?)`);
  log(`quality 24h events=${q.n} finished=${q.fin || 0} score_ok=${q.fin ? Math.round(100 * q.ok / q.fin) : 0}% with_prematch_FT=${q.fin ? Math.round(100 * ft.n / q.fin) : 0}% db=${sz(DB_PATH).toFixed(2)}GB wal=${sz(DB_PATH + '-wal').toFixed(2)}GB gaps24h: ${gtxt}`);
}
// Orphans (rows whose event is missing) are detected read-only first, then deleted in small batches so the collector never waits on us.
async function cleanseOrphans(now) {
  const cut = now - 2 * 86400000;
  const find = db.prepare('SELECT rowid FROM odds WHERE ts<? AND NOT EXISTS (SELECT 1 FROM events e WHERE e.id=odds.event_id) LIMIT 5000');
  let total = 0;
  for (let i = 0; i < 20; i++) {
    const ids = find.all(cut).map((r) => r.rowid);
    if (!ids.length) break;
    db.prepare(`DELETE FROM odds WHERE rowid IN (${ph(ids.length)})`).run(...ids);
    total += ids.length;
    await sleep(100);
  }
  if (total) log(`removed ${total} orphan odds rows`);
}

function runBackup(dest) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [BACKUP_SCRIPT, DB_PATH, dest], { timeout: 30 * 60000, windowsHide: true }, (err, out, errOut) => {
      if (err) reject(new Error((errOut || err.message).toString().slice(0, 300)));
      else resolve(out);
    });
  });
}
function rotateBackups(now) {
  const files = fs.readdirSync(BACKUP_DIR);
  for (const f of files) {
    const full = path.join(BACKUP_DIR, f);
    if (/\.tmp-|-journal$|-wal$|-shm$/.test(f) && now - fs.statSync(full).mtimeMs > 2 * 3600000) { fs.rmSync(full, { force: true }); log('removed stale temp', f); }
  }
  const bk = fs.readdirSync(BACKUP_DIR).filter((f) => /^vigil-\d{8}-\d{6}\.sqlite$/.test(f)).sort().reverse();
  const keptDays = new Set();
  for (const f of bk) {
    const age = now - fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs;
    const day = f.slice(10, 18);
    let keep = age < 24 * 3600000;
    if (!keep && age < 14 * 86400000 && !keptDays.has(day)) keep = true;
    if (keep) keptDays.add(day);
    else { fs.rmSync(path.join(BACKUP_DIR, f), { force: true }); log('rotated backup', f); }
  }
}
async function doBackup(now) {
  if (!coldReady()) return false;
  const st = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
  const dest = path.join(BACKUP_DIR, `vigil-${st}.sqlite`);
  const t = Date.now();
  await runBackup(dest);
  log(`backup ok ${path.basename(dest)} ${(fs.statSync(dest).size / 2 ** 30).toFixed(2)}GB in ${Math.round((Date.now() - t) / 1000)}s`);
  rotateBackups(now);
  return true;
}

function summarize(ids, now) {
  const ev = db.prepare('SELECT * FROM events WHERE id=?');
  const q = (cmp) => db.prepare(`SELECT c.label l, o.odds v FROM odds o JOIN outcomes c ON c.id=o.outcome_id
    WHERE o.event_id=? AND c.market='Full Time' AND o.odds>1000 AND ${cmp} ORDER BY o.ts`);
  const pre = q('o.ts<=?'), live = q('o.ts>? AND o.ts<=?');
  const cnt = db.prepare('SELECT COUNT(*) n FROM odds WHERE event_id=?');
  const ins = db.prepare('INSERT OR REPLACE INTO event_summary VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  db.transaction(() => {
    for (const id of ids) {
      const e = ev.get(id);
      const p = {}; for (const r of pre.all(id, e.start_ms)) p[r.l] = r.v;
      const lv = {}; for (const r of live.all(id, e.start_ms, e.start_ms + 120000)) if (!(r.l in lv)) lv[r.l] = r.v;
      ins.run(id, e.term, e.home, e.away, e.start_ms, e.final_home, e.final_away, e.result_status,
        p['1'] ?? null, p.X ?? null, p['2'] ?? null, lv['1'] ?? null, lv.X ?? null, lv['2'] ?? null, cnt.get(id).n, now);
    }
  })();
}
async function verifyArchive(file, expectedSha, expectedRows) {
  const h = crypto.createHash('sha256');
  let rows = 0, rest = '';
  for await (const chunk of fs.createReadStream(file).pipe(zlib.createGunzip())) {
    rest += chunk.toString('utf8');
    const lines = rest.split('\n');
    rest = lines.pop();
    for (const ln of lines) if (ln) { h.update(ln + '\n'); rows++; }
  }
  if (rest) { h.update(rest + '\n'); rows++; }
  if (rows !== expectedRows || h.digest('hex') !== expectedSha) throw new Error('archive verification failed');
}
async function doArchive(now) {
  if (!coldReady()) return;
  const ids = db.prepare('SELECT id FROM events WHERE finished_ms IS NOT NULL AND archived_ms IS NULL AND start_ms<? ORDER BY start_ms LIMIT 5000').all(now - RETENTION_MS).map((r) => r.id);
  if (!ids.length) { log('archive: nothing older than retention'); return; }
  summarize(ids, now);
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const file = path.join(ARCHIVE_DIR, `vigil-${stamp}.ndjson.gz`);
  const gz = zlib.createGzip({ level: 6 });
  const out = fs.createWriteStream(file, { flags: 'wx' });
  gz.pipe(out);
  const hash = crypto.createHash('sha256');
  let rows = 0;
  const write = (t, r) => new Promise((res) => { const ln = JSON.stringify({ t, r }) + '\n'; hash.update(ln); rows++; if (gz.write(ln)) res(); else gz.once('drain', res); });
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    for (const r of db.prepare(`SELECT * FROM events WHERE id IN (${ph(chunk.length)})`).iterate(...chunk)) await write('events', r);
    for (const t of TABLES) for (const r of db.prepare(`SELECT * FROM ${t} WHERE event_id IN (${ph(chunk.length)})`).iterate(...chunk)) await write(t, r);
  }
  gz.end();
  await new Promise((res, rej) => { out.once('close', res); out.once('error', rej); });
  const sha = hash.digest('hex');
  await verifyArchive(file, sha, rows);
  const range = db.prepare(`SELECT MIN(start_ms) a, MAX(start_ms) b FROM events WHERE id IN (${ph(Math.min(ids.length, 900))})`).get(...ids.slice(0, 900));
  fs.writeFileSync(`${file}.manifest.json`, JSON.stringify({ file, sha256: sha, events: ids.length, rows, created: new Date(now).toISOString() }, null, 1));
  db.prepare('INSERT INTO archive_log(created_ms,path,sha256,events,rows,start_from,start_to,deleted) VALUES(?,?,?,?,?,?,?,?)').run(now, file, sha, ids.length, rows, range.a, range.b, DELETE_AFTER_ARCHIVE ? 1 : 0);
  log(`archive ok ${path.basename(file)} events=${ids.length} rows=${rows} ${(fs.statSync(file).size / 2 ** 20).toFixed(1)}MB verified`);
  const mark = db.prepare('UPDATE events SET archived_ms=? WHERE id=?');
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    db.transaction(() => {
      if (DELETE_AFTER_ARCHIVE) for (const t of TABLES) db.prepare(`DELETE FROM ${t} WHERE event_id IN (${ph(chunk.length)})`).run(...chunk);
      for (const id of chunk) mark.run(now, id);
    })();
    await sleep(100);
  }
  if (DELETE_AFTER_ARCHIVE) for (let i = 0; i < 20; i++) { db.pragma('incremental_vacuum(20000)'); await sleep(50); }
  log(`pruned hot data for ${ids.length} events (delete=${DELETE_AFTER_ARCHIVE})`);
}
function optimize() { db.pragma('wal_checkpoint(TRUNCATE)'); db.exec('PRAGMA optimize'); log('checkpoint + optimize done'); }

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  const now = Date.now();
  try {
    finalize(now);
    if (state.lastBackup && now - state.lastBackup > 3 * BACKUP_EVERY) alert('backup-stale', `last successful backup ${Math.round((now - state.lastBackup) / 60000)} min ago`);
    if (now - (state.lastBackup || 0) >= BACKUP_EVERY) {
      try { if (await doBackup(now)) state.lastBackup = now; } catch (e) { log('BACKUP FAILED', e.message); alert('backup-failed', e.message); }
      try { quality(now); await cleanseOrphans(now); } catch (e) { log('cleanse failed', e.message); }
      saveState();
    }
    if (now - (state.lastArchive || 0) >= ARCHIVE_EVERY) {
      try { await doArchive(now); optimize(); state.lastArchive = now; } catch (e) { log('ARCHIVE FAILED', e.message); alert('archive-failed', e.message); }
      saveState();
    }
  } catch (e) { log('tick error', e.message); }
  busy = false;
}
function shutdown() { try { db.close(); } catch { /* best effort */ } process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('message', (m) => { if (m && m.type === 'shutdown') shutdown(); });
coldReady();
loadState();
log(`maintenance start db=${DB_PATH} cold=${COLD} retention=${RETENTION_MS / 86400000}d delete=${DELETE_AFTER_ARCHIVE}`);
setInterval(tick, 60000);
setInterval(() => { if (process.send) process.send({ type: 'hb', proc: 'maintain', ts: Date.now(), busy }); }, 30000);
setTimeout(tick, 5000);
