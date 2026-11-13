// =============================================================================
// BIAS LEDGER — the user's trades with their detector results, ready for the
// report card (13 Nov 2026).
//
// A trade placed by tap since 24 Oct carries what the detectors found in
// transactions.bias_flags (an empty list means "checked, nothing found").
// Two kinds of trade carry nothing:
//   - orders the matcher filled (limit, after-hours): 8,503 of 21,079 trades
//     on 13 Nov. Their bias_flags is only a "limit_order_filled" marker;
//   - anything before 24 Oct (the old detectors, measured wrong on real
//     trades; their panic_sell flags are ignored).
// For those, the detectors that need nothing but the ledger (churning,
// averaging down, overtrading) are run here, with the same functions the app
// uses on a tap. Patterns that need price history (panic sell, chasing,
// selling winners) are left unjudged for them: the report card never guesses.
//
// Imports biasCore.js only, so it runs unchanged in Node.
// =============================================================================

import { detectChurning, detectAnchoring, detectOvertrading } from "./biasCore.js";

/** 24 Oct 2026 00:00 IST: bias_flags hold the rewritten detectors' results from here. */
export const DETECTOR_CUTOFF_MS = Date.UTC(2026, 9, 23, 18, 30);

const flagName = (f) => (typeof f === "string" ? f : f?.bias);
const isAuto = (flags) => (flags || []).some((f) => flagName(f) === "limit_order_filled");
const detectorFlags = (flags) => (flags || []).filter((f) => f && typeof f === "object" && typeof f.bias === "string" && Number.isFinite(Number(f.severity)));

/**
 * @param transactions [{ ts, symbol, side, qty, pricePaise, biasFlags }]
 * @param kindOf       symbol -> "STOCK" | "ETF" | "MF"
 * @returns oldest first: [{ ts, symbol, side, qty, pricePaise, flags, auto }]
 */
export function tradesWithFlags(transactions, kindOf = () => "STOCK") {
  const sorted = (transactions || [])
    .filter((t) => t && t.symbol && Number(t.qty) > 0 && Number.isFinite(t.ts))
    .slice().sort((a, b) => a.ts - b.ts);
  const book = {};          // symbol -> { qty, avg }, same rounding as tradeStats.js
  const history = [];
  const out = [];
  for (const t of sorted) {
    const qty = Number(t.qty), px = Number(t.pricePaise) || 0;
    const auto = isAuto(t.biasFlags);
    const b = book[t.symbol] || (book[t.symbol] = { qty: 0, avg: 0 });
    let flags;
    if (!auto && t.ts >= DETECTOR_CUTOFF_MS) {
      flags = detectorFlags(t.biasFlags);
    } else {
      const ctx = {
        trade: { symbol: t.symbol, side: t.side, qty, pricePaise: px, at: t.ts },
        kind: kindOf(t.symbol),
        bars: null,
        holdingBefore: b.qty > 1e-9 ? { qty: b.qty, avgCostPaise: b.avg } : null,
        history,
      };
      flags = [];
      for (const det of auto ? [detectChurning, detectAnchoring] : [detectChurning, detectAnchoring, detectOvertrading]) {
        let r = null;
        try { r = px > 0 ? det(ctx) : null; } catch { r = null; }
        if (r) flags.push({ bias: r.bias, severity: Math.round(r.severity * 100) / 100, evidence: r.evidence });
      }
    }
    out.push({ ts: t.ts, symbol: t.symbol, side: t.side, qty, pricePaise: px, flags, auto });

    if (t.side === "BUY") {
      const nq = b.qty + qty;
      b.avg = nq > 0 ? Math.round((b.avg * b.qty + px * qty) / nq) : px;
      b.qty = nq;
    } else if (t.side === "SELL") {
      b.qty = Math.max(0, b.qty - Math.min(qty, b.qty));
      if (b.qty <= 1e-9) { b.qty = 0; b.avg = 0; }
    }
    history.push({ symbol: t.symbol, side: t.side, qty, pricePaise: px, ts: t.ts, auto });
  }
  return out;
}
