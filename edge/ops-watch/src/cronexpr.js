// Just enough cron (minute hour day-of-month month day-of-week, UTC, the way
// pg_cron reads it) to answer one question: when should this job last have run?

function field(expr, lo, hi) {
  const set = new Set();
  for (const part of String(expr).split(",")) {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) return null;
    let a, b;
    if (range === "*") { a = lo; b = hi; }
    else if (/^\d+-\d+$/.test(range)) { [a, b] = range.split("-").map(Number); }
    else if (/^\d+$/.test(range)) { a = Number(range); b = stepRaw === undefined ? a : hi; }
    else return null;
    if (a < lo || b > hi || a > b) return null;
    for (let v = a; v <= b; v += step) set.add(v);
  }
  return set.size ? set : null;
}

export function parseCron(expr) {
  const f = String(expr || "").trim().split(/\s+/);
  if (f.length !== 5) return null;
  const min = field(f[0], 0, 59), hour = field(f[1], 0, 23), dom = field(f[2], 1, 31), mon = field(f[3], 1, 12);
  const dow = field(f[4], 0, 7);
  if (!min || !hour || !dom || !mon || !dow) return null;
  if (dow.has(7)) { dow.add(0); dow.delete(7); }
  return { min, hour, dom, mon, dow, domAny: f[2] === "*", dowAny: f[4] === "*", everyMinute: min.size >= 30 };
}

export function cronMatches(c, ms) {
  const d = new Date(ms);
  if (!c.min.has(d.getUTCMinutes()) || !c.hour.has(d.getUTCHours()) || !c.mon.has(d.getUTCMonth() + 1)) return false;
  const domOk = c.dom.has(d.getUTCDate()), dowOk = c.dow.has(d.getUTCDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dowOk;
  if (c.dowAny) return domOk;
  return domOk || dowOk;
}

// Latest scheduled minute at or before `beforeMs`, looking back `maxBackMin`.
export function prevRun(c, beforeMs, maxBackMin = 1560) {
  let t = Math.floor(beforeMs / 60000) * 60000;
  for (let i = 0; i <= maxBackMin; i++, t -= 60000) if (cronMatches(c, t)) return t;
  return null;
}
