'use strict';
// Self-healing Engine.IO v4 push client (Node 22 global WebSocket). It never waits for onclose: on a connect timeout or silence,
// WebSocket.close() against an unresponsive peer does not emit 'close', so the socket is abandoned and a fresh one is created.
function createPushClient({ url, topics, onUpdates, log = () => {}, staleMs = 120000, connectTimeoutMs = 20000 }) {
  let sock = null, timer = null, backoff = 1000, lastMsg = 0, up = false, reconnects = 0, downSince = Date.now();

  function abandon() {
    const old = sock;
    sock = null;
    if (up) downSince = Date.now();
    up = false;
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      try { old.close(); } catch { /* socket may already be dead */ }
    }
  }
  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; connect(); }, backoff);
    backoff = Math.min(backoff * 2, 30000);
  }
  function connect() {
    if (sock) return;
    let s;
    try { s = new WebSocket(url); } catch (e) { log('ws ctor', e.message); return schedule(); }
    sock = s;
    lastMsg = Date.now();
    reconnects++;
    s.onopen = () => { if (sock !== s) return; up = true; lastMsg = Date.now(); };
    s.onmessage = (ev) => {
      if (sock !== s) return;
      lastMsg = Date.now();
      const d = typeof ev.data === 'string' ? ev.data : '';
      if (d === '2') return s.send('3');
      if (d[0] === '0') return s.send('40');
      if (d.startsWith('40')) { backoff = 1000; for (const t of topics) s.send(`42["subscribe",{"topic":"${t}"}]`); return; }
      if (!d.startsWith('42["message"')) return;
      try { onUpdates(JSON.parse(JSON.parse(d.slice(2))[1])); } catch { /* malformed push message */ }
    };
    s.onclose = () => { if (sock !== s) return; abandon(); schedule(); };
    s.onerror = () => { if (sock !== s) return; abandon(); schedule(); };
  }
  const watchdog = setInterval(() => {
    if (!sock) return;
    const limit = up ? staleMs : connectTimeoutMs;
    if (Date.now() - lastMsg > limit) {
      log(`ws ${up ? 'stale' : 'connect timeout'} (${Math.round((Date.now() - lastMsg) / 1000)}s), reconnecting`);
      abandon();
      schedule();
    }
  }, Math.max(500, Math.floor(Math.min(staleMs, connectTimeoutMs) / 4)));
  watchdog.unref();

  return {
    start: connect,
    stop() { clearInterval(watchdog); if (timer) clearTimeout(timer); abandon(); },
    reconnectNow() { backoff = 1000; if (timer) { clearTimeout(timer); timer = null; } abandon(); connect(); },
    get up() { return up; },
    get ageMs() { return sock && up ? Date.now() - lastMsg : null; },
    get downForMs() { return up ? 0 : Date.now() - downSince; },
    get reconnects() { return reconnects; },
  };
}

module.exports = { createPushClient };
