'use strict';
// Alert sink: one [ALERT] line in the process log and in a dedicated alerts file, rate-limited per key.
const fs = require('node:fs');
const path = require('node:path');

function makeAlert(file, log, cooldownMs = 600000) {
  const last = new Map();
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* alerts still go to the log */ }
  return (key, msg) => {
    const now = Date.now();
    if (now - (last.get(key) || 0) < cooldownMs) return;
    last.set(key, now);
    log(`[ALERT] ${key}: ${msg}`);
    try { fs.appendFileSync(file, `${new Date(now).toISOString()} [ALERT] ${key}: ${msg}\n`); } catch { /* alerts file locked */ }
  };
}

module.exports = { makeAlert };
