'use strict';
// Collector self-checks. Every tick: detect suspend/freeze, push-stream gaps, network gaps and data stalls, record them in capture_gaps,
// escalate (reconnect -> restart), sample health once a minute, check disks, and send a heartbeat to the supervisor over IPC.
const fs = require('node:fs');
const path = require('node:path');

const T = {
  tick: Number(process.env.SB_HEALTH_TICK_MS || 10000),
  wsGap: Number(process.env.SB_WS_GAP_MS || 30000),
  netGap: Number(process.env.SB_NET_GAP_MS || 60000),
  stall: Number(process.env.SB_STALL_MS || 120000),
  stallRestart: Number(process.env.SB_STALL_RESTART_MS || 300000),
  wsRestart: Number(process.env.SB_WS_RESTART_MS || 600000),
  suspend: Number(process.env.SB_SUSPEND_MS || 45000),
};

// Run once at startup: close gaps left open by a crash and record the time the collector was not running.
function recoverGaps(db, now, log) {
  const closed = db.prepare("UPDATE capture_gaps SET end_ms=?, note=COALESCE(note,'') || ' [closed at restart]' WHERE end_ms IS NULL").run(now).changes;
  const last = db.prepare('SELECT MAX(v) v FROM (SELECT MAX(ts) v FROM health UNION ALL SELECT MAX(last_seen) FROM events)').get().v;
  if (last && now - last > 120000) {
    db.prepare("INSERT INTO capture_gaps(kind,start_ms,end_ms,note) VALUES('down',?,?,'collector not running')").run(last, now);
    log(`recovery: collector was down ${Math.round((now - last) / 60000)} min (gap recorded)`);
  }
  if (closed) log(`recovery: closed ${closed} dangling gap(s)`);
}

function startHealth({ db, probe, actions, log, alert, dataDir, coldRoot }) {
  const insGap = db.prepare('INSERT INTO capture_gaps(kind,start_ms,end_ms,note) VALUES(?,?,?,?)');
  const endGap = db.prepare('UPDATE capture_gaps SET end_ms=? WHERE id=?');
  const insHealth = db.prepare('INSERT INTO health(ts,ws_up,ws_age_s,poll_age_s,rows,queue,poll_err,skew_ms,free_gb,loop_lag_ms) VALUES(?,?,?,?,?,?,?,?,?,?)');
  const open = {};
  const setGap = (kind, active, startTs, note, now) => {
    if (active && !open[kind]) {
      open[kind] = { id: insGap.run(kind, startTs, null, note).lastInsertRowid, start: startTs };
      log(`gap open ${kind}: ${note}`);
    } else if (!active && open[kind]) {
      endGap.run(now, open[kind].id);
      log(`gap closed ${kind} after ${Math.round((now - open[kind].start) / 1000)}s`);
      delete open[kind];
    }
  };

  let lastTick = Date.now(), lastRows = -1, lastRowsAt = Date.now(), lastSample = 0, lastDisk = 0, stallActed = false, lagMs = 0, freeGb = null;
  const gb = (p) => { const v = fs.statfsSync(p); return (v.bavail * v.bsize) / 2 ** 30; };

  function tick() {
    const now = Date.now();
    const dt = now - lastTick;
    lastTick = now;
    lagMs = Math.max(0, dt - T.tick);
    const s = probe();
    const netOk = now - s.lastPollOk <= T.netGap;

    if (dt > T.suspend) {
      insGap.run('suspend', now - dt, now, `process frozen or PC suspended for ${Math.round(dt / 1000)}s`);
      alert('suspend', `no ticks for ${Math.round(dt / 1000)}s (PC sleep or frozen process); resyncing`);
      actions.reconnectWs();
      lastRowsAt = now;
    }
    setGap('ws', s.wsDataAgeMs > T.wsGap, now - s.wsDataAgeMs, 'no push data', now);
    setGap('net', !netOk, s.lastPollOk, 'list polls failing (network or API)', now);

    if (s.dataRows !== lastRows || s.live === 0 || !netOk) { lastRows = s.dataRows; lastRowsAt = now; stallActed = false; }
    const stallMs = now - lastRowsAt;
    setGap('stall', stallMs > T.stall, lastRowsAt, `no odds/score changes with ${s.live} live events`, now);
    if (stallMs > T.stall && !stallActed) {
      stallActed = true;
      alert('stall', `no odds/score changes for ${Math.round(stallMs / 1000)}s with ${s.live} live events; forcing ws reconnect`);
      actions.reconnectWs();
    }
    if (stallMs > T.stallRestart) { alert('stall-restart', 'data still stalled after reconnect; restarting collector'); actions.restart(); }
    if (netOk && s.wsDataAgeMs > T.wsRestart) { alert('ws-restart', `no push data for ${Math.round(s.wsDataAgeMs / 1000)}s with network OK; restarting collector`); actions.restart(); }
    if (open.net && now - open.net.start > 600000) alert('net-long', `network/API unreachable for ${Math.round((now - open.net.start) / 60000)} min`);
    if (open.ws && now - open.ws.start > 300000) alert('ws-long', `no push data for ${Math.round((now - open.ws.start) / 60000)} min`);
    if (s.queue > 50000) alert('queue', `${s.queue} rows waiting to be written`);
    if (s.flushFails >= 10) { alert('flush', 'database writes failing repeatedly; restarting collector'); actions.restart(); }
    if (Math.abs(s.skewMs) > 5000) alert('skew', `clock skew vs push server ${Math.round(s.skewMs)} ms`);
    if (s.apiEmptyCycles >= 6) alert('api-empty', 'event list returned 0 events for 6 consecutive cycles (schedule gap, API change or block)');

    if (now - lastDisk >= 300000) {
      lastDisk = now;
      try { freeGb = gb(dataDir); if (freeGb < 10) alert('disk-data', `only ${freeGb.toFixed(1)} GB free on the data drive`); } catch { /* statfs unsupported */ }
      try { const c = gb(path.parse(coldRoot).root); if (c < 50) alert('disk-cold', `only ${c.toFixed(0)} GB free on cold storage`); } catch (e) { alert('cold-missing', `cold storage drive unavailable: ${e.message}`); }
    }
    if (now - lastSample >= 60000) {
      lastSample = now;
      insHealth.run(now, s.wsUp ? 1 : 0, s.wsAgeMs == null ? null : Math.round(s.wsAgeMs / 1000), Math.round((now - s.lastPollOk) / 1000), s.rows, s.queue, s.pollErr, Math.round(s.skewMs), freeGb, Math.round(lagMs));
    }
    if (process.send) process.send({ type: 'hb', proc: 'collector', ts: now, wsUp: s.wsUp, rows: s.rows, queue: s.queue, live: s.live, tracked: s.tracked, gaps: Object.keys(open) });
  }
  const iv = setInterval(() => { try { tick(); } catch (e) { log('health tick error', e.message); } }, T.tick);
  return { stop() { clearInterval(iv); }, get openGaps() { return Object.keys(open); } };
}

module.exports = { startHealth, recoverGaps };
