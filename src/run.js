'use strict';
// the sportsbook supervisor: single-instance lock, DB init, collector + maintenance as restarting children, rotated log,
// heartbeat watchdog (kills hung children), restart-storm alerts and a status file. Run with Node 22.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { acquireInstanceLock } = require('../src/runtime/instance-lock');
const { makeAlert } = require('./alerts');

const root = path.resolve(__dirname, '..');
const dbPath = path.resolve(process.env.SB_DB || path.join(root, 'data', 'odds.sqlite'));
const logDir = process.env.SB_LOG_DIR || path.join(root, 'logs');
const logPath = path.join(logDir, 'vigil.log');
const statusPath = path.join(logDir, 'vigil-status.json');
const alertPath = process.env.SB_ALERT_FILE || path.join(logDir, 'vigil-alerts.log');
const MAX_LOG = 20 * 2 ** 20, KEEP = 5;
const HB_LIMIT = { collector: Number(process.env.SB_HB_TIMEOUT_MS || 90000), maintain: Number(process.env.SB_HB_MAINT_TIMEOUT_MS || 600000) };
fs.mkdirSync(path.dirname(logPath), { recursive: true });

function rotate() {
  try {
    if (fs.statSync(logPath).size < MAX_LOG) return;
    for (let i = KEEP - 1; i >= 1; i--) if (fs.existsSync(`${logPath}.${i}`)) fs.renameSync(`${logPath}.${i}`, `${logPath}.${i + 1}`);
    fs.renameSync(logPath, `${logPath}.1`);
    fs.rmSync(`${logPath}.${KEEP + 1}`, { force: true });
  } catch { /* log does not exist yet */ }
}
function writeLog(line) {
  const text = `${line}\n`;
  process.stdout.write(text);
  rotate();
  try { fs.appendFileSync(logPath, text); } catch { /* keep running even if the log is locked */ }
}
const alert = makeAlert(alertPath, (m) => writeLog(`[runtime] ${m}`));

const releaseLock = acquireInstanceLock(`${dbPath}.runtime.lock`);
const init = spawnSync(process.execPath, [path.join(__dirname, 'collector.js'), '--init-only'], { env: process.env, encoding: 'utf8' });
if (init.status !== 0) { writeLog(`[runtime] db init failed: ${(init.stderr || init.stdout || '').slice(0, 300)}`); releaseLock(); process.exit(1); }
writeLog(`[runtime] db ready ${dbPath}`);

const children = new Map();
const startedAt = new Map();
const lastHb = new Map();
const hbData = new Map();
const restartLog = new Map();
const bootAt = Date.now();
let stopping = false;

function start(name, script) {
  startedAt.set(name, Date.now());
  const child = spawn(process.execPath, [path.join(__dirname, script)], { env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  children.set(name, child);
  child.stdout.on('data', (c) => writeLog(`[${name}] ${c.toString().trimEnd()}`));
  child.stderr.on('data', (c) => writeLog(`[${name}:stderr] ${c.toString().trimEnd()}`));
  child.on('message', (m) => { if (m && m.type === 'hb') { lastHb.set(name, Date.now()); hbData.set(name, m); } });
  child.on('exit', (code, signal) => {
    if (stopping || children.get(name) !== child) return;
    const now = Date.now();
    const fast = now - startedAt.get(name) < 30000;
    const recent = (restartLog.get(name) || []).filter((t) => now - t < 30 * 60000);
    recent.push(now);
    restartLog.set(name, recent);
    if (recent.length >= 5) alert(`restart-storm-${name}`, `${name} restarted ${recent.length} times in 30 min (last exit code=${code} signal=${signal})`);
    const delay = fast ? 30000 : 5000;
    writeLog(`[runtime] ${name} exited code=${code} signal=${signal}; restarting in ${delay / 1000}s`);
    setTimeout(() => { if (!stopping) start(name, script); }, delay);
  });
}
start('collector', 'collector.js');
start('maintain', 'maintain.js');

// Watchdog: a child that stops sending heartbeats (frozen event loop, deadlock) is killed; the exit handler restarts it.
setInterval(() => {
  if (stopping) return;
  const now = Date.now();
  for (const [name, c] of children) {
    if (c.exitCode !== null) continue;
    const since = now - Math.max(lastHb.get(name) || 0, startedAt.get(name));
    if (since > HB_LIMIT[name]) {
      alert(`hung-${name}`, `no heartbeat for ${Math.round(since / 1000)}s; killing for restart`);
      c.kill();
    }
  }
}, Number(process.env.SB_WATCHDOG_MS || 15000));

function writeStatus() {
  const now = Date.now();
  const status = {
    ts: new Date(now).toISOString(), uptime_min: Math.round((now - bootAt) / 60000),
    children: Object.fromEntries([...children].map(([n, c]) => [n, { up: c.exitCode === null, last_hb_s: lastHb.has(n) ? Math.round((now - lastHb.get(n)) / 1000) : null, restarts_30m: (restartLog.get(n) || []).filter((t) => now - t < 30 * 60000).length, hb: hbData.get(n) || null }])),
  };
  try { fs.writeFileSync(`${statusPath}.tmp`, JSON.stringify(status, null, 1)); fs.renameSync(`${statusPath}.tmp`, statusPath); } catch { /* status is best effort */ }
}
setInterval(writeStatus, 30000);

setInterval(() => {
  const size = (() => { try { return (fs.statSync(dbPath).size / 2 ** 30).toFixed(2); } catch { return '?'; } })();
  const c = hbData.get('collector');
  writeLog(`[runtime] heartbeat ${[...children].map(([n, ch]) => `${n}:${ch.exitCode === null ? 'up' : 'down'}`).join(',')} db=${size}GB${c ? ` ws=${c.wsUp ? 'up' : 'DOWN'} live=${c.live} gaps=${(c.gaps || []).join('+') || '-'}` : ''}`);
}, 300000);

function shutdown() {
  if (stopping) return;
  stopping = true;
  writeLog('[runtime] shutdown requested');
  for (const c of children.values()) { if (c.exitCode === null) { try { c.send({ type: 'shutdown' }); } catch { c.kill(); } } }
  setTimeout(() => { for (const c of children.values()) if (c.exitCode === null) c.kill(); releaseLock(); process.exit(0); }, 10000).unref();
  const poll = setInterval(() => { if ([...children.values()].every((c) => c.exitCode !== null)) { clearInterval(poll); releaseLock(); process.exit(0); } }, 250);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', releaseLock);
