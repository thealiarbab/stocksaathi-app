// =============================================================================
// LEARNING — what the report card's "Learning and activity" pillar reads.
//
// logLearn(): one row in public.learn_events each time a signed-in user opens
// an explainer (a finance term, the "What is ...?" sheet of an after-trade
// note). Nothing recorded this per account before.
//
// loadActivity(): the user's last 12 weeks from report_card_activity() as
// { weeks: [[weekStart, activeDays, replays, questions, reads]] }: one small
// call, kept in the browser for a few minutes so the page opens fast.
//
// Like track.js, nothing here may throw into a click handler.
// =============================================================================

import { sb } from "../db/supabase.js";
import { currentUser } from "../auth/accounts.js";

const KEY = "ss.rcActivity.v1";
const FRESH_MS = 10 * 60_000;
const PAINT_MS = 24 * 3_600_000;
const _recent = new Map();          // `${kind}:${subject}` -> ts

function saved(maxAgeMs) {
  try {
    const uid = currentUser()?.id || null;
    const o = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!uid || !o || o.uid !== uid || !Array.isArray(o.weeks)) return null;
    return Date.now() - (o.at || 0) < maxAgeMs ? { weeks: o.weeks } : null;
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

/** Fresh activity, or the last copy if the call fails, or null. */
export async function loadActivity() {
  const fresh = saved(FRESH_MS);
  if (fresh) return fresh;
  try {
    const uid = currentUser()?.id || null;
    const client = await sb();
    if (!uid || !client) return saved(PAINT_MS);
    const { data, error } = await client.rpc("report_card_activity");
    if (error || !Array.isArray(data)) return saved(PAINT_MS);
    try { localStorage.setItem(KEY, JSON.stringify({ uid, at: Date.now(), weeks: data })); } catch {}
    return { weeks: data };
  } catch {
    return saved(PAINT_MS);
  }
}
