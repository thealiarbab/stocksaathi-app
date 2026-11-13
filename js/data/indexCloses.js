// =============================================================================
// INDEX CLOSES — real Nifty 50 daily closes, for the report card's
// "against the Nifty 50" pillar.
//
// /api/history cannot serve an index: its handler appends ".NS" to the
// symbol. /api/ai?op=history takes the Yahoo ticker as given (^NSEI), is what
// the crash replays are built from, and saves each answer on the server per
// (symbol, from, to). So `from` is snapped to the first of a month and `to`
// is today: every user who started in the same month shares one saved answer
// a day.
//
// Finished sessions only: today's bar is dropped (the server may have saved
// it mid-session), so the benchmark never moves on an intraday price.
// Rows are [["YYYY-MM-DD", close]], oldest first.
// =============================================================================

const KEY = "ss.nifty50.v1";
const IST = 5.5 * 3_600_000;
const DAY = 86_400_000;
const MAX_BACK_DAYS = 700;          // the endpoint refuses ranges over 2 years
const STALE_OK_DAYS = 7;            // a failed refresh may reuse closes this old

const istDate = (ms) => new Date(ms + IST).toISOString().slice(0, 10);

function fromFor(sinceTs) {
  const now = Date.now();
  const start = Math.max(Number.isFinite(sinceTs) ? sinceTs - 10 * DAY : now - 60 * DAY, now - MAX_BACK_DAYS * DAY);
  return istDate(start).slice(0, 8) + "01";
}

function read() {
  try {
    const o = JSON.parse(localStorage.getItem(KEY) || "null");
    return o && Array.isArray(o.rows) && o.rows.length >= 2 && typeof o.from === "string" && typeof o.day === "string" ? o : null;
  } catch { return null; }
}

/** Closes already in this browser that cover `sinceTs`, or null. No network. */
export function cachedNiftyCloses(sinceTs) {
  const o = read();
  if (!o || o.from > fromFor(sinceTs)) return null;
  const ageDays = (Date.parse(istDate(Date.now())) - Date.parse(o.day)) / DAY;
  return ageDays <= STALE_OK_DAYS ? o.rows : null;
}

/** Real Nifty 50 closes from before `sinceTs` to the last finished session, or null. */
export async function niftyCloses(sinceTs) {
  const today = istDate(Date.now());
  const from = fromFor(sinceTs);
  const saved = read();
  if (saved && saved.day === today && saved.from <= from) return saved.rows;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const res = await fetch(`/api/ai?op=history&symbol=${encodeURIComponent("^NSEI")}&from=${from}&to=${today}`, { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error("http_" + res.status);
    const data = await res.json();
    const rows = (data?.points || [])
      .filter((p) => p && typeof p.d === "string" && p.d < today && Number(p.c) > 0)
      .map((p) => [p.d, Number(p.c)]);
    if (rows.length < 2) throw new Error("no_points");
    try { localStorage.setItem(KEY, JSON.stringify({ from, day: today, rows })); } catch {}
    return rows;
  } catch {
    return cachedNiftyCloses(sinceTs);
  }
}
