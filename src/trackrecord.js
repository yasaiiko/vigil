'use strict';
// Append-only, hash-chained record of the bot decisions (written by the bots BEFORE kickoff: ts, event, line, market p, model p, gap, side, odds) for third-party verification.
// Reads data/totals*.jsonl (dry and live rows; account fields such as coupon refs are dropped), appends new rows to trackrecord/chain.jsonl (h = sha256(prev + row)), rewrites trackrecord/MANIFEST.json.
// Usage: node src/trackrecord.js           append new rows   |   node src/trackrecord.js --verify   re-check the whole chain
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..'), dir = path.join(root, 'trackrecord'), CH = path.join(dir, 'chain.jsonl');
const FILES = { cla: 'totals.jsonl', eb: 'totals_eb.jsonl', ebwc: 'totals_ebwc.jsonl' };
const KEEP = ['ts', 'profile', 'event', 'mode', 'decision', 'line', 'pMkt', 'pModel', 'gap', 'mg', 'side', 'odds', 'stake'];
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const read = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
fs.mkdirSync(dir, { recursive: true });
const chain = read(CH).map((l) => JSON.parse(l));
if (process.argv.includes('--verify')) {
  let prev = '', bad = 0;
  chain.forEach((c, i) => { if (c.prev !== prev || c.h !== sha(prev + JSON.stringify(c.row))) { bad++; if (bad < 4) console.log(`broken at row ${i}`); } prev = c.h; });
  console.log(`chain rows ${chain.length} | head ${prev.slice(0, 16)} | ${bad ? `INVALID (${bad} bad links)` : 'valid'}`);
  process.exit(bad ? 1 : 0);
}
const seen = new Set(chain.map((c) => `${c.row.profile}|${c.row.event}|${c.row.ts}`));
const fresh = [];
for (const [p, f] of Object.entries(FILES)) for (const l of read(path.join(root, 'data', f))) {
  let r; try { r = JSON.parse(l); } catch { continue; }
  r.profile = p;
  const row = Object.fromEntries(KEEP.filter((k) => r[k] !== undefined).map((k) => [k, r[k]]));
  if (!seen.has(`${p}|${row.event}|${row.ts}`)) fresh.push(row);
}
fresh.sort((a, b) => a.ts.localeCompare(b.ts));
let prev = chain.length ? chain[chain.length - 1].h : '';
const out = [];
for (const row of fresh) { const h = sha(prev + JSON.stringify(row)); out.push(JSON.stringify({ prev, h, row })); prev = h; }
if (out.length) fs.appendFileSync(CH, out.join('\n') + '\n');
const all = chain.map((c) => c.row).concat(fresh), by = {};
for (const r of all) { const k = `${r.profile}/${r.mode}`; by[k] = (by[k] || 0) + 1; }
fs.writeFileSync(path.join(dir, 'MANIFEST.json'), JSON.stringify({ updated: new Date().toISOString(), rows: all.length, head: prev, first_ts: all.length ? all.reduce((m, r) => (r.ts < m ? r.ts : m), all[0].ts) : null, last_ts: all.length ? all.reduce((m, r) => (r.ts > m ? r.ts : m), all[0].ts) : null, by_profile_mode: by }, null, 1) + '\n');
console.log(`trackrecord: +${out.length} rows, total ${all.length}, head ${prev.slice(0, 16)}`);
