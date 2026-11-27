// =============================================================================
// REPORT CARD CORE — the score, as pure functions (v2, 13 Nov 2026).
//
// No imports and no app state, like biasCore.js: everything comes in `input`,
// so the same code runs in the browser (pages/reportCard.js feeds it), in Node
// (scripts/test-report-card.mjs) and against exported real users.
//
// What v1 got wrong: it started everyone at 75 and moved a few points on
// counts read from coach messages, which never carry the detector results
// after a reload. Real users all landed on B+ or A. It also still paid +8 for
// "intervention holds", a pause that was removed on 24 Oct.
//
// v2 is three pillars plus one small one:
//   discipline       45  behaviour flags on the user's own trades
//                        (transactions.bias_flags), weighted by pattern,
//                        severity and recency, divided by how much they trade
//   diversification  25  biggest stock, biggest sector, number of real
//                        positions, idle cash (judged gently)
//   learning         20  steady weeks in the app, and replays finished,
//                        questions asked, explainers read. Never trade count.
//   market           10  profit against the same money in the Nifty 50 on the
//                        same days, only after 28 days or 10 trades. Before
//                        that it is not shown or scored.
// A pillar without enough history is "locked" and says what unlocks it; its
// weight is shared among the others. The overall grade needs Discipline.
//
// Every number shown to the user comes back in `facts` as { key, tone, ... }.
// reportCardCopy.js turns those into English or Hinglish sentences.
//
// input = {
//   now:              ms
//   accountCreatedAt: ms | null
//   trades: [{ ts, symbol, side, qty, pricePaise,
//              flags: [{ bias, severity, evidence? }],   detector results only
//              auto }]                                   filled by the matcher
//   stats:   computeTradeStats() output, or null (context only, never scored)
//   portfolio: { cashPaise,                              free + reserved cash
//                positions: [{ symbol, name?, valuePaise, kind, sector }] }
//                kind = "STOCK" | "ETF" | "MF"; value at a REAL price, else cost
//   activity: { weeks: [[weekStart "YYYY-MM-DD", activeDays, replays,
//                        questions, reads]] } | null     null = not loaded
//   profit:  { plPaise }               booked + on paper (returnSummary) | null
//   research: [[ts, symbol, viewDays, chart, watchlist, asked]] | null
//            each BUY of the last 120 days (report_card_signals().r)
//   curve:   [["YYYY-MM-DD", totalValuePaise]] daily account value | null
//   market:  { userPlPaise,            profit: booked + on paper (returnSummary)
//              benchPlPaise, peakInvestedPaise, sinceTs }   from benchmarkPl()
//            | null
// }
// =============================================================================

export const RC_VERSION = 2;

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const IST = 5.5 * 3_600_000;

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const round = (x) => Math.round(x);
const pct = (frac) => Math.round(frac * 100);
/** Straight line from (x0 -> y0) to (x1 -> y1), flat outside. */
const lin = (x, x0, y0, x1, y1) => (x <= x0 ? y0 : x >= x1 ? y1 : y0 + ((x - x0) / (x1 - x0)) * (y1 - y0));

// v3 (13 Nov, owner's request): the card reads what the user DOES on the
// site, not only the trades. Results (own profit, risk-adjusted) and
// Research (did they look into a stock before buying it) joined. Measured on
// real users, a grade with no money in it had no link to profit at all
// (correlation 0.05), and traders up 30% to 170% were getting C and D.
export const WEIGHTS = { discipline: 25, results: 25, research: 15, diversification: 15, learning: 10, market: 10 };

// ---- Discipline ---------------------------------------------------------------
// weight = how many ordinary trades one flag of this pattern is worth. A
// churning flag stands for three quick round trips (six trades), an
// overtrading flag for ten trades in a day, a disposition flag for a habit
// seen over 60 days; a panic sell is one trade but the costliest habit.
// concentration and sector_concentration flags are not counted here: the
// Diversification pillar judges what is held now.
export const PATTERNS = {
  panic_sell:  { group: "panic",       weight: 3.0 },
  fomo:        { group: "chase",       weight: 1.5 },
  pump_chase:  { group: "chase",       weight: 1.5 },
  churning:    { group: "churn",       weight: 3.0 },
  overtrading: { group: "overtrade",   weight: 3.0 },
  anchoring:   { group: "avg_down",    weight: 1.2 },
  disposition: { group: "disposition", weight: 2.0 },
};
export const DISCIPLINE = {
  minTrades: 5,          // fewer than this: nothing to judge yet
  halfLifeDays: 45,      // a flag counts half as much after 45 days
  priorTrades: 6,        // clean trades assumed, so 1 flag in 5 is not a verdict
  // score = 100 * exp(-steepness * rate). At 6, one mild note in 13 trades
  // costs about 29 points; at 9 (tried first) it cost 41, too much for one
  // slip, and the top of the real spread was the same either way.
  steepness: 6,
  factWindowDays: 90,    // "of your last N sells" looks back this far
  // A record a few days old proves little either way. Until it is `fullDays`
  // old the score is pulled towards `neutral`: in its first week it cannot
  // fall below 50 or rise above 80, whatever the trades were. Time, not
  // trade count, so nobody gains by trading more.
  neutral: 72,
  fullDays: 28,
  minConfidence: 0.3,
  // An "averaging down" note on a buy this far below the user's own cost is
  // not counted. The app does not adjust a holding for a split or bonus, so
  // after a 1:2 split every buy looks 50% below cost. On the real trades of
  // 13 Nov, 2 of the 3 averaging-down notes were like this.
  splitGapPct: -40,
  trendBonus: 8,         // points back, at most, for halving notes per trade lately
};

function scoreDiscipline(input) {
  const now = input.now;
  const trades = (input.trades || []).filter((t) => t && t.symbol && num(t.qty) > 0 && Number.isFinite(t.ts));
  const n = trades.length;
  if (n < DISCIPLINE.minTrades) {
    return { state: "locked", unlock: { key: "trades", have: n, need: DISCIPLINE.minTrades }, facts: [] };
  }
  const hl = DISCIPLINE.halfLifeDays * DAY;
  const since = now - DISCIPLINE.factWindowDays * DAY;
  let exposure = 0, penalty = 0, firstTs = Infinity;
  const groups = {};
  const win = { trades: 0, buys: 0, sells: 0 };
  for (const t of trades) {
    const rec = Math.pow(0.5, Math.max(0, now - t.ts) / hl);
    exposure += rec;
    if (t.ts < firstTs) firstTs = t.ts;
    const inWin = t.ts >= since;
    if (inWin) { win.trades++; if (t.side === "BUY") win.buys++; else if (t.side === "SELL") win.sells++; }
    const seen = new Set();          // one flag per pattern group per trade
    for (const f of (Array.isArray(t.flags) ? t.flags : [])) {
      const p = PATTERNS[f?.bias];
      const sev = clamp(num(f?.severity), 0, 1);
      if (!p || sev <= 0 || seen.has(p.group)) continue;
      if (f.bias === "anchoring" && num(f.evidence?.below_cost_pct) <= DISCIPLINE.splitGapPct) continue;
      seen.add(p.group);
      const pen = p.weight * sev * rec;
      penalty += pen;
      const g = groups[p.group] || (groups[p.group] = { key: p.group, count: 0, recent: 0, penalty: 0, lastTs: 0, symbol: null, peak: 0 });
      g.count++;
      g.penalty += pen;
      if (inWin) g.recent++;
      if (t.ts >= g.lastTs) { g.lastTs = t.ts; g.symbol = t.symbol; }
      const ev = f.evidence || {};
      g.peak = Math.max(g.peak, num(ev.trades_today), num(ev.round_trips_30d));
    }
  }
  const rate = penalty / (exposure + DISCIPLINE.priorTrades);
  // Getting better counts: notes per trade in the last 30 days against the
  // time before. Fewer notes now earns up to `trendBonus` points back; more
  // is only said, the notes already cost what they cost.
  const cut = now - 30 * DAY;
  const half = (inRecent) => {
    let n = 0, pen = 0, cnt = 0;
    for (const t of trades) {
      if ((t.ts >= cut) !== inRecent) continue;
      n++;
      const seen = new Set();
      for (const f of (Array.isArray(t.flags) ? t.flags : [])) {
        const p = PATTERNS[f?.bias];
        const sev = clamp(num(f?.severity), 0, 1);
        if (!p || sev <= 0 || seen.has(p.group)) continue;
        if (f.bias === "anchoring" && num(f.evidence?.below_cost_pct) <= DISCIPLINE.splitGapPct) continue;
        seen.add(p.group);
        pen += p.weight * sev;
        cnt++;
      }
    }
    return { n, rate: n ? pen / n : 0, per10: n ? Math.round((cnt / n) * 100) / 10 : 0 };
  };
  const before = half(false), recent = half(true);
  let trend = null, bonus = 0;
  if (before.n >= DISCIPLINE.minTrades && recent.n >= DISCIPLINE.minTrades) {
    if (before.rate > 0) {
      const ratio = recent.rate / before.rate;
      if (ratio <= 0.5) { trend = "improving"; bonus = DISCIPLINE.trendBonus * (1 - ratio); }
      else if (ratio >= 1.5) trend = "slipping";
    } else if (recent.per10 >= 2) {
      trend = "slipping";          // a clean record that started picking up notes
    }
  }
  const raw = Math.min(100, 100 * Math.exp(-DISCIPLINE.steepness * rate) + bonus);
  const spanDays = Math.max(0, (now - firstTs) / DAY);
  const confidence = clamp(spanDays / DISCIPLINE.fullDays, DISCIPLINE.minConfidence, 1);
  const score = DISCIPLINE.neutral + (raw - DISCIPLINE.neutral) * confidence;

  const facts = [];
  const ranked = Object.values(groups).sort((a, b) => b.penalty - a.penalty);
  for (const g of ranked.slice(0, 2)) {
    const of = g.key === "panic" || g.key === "churn" || g.key === "disposition" ? win.sells
      : g.key === "overtrade" ? win.trades : win.buys;
    // An old flag outside the window is still shown, as a count over all trades.
    facts.push(g.recent > 0
      ? { key: g.key, tone: g.penalty / (exposure + DISCIPLINE.priorTrades) > 0.1 ? "bad" : "warn", n: g.recent, of: Math.max(of, g.recent), symbol: g.symbol, peak: g.peak, days: DISCIPLINE.factWindowDays }
      : { key: g.key + "_old", tone: "info", n: g.count, days: round((now - g.lastTs) / DAY) });
  }
  if (!ranked.length) facts.push({ key: "clean", tone: "good", trades: n, days: Math.max(1, round(spanDays)) });
  if (trend) facts.push({ key: trend, tone: trend === "improving" ? "good" : "warn", before: before.per10, now: recent.per10 });
  if (facts.length < 3) {
    if (confidence < 1) facts.push({ key: "young", tone: "info", days: Math.max(1, round(spanDays)), full: DISCIPLINE.fullDays });
    else if (ranked.length < 2) facts.push({ key: "record", tone: "info", trades: n, days: round(spanDays) });
  }

  return {
    state: "scored", score: clamp(round(score), 0, 100), facts,
    detail: {
      trades: n, flags: ranked.reduce((s, g) => s + g.count, 0), rate, raw: round(raw),
      confidence, spanDays: round(spanDays), trend, bonus: Math.round(bonus * 10) / 10,
      groups: ranked.map((g) => ({ key: g.key, count: g.count, recent: g.recent })),
    },
  };
}

// ---- Results ------------------------------------------------------------------
// The user's own profit (booked + on paper) as a share of the most money they
// ever had in stocks and funds at once. Cash kept aside is not counted
// against them: 1 lakh invested that made 10,000 is +10%, whether 9 lakh more
// sat in cash or not. Breaking even is 50; the curve flattens at both ends so
// one huge win or loss cannot run the whole grade. Like Discipline, a record
// younger than 4 weeks is pulled towards the middle: a lucky first week is
// not a result yet.
export const RESULTS = {
  // score = 50 + 50 * tanh(return% / 8): +5% -> 78, +10% -> 92, -5% -> 22.
  // Measured 13 Nov: 15 left profit almost no pull on the grade (rank
  // correlation 0.31), 5 made a 3% week worth 26 points; 8 gave 0.40.
  scalePct: 8,
  fullDays: 28,
  minConfidence: 0.3,
  calmDrawdownPct: 10,   // a fall up to this share of the money invested is ordinary
  drawdownWeight: 0.5,   // each point of fall beyond it takes half a point of return
};

// ---- Research -----------------------------------------------------------------
// Did they look into a stock before putting money in? For every NEW buy (no
// trade in that stock in the 14 days before; topping up or re-buying a stock
// they were just trading is not a fresh decision) the server reports what the
// user did first: opened the stock's page on an earlier day, used its chart,
// had it on the watchlist, asked Saathi about it. One of those is half
// marks, two or more is full marks; none, within minutes of first opening
// the stock, is an impulse buy. Recent buys count more (45-day half-life).
export const RESEARCH = {
  minBuys: 3,
  freshDays: 14,
  halfLifeDays: 45,
};

function scoreResearch(input) {
  if (!Array.isArray(input.research)) return { state: "pending", facts: [] };
  const now = input.now;
  const trades = (input.trades || []).filter((t) => t && t.symbol && Number.isFinite(t.ts));
  const fresh = [];
  for (const row of input.research) {
    if (!Array.isArray(row)) continue;
    const [ts, symbol, viewDays, chart, watch, asked] = row;
    if (!Number.isFinite(Number(ts)) || !symbol) continue;
    const t0 = Number(ts);
    const recentTrade = trades.some((t) => t.symbol === symbol && t.ts < t0 - 60_000 && t.ts >= t0 - RESEARCH.freshDays * DAY);
    if (recentTrade) continue;
    const ways = { views: num(viewDays) > 0, chart: !!chart, watch: !!watch, asked: !!asked };
    const depth = ways.views + ways.chart + ways.watch + ways.asked + (num(viewDays) >= 2 ? 1 : 0);
    fresh.push({ ts: t0, symbol, depth, ways });
  }
  if (fresh.length < RESEARCH.minBuys) {
    return { state: "locked", unlock: { key: "research", have: fresh.length, need: RESEARCH.minBuys }, facts: [] };
  }
  const hl = RESEARCH.halfLifeDays * DAY;
  let w = 0, s = 0;
  const count = { researched: 0, impulse: 0, views: 0, chart: 0, watch: 0, asked: 0 };
  for (const b of fresh) {
    const rec = Math.pow(0.5, Math.max(0, now - b.ts) / hl);
    w += rec;
    s += rec * Math.min(b.depth, 2) / 2;
    if (b.depth > 0) count.researched++; else count.impulse++;
    for (const k of ["views", "chart", "watch", "asked"]) if (b.ways[k]) count[k]++;
  }
  const score = w > 0 ? (100 * s) / w : 0;
  const share = count.researched / fresh.length;
  const facts = [{ key: "researched", tone: share >= 0.6 ? "good" : share >= 0.3 ? "warn" : "bad", n: count.researched, of: fresh.length }];
  if (count.impulse > 0) facts.push({ key: "impulse", tone: count.impulse / fresh.length > 0.5 ? "bad" : "warn", n: count.impulse, of: fresh.length });
  if (count.researched > 0) facts.push({ key: "research_ways", tone: "info", views: count.views, chart: count.chart, watch: count.watch, asked: count.asked });
  return {
    state: "scored", score: clamp(round(score), 0, 100), facts,
    detail: { buys: fresh.length, ...count },
  };
}

/** Most money (at cost) the user had in stocks and funds at once, first in first out. */
export function peakInvested(trades) {
  const list = (trades || []).filter((t) => t && t.symbol && num(t.qty) > 0 && num(t.pricePaise) > 0 && Number.isFinite(t.ts))
    .slice().sort((a, b) => a.ts - b.ts);
  const lots = {};
  let invested = 0, peak = 0;
  for (const t of list) {
    const book = lots[t.symbol] || (lots[t.symbol] = []);
    if (t.side === "BUY") {
      book.push({ qty: num(t.qty), px: num(t.pricePaise) });
      invested += num(t.qty) * num(t.pricePaise);
      if (invested > peak) peak = invested;
    } else if (t.side === "SELL") {
      let left = num(t.qty);
      while (left > 1e-9 && book.length) {
        const lot = book[0];
        const part = Math.min(left, lot.qty);
        invested -= part * lot.px;
        lot.qty -= part;
        left -= part;
        if (lot.qty <= 1e-9) book.shift();
      }
    }
  }
  return Math.round(peak);
}

function scoreResults(input) {
  const trades = (input.trades || []).filter((t) => t && t.symbol && num(t.qty) > 0 && Number.isFinite(t.ts));
  if (!trades.some((t) => t.side === "BUY")) {
    return { state: "locked", unlock: { key: "first_buy" }, facts: [] };
  }
  const pl = input.profit?.plPaise;
  const peak = peakInvested(trades);
  if (!Number.isFinite(pl) || !(peak > 0)) return { state: "pending", facts: [] };
  const r = (pl / peak) * 100;
  // The score reads the smoothed figure when the caller has one (the middle of
  // the last five days, reportCardWeek.js smoothedPl): one sharp day used to
  // flip the letter for a third of students. The sentence still quotes the
  // live profit, the number the portfolio page shows.
  const plScore = Number.isFinite(input.profit?.scorePlPaise) ? input.profit.scorePlPaise : pl;
  const rScore = (plScore / peak) * 100;
  // Risk: the deepest fall of the account's value from an earlier high (daily
  // values, real prices), against the money that was in stocks. Up to 10% is
  // normal market life; past that, half of the extra fall comes off.
  let dropPaise = 0, top = -Infinity;
  for (const [, v] of (input.curve || [])) {
    const x = num(v);
    if (!(x > 0)) continue;
    if (x > top) top = x;
    else if (top - x > dropPaise) dropPaise = top - x;
  }
  const ddPct = (dropPaise / peak) * 100;
  const riskCut = Math.max(0, ddPct - RESULTS.calmDrawdownPct) * RESULTS.drawdownWeight;
  const raw = 50 + 50 * Math.tanh((rScore - riskCut) / RESULTS.scalePct);
  const firstTs = trades.reduce((m, t) => Math.min(m, t.ts), Infinity);
  const spanDays = Math.max(0, (input.now - firstTs) / DAY);
  const confidence = clamp(spanDays / RESULTS.fullDays, RESULTS.minConfidence, 1);
  const score = 50 + (raw - 50) * confidence;
  const r1 = Math.round(r * 10) / 10;
  const facts = [{
    key: pl >= 0 ? "profit" : "loss",
    tone: r >= 2 ? "good" : r > -2 ? "info" : r > -10 ? "warn" : "bad",
    plPaise: Math.round(pl), pct: r1, peakPaise: peak,
  }];
  if (ddPct >= 5) facts.push({ key: "drawdown", tone: ddPct > RESULTS.calmDrawdownPct ? "warn" : "info", dropPaise: Math.round(dropPaise), pct: Math.round(ddPct * 10) / 10 });
  const st = input.stats;
  if (st && num(st.wins) + num(st.losses) + num(st.evens) > 0) {
    facts.push({ key: "closed", tone: "info", wins: num(st.wins), losses: num(st.losses), evens: num(st.evens) });
  }
  if (confidence < 1) facts.push({ key: "results_young", tone: "info", days: Math.max(1, round(spanDays)), full: RESULTS.fullDays });
  return {
    state: "scored", score: clamp(round(score), 0, 100), facts: facts.slice(0, 3),
    detail: { plPaise: Math.round(pl), peakPaise: peak, pct: r1, drawdownPct: Math.round(ddPct * 10) / 10, riskCut: Math.round(riskCut * 10) / 10, raw: round(raw), confidence, spanDays: round(spanDays) },
  };
}

// ---- Diversification ----------------------------------------------------------
export const DIVERSIFICATION = {
  minInvestedShare: 0.2,     // one small position in a pile of cash is not judged
  stock: { fine: 0.15, worst: 0.6, weight: 35 },      // biggest stock / everything
  sector: { fine: 0.4, worst: 0.9, weight: 20 },      // biggest sector / stock money
  positions: { worst: 1, fine: 6, weight: 30 },       // effective number held
  cash: { fine: 0.7, worstScore: 40, weight: 15, graceDays: 30 },
  basketCounts: 5,           // a fund or ETF is a basket: counts as 5 positions
  dustShare: 0.02,           // positions under 2% of the invested money are not "real"
};
const noSector = (s) => !s || /^(unknown|other|etf)$/i.test(String(s));

function scoreDiversification(input) {
  const pf = input.portfolio || {};
  const cash = Math.max(0, num(pf.cashPaise));
  const positions = (pf.positions || []).filter((p) => p && num(p.valuePaise) > 0);
  const invested = positions.reduce((s, p) => s + num(p.valuePaise), 0);
  const total = cash + invested;
  if (!positions.length || total <= 0) {
    return { state: "locked", unlock: { key: "no_holdings" }, facts: [] };
  }
  const investedShare = invested / total;
  if (positions.length < 2 && investedShare < DIVERSIFICATION.minInvestedShare) {
    return { state: "locked", unlock: { key: "small", pct: Math.max(1, pct(investedShare)), need: pct(DIVERSIFICATION.minInvestedShare) }, facts: [] };
  }
  const C = DIVERSIFICATION;
  const isBasket = (p) => p.kind === "MF" || p.kind === "ETF";
  const stocks = positions.filter((p) => !isBasket(p));
  const baskets = positions.filter(isBasket);

  // Biggest single stock against everything, cash included (the risk view).
  const top = stocks.reduce((m, p) => (num(p.valuePaise) > num(m?.valuePaise) ? p : m), null);
  const topShare = top ? num(top.valuePaise) / total : 0;
  const sStock = lin(topShare, C.stock.fine, 100, C.stock.worst, 0);

  // Biggest sector among stocks with a known sector, when there are 2+ of them
  // and stocks are a real part of the portfolio (same gates as the detector).
  const bySector = {};
  let sectorMoney = 0, sectorStocks = 0;
  for (const p of stocks) {
    if (noSector(p.sector)) continue;
    bySector[p.sector] = bySector[p.sector] || { money: 0, n: 0 };
    bySector[p.sector].money += num(p.valuePaise);
    bySector[p.sector].n++;
    sectorMoney += num(p.valuePaise);
    sectorStocks++;
  }
  let topSector = null, sSector = null;
  if (sectorStocks >= 2 && sectorMoney >= 0.2 * total) {
    const [name, v] = Object.entries(bySector).sort((a, b) => b[1].money - a[1].money)[0];
    topSector = { name, share: v.money / sectorMoney, n: v.n };
    sSector = lin(topSector.share, C.sector.fine, 100, C.sector.worst, 0);
  }

  // Effective number of positions (1 / sum of squared shares of the invested
  // money). Five equal stocks = 5; one stock at 90% plus dust = about 1.2.
  let hhi = 0;
  for (const p of positions) {
    const w = num(p.valuePaise) / invested;
    hhi += (w * w) / (isBasket(p) ? C.basketCounts : 1);
  }
  const effective = hhi > 0 ? 1 / hhi : 0;
  const sPositions = lin(effective, C.positions.worst, 0, C.positions.fine, 100);
  const real = positions.filter((p) => num(p.valuePaise) / invested >= C.dustShare).length;

  // Idle cash. Not judged in the first month, and never harshly: sitting in
  // cash while learning is not a mistake.
  const cashShare = cash / total;
  const ageDays = Number.isFinite(input.accountCreatedAt) ? (input.now - input.accountCreatedAt) / DAY : 0;
  const cashJudged = ageDays >= C.cash.graceDays;
  const sCash = cashJudged ? lin(cashShare, C.cash.fine, 100, 1, C.cash.worstScore) : 100;

  let wSum = 0, sSum = 0;
  const add = (s, w) => { if (s != null) { sSum += s * w; wSum += w; } };
  add(stocks.length ? sStock : null, C.stock.weight);
  add(sSector, C.sector.weight);
  add(sPositions, C.positions.weight);
  add(sCash, C.cash.weight);
  const score = wSum > 0 ? sSum / wSum : 0;

  const tone = (s) => (s >= 70 ? "good" : s >= 40 ? "warn" : "bad");
  const facts = [];
  if (top) facts.push({ key: "top_stock", tone: tone(sStock), symbol: top.symbol, name: top.name || top.symbol, pct: pct(topShare) });
  facts.push({ key: "positions", tone: tone(sPositions), n: real, funds: baskets.length });
  if (topSector) facts.push({ key: "top_sector", tone: tone(sSector), sector: topSector.name, pct: pct(topSector.share), n: topSector.n });
  else facts.push({ key: cashJudged && cashShare > C.cash.fine ? "cash_idle" : "cash", tone: cashJudged && cashShare > C.cash.fine ? "warn" : "info", pct: pct(cashShare), days: round(ageDays) });

  return {
    state: "scored", score: clamp(round(score), 0, 100), facts,
    detail: {
      topStockPct: pct(topShare), topSectorPct: topSector ? pct(topSector.share) : null, topSector: topSector?.name || null,
      effective: Math.round(effective * 10) / 10, positions: real, funds: baskets.length, cashPct: pct(cashShare), cashJudged,
      parts: { stock: stocks.length ? round(sStock) : null, sector: sSector == null ? null : round(sSector), positions: round(sPositions), cash: round(sCash) },
    },
  };
}

// ---- Learning and activity ----------------------------------------------------
export const LEARNING = {
  windowWeeks: 8,
  graceDays: 14,        // a new account with under `graceActions` is not judged
  graceActions: 3,
  replayPoints: 3, maxReplays: 2, maxQuestions: 5, maxReads: 5,
  weekCap: 6,           // points counted per week: a binge is not steadiness
  goodWeek: 3,          // one replay, or three questions/explainers
  weights: { showedUp: 40, learnedWeeks: 25, depth: 20, breadth: 15 },
};

/** Monday 00:00 IST of the week `ms` falls in, as "YYYY-MM-DD". */
export function istWeekStart(ms) {
  const d = new Date(ms + IST);
  const dow = (d.getUTCDay() + 6) % 7;            // Monday = 0
  const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
  return mon.toISOString().slice(0, 10);
}

function scoreLearning(input) {
  if (!input.activity || !Array.isArray(input.activity.weeks)) {
    return { state: "pending", facts: [] };
  }
  const L = LEARNING;
  const byWeek = new Map();
  for (const w of input.activity.weeks) {
    if (!Array.isArray(w) || !w[0]) continue;
    byWeek.set(String(w[0]).slice(0, 10), { days: num(w[1]), replays: num(w[2]), questions: num(w[3]), reads: num(w[4]) });
  }
  const now = input.now;
  const ageDays = Number.isFinite(input.accountCreatedAt) ? Math.max(0, (now - input.accountCreatedAt) / DAY) : L.windowWeeks * 7;
  // Weeks judged: the finished weeks since the account began (up to 8), plus
  // this week only if something already happened in it.
  const thisWeek = istWeekStart(now);
  // The user reading their own card is in the app this week, even when the
  // cached activity was fetched before this visit was logged (453 of 3,399
  // users would otherwise read "You opened the app in 0 of the last 4 weeks"
  // while opening it). The admin view leaves activeNow unset.
  if (input.activeNow) {
    const w = byWeek.get(thisWeek) || { days: 0, replays: 0, questions: 0, reads: 0 };
    byWeek.set(thisWeek, { ...w, days: Math.max(1, w.days) });
  }
  const cur = byWeek.get(thisWeek);
  const curActive = !!cur && (cur.days > 0 || cur.replays + cur.questions + cur.reads > 0);
  const finished = clamp(Math.floor(ageDays / 7), 0, L.windowWeeks - (curActive ? 1 : 0));
  const W = Math.max(1, finished + (curActive ? 1 : 0));
  let showed = 0, learned = 0, points = 0, replays = 0, questions = 0, reads = 0;
  for (let i = 0; i < W; i++) {
    const key = istWeekStart(now - (i + (curActive ? 0 : 1)) * WEEK);
    const w = byWeek.get(key);
    if (!w) continue;
    const pts = Math.min(L.weekCap, L.replayPoints * Math.min(w.replays, L.maxReplays) + Math.min(w.questions, L.maxQuestions) + Math.min(w.reads, L.maxReads));
    if (w.days > 0 || pts > 0) showed++;
    if (pts > 0) learned++;
    points += pts;
    replays += w.replays; questions += w.questions; reads += w.reads;
  }
  const actions = replays + questions + reads;
  if (ageDays < L.graceDays && actions < L.graceActions) {
    return { state: "locked", unlock: { key: "learn", have: actions, need: L.graceActions }, facts: [] };
  }
  const kinds = (replays > 0) + (questions > 0) + (reads > 0);
  const parts = {
    showedUp: showed / W,
    learnedWeeks: learned / W,
    depth: clamp(points / (W * L.goodWeek), 0, 1),
    breadth: kinds / 3,
  };
  const wt = L.weights;
  const score = parts.showedUp * wt.showedUp + parts.learnedWeeks * wt.learnedWeeks + parts.depth * wt.depth + parts.breadth * wt.breadth;

  const facts = [{ key: "weeks", tone: parts.showedUp >= 0.75 ? "good" : parts.showedUp >= 0.4 ? "warn" : "bad", active: showed, of: W }];
  facts.push(actions > 0
    ? { key: "actions", tone: parts.depth >= 0.6 ? "good" : "warn", replays, questions, reads, weeks: learned, of: W }
    : { key: "no_actions", tone: "bad", of: W });
  if (actions > 0 && kinds < 3) facts.push({ key: "untried", tone: "info", replays: replays > 0, questions: questions > 0, reads: reads > 0 });

  return {
    state: "scored", score: clamp(round(score), 0, 100), facts,
    detail: { weeks: W, showed, learned, replays, questions, reads, points, parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, pct(v)])) },
  };
}

// ---- Return against the Nifty 50 ----------------------------------------------
// Like for like: the SAME rupees on the SAME days. A plain "your return vs the
// Nifty's" compares a portfolio that is mostly cash with an index that is
// fully invested: measured on 13 Nov, after the Nifty rose 9% in a month, it
// scored 58% of users under 10 out of 100 for holding cash, which the brief
// says is not a mistake. So every rupee the user put into a stock or fund is
// followed in the Nifty for exactly the days it was invested.
export const MARKET = {
  minDays: 28, minTrades: 10,
  pointsPerPct: 3,       // each point ahead of / behind moves the score 3
};

const istDate = (ms) => new Date(ms + IST).toISOString().slice(0, 10);

/**
 * What the user's own money would have made in the Nifty 50: each BUY buys the
 * index at that day's close, each SELL takes the same shares' cost back out
 * (first in, first out), and whatever is still held is valued at the last close.
 *
 * @param trades [{ ts, symbol, side, qty, pricePaise }]
 * @param closes [["YYYY-MM-DD", close]] real Nifty 50 closes, oldest first,
 *               finished sessions only
 * @returns { benchPlPaise, peakInvestedPaise, sinceTs } or null without data
 */
export function benchmarkPl(trades, closes) {
  const series = (closes || []).filter((c) => Array.isArray(c) && c[0] && Number(c[1]) > 0);
  const list = (trades || []).filter((t) => t && t.symbol && num(t.qty) > 0 && num(t.pricePaise) > 0 && Number.isFinite(t.ts))
    .slice().sort((a, b) => a.ts - b.ts);
  if (!series.length || !list.length) return null;
  const last = Number(series[series.length - 1][1]);
  // The close of the trade's own day when that session is in the series,
  // else the latest one before it (a trade today is valued at the last close).
  const level = (ms) => {
    const d = istDate(ms);
    let lo = 0, hi = series.length - 1, at = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (series[mid][0] <= d) { at = mid; lo = mid + 1; } else hi = mid - 1; }
    return Number(series[at < 0 ? 0 : at][1]);
  };
  const lots = {};
  let bench = 0, invested = 0, peak = 0;
  for (const t of list) {
    const q = num(t.qty), px = num(t.pricePaise);
    const book = lots[t.symbol] || (lots[t.symbol] = []);
    if (t.side === "BUY") {
      book.push({ qty: q, px, lvl: level(t.ts) });
      invested += q * px;
      if (invested > peak) peak = invested;
    } else if (t.side === "SELL") {
      let left = q;
      const lvl = level(t.ts);
      while (left > 1e-9 && book.length) {
        const lot = book[0];
        const part = Math.min(left, lot.qty);
        const cost = part * lot.px;
        bench += cost * (lvl / lot.lvl - 1);
        invested -= cost;
        lot.qty -= part;
        left -= part;
        if (lot.qty <= 1e-9) book.shift();
      }
    }
  }
  for (const book of Object.values(lots)) for (const lot of book) bench += lot.qty * lot.px * (last / lot.lvl - 1);
  return { benchPlPaise: Math.round(bench), peakInvestedPaise: Math.round(peak), sinceTs: list[0].ts };
}

function scoreMarket(input) {
  const trades = (input.trades || []).filter((t) => t && Number.isFinite(t.ts));
  if (!trades.length) return { state: "hidden", facts: [] };
  const firstTs = trades.reduce((m, t) => Math.min(m, t.ts), Infinity);
  const spanDays = (input.now - firstTs) / DAY;
  // Before 4 weeks or 10 trades: not shown, not scored (owner's rule).
  if (spanDays < MARKET.minDays && trades.length < MARKET.minTrades) return { state: "hidden", facts: [] };
  const m = input.market;
  if (!m || !Number.isFinite(m.userPlPaise) || !Number.isFinite(m.benchPlPaise) || !(m.peakInvestedPaise > 0)) return { state: "pending", facts: [] };
  // Both profits as a share of the most the user ever had invested at once.
  const excess = ((m.userPlPaise - m.benchPlPaise) / m.peakInvestedPaise) * 100;
  const score = clamp(50 + excess * MARKET.pointsPerPct, 0, 100);
  const r1 = (x) => Math.round(x * 10) / 10;
  return {
    state: "scored", score: round(score),
    facts: [{ key: "vs_nifty", tone: excess >= 0 ? "good" : excess <= -5 ? "warn" : "info", youPaise: round(m.userPlPaise), niftyPaise: round(m.benchPlPaise), diff: r1(excess), sinceTs: Number.isFinite(m.sinceTs) ? m.sinceTs : firstTs }],
    detail: { youPaise: round(m.userPlPaise), niftyPaise: round(m.benchPlPaise), peakPaise: round(m.peakInvestedPaise), diff: r1(excess), days: round(spanDays) },
  };
}

// ---- Overall --------------------------------------------------------------------
// Cut points chosen from the measured spread of the 987 real users with 5+
// trades on 13 Nov 2026 with all six parts (v3; overall score p5 45, p10 49,
// p30 56, p50 62, p80 69, p95 76), aiming near 6% A+, 15% A, 27% B+, 25% B,
// 20% C, 7% D. AGENTS.md says how to re-measure. Fixed numbers, not a curve:
// a user's grade never moves because other users changed.
//
// The marks a student sees (28 Nov 2026, the owner's call). The weighted mean
// of the six parts is hard to push up: a card with four parts at 100 still
// lands near 78, so the cut for A+ sat at 75 and read like a B1 next to
// school marks (CBSE gives A1 from 91). Who gets which letter did not change.
// The overall mark is now stretched so the same cuts land on school numbers:
// 75 -> 90, 69 -> 80, 62 -> 70, 55 -> 60, 47 -> 50, straight lines between.
// `overall.score` is the stretched mark (shown, saved and shared everywhere);
// `overall.raw` is the weighted mean. Part marks are not stretched.
const RAW_CUTS = [0, 47, 55, 62, 69, 75, 100];
const SHOWN_CUTS = [0, 50, 60, 70, 80, 90, 100];
/** The mark shown for a raw overall mark (whole numbers in, whole numbers out; never crosses a cut). */
export function stretchMark(raw) {
  if (!Number.isFinite(raw)) return raw;
  const x = clamp(raw, 0, 100);
  let i = 1;
  while (i < RAW_CUTS.length - 1 && x >= RAW_CUTS[i]) i++;
  const a = RAW_CUTS[i - 1], b = RAW_CUTS[i], c = SHOWN_CUTS[i - 1], d = SHOWN_CUTS[i];
  return round(c + ((x - a) / (b - a)) * (d - c));
}
/** Letters by the mark shown. */
export const GRADES = [
  { grade: "A+", min: 90 },
  { grade: "A",  min: 80 },
  { grade: "B+", min: 70 },
  { grade: "B",  min: 60 },
  { grade: "C",  min: 50 },
  { grade: "D",  min: 0 },
];
/** The letter for a mark as shown (an overall mark). */
export function gradeFor(score) {
  return (GRADES.find((g) => score >= g.min) || GRADES[GRADES.length - 1]).grade;
}
/** The letter for an unstretched mark (a part's mark, or the raw overall). */
export const rawGradeFor = (raw) => gradeFor(stretchMark(raw));

export function scoreReportCard(input) {
  const inp = { ...input, now: Number.isFinite(input?.now) ? input.now : Date.now() };
  const pillars = {
    discipline: scoreDiscipline(inp),
    results: scoreResults(inp),
    research: scoreResearch(inp),
    diversification: scoreDiversification(inp),
    learning: scoreLearning(inp),
    market: scoreMarket(inp),
  };
  let wSum = 0, sSum = 0;
  for (const [k, p] of Object.entries(pillars)) {
    p.key = k;
    p.weight = WEIGHTS[k];
    if (p.state === "scored") { wSum += p.weight; sSum += p.score * p.weight; }
  }
  // Share of the overall score each pillar carries right now (locked ones 0).
  for (const p of Object.values(pillars)) p.share = p.state === "scored" && wSum > 0 ? Math.round((p.weight / wSum) * 100) : 0;

  const graded = pillars.discipline.state === "scored";
  const raw = graded && wSum > 0 ? Math.round(sSum / wSum) : null;
  const score = raw == null ? null : stretchMark(raw);
  const scored = Object.values(pillars).filter((p) => p.state === "scored" && p.key !== "market");
  const best = scored.slice().sort((a, b) => b.score - a.score)[0] || null;
  const worst = scored.slice().sort((a, b) => a.score - b.score)[0] || null;
  return {
    version: RC_VERSION,
    overall: {
      state: graded ? "graded" : "building",
      score,
      raw,
      grade: graded ? gradeFor(score) : null,
      best: best && worst && best.key !== worst.key ? best.key : null,
      worst: best && worst && best.key !== worst.key ? worst.key : null,
      unlock: graded ? null : pillars.discipline.unlock,
    },
    pillars,
  };
}
