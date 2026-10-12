'use strict';
// Capture gaps as intervals. Analysis scripts drop events whose window overlaps any gap (env KEEP_GAPS=1 keeps them).
function loadGaps(db, now = Date.now()) {
  try { return db.prepare('SELECT kind, start_ms s, COALESCE(end_ms, ?) e FROM capture_gaps ORDER BY start_ms').all(now); } catch { return []; }
}
const hits = (gaps, a, b) => gaps.some((g) => g.s < b && g.e > a);

module.exports = { loadGaps, hits };
