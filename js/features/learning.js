// =============================================================================
// LEARNING + SIGNALS — what the report card reads beyond the trades.
//
// logLearn(): one row in public.learn_events each time a signed-in user opens
// an explainer (a finance term, the "What is ...?" sheet of an after-trade
// note). Nothing recorded this per account before 13 Nov.
//
// loadActivity(): one call to report_card_signals() for the signed-in user:
//   weeks     [[weekStart, activeDays, replays, questions, reads]]  (Learning)
//   research  [[ts, symbol, viewDays, chart, watchlist, asked]]     (Research)
//   curve     [["YYYY-MM-DD", totalValuePaise]]                     (Results)
// kept in the browser for a few minutes so the page opens fast. Falls back to
// report_card_activity() (weeks only) if the newer call fails.
//
// Like track.js, nothing here may throw into a click handler.
// =============================================================================

import { sb } from "../db/supabase.js";
import { currentUser } from "../auth/accounts.js";

const KEY = "ss.rcSignals.v1";
const FRESH_MS = 10 * 60_000;
const PAINT_MS = 24 * 3_600_000;
const _recent = new Map();          // `${kind}:${subject}` -> ts

function saved(maxAgeMs) {
  try {
    const uid = currentUser()?.id || null;
    const o = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!uid || !o || o.uid !== uid || !Array.isArray(o.weeks)) return null;
    if (!(Date.now() - (o.at || 0) < maxAgeMs)) return null;
    return { weeks: o.weeks, research: Array.isArray(o.research) ? o.research : null, curve: Array.isArray(o.curve) ? o.curve : null };
  } catch { return null; }
}

/** Record that the user opened an explainer. Never awaits, never throws. */
export function logLearn(kind, subject = null) {
  try {
    const uid = currentUser()?.id || null;
    if (!uid || !kind) return;
    const key = `${kind}:${subject ?? ""}`;
    const now = Date.now();
    if (now - (_recent.get(key) || 0) < 60_000) return;      // a double tap is one read
    _recent.set(key, now);
    if (_recent.size > 200) _recent.clear();
    Promise.resolve(sb()).then((client) => {
      if (!client) return;
      return client.from("learn_events").insert({ kind: String(kind).slice(0, 24), subject: subject == null ? null : String(subject).slice(0, 120) });
    }).then(() => { try { localStorage.removeItem(KEY); } catch {} }).catch(() => {});
  } catch { /* never break the tap that opened the explainer */ }
}

/** The last copy in this browser (up to a day old), for the first paint. */
export function cachedActivity() {
  return saved(PAINT_MS);
}

/** Fresh signals, or the last copy if the call fails, or null. */
export async function loadActivity() {
  const fresh = saved(FRESH_MS);
  if (fresh) return fresh;
  try {
    const uid = currentUser()?.id || null;
    const client = await sb();
    if (!uid || !client) return saved(PAINT_MS);
    let out = null;
    const sig = await client.rpc("report_card_signals");
    if (!sig.error && sig.data && Array.isArray(sig.data.w)) {
      out = { weeks: sig.data.w, research: Array.isArray(sig.data.r) ? sig.data.r : null, curve: Array.isArray(sig.data.cv) ? sig.data.cv : null };
    } else {
      const act = await client.rpc("report_card_activity");
      if (!act.error && Array.isArray(act.data)) out = { weeks: act.data, research: null, curve: null };
    }
    if (!out) return saved(PAINT_MS);
    try { localStorage.setItem(KEY, JSON.stringify({ uid, at: Date.now(), ...out })); } catch {}
    return out;
  } catch {
    return saved(PAINT_MS);
  }
}
