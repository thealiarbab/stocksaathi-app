// scripts/test-report-card.mjs — the report card score (js/coach/reportCardCore.js),
// the trade ledger that feeds it (js/coach/biasLedger.js) and every sentence
// it can show, in both languages (js/coach/reportCardCopy.js).
//
// These are the app's own modules, not copies. The cases are the ones the
// brief names (no trades, only buys, all evens, one huge position, all cash,
// a split-adjusted price mismatch) plus the rules the score was built on:
// a flag counts against how much you trade, a locked part never lowers a
// grade, the Nifty part stays hidden until 4 weeks or 10 trades, and one
// day's price move cannot swing the grade.
//
// The grade cut points themselves were set on real users (see AGENTS.md,
// "Report card v2"); this file only guards the logic.
//
// Run:  node scripts/test-report-card.mjs
import * as core from "../js/coach/reportCardCore.js";
import * as copy from "../js/coach/reportCardCopy.js";
import { tradesWithFlags, DETECTOR_CUTOFF_MS } from "../js/coach/biasLedger.js";
import { computeTradeStats } from "../js/data/tradeStats.js";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const NOW = Date.UTC(2026, 10, 13, 6, 0);          // Fri 13 Nov 2026, 11:30 IST
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log("FAIL", name, extra); } };
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

// ---- Builders ---------------------------------------------------------------------
const tr = (daysAgo, symbol, side, qty, px, flags = [], auto = false) => ({ ts: NOW - daysAgo * DAY, symbol, side, qty, pricePaise: px, flags, auto });
const flag = (bias, severity = 0.7, evidence = {}) => ({ bias, severity, evidence });
const pos = (symbol, valuePaise, sector = "Banking", kind = "STOCK") => ({ symbol, name: symbol + " Ltd", valuePaise, kind, sector });
const base = (o = {}) => ({
  now: NOW, accountCreatedAt: NOW - 60 * DAY, trades: [], stats: null,
  portfolio: { cashPaise: 10_000_000, positions: [] }, activity: null, market: null, ...o,
});
// n clean trades spread evenly from `fromDays` ago to `toDays` ago, buys and sells alternating.
const spread = (n, fromDays = 40, toDays = 1, sym = "S") => Array.from({ length: n }, (_, i) =>
  tr(fromDays - (i * (fromDays - toDays)) / Math.max(1, n - 1), sym + (i % 7), i % 2 ? "SELL" : "BUY", 1, 10000));
const weeksOf = (fn, n = 8) => Array.from({ length: n }, (_, i) => [core.istWeekStart(NOW - i * WEEK), ...fn(i)]);

// Every card scored here is kept, so the copy checks at the end run over all of them.
const seen = [];
const score = (input) => { const rc = core.scoreReportCard(input); seen.push(rc); return rc; };
// No NaN, Infinity or undefined anywhere in a result (JSON would hide NaN as null).
function clean(x, pathName = "rc") {
  if (typeof x === "number") return Number.isFinite(x) ? null : pathName;
  if (x === undefined) return pathName;
  if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) { const bad = clean(v, `${pathName}.${k}`); if (bad) return bad; }
  return null;
}

// ---- 1. No trades -------------------------------------------------------------------
{
  const rc = score(base());
  ok("no trades: not graded", rc.overall.state === "building" && rc.overall.grade === null && rc.overall.score === null);
  ok("no trades: discipline says what unlocks it", rc.pillars.discipline.state === "locked" && rc.pillars.discipline.unlock.have === 0 && rc.pillars.discipline.unlock.need === 5);
  ok("no trades: diversification locked, not zero", rc.pillars.diversification.state === "locked" && rc.pillars.diversification.unlock.key === "no_holdings" && rc.pillars.diversification.score === undefined);
  ok("no trades: learning waits for its data", rc.pillars.learning.state === "pending");
  ok("no trades: Nifty part hidden", rc.pillars.market.state === "hidden");
  ok("no trades: summary names the 5 trades", /5 trades/.test(copy.overallSummary(rc.overall)) && /5 trades/.test(copy.overallSummary(rc.overall, true)));

  const fresh = score(base({ accountCreatedAt: NOW - 3 * DAY, activity: { weeks: [] } }));
  ok("new account, nothing done: learning locked with a count", fresh.pillars.learning.state === "locked" && fresh.pillars.learning.unlock.have === 0 && fresh.pillars.learning.unlock.need === 3);

  const empty = score({});
  ok("empty input does not throw or grade", empty.overall.state === "building" && clean(empty.overall) === null);
}

// ---- 2. Under 5 trades: never a grade, however bad ------------------------------------
{
  const trades = [0, 1, 2, 3].map((d) => tr(d + 1, "X", "SELL", 5, 10000, [flag("panic_sell", 1)]));
  const rc = score(base({ trades }));
  ok("4 flagged trades: still not graded", rc.overall.state === "building" && rc.overall.grade === null && rc.pillars.discipline.unlock.have === 4);
}

// ---- 3. Only buys ---------------------------------------------------------------------
{
  const trades = [40, 33, 26, 19, 12, 5].map((d, i) => tr(d, "B" + i, "BUY", 10, 50000));
  const positions = trades.map((t, i) => pos(t.symbol, 500_000, ["Banking", "IT", "Pharma", "Auto", "FMCG", "Energy"][i]));
  const rc = score(base({ trades, portfolio: { cashPaise: 500_000, positions } }));
  ok("only buys: graded, nothing broken", rc.overall.state === "graded" && clean(rc) === null, clean(rc) || "");
  ok("only buys: clean record scores 100 once it is 4 weeks old", rc.pillars.discipline.score === 100 && rc.pillars.discipline.facts[0].key === "clean");
  ok("only buys: Nifty part waits for data, is not scored as zero", rc.pillars.market.state === "pending" && rc.pillars.market.share === 0);

  // Stats (wins, losses, win rate) are context only: they never move the score.
  const a = score(base({ trades, stats: computeTradeStats([]) }));
  const b = score(base({ trades, stats: { wins: 0, losses: 99, evens: 0, winRate: 0, realisedPaise: -9e9 } }));
  ok("win rate and realised loss never change the score", a.overall.score === b.overall.score && a.pillars.discipline.score === b.pillars.discipline.score);
}

// ---- 4. All evens ---------------------------------------------------------------------
{
  const tx = [];
  for (let i = 0; i < 3; i++) {
    tx.push({ id: i * 2, ts: NOW - (18 - i * 6) * DAY, symbol: "E" + i, side: "BUY", qty: 5, pricePaise: 10000, biasFlags: [] });
    tx.push({ id: i * 2 + 1, ts: NOW - (14 - i * 6) * DAY, symbol: "E" + i, side: "SELL", qty: 5, pricePaise: 10000, biasFlags: [] });
  }
  const stats = computeTradeStats(tx);
  ok("all evens: shared stats give a finite win rate", stats.evens === 3 && stats.wins === 0 && stats.losses === 0 && Number.isFinite(stats.winRate));
  const trades = tradesWithFlags(tx);
  const closes = [["2026-10-20", 25000], ["2026-11-12", 25000]];
  const bench = core.benchmarkPl(trades, closes);
  const rc = score(base({ trades, stats, market: { userPlPaise: 0, ...bench } }));
  ok("all evens: graded with no NaN anywhere", rc.overall.state === "graded" && clean(rc) === null, clean(rc) || "");
  ok("all evens: no flags, so discipline is not marked down", rc.pillars.discipline.detail.flags === 0 && rc.pillars.discipline.score >= 72);
  ok("all evens: holding nothing now locks diversification", rc.pillars.diversification.state === "locked");
}

// ---- 5. One huge position ---------------------------------------------------------------
{
  const trades = spread(6);
  const huge = score(base({ trades, portfolio: { cashPaise: 500_000, positions: [pos("BIG", 9_500_000)] } }));
  const d = huge.pillars.diversification;
  ok("one huge position: scored low", d.state === "scored" && d.score < 30, String(d.score));
  ok("one huge position: the fact is the user's own number", d.facts[0].key === "top_stock" && d.facts[0].pct === 95 && d.facts[0].tone === "bad");
  ok("one huge position: sentence quotes it", /BIG Ltd.*95%/.test(copy.factText(d.facts[0])));

  const sectors = ["Banking", "IT", "Pharma", "Auto", "FMCG", "Energy"];
  const even = score(base({ trades, portfolio: { cashPaise: 1_000_000, positions: sectors.map((s, i) => pos("P" + i, 1_500_000, s)) } }));
  ok("six even positions in six sectors: scored high", even.pillars.diversification.score >= 90, String(even.pillars.diversification.score));
  ok("spreading out raises the overall grade", even.overall.score > huge.overall.score + 10, `${even.overall.score} vs ${huge.overall.score}`);

  const oneSector = score(base({ trades, portfolio: { cashPaise: 1_000_000, positions: sectors.map((_, i) => pos("Q" + i, 1_500_000, "Banking")) } }));
  ok("six positions in one sector score below six sectors", oneSector.pillars.diversification.score < even.pillars.diversification.score && oneSector.pillars.diversification.facts.some((f) => f.key === "top_sector" && f.pct === 100));

  // A fund is a basket: one index fund is not one concentrated bet.
  const fund = score(base({ trades, portfolio: { cashPaise: 500_000, positions: [pos("MF_NIFTY", 9_500_000, null, "MF")] } }));
  ok("one mutual fund is not treated as one stock", fund.pillars.diversification.score >= 80 && !fund.pillars.diversification.facts.some((f) => f.key === "top_stock"), String(fund.pillars.diversification.score));

  // Dust positions do not count as "real" ones.
  const dust = score(base({ trades, portfolio: { cashPaise: 0, positions: [pos("BIG", 9_800_000), pos("D1", 100_000, "IT"), pos("D2", 100_000, "Pharma")] } }));
  ok("positions under 2% are not counted as real", dust.pillars.diversification.facts.find((f) => f.key === "positions").n === 1);
}

// ---- 6. All cash, and cash judged fairly ------------------------------------------------
{
  const trades = spread(6);
  const rc = score(base({ trades, portfolio: { cashPaise: 10_000_000, positions: [] } }));
  ok("all cash: diversification locked, never a zero", rc.pillars.diversification.state === "locked" && rc.pillars.diversification.share === 0);
  ok("all cash: the grade is the scored parts only", rc.overall.state === "graded" && rc.overall.score === rc.pillars.discipline.score && rc.pillars.discipline.share === 100);

  const small = score(base({ trades, portfolio: { cashPaise: 9_000_000, positions: [pos("ONE", 1_000_000)] } }));
  ok("one small position in a pile of cash: not judged yet", small.pillars.diversification.state === "locked" && small.pillars.diversification.unlock.key === "small" && small.pillars.diversification.unlock.pct === 10);

  const two = [pos("A", 50_000, "IT"), pos("B", 50_000, "Pharma")];
  const newbie = score(base({ trades, accountCreatedAt: NOW - 10 * DAY, portfolio: { cashPaise: 9_900_000, positions: two } }));
  ok("cash is not judged in the first month", newbie.pillars.diversification.detail.cashJudged === false && newbie.pillars.diversification.detail.parts.cash === 100);
  const old = score(base({ trades, portfolio: { cashPaise: 9_900_000, positions: two } }));
  ok("99% idle cash after a month: marked gently, never under 40", old.pillars.diversification.detail.cashJudged && old.pillars.diversification.detail.parts.cash >= 40 && old.pillars.diversification.detail.parts.cash < 60);
  const mid = score(base({ trades, portfolio: { cashPaise: 6_000_000, positions: [pos("A", 2_000_000, "IT"), pos("B", 2_000_000, "Pharma")] } }));
  ok("60% cash costs nothing", mid.pillars.diversification.detail.parts.cash === 100);
}

// ---- 7. A locked or missing part never lowers a grade ------------------------------------
{
  const trades = spread(8);
  const activity = { weeks: weeksOf(() => [3, 1, 2, 1]) };
  const portfolio = { cashPaise: 1_000_000, positions: [pos("A", 3_000_000, "IT"), pos("B", 3_000_000, "Pharma"), pos("C", 3_000_000, "Auto")] };
  const full = score(base({ trades, activity, portfolio }));
  const p = full.pillars;
  const mean = (keys) => Math.round(keys.reduce((s, k) => s + p[k].score * p[k].weight, 0) / keys.reduce((s, k) => s + p[k].weight, 0));
  ok("overall is the weighted mean of the scored parts", full.overall.score === mean(["discipline", "diversification", "learning"]));
  const shares = Object.values(p).reduce((s, x) => s + x.share, 0);
  ok("shares of scored parts add up to 100", near(shares, 100, 1), String(shares));

  const noLearn = score(base({ trades, activity: null, portfolio }));
  const q = noLearn.pillars;
  ok("learning data missing: left out, not scored as zero", q.learning.state === "pending" && noLearn.overall.score === Math.round((q.discipline.score * 45 + q.diversification.score * 25) / 70));
}

// ---- 8. Discipline: flags against how much you trade --------------------------------------
{
  const chase = () => [flag("fomo", 0.7, { symbol: "S1" })];
  const few = spread(5);
  few[2].flags = chase(); few[4].flags = chase();
  const many = spread(300);
  many[296].flags = chase(); many[298].flags = chase();
  const sFew = score(base({ trades: few })).pillars.discipline;
  const sMany = score(base({ trades: many })).pillars.discipline;
  ok("2 flags in 5 trades cost far more than 2 in 300", sMany.score - sFew.score >= 40, `${sFew.score} vs ${sMany.score}`);
  ok("2 flags in 300 trades is still a good score", sMany.score >= 85, String(sMany.score));
  ok("the fact counts the flagged buys out of the user's buys", sFew.facts[0].key === "chase" && sFew.facts[0].n === 2 && sFew.facts[0].of === 3);

  // Trading more never helps by itself: the same clean record, 6 or 300 trades.
  ok("a clean record scores the same at 6 trades and 300", score(base({ trades: spread(6) })).pillars.discipline.score === score(base({ trades: spread(300) })).pillars.discipline.score);

  // Severity and recency.
  const one = (sev, daysAgo) => { const t = spread(10, 120, 1); t.push(tr(daysAgo, "Z", "SELL", 1, 10000, [flag("panic_sell", sev)])); return score(base({ trades: t })).pillars.discipline; };
  ok("a stronger signal costs more", one(1, 2).score < one(0.5, 2).score);
  ok("an old flag costs less than a new one", one(1, 100).score > one(1, 2).score + 5, `${one(1, 100).score} vs ${one(1, 2).score}`);
  ok("a flag outside 90 days is shown as an old note", one(1, 100).facts.some((f) => f.key === "panic_old" && f.days === 100));
  ok("a recent flag is shown with its count", one(1, 2).facts.some((f) => f.key === "panic" && f.n === 1));

  // What is and is not counted.
  const withFlags = (flags) => { const t = spread(10); t[9].flags = flags; return score(base({ trades: t })).pillars.discipline.score; };
  const cleanScore = withFlags([]);
  ok("concentration flags are left to the diversification part", withFlags([flag("concentration", 1), flag("sector_concentration", 1)]) === cleanScore);
  ok("the matcher's marker is not a flag", withFlags(["limit_order_filled", { bias: "limit_order_filled" }]) === cleanScore);
  ok("two chase flags on one trade count once", withFlags([flag("fomo", 0.7), flag("pump_chase", 0.7)]) === withFlags([flag("fomo", 0.7)]));
  ok("a zero-severity flag is nothing", withFlags([flag("panic_sell", 0)]) === cleanScore);
  ok("an unknown pattern is ignored", withFlags([flag("made_up", 1)]) === cleanScore);

  // A young record is pulled to the middle: no verdict from a few days.
  const young = (flags) => score(base({ accountCreatedAt: NOW - 3 * DAY, trades: [0, 1, 2, 3, 4].map((i) => tr(2 - i * 0.4, "Y", "SELL", 1, 10000, flags)) })).pillars.discipline;
  const best = young([]), worst = young([flag("panic_sell", 1)]);
  ok("first days, clean: good but not perfect", best.score >= 75 && best.score <= 81, String(best.score));
  ok("first days, every trade flagged: floor of 50", worst.score >= 50 && worst.score < 60, String(worst.score));
  ok("a young record says so", best.facts.some((f) => f.key === "young" && f.full === 28));
}

// ---- 9. Split-adjusted price mismatch ------------------------------------------------------
{
  // Stored flag: a buy "50% below cost" is a split, not averaging down.
  const withAnchor = (below) => { const t = spread(10); t[8].flags = [flag("anchoring", 0.9, { symbol: "S1", below_cost_pct: below })]; return score(base({ trades: t })).pillars.discipline; };
  const cleanD = score(base({ trades: spread(10) })).pillars.discipline;
  ok("averaging-down flag 50% below cost is not counted (split)", withAnchor(-50).score === cleanD.score && withAnchor(-50).detail.flags === 0);
  ok("averaging-down flag 90% below cost is not counted (1:10 split)", withAnchor(-90).score === cleanD.score);
  ok("a real 12% averaging down is counted", withAnchor(-12).score < cleanD.score && withAnchor(-12).facts.some((f) => f.key === "avg_down"));

  // The same through the ledger: a matcher-filled buy after a 1:2 split.
  const auto = ["limit_order_filled"];
  const tx = [
    { id: 1, ts: NOW - 30 * DAY, symbol: "TRENT", side: "BUY", qty: 10, pricePaise: 423900, biasFlags: auto },
    { id: 2, ts: NOW - 20 * DAY, symbol: "TRENT", side: "BUY", qty: 10, pricePaise: 211950, biasFlags: auto },
    ...[15, 12, 9, 6].map((d, i) => ({ id: 3 + i, ts: NOW - d * DAY, symbol: "O" + i, side: "BUY", qty: 1, pricePaise: 10000, biasFlags: auto })),
  ];
  const trades = tradesWithFlags(tx);
  const d = score(base({ trades })).pillars.discipline;
  ok("ledger: the split buy does not reach the score", d.detail.flags === 0 && !d.facts.some((f) => f.key.startsWith("avg_down")), JSON.stringify(d.facts));

  // The Nifty comparison follows the user's own cost, so a split in the price
  // history cannot move the benchmark.
  const closes = [["2026-10-10", 100], ["2026-11-12", 100]];
  const b = core.benchmarkPl(trades, closes);
  ok("benchmark of a flat index is zero whatever the trade prices", b.benchPlPaise === 0 && b.peakInvestedPaise === 10 * 423900 + 10 * 211950 + 4 * 10000);
}

// ---- 10. The ledger ---------------------------------------------------------------------
{
  const after = DETECTOR_CUTOFF_MS + 5 * DAY, before = DETECTOR_CUTOFF_MS - 10 * DAY;
  const stored = { bias: "fomo", severity: 0.6, evidence: { symbol: "A" } };
  const out = tradesWithFlags([
    { id: 2, ts: after, symbol: "A", side: "BUY", qty: 1, pricePaise: 10000, biasFlags: [stored, "note", { bias: "x" }, null] },
    { id: 1, ts: before, symbol: "A", side: "SELL", qty: 1, pricePaise: 10000, biasFlags: [{ bias: "panic_sell", severity: 1 }] },
    { id: 3, ts: after + DAY, symbol: "B", side: "BUY", qty: 1, pricePaise: 10000, biasFlags: ["limit_order_filled"] },
    { id: 4, ts: after + DAY, symbol: "", side: "BUY", qty: 1, pricePaise: 10000 },
    { id: 5, ts: after + DAY, symbol: "C", side: "BUY", qty: 0, pricePaise: 10000 },
  ]);
  ok("ledger: oldest first, broken rows dropped", out.length === 3 && out[0].ts === before && out[2].symbol === "B");
  ok("ledger: a tap since 24 Oct keeps its stored detector results only", out[1].flags.length === 1 && out[1].flags[0].bias === "fomo" && out[1].auto === false);
  ok("ledger: the old detectors' panic flags are ignored", out[0].flags.length === 0);
  ok("ledger: a matcher fill is marked auto", out[2].auto === true && out[2].flags.length === 0);
  // 13 real trades (12 Sep 2026) hold bias_flags = {} instead of a list.
  let odd = null;
  try { odd = tradesWithFlags([{ id: 9, ts: after, symbol: "Z", side: "BUY", qty: 1, pricePaise: 10000, biasFlags: {} }, { id: 8, ts: before, symbol: "Z", side: "SELL", qty: 1, pricePaise: 10000, biasFlags: "x" }]); } catch { odd = null; }
  ok("ledger: flags stored as {} or text do not crash and count as none", odd && odd.length === 2 && odd.every((t) => t.flags.length === 0 && t.auto === false));
  ok("score: a trade whose flags are not a list scores as clean", score(base({ trades: spread(6).map((t) => ({ ...t, flags: {} })) })).pillars.discipline.state === "scored");

  // Three quick round trips in one stock, all filled by the matcher: the third sell is churning.
  const churn = [];
  for (let i = 0; i < 3; i++) {
    churn.push({ id: i * 2, ts: after + i * 2 * DAY, symbol: "CH", side: "BUY", qty: 5, pricePaise: 10000, biasFlags: ["limit_order_filled"] });
    churn.push({ id: i * 2 + 1, ts: after + i * 2 * DAY + DAY, symbol: "CH", side: "SELL", qty: 5, pricePaise: 10100, biasFlags: ["limit_order_filled"] });
  }
  const c = tradesWithFlags(churn);
  ok("ledger: churning is found on matcher fills", c[5].flags.some((f) => f.bias === "churning") && c.slice(0, 5).every((t) => t.flags.length === 0));

  // Twelve trades on one day. Taps before 24 Oct: the 10th is overtrading. Matcher fills: never.
  const day = (auto) => [
    { id: 0, ts: before - 2 * DAY, symbol: "F", side: "BUY", qty: 1, pricePaise: 10000, biasFlags: auto ? ["limit_order_filled"] : [] },
    ...Array.from({ length: 12 }, (_, i) => ({ id: i + 1, ts: before + i * 60_000, symbol: "T" + i, side: "BUY", qty: 1, pricePaise: 10000, biasFlags: auto ? ["limit_order_filled"] : [] })),
  ];
  const taps = tradesWithFlags(day(false)), fills = tradesWithFlags(day(true));
  ok("ledger: the 10th hand-placed trade of a day is overtrading", taps[10].flags.some((f) => f.bias === "overtrading") && taps.filter((t) => t.flags.length).length === 1);
  ok("ledger: orders the matcher filled are never overtrading", fills.every((t) => !t.flags.some((f) => f.bias === "overtrading")));
}

// ---- 11. Learning and activity ------------------------------------------------------------
{
  const trades = spread(6);
  const steady = score(base({ trades, activity: { weeks: weeksOf(() => [3, 1, 0, 0]) } })).pillars.learning;
  const binge = score(base({ trades, activity: { weeks: weeksOf((i) => (i === 2 ? [1, 20, 50, 50] : [0, 0, 0, 0])) } })).pillars.learning;
  ok("eight steady weeks score high", steady.state === "scored" && steady.score >= 85, String(steady.score));
  ok("one binge day does not replace a steady habit", steady.score - binge.score >= 40, `${steady.score} vs ${binge.score}`);
  ok("learning facts are the user's own counts", steady.facts[0].key === "weeks" && steady.facts[0].active === 8 && steady.facts[0].of === 8 && steady.facts[1].replays === 8);

  const act = { weeks: weeksOf(() => [2, 0, 2, 1]) };
  ok("the number of trades never counts", score(base({ trades: [], activity: act })).pillars.learning.score === score(base({ trades: spread(300), activity: act })).pillars.learning.score);

  const idle = score(base({ trades, activity: { weeks: weeksOf(() => [2, 0, 0, 0]) } })).pillars.learning;
  ok("opening the app without learning: some credit, and it says so", idle.score === 40 && idle.facts.some((f) => f.key === "no_actions"));
  const none = score(base({ trades, activity: { weeks: [] } })).pillars.learning;
  ok("nothing in 8 weeks: scored zero, with no NaN", none.score === 0 && clean(none) === null);

  // A new account is judged on the weeks it has existed.
  const wk = (r, q, e) => ({ weeks: [[core.istWeekStart(NOW), 3, r, q, e]] });
  const newDone = score(base({ accountCreatedAt: NOW - 5 * DAY, activity: wk(1, 2, 1) })).pillars.learning;
  ok("5-day account that did all three: full marks", newDone.state === "scored" && newDone.score === 100 && newDone.detail.weeks === 1, String(newDone.score));
  const newIdle = score(base({ accountCreatedAt: NOW - 5 * DAY, activity: wk(0, 2, 0) })).pillars.learning;
  ok("5-day account with 2 actions: not judged yet", newIdle.state === "locked" && newIdle.unlock.have === 2);

  ok("week starts on Monday, IST", core.istWeekStart(NOW) === "2026-11-09"
    && core.istWeekStart(Date.UTC(2026, 10, 8, 18, 29)) === "2026-11-02"       // Sun 23:59 IST
    && core.istWeekStart(Date.UTC(2026, 10, 8, 18, 30)) === "2026-11-09");      // Mon 00:00 IST
}

// ---- 12. Against the Nifty 50 --------------------------------------------------------------
{
  const mk = (n, firstDaysAgo) => Array.from({ length: n }, (_, i) => tr(firstDaysAgo - (i * (firstDaysAgo - 1)) / Math.max(1, n - 1), "M" + i, "BUY", 1, 10000));
  const m = { userPlPaise: 0, benchPlPaise: 0, peakInvestedPaise: 1_000_000, sinceTs: NOW - 27 * DAY };
  ok("9 trades in 27 days: hidden even with data", score(base({ trades: mk(9, 27), market: m })).pillars.market.state === "hidden");
  ok("10 trades in 3 days: shown", score(base({ trades: mk(10, 3), market: m })).pillars.market.state === "scored");
  ok("5 trades over 28 days: shown", score(base({ trades: mk(5, 28), market: m })).pillars.market.state === "scored");
  ok("shown but no index data: left out, not zero", score(base({ trades: mk(10, 3), market: null })).pillars.market.state === "pending");
  ok("no money ever invested: left out", score(base({ trades: mk(10, 3), market: { ...m, peakInvestedPaise: 0 } })).pillars.market.state === "pending");

  const at = (userPl, benchPl) => score(base({ trades: mk(10, 30), market: { ...m, userPlPaise: userPl, benchPlPaise: benchPl } })).pillars.market;
  ok("level with the Nifty is 50", at(100_000, 100_000).score === 50);
  ok("5% ahead is 65", at(50_000, 0).score === 65);
  ok("far behind stops at 0, far ahead at 100", at(-900_000, 0).score === 0 && at(900_000, 0).score === 100);
  ok("the fact carries both rupee figures", at(123_456, 100_000).facts[0].youPaise === 123_456 && at(123_456, 100_000).facts[0].niftyPaise === 100_000);

  // Small weight: with every part scored, the worst and best Nifty result are 10 points apart.
  const full = (userPl) => score(base({
    trades: mk(10, 30), activity: { weeks: weeksOf(() => [3, 1, 1, 1]) },
    portfolio: { cashPaise: 1_000_000, positions: [pos("A", 3_000_000, "IT"), pos("B", 3_000_000, "Pharma"), pos("C", 3_000_000, "Auto")] },
    market: { ...m, userPlPaise: userPl },
  }));
  const lo = full(-900_000), hi = full(900_000);
  const scoredW = Object.values(lo.pillars).filter((x) => x.state === "scored").reduce((s, x) => s + x.weight, 0);
  const share = Math.round((core.WEIGHTS.market / scoredW) * 100);
  ok("Nifty part carries only its weight of the grade", lo.pillars.market.share === share && near(hi.overall.score - lo.overall.score, share, 1), `${share} ${lo.overall.score}..${hi.overall.score}`);

  // benchmarkPl: the same rupees on the same days.
  const closes = [["2026-10-05", 100], ["2026-10-06", 102], ["2026-10-20", 105], ["2026-11-12", 110]];
  const t0 = Date.UTC(2026, 9, 5, 6, 0), t1 = Date.UTC(2026, 9, 20, 6, 0);
  const buy = { ts: t0, symbol: "X", side: "BUY", qty: 10, pricePaise: 1_000_000 };
  const held = core.benchmarkPl([buy], closes);
  ok("benchmark: 1 lakh held while the index goes 100 to 110 makes 10,000", held.benchPlPaise === 1_000_000 && held.peakInvestedPaise === 10_000_000 && held.sinceTs === t0);
  const half = core.benchmarkPl([buy, { ts: t1, symbol: "X", side: "SELL", qty: 5, pricePaise: 2_000_000 }], closes);
  ok("benchmark: selling half takes that money out of the index at that day's close", half.benchPlPaise === 250_000 + 500_000 && half.peakInvestedPaise === 10_000_000);
  const early = core.benchmarkPl([{ ...buy, ts: Date.UTC(2026, 8, 1) }], closes);
  ok("benchmark: a trade before the series uses its first close", early.benchPlPaise === 1_000_000);
  const today = core.benchmarkPl([{ ...buy, ts: NOW }], closes);
  ok("benchmark: a trade today has made nothing yet", today.benchPlPaise === 0);
  ok("benchmark: no closes or no trades gives null, not zero", core.benchmarkPl([buy], []) === null && core.benchmarkPl([], closes) === null && core.benchmarkPl([buy], [["2026-10-05", 0]]) === null);
  const weekend = core.benchmarkPl([{ ...buy, ts: Date.UTC(2026, 9, 10, 6, 0) }], closes);      // no session that day
  ok("benchmark: a day with no session uses the close before it", weekend.benchPlPaise === Math.round(10_000_000 * (110 / 102 - 1)));
}

// ---- 13. Stable: one day's prices do not swing the grade ------------------------------------
{
  const trades = spread(12);
  const mkt = (userPl) => ({ userPlPaise: userPl, benchPlPaise: 200_000, peakInvestedPaise: 8_000_000, sinceTs: NOW - 40 * DAY });
  const card = (aValue, userPl) => score(base({
    trades, activity: { weeks: weeksOf(() => [2, 0, 2, 1]) }, market: mkt(userPl),
    portfolio: { cashPaise: 2_000_000, positions: [pos("A", aValue, "IT"), pos("B", 2_000_000, "Pharma"), pos("C", 2_000_000, "Auto"), pos("D", 1_500_000, "FMCG")] },
  }));
  const flat = card(2_500_000, 250_000);
  const up = card(Math.round(2_500_000 * 1.05), 250_000 + 125_000);       // biggest holding +5% in a day
  const down = card(Math.round(2_500_000 * 0.95), 250_000 - 125_000);     // or -5%
  ok("a 5% day in the biggest holding moves the overall score by 2 at most", Math.abs(up.overall.score - flat.overall.score) <= 2 && Math.abs(down.overall.score - flat.overall.score) <= 2, `${down.overall.score} ${flat.overall.score} ${up.overall.score}`);
  ok("prices never touch discipline or learning", up.pillars.discipline.score === flat.pillars.discipline.score && up.pillars.learning.score === flat.pillars.learning.score);
  const a = score(base({ trades, now: NOW })), b = score(base({ trades, now: NOW + DAY }));
  ok("one more day with nothing new moves discipline by 1 at most", Math.abs(a.pillars.discipline.score - b.pillars.discipline.score) <= 1);
}

// ---- 13b. Results: own profit, risk-adjusted ----------------------------------------------
{
  // 10 lakh bought 40 days ago, still held. Profit decides; cash on the side does not dilute it.
  const trades = [tr(40, "R", "BUY", 100, 10_000_00), ...spread(6, 35, 2, "Q")];
  const res = (plPaise, extra = {}) => score(base({ trades, profit: { plPaise }, ...extra })).pillars.results;
  const peak = core.peakInvested(trades);
  ok("results: breaking even is 50", res(0).score === 50);
  ok("results: +5% on the money invested is about 78", near(res(Math.round(peak * 0.05)).score, 78, 1), String(res(Math.round(peak * 0.05)).score));
  ok("results: -5% is about 22", near(res(-Math.round(peak * 0.05)).score, 22, 1));
  ok("results: a huge win flattens out below 100", res(peak * 5).score <= 100 && res(peak * 5).score >= 99);
  ok("results: more profit never scores lower", res(Math.round(peak * 0.02)).score < res(Math.round(peak * 0.04)).score);
  ok("results: the fact says rupees and percent of money invested", res(Math.round(peak * 0.05)).facts[0].key === "profit" && res(Math.round(peak * 0.05)).facts[0].pct === 5);
  ok("results: a loss is a loss fact", res(-100_00).facts[0].key === "loss");
  ok("results: cash kept aside does not change it",
    score(base({ trades, profit: { plPaise: 50_000_00 }, portfolio: { cashPaise: 1, positions: [] } })).pillars.results.score
    === score(base({ trades, profit: { plPaise: 50_000_00 }, portfolio: { cashPaise: 900_000_000, positions: [] } })).pillars.results.score);
  ok("results: no buy yet is locked, not zero", score(base({ trades: [tr(3, "X", "SELL", 1, 100)], profit: { plPaise: 0 } })).pillars.results.state === "locked");
  ok("results: no profit figure is left out, not scored", score(base({ trades })).pillars.results.state === "pending");

  // Risk: a fall deeper than 10% of the money invested costs part of the return.
  const P = Math.round(peak * 0.06);
  const calm = res(P, { curve: [["2026-10-01", 100_000_000], ["2026-10-20", 100_000_000 - Math.round(peak * 0.05)], ["2026-11-12", 100_000_000 + P]] });
  const wild = res(P, { curve: [["2026-10-01", 100_000_000], ["2026-10-20", 100_000_000 - Math.round(peak * 0.30)], ["2026-11-12", 100_000_000 + P]] });
  ok("results: a 5% dip along the way costs nothing", calm.score === res(P).score && calm.facts.some((f) => f.key === "drawdown" && f.pct === 5));
  ok("results: a 30% fall along the way costs points", wild.score < calm.score - 10 && wild.facts.some((f) => f.key === "drawdown" && f.tone === "warn"), `${wild.score} vs ${calm.score}`);

  // A young record is pulled to 50: one lucky week is not a result.
  const young = score(base({ accountCreatedAt: NOW - 3 * DAY, trades: [tr(2, "Y", "BUY", 10, 1000_00)], profit: { plPaise: 300_00 } })).pillars.results;
  ok("results: a 2-day-old 30% win stays near the middle", young.score <= 65 && young.facts.some((f) => f.key === "results_young"), String(young.score));
  ok("peakInvested: sells take money back out", core.peakInvested([tr(5, "A", "BUY", 10, 100), tr(4, "A", "SELL", 10, 150), tr(3, "B", "BUY", 5, 100)]) === 1000);
}

// ---- 13c. Research: did they look before buying ----------------------------------------------
{
  const ts = (d) => NOW - d * DAY;
  const buys = (rows) => rows.map(([d, sym]) => tr(d, sym, "BUY", 1, 100_00));
  const rs = (rows, research) => score(base({ trades: buys(rows), research })).pillars.research;
  const rows = [[30, "A"], [20, "B"], [10, "C"], [5, "D"]];
  const all = rs(rows, rows.map(([d, s]) => [ts(d), s, 2, true, true, true]));
  const none = rs(rows, rows.map(([d, s]) => [ts(d), s, 0, false, false, false]));
  const one = rs(rows, rows.map(([d, s]) => [ts(d), s, 0, true, false, false]));
  ok("research: looked in several ways before every buy is 100", all.state === "scored" && all.score === 100);
  ok("research: never looked is 0, all impulse", none.score === 0 && none.facts.some((f) => f.key === "impulse" && f.n === 4 && f.tone === "bad"));
  ok("research: one way of looking is half marks", one.score === 50);
  ok("research: the facts count the user's own buys", all.facts[0].key === "researched" && all.facts[0].n === 4 && all.facts[0].of === 4 && all.facts.some((f) => f.key === "research_ways" && f.asked === 4));
  ok("research: under 3 fresh buys is locked", rs(rows.slice(0, 2), rows.slice(0, 2).map(([d, s]) => [ts(d), s, 1, false, false, false])).state === "locked");
  ok("research: no data is left out", rs(rows, null).state === "pending");

  // Re-buying a stock already being traded is not a fresh decision.
  const churn = [[30, "A"], [29, "A"], [28, "A"], [27, "A"], [20, "B"]];
  const c = rs(churn, churn.map(([d, s]) => [ts(d), s, 0, false, false, false]));
  ok("research: repeat buys in a stock traded days before are not judged", c.state === "locked" && c.unlock.have === 2);
  // Recent buys count more.
  const oldBad = rs(rows, rows.map(([d, s], i) => [ts(d), s, i < 2 ? 0 : 2, false, i >= 2, false]));
  const newBad = rs(rows, rows.map(([d, s], i) => [ts(d), s, i >= 2 ? 0 : 2, false, i < 2, false]));
  ok("research: recent buys weigh more than old ones", oldBad.score > newBad.score, `${oldBad.score} vs ${newBad.score}`);
}

// ---- 13d. Discipline: getting better counts --------------------------------------------------
{
  const chase = [flag("fomo", 0.8)];
  const t = (flagsOld, flagsNew) => {
    const old = Array.from({ length: 10 }, (_, i) => tr(90 - i * 5, "O" + i, "BUY", 1, 100_00, i < flagsOld ? chase : []));
    const fresh = Array.from({ length: 10 }, (_, i) => tr(25 - i * 2, "N" + i, "BUY", 1, 100_00, i < flagsNew ? chase : []));
    return score(base({ accountCreatedAt: NOW - 120 * DAY, trades: [...old, ...fresh] })).pillars.discipline;
  };
  const better = t(4, 0), same = t(2, 2), worse = t(0, 4);
  ok("discipline: fewer notes lately says so", better.facts.some((f) => f.key === "improving" && f.before === 4 && f.now === 0));
  ok("discipline: improving earns points back", better.detail.bonus > 0 && better.score > t(4, 4).score);
  ok("discipline: more notes lately is flagged", worse.facts.some((f) => f.key === "slipping"));
  ok("discipline: steady record has no trend fact", !same.facts.some((f) => f.key === "improving" || f.key === "slipping"));
}

// ---- 14. Grades -----------------------------------------------------------------------------
{
  const g = core.gradeFor;
  ok("grade cut points", g(100) === "A+" && g(75) === "A+" && g(74) === "A" && g(69) === "A" && g(68) === "B+" && g(62) === "B+"
    && g(61) === "B" && g(55) === "B" && g(54) === "C" && g(47) === "C" && g(46) === "D" && g(0) === "D");
  ok("cut points go down and end at 0", core.GRADES.every((x, i, arr) => i === 0 || x.min < arr[i - 1].min) && core.GRADES[core.GRADES.length - 1].min === 0);
  ok("weights add up to 100, discipline largest, Nifty smallest", Object.values(core.WEIGHTS).reduce((s, x) => s + x, 0) === 100
    && core.WEIGHTS.discipline === Math.max(...Object.values(core.WEIGHTS)) && core.WEIGHTS.market === Math.min(...Object.values(core.WEIGHTS)));
  for (const grade of core.GRADES.map((x) => x.grade)) ok(`grade ${grade} has a title in both languages`, copy.gradeTitle(grade).length > 2 && copy.gradeTitle(grade, true).length > 2);
}

// ---- 15. Copy: every sentence, both languages ------------------------------------------------
{
  const sample = {
    panic: { n: 2, of: 7 }, chase: { n: 2, of: 11 }, churn: { n: 3, symbol: "IDEA" }, overtrade: { n: 4, peak: 23 },
    avg_down: { n: 1, of: 9 }, disposition: { n: 2 },
    panic_old: { days: 100 }, chase_old: { days: 95 }, churn_old: { days: 120 }, overtrade_old: { days: 99 }, avg_down_old: { days: 140 }, disposition_old: { days: 91 },
    clean: { trades: 12, days: 40 }, young: { days: 6, full: 28 }, record: { trades: 31, days: 62 },
    top_stock: { name: "Reliance Industries", symbol: "RELIANCE", pct: 52 }, positions: { n: 4, funds: 1 }, top_sector: { sector: "Banking", pct: 71, n: 3 },
    cash: { pct: 60, days: 12 }, cash_idle: { pct: 88, days: 70 },
    weeks: { active: 5, of: 8 }, actions: { replays: 1, questions: 4, reads: 2, weeks: 3, of: 8 }, no_actions: { of: 8 }, untried: { replays: true, questions: false, reads: false },
    vs_nifty: { youPaise: -123450, niftyPaise: 678900, diff: -8.1, sinceTs: Date.UTC(2026, 9, 5, 6, 0) },
    improving: { before: 4, now: 0.5 }, slipping: { before: 1, now: 3 },
    profit: { plPaise: 1234567, pct: 6.2, peakPaise: 19912345 }, loss: { plPaise: -50000, pct: -1.4, peakPaise: 3571428 },
    drawdown: { dropPaise: 2500000, pct: 12.5 }, closed: { wins: 47, losses: 8, evens: 43 }, results_young: { days: 6, full: 28 },
    researched: { n: 3, of: 5 }, impulse: { n: 2, of: 5 }, research_ways: { views: 2, chart: 1, watch: 0, asked: 1 },
  };
  const bad = /undefined|NaN|null|\[object/;
  for (const [key, f] of Object.entries(sample)) {
    const en = copy.factText({ key, tone: "info", ...f }), hi = copy.factText({ key, tone: "info", ...f }, true);
    ok(`copy: "${key}" has an English sentence`, en.length > 12 && !bad.test(en), en);
    ok(`copy: "${key}" has a Hinglish sentence`, hi.length > 12 && !bad.test(hi) && hi !== en, hi);
  }
  // Every fact the core can produce must have a sentence. Run over every card scored above.
  const produced = new Set();
  let unworded = "";
  for (const rc of seen) for (const p of Object.values(rc.pillars)) for (const f of p.facts || []) {
    produced.add(f.key);
    for (const hi of [false, true]) { const t = copy.factText(f, hi); if (!t || bad.test(t)) unworded = `${f.key}: ${t}`; }
  }
  ok("copy: every fact scored in this file reads cleanly in both languages", !unworded, unworded);
  const unknown = [...produced].filter((k) => !(k in sample));
  ok("copy: the core produced no fact key this file does not know", unknown.length === 0, unknown.join(","));
  ok("copy: the cases above reached most kinds of fact", produced.size >= 16, [...produced].join(","));

  ok("copy: the user's own numbers are in the sentence", /2 of your last 7 sells/.test(copy.factText({ key: "panic", ...sample.panic })) && /most: 23/.test(copy.factText({ key: "overtrade", ...sample.overtrade })));
  ok("copy: rupees always have 2 decimals", /lost ₹1,234\.50/.test(copy.factText({ key: "vs_nifty", ...sample.vs_nifty })) && /would have made ₹6,789\.00/.test(copy.factText({ key: "vs_nifty", ...sample.vs_nifty })));
  ok("copy: singular and plural", /noted 1 time \(/.test(copy.factText({ key: "churn", n: 1, symbol: "X" })) && /You hold 1 position\./.test(copy.factText({ key: "positions", n: 1, funds: 0 })));
  ok("copy: an unknown fact is an empty string, not a crash", copy.factText({ key: "nope" }) === "" && copy.factText(null) === "");

  for (const key of Object.keys(core.WEIGHTS)) {
    for (const hi of [false, true]) {
      const c = copy.pillarCopy(key, hi);
      ok(`copy: ${key} explains itself (${hi ? "Hinglish" : "English"})`, c && c.name && c.what.length > 40 && c.how.length > 40 && c.tryThis.length > 20);
    }
  }
  const unlocks = [["trades", { have: 2, need: 5 }], ["no_holdings", {}], ["small", { pct: 10, need: 20 }], ["learn", { have: 1, need: 3 }], ["first_buy", {}], ["research", { have: 1, need: 3 }], ["other", {}]];
  for (const [key, u] of unlocks) {
    const en = copy.unlockText("discipline", { key, ...u }), hi = copy.unlockText("discipline", { key, ...u }, true);
    ok(`copy: unlock "${key}" in both languages`, en.length > 12 && hi.length > 12 && en !== hi && !bad.test(en + hi), en);
  }
  ok("copy: the unlock line counts what is left", /You have 2, 3 to go/.test(copy.unlockText("discipline", { key: "trades", have: 2, need: 5 })));

  // The lines handed to the AI card.
  const graded = seen.find((rc) => rc.overall.state === "graded" && rc.pillars.market.state === "hidden" && rc.pillars.diversification.state === "locked");
  const lines = copy.promptLines(graded);
  ok("prompt lines: lead with the grade on screen", lines[0] === `Overall grade: ${graded.overall.grade} (${graded.overall.score}/100)`);
  ok("prompt lines: a locked part is called locked, a hidden one is left out", lines.some((l) => /^Diversification.*locked/.test(l)) && !lines.some((l) => /Nifty/.test(l)));
  ok("prompt lines: fit the server's limit of 24", lines.length <= 24 && lines.every((l) => l.length <= 240));
  ok("prompt lines: ungraded card says so", /not graded yet/.test(copy.promptLines(seen[0])[0]));
  ok("summary: a graded card names its strongest and weakest part", /Strongest: .*Most room to grow: /.test(copy.overallSummary({ state: "graded", best: "learning", worst: "discipline" })));
}

// ---- 15b. Found by running all 3,399 real users' cards (13 Nov) --------------------------------
{
  // Old account, nothing logged this week yet: the reader is in the app now.
  const quiet = weeksOf((i) => (i === 3 ? [2, 0, 0, 0] : [0, 0, 0, 0])).filter((w) => w[1] > 0);
  const trades = spread(12, 60, 5);
  const page = score(base({ trades, activity: { weeks: quiet }, activeNow: true })).pillars.learning;
  const admin = score(base({ trades, activity: { weeks: quiet } })).pillars.learning;
  const wPage = page.facts.find((f) => f.key === "weeks"), wAdmin = admin.facts.find((f) => f.key === "weeks");
  ok("learning: the reader counts as here this week", wPage.active === 2 && wPage.of === 8, JSON.stringify(wPage));
  ok("learning: the admin view keeps the real count", wAdmin.active === 1, JSON.stringify(wAdmin));
  ok("learning: activeNow never lowers the score", page.score >= admin.score);
  ok("copy: zero weeks is not '0 of'", !/\b0 of\b/.test(copy.factText({ key: "weeks", active: 0, of: 4 })) && /not opened in the last 4 weeks/.test(copy.factText({ key: "weeks", active: 0, of: 4 })));
  ok("copy: zero researched buys reads 'None of'", /^None of your last 3 new buys/.test(copy.factText({ key: "researched", n: 0, of: 3 })) && !/ 0 /.test(copy.factText({ key: "researched", n: 0, of: 3 }, true)));
  ok("copy: one impulse buy is singular", /1 of 5 was bought/.test(copy.factText({ key: "impulse", n: 1, of: 5 })) && /1 buy stock/.test(copy.factText({ key: "impulse", n: 1, of: 5 }, true)) && /2 of 5 were bought/.test(copy.factText({ key: "impulse", n: 2, of: 5 })));
}

// ---- 16. Nothing scored in this file contains a broken number --------------------------------
{
  const broken = seen.map((rc) => clean(rc)).filter(Boolean);
  ok("no NaN, Infinity or undefined in any card", broken.length === 0, broken.slice(0, 3).join(" | "));
  ok("every score is a whole number from 0 to 100", seen.every((rc) => Object.values(rc.pillars).every((p) => p.state !== "scored" || (Number.isInteger(p.score) && p.score >= 0 && p.score <= 100))));
  ok("every scored part shows 1 to 3 facts", seen.every((rc) => Object.values(rc.pillars).every((p) => p.state !== "scored" || (p.facts.length >= 1 && p.facts.length <= 3))));
  ok("every locked part says what unlocks it", seen.every((rc) => Object.values(rc.pillars).every((p) => p.state !== "locked" || (p.unlock && p.unlock.key))));
}

// ---- 17. The weekly card: plating per part, the letter that holds, smoothed profit ------
{
  const W = await import("../js/coach/reportCardWeek.js");
  const A = await import("../js/coach/reportCardArt.js");

  // plating per part: each part has its own cut points
  ok("results 49 is bronze, 50 (break even) is silver", W.partPlating("results", 49) === "bronze" && W.partPlating("results", 50) === "silver");
  ok("vs Nifty 50 (level with the index) is gold", W.partPlating("market", 50) === "gold" && W.partPlating("market", 49) === "silver");
  ok("the same marks plate differently by part", W.partPlating("learning", 75) === "platinum" && W.partPlating("discipline", 75) === "bronze");
  ok("research 25 / 50 / 75", ["bronze", "silver", "gold", "platinum"].join() === [24, 25, 50, 75].map((x) => W.partPlating("research", x)).join());
  ok("discipline 100 with few trades stops at gold", W.partPlating("discipline", 100, { trades: 8 }) === "gold" && W.partPlating("discipline", 100, { trades: 20 }) === "platinum");
  ok("a locked part has no plating", W.partPlating("research", null) === null && W.partPlating("nope", 50) === null);
  ok("every part has three rising cut points", W.PART_KEYS.every((k) => { const c = W.PLATING_CUTS[k]; return c && c.length === 3 && c[0] < c[1] && c[1] < c[2] && c[2] <= 100; }));
  const np = W.nextPlating("research", 37);
  ok("next plating: research 37 needs 13 more for gold", np.plating === "gold" && np.at === 50 && np.left === 13);
  ok("no next plating at the top", W.nextPlating("learning", 90) === null);
  ok("discipline at 100 with few trades: the next plating waits for trades, not marks", W.nextPlating("discipline", 100, { trades: 8 })?.needsTrades === true);

  // the letter that holds
  ok("no saved card: the plain letter", W.stickyGrade(68, null) === "B+" && W.stickyGrade(69, undefined) === "A");
  ok("going up happens at the cut point", W.stickyGrade(69, "B+") === "A" && W.stickyGrade(75, "B") === "A+");
  ok("going down waits for 2 marks under the cut", W.stickyGrade(68, "A") === "A" && W.stickyGrade(67, "A") === "A" && W.stickyGrade(66, "A") === "B+");
  ok("a big fall is not held", W.stickyGrade(56, "A") === "B" && W.stickyGrade(30, "A+") === "D");
  ok("a held letter needs the cut point again once lost", W.stickyGrade(68, "B+") === "B+");
  ok("an unknown saved letter is ignored", W.stickyGrade(60, "Z") === "B");
  ok("no score, no letter", W.stickyGrade(null, "A") === null);
  ok("card plating follows the letter", ["platinum", "gold", "silver", "bronze", "bronze", "plain"].join() === ["A+", "A", "B+", "B", "C", "D"].map(W.cardPlating).join());

  // profit, smoothed
  const dayIso = (ago) => new Date(NOW + 5.5 * 3600_000 - ago * DAY).toISOString().slice(0, 10);
  const curve = [[dayIso(4), 1_000_000], [dayIso(3), 1_010_000], [dayIso(2), 1_020_000], [dayIso(1), 1_030_000]];
  // live value 1,100,000 and live profit 100,000: the saved days read 0, 10k, 20k, 30k
  ok("the middle of five days", W.smoothedPl(100_000, 1_100_000, curve, NOW) === 20_000);
  ok("one sharp day does not move it", W.smoothedPl(-400_000, 600_000, curve, NOW) === 10_000);
  ok("fewer than two saved days: the live figure", W.smoothedPl(100_000, 1_100_000, curve.slice(-1), NOW) === 100_000 && W.smoothedPl(5, 10, null, NOW) === 5);
  ok("today's own row and stale rows are left out", W.smoothedPl(100_000, 1_100_000, [[dayIso(40), 1], [dayIso(30), 1], [dayIso(0), 1]], NOW) === 100_000);
  ok("four values: the mean of the middle two", W.smoothedPl(100_000, 1_100_000, curve.slice(-3), NOW) === 25_000);
  ok("a broken live figure passes through", Number.isNaN(W.smoothedPl(NaN, 1, curve, NOW)));
  {
    const base = { now: NOW, trades: [tr(40, "TCS", "BUY", 10, 100_000)], stats: computeTradeStats([]), portfolio: { cashPaise: 0, positions: [] } };
    const live = core.scoreReportCard({ ...base, profit: { plPaise: 100_000 } }).pillars.results;
    const smooth = core.scoreReportCard({ ...base, profit: { plPaise: 100_000, scorePlPaise: 0 } }).pillars.results;
    ok("Results is scored on the smoothed profit", smooth.score < live.score && near(smooth.score, 50, 1), `${live.score} ${smooth.score}`);
    ok("the sentence still quotes the live profit", smooth.facts[0].plPaise === 100_000);
  }

  // the week
  ok("the week starts on Monday, IST", W.weekStartIso(Date.UTC(2026, 10, 13, 6)) === "2026-11-09" && W.weekStartIso(Date.UTC(2026, 10, 15, 18, 0)) === "2026-11-09" && W.weekStartIso(Date.UTC(2026, 10, 15, 18, 45)) === "2026-11-16");
  const prev = { discipline: 74, results: 57, research: 25, diversification: 62, learning: 61, market: null };
  const nowP = { discipline: 80, results: 58, research: 37, diversification: 62, learning: 53, market: 47 };
  const ch = W.changesSince(prev, nowP);
  ok("changes: 3 marks or more, biggest first, new parts left out", ch.map((c) => c.key).join() === "research,learning,discipline" && ch[1].by === -8);
  ok("direction of a part", W.dirOf(25, 37) === "up" && W.dirOf(61, 53) === "down" && W.dirOf(57, 58) === "flat" && W.dirOf(null, 47) === "flat");
  const saved = [{ week: "2026-10-12", score: 49, grade: "C" }, { week: "2026-10-26", score: 57, grade: "B" }, { week: "2026-11-02", score: 60, grade: "B" }, { week: "2026-11-09", score: 62, grade: "B+" }, { week: "2026-11-16", score: 63, grade: "B+" }];
  const row = W.weekRow(saved, { score: 64, grade: "B+" }, "2026-11-16");
  ok("week row: three past cards then this week, live", row.length === 4 && row[0].week === "2026-10-26" && row[3].now && row[3].score === 64 && row[2].plating === "silver");
  ok("this week's saved row is not 'last week'", W.lastWeek(saved, "2026-11-16").week === "2026-11-09" && W.lastWeek([], "2026-11-16") === null);
  const rd = W.road(64, "B+", saved);
  ok("the road: far, next, here, done, done", rd.map((r) => r.state).join() === "far,next,here,done,done" && rd[1].left === 5 && rd[3].since === "2026-10-26" && rd[2].since === "2026-11-09");
  ok("the road at D ends on D", W.road(30, "D", []).slice(-1)[0].grade === "D" && W.road(30, "D", []).filter((r) => r.state === "here").length === 1);
  ok("the road at A+ has no next", W.road(80, "A+", []).every((r) => r.state !== "next") && W.nextGrade(80, "A+") === null);
  ok("marks to the next letter", W.nextGrade(64, "B+").grade === "A" && W.nextGrade(64, "B+").left === 5 && W.nextGrade(67, "A").grade === "A+");
  const rcLike = { pillars: { discipline: { state: "scored", score: 80, key: "discipline" }, results: { state: "scored", score: 58, key: "results" }, research: { state: "locked", key: "research" }, diversification: { state: "scored", score: 62, key: "diversification" }, learning: { state: "scored", score: 53, key: "learning" }, market: { state: "scored", score: 99, key: "market" } } };
  ok("parts of a card: locked is null", W.partsOf(rcLike).research === null && W.partsOf(rcLike).discipline === 80);
  ok("standouts leave vs Nifty out", W.standouts(rcLike).best.key === "discipline" && W.standouts(rcLike).low.key === "learning");

  // the drawings
  const stats = W.PART_KEYS.map((k) => ({ key: k, score: nowP[k], dir: W.dirOf(prev[k], nowP[k]) }));
  const card = A.cardSvg({ score: 64, grade: "B+", name: `<Aarav & "co">`, plating: "silver", art: { key: "discipline", tier: "gold" }, stats, label: "Report card: 64 marks, grade B+" });
  ok("the card prints the marks, the letter and all six parts", card.includes(">64<") && card.includes(">B+<") && ["DIS", "RES", "REA", "SPR", "LRN", "NIF"].every((x) => card.includes(">" + x + "<")));
  ok("the name is escaped", card.includes("&lt;Aarav &amp; &quot;co&quot;&gt;") && !card.includes("<Aarav"));
  ok("a card being built shows trades, not marks", A.cardSvg({ building: { have: 3, need: 5 }, stats: [] }).includes(">3/5<"));
  ok("a long name shrinks to fit", /font-size="1[1-4]" font-weight="900" fill="#1C2340">Meenakshi Sundaram Iy/.test(A.cardSvg({ score: 70, grade: "A", name: "Meenakshi Sundaram Iyer", stats: [] })));
  const mini = A.miniSvg({ score: 69, grade: "A", next: true });
  ok("the coming card is a dashed outline", mini.includes("stroke-dasharray") && !mini.includes("url(#"));
  const share = A.shareSvg({ card: { score: 64, grade: "B+", name: "Aarav", plating: "silver", stats }, week: "Week of 16 Nov", nums: [{ big: "B+", small: "this week" }, { big: "64", small: "marks of 100" }], fontCss: "@font-face{font-family:Inter}" });
  ok("the picture stands alone: its own gradients and font", share.startsWith("<svg xmlns=") && share.includes('id="rcm-silver"') && share.includes('id="achm-silver"') && share.includes("@font-face{font-family:Inter}"));
  ok("the picture carries no rupee amount", !share.includes("₹") && !/Rs\b/.test(share));
  const all = card + mini + share + A.miniSvg({ score: 64, grade: "B+", plating: "silver" }) + A.sealSvg("A+", 44, "platinum") + A.sealSvg("D", 44, "plain") + A.starSvg("#123456");
  ok("no blur, glow or drop shadow anywhere in the art", !/filter=|<filter|blur|drop-shadow|feGaussian/i.test(all));
  ok("a gradient only on metal: every gradient fill is a plating", (all.match(/url\(#[^)]+\)/g) || []).every((u) => /^url\(#(rcm|achm)-(bronze|silver|gold|platinum)\)$/.test(u)));
  ok("no broken number in the art", !/NaN|undefined|Infinity/.test(all));
}

console.log(`report card: ${pass}/${pass + fail} passing`);
if (fail) process.exit(1);
