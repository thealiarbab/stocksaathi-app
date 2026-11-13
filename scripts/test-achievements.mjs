// scripts/test-achievements.mjs — the achievement rules (js/achievements/core.js).
//
// The database awards achievements (public._ach_facts / _ach_award); the JS
// module is the same rules written as pure functions, so the edge cases are
// pinned down here: no trades, only buys, a split price mismatch, a user who
// earns 40 at once, the streak grace day, plus the catalogue itself (80+,
// tiers that climb, copy in English and Hinglish, nothing that rewards
// trading more) and the checks every AI-drafted concept must pass.
//
// Run:  node scripts/test-achievements.mjs
import * as A from "../js/achievements/core.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-13T06:00:00Z");           // 11:30 IST, 13 Nov 2026
const at = (daysAgo, hourUtc = 5) => new Date(Date.UTC(2026, 10, 13 - daysAgo, hourUtc, 0)).toISOString();
const ymd = (daysAgo) => at(daysAgo).slice(0, 10);
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log("FAIL", name, extra === "" ? "" : JSON.stringify(extra)); } };

const DEFS = A.buildDefs();
const byCode = new Map(DEFS.map((d) => [d.code, d]));
const earned = (facts, season = {}) => new Set(A.evaluate({ ...facts, season }, DEFS).map((x) => x.code));
const buy = (symbol, qty, rupees, daysAgo, extra = {}) => ({ symbol, side: "BUY", qty, price_paise: Math.round(rupees * 100), created_at: at(daysAgo), ...extra });
const sell = (symbol, qty, rupees, daysAgo, extra = {}) => ({ symbol, side: "SELL", qty, price_paise: Math.round(rupees * 100), created_at: at(daysAgo), ...extra });
// Real closes for `days` sessions ending today, from a function of days-ago.
const closes = (days, f) => Array.from({ length: days + 1 }, (_, i) => [ymd(days - i), Math.round(f(days - i) * 100)]);
const INST = {
  TCS: { sector: "IT Services" }, INFY: { sector: "IT Services" }, HDFCBANK: { sector: "Banking" },
  ITC: { sector: "FMCG" }, RELIANCE: { sector: "Energy" }, SUNPHARMA: { sector: "Pharma" },
  NIFTYBEES: { sector: "ETF", isFund: true }, JUNK: { sector: "Other" },
};

// ---------------------------------------------------------------- catalogue
{
  ok("catalogue: 80+ achievements", DEFS.length >= 80, DEFS.length);
  ok("catalogue: codes unique", new Set(DEFS.map((d) => d.code)).size === DEFS.length);
  ok("catalogue: codes fit the table check", DEFS.every((d) => /^[a-z0-9_]{2,60}$/.test(d.code)));
  for (const cat of A.CATEGORIES) ok(`catalogue: has ${cat.key}`, DEFS.some((d) => d.category === cat.key));
  ok("catalogue: has tiers up to platinum", DEFS.some((d) => d.tier === 4));
  const fams = new Map();
  for (const d of DEFS) { if (!fams.has(d.family)) fams.set(d.family, []); fams.get(d.family).push(d); }
  for (const [f, list] of fams) {
    const t = list.map((d) => d.threshold);
    ok(`catalogue: ${f} thresholds climb`, t.every((v, i) => i === 0 || v > t[i - 1]), t);
  }
  for (const d of DEFS) {
    const text = [d.name_en, d.name_hi, d.desc_en, d.desc_hi, d.why_en, d.why_hi].join(" | ");
    ok(`copy ${d.code}: both languages`, d.name_hi && d.desc_hi && d.why_hi && d.name_en && d.desc_en && d.why_en);
    ok(`copy ${d.code}: description fully filled`, !/\{[a-z_]+\}|undefined|NaN/.test(d.desc_en + d.desc_hi), d.desc_en);
    ok(`copy ${d.code}: no pressure or trade-more wording`, !/lose your streak|don't lose|streak khatam|trade every day|\d+ trades/i.test(d.desc_en + d.desc_hi), text);
  }
  // No achievement may be a count of trades (overtrading is a flagged habit).
  ok("rules: only first_steps reads the trade count", DEFS.filter((d) => d.metric === "trades").every((d) => d.family === "first_steps" && d.threshold === 1));
  for (const d of DEFS.filter((x) => x.metric === "season")) {
    ok(`season ${d.code}: uses allowed metrics only`, Object.keys(d.rule.need).every((k) => k in A.SEASON_METRICS), d.rule);
  }
}

// ---------------------------------------------------------------- fill
{
  ok("fill: numbers and arrays", A.fill("{n} of {sectors}", { n: 3, sectors: ["Auto", "FMCG"] }) === "3 of Auto, FMCG");
  ok("fill: one decimal", A.fill("{pct}%", { pct: 13.94 }) === "13.9%");
  ok("fill: missing key is a dash, not undefined", A.fill("{symbol} held", {}) === "— held");
  ok("fill: singular description", byCode.get("your_price_bronze").desc_en === "Get 1 limit order filled at the price you chose.");
  ok("fill: plural description", byCode.get("your_price_silver").desc_en === "Get 5 limit orders filled at the price you chose.");
}

// ---------------------------------------------------------------- no trades
{
  const f = A.deriveFacts({ now: NOW, createdAt: at(3), trades: [], instruments: INST, events: [] });
  const got = earned(f);
  ok("no trades: nothing earned", got.size === 0, [...got]);
  ok("no trades: every metric is zero", Object.values(f.m).every((v) => v === 0), f.m);
  ok("no trades: progress 0 not NaN", A.progressFor(byCode.get("long_termer_bronze"), f).pct === 0);
}

// ---------------------------------------------------------------- only buys
{
  const trades = [buy("TCS", 2, 3500, 40), buy("HDFCBANK", 5, 1600, 35), buy("ITC", 10, 420, 34), buy("RELIANCE", 3, 1300, 10)];
  const f = A.deriveFacts({
    now: NOW, createdAt: at(60), trades, instruments: INST, events: [{ kind: "page_view", subject: "/portfolio", at: at(1) }],
    closes: { TCS: closes(45, () => 3500), HDFCBANK: closes(40, () => 1600), ITC: closes(40, () => 420), RELIANCE: closes(15, () => 1300) },
  });
  const got = earned(f);
  ok("only buys: first steps", got.has("first_steps"));
  ok("only buys: no profit booked", !got.has("first_profit") && f.m.profit_booked === 0);
  ok("only buys: longest hold is the open TCS position", f.m.max_hold_days === 40 && f.ev.max_hold_days.symbol === "TCS", f.ev.max_hold_days);
  ok("only buys: long termer bronze", got.has("long_termer_bronze") && !got.has("long_termer_silver"));
  ok("only buys: 4 sectors at once", f.m.max_sectors === 4 && got.has("spread_out_bronze"), f.ev.max_sectors);
  ok("only buys: flat prices are no dip", f.m.dip_pct === 0 && !got.has("held_the_line_bronze"));
  ok("only buys: member days while active", f.m.member_days === 60);
}

// ---------------------------------------------------------------- holding through a dip, and a comeback
{
  // Bought at 1000, real close falls to 870 (-13%), then recovers to 1020.
  const path = (d) => (d > 20 ? 1000 : d > 10 ? 1000 - (20 - d) * 13 : 870 + (10 - d) * 15);
  const f = A.deriveFacts({ now: NOW, createdAt: at(40), trades: [buy("INFY", 10, 1000, 30)], instruments: INST, events: [], closes: { INFY: closes(30, path) } });
  const got = earned(f);
  ok("dip: 13% low measured on real closes", f.m.dip_pct === 13 && f.ev.dip_pct.symbol === "INFY", f.ev.dip_pct);
  ok("dip: held the line silver, not gold", got.has("held_the_line_silver") && !got.has("held_the_line_gold"));
  ok("dip: comeback counted", f.m.comebacks === 1 && got.has("comeback_bronze"));
  // A partial sell is not the end of the holding.
  const f2 = A.deriveFacts({ now: NOW, trades: [buy("INFY", 10, 1000, 30), sell("INFY", 4, 1010, 5)], instruments: INST, events: [], closes: { INFY: closes(30, path) } });
  ok("dip: a trim keeps the holding open", f2.m.max_hold_days === 30);
}

// ---------------------------------------------------------------- split price mismatch
{
  // The buy went through at 4,239 but split-adjusted history says ~2,834
  // that day (the TRENT case): no price-based achievement may judge it.
  const f = A.deriveFacts({ now: NOW, trades: [buy("TCS", 5, 4239, 30)], instruments: INST, events: [], closes: { TCS: closes(30, (d) => (d > 15 ? 2834 : 2400)) } });
  ok("split mismatch: no dip awarded", f.m.dip_pct === 0 && !earned(f).has("held_the_line_bronze"), f.m.dip_pct);
  // A 1:2 split while held, in the unadjusted exchange file: a one-day fall
  // below 60% of the previous close is a corporate action, not a dip.
  const f2 = A.deriveFacts({ now: NOW, trades: [buy("ITC", 10, 400, 30)], instruments: INST, events: [], closes: { ITC: closes(30, (d) => (d > 10 ? 400 : 200)) } });
  ok("corporate action: not a 50% dip", f2.m.dip_pct === 0, f2.m.dip_pct);
  // No real close at all (a fund priced only by NAV): not judged either.
  const f3 = A.deriveFacts({ now: NOW, trades: [buy("NIFTYBEES", 10, 280, 30)], instruments: INST, events: [], closes: {} });
  ok("no closes: not judged", f3.m.dip_pct === 0 && f3.m.fund_hold_days === 30);
}

// ---------------------------------------------------------------- profit and patience
{
  const trades = [buy("ITC", 10, 400, 50), buy("ITC", 10, 440, 45), sell("ITC", 20, 450, 2), buy("HDFCBANK", 2, 1600, 3), sell("HDFCBANK", 2, 1580, 1)];
  const f = A.deriveFacts({ now: NOW, trades, instruments: INST, events: [] });
  ok("profit: above the running average (420), not the first buy", f.m.profit_booked === 1 && f.ev.profit_booked.pct === 7.1, f.ev.profit_booked);
  ok("patience: profit after 30+ days counts once per holding", f.m.patient_profits === 1);
  ok("patience: a loss is not a win", f.ev.patient_profits.symbol === "ITC");
}

// ---------------------------------------------------------------- calm hands (flags)
{
  const flag = [{ bias: "churning", severity: 0.7 }];
  const fill_ = [{ bias: "limit_order_filled" }];       // not a behaviour flag
  const trades = [
    buy("TCS", 1, 3500, 18, { bias_flags: [] }), buy("ITC", 1, 400, 16, { bias_flags: fill_ }), buy("INFY", 1, 1500, 9, { bias_flags: [] }),
    buy("TCS", 1, 3500, 8, { bias_flags: flag }),
    buy("ITC", 1, 400, 6), buy("ITC", 1, 400, 3),
  ];
  const f = A.deriveFacts({ now: NOW, trades, instruments: INST, events: [] });
  ok("calm: longest unflagged run of 3+ trades", f.m.calm_days === 9 && f.ev.calm_days.trades === 3, f.ev.calm_days);
  ok("calm: bronze at 7 days", earned(f).has("calm_hands_bronze") && !earned(f).has("calm_hands_silver"));
  const old = A.deriveFacts({ now: NOW, trades: [buy("TCS", 1, 3500, 60), buy("TCS", 1, 3500, 50), buy("TCS", 1, 3500, 40)], instruments: INST, events: [] });
  ok("calm: trades before flags existed do not count", old.m.calm_days === 0);
}

// ---------------------------------------------------------------- streak grace day
{
  const ev = (k, daysAgo, subject = null) => ({ kind: k, at: at(daysAgo), subject });
  // Learned Mon, Tue, (missed Wed), Thu, Fri: one streak of 4 learning days.
  const f = A.deriveFacts({ now: NOW, trades: [], instruments: INST, events: [ev("chat_user", 10), ev("news_click", 9), ev("replay_finish", 7, "COVID_2020"), ev("learn", 6, "term:pe")] });
  ok("grace: one missed day keeps the streak", f.m.learn_streak === 4, f.m.learn_streak);
  // Two missed days in a row break it.
  const g = A.deriveFacts({ now: NOW, trades: [], instruments: INST, events: [ev("chat_user", 10), ev("chat_user", 9), ev("chat_user", 6), ev("chat_user", 5)] });
  ok("grace: two missed days break it", g.m.learn_streak === 2, g.m.learn_streak);
  // Browsing the portfolio is not learning.
  const h = A.deriveFacts({ now: NOW, trades: [], instruments: INST, events: [ev("page_view", 3, "/portfolio"), ev("page_view", 2, "/portfolio"), ev("page_view", 1, "/portfolio")] });
  ok("grace: page views are visits, not learning", h.m.learn_streak === 0 && h.m.visit_days === 3);
  ok("grace: bestRun direct", A.bestRun(["2026-11-01", "2026-11-03", "2026-11-05", "2026-11-08"], A.GRACE_DAYS) === 3);
  ok("weekly: one missed week forgiven", A.bestRun(["2026-10-05", "2026-10-12", "2026-10-26", "2026-11-02"].map(A.weekOf), A.GRACE_WEEKS * 7) === 4);
  ok("weekly: Monday weeks", A.weekOf("2026-11-15") === "2026-11-09");
}

// ---------------------------------------------------------------- 40 at once, one summary
{
  const evs = [];
  for (let d = 70; d >= 0; d--) {
    evs.push({ kind: "page_view", subject: "/portfolio", at: at(d) });
    if (d % 2 === 0) evs.push({ kind: "chat_user", at: at(d) });
    if (d % 7 === 0) evs.push({ kind: "news_click", at: at(d) });
  }
  ["COVID_2020", "GFC_2008", "DEMO_2016", "CUSTOM_A", "CUSTOM_B"].forEach((s, i) => evs.push({ kind: "replay_finish", subject: s, at: at(20 + i) }));
  for (let i = 0; i < 80; i++) evs.push({ kind: "stock_view", subject: "S" + i, at: at(70 - (i % 60)) });
  ["TCS", "INFY", "HDFCBANK", "ITC", "RELIANCE", "SUNPHARMA"].forEach((s) => evs.push({ kind: "stock_view", subject: s, at: at(100) }));
  for (let i = 0; i < 10; i++) evs.push({ kind: "page_view", subject: "/learn/lesson-" + i, at: at(30 - i) });
  const trades = [
    buy("TCS", 2, 3500, 200), buy("INFY", 5, 1500, 100), buy("HDFCBANK", 3, 1600, 95), buy("ITC", 10, 400, 95),
    buy("RELIANCE", 4, 1300, 95), buy("SUNPHARMA", 3, 1700, 95), buy("NIFTYBEES", 20, 280, 95), buy("NIFTYBEES", 5, 285, 60),
    buy("NIFTYBEES", 5, 290, 30), sell("ITC", 10, 450, 20),
  ];
  const f = A.deriveFacts({
    now: NOW, createdAt: at(200), trades, instruments: INST, events: evs, limitFills: 6,
    holdings: [["TCS", 2, 3600], ["INFY", 5, 1550], ["HDFCBANK", 3, 1650], ["RELIANCE", 4, 1350], ["SUNPHARMA", 3, 1750], ["NIFTYBEES", 30, 300]]
      .map(([symbol, qty, r]) => ({ symbol, qty, price_paise: r * 100 })),
    closes: { INFY: closes(100, (d) => (d > 60 ? 1500 : d > 40 ? 1250 : 1560)) },
  });
  const list = A.evaluate({ ...f, season: {} }, DEFS);
  ok("big user: 40+ earned at once", list.length >= 40, list.length);
  const plan = A.deliveryPlan(list.map((x) => ({ ...x, tier: byCode.get(x.code).tier })));
  ok("big user: ONE summary, not a toast each", plan.kind === "summary" && plan.count === list.length);
  ok("big user: summary leads with the highest tiers", plan.top[0].tier >= plan.top[2].tier);
  ok("two new: shown one by one", A.deliveryPlan([{ tier: 1 }, { tier: 2 }]).kind === "each");
  const why = list.map((x) => A.fill(byCode.get(x.code).why_en, x.evidence));
  ok("big user: every reason filled with real numbers", why.every((s) => !/—|undefined|NaN/.test(s)), why.filter((s) => /—|undefined|NaN/.test(s)));
  ok("big user: platinum long termer", list.some((x) => x.code === "long_termer_platinum"));
  ok("big user: balanced basket", f.m.balanced_level >= 2, f.ev.balanced_level);
  ok("big user: three fund months", f.m.fund_months === 3);
}

// ---------------------------------------------------------------- seasons
{
  const events = [
    { id: 1, kind: "rbi_policy", name: "RBI policy, 7 Oct 2026", starts_on: "2026-10-07", ends_on: "2026-10-07" },
    { id: 2, kind: "diwali", name: "Diwali 2026", starts_on: "2026-11-08", ends_on: "2026-11-08" },
    { id: 3, kind: "budget", name: "Union Budget 2027", starts_on: "2027-02-01", ends_on: "2027-02-01" },
  ];
  const input = {
    now: NOW,
    trades: [buy("TCS", 1, 3500, 40)],
    events: [{ kind: "chat_user", at: "2026-10-08T07:00:00Z" }, { kind: "page_view", subject: "/portfolio", at: "2026-11-08T09:30:00Z" }],
  };
  const s = A.deriveSeason(input, DEFS, events);
  ok("season: learned the day after RBI policy (pad +1)", s.rate_watcher_bronze?.n === 1 && s.rate_watcher_bronze.event === "RBI policy, 7 Oct 2026");
  ok("season: muhurat visit", s.muhurat?.n === 1);
  ok("season: Diwali hold not judged before the window closes", !s.diwali_holder_bronze, s.diwali_holder_bronze);
  const later = A.deriveSeason({ ...input, now: Date.parse("2026-11-20T06:00:00Z") }, DEFS, events);
  ok("season: Diwali hold judged after it", later.diwali_holder_bronze?.n === 1);
  ok("season: future budget counts nothing", !s.budget_buff_bronze);
  ok("season: window pads", JSON.stringify(A.windowOf(events[1], [14, 7])) === JSON.stringify(["2026-10-25", "2026-11-15"]));
}

// ---------------------------------------------------------------- AI drafts
{
  const good = { name_en: "Budget Day Learner", name_hi: "Budget Ka Din", desc_en: "Ask Saathi one question about the Budget.", desc_hi: "Budget par Saathi se ek sawaal poocho.",
    why_en: "You asked about {event}.", why_hi: "Tumne {event} par sawaal poocha.", tier: 1, need: { questions: 1 }, pad: [0, 1] };
  ok("draft: a good concept passes", A.validateDraft(good).length === 0, A.validateDraft(good));
  ok("draft: trade counts refused", A.validateDraft({ ...good, need: { trades: 5 } }).includes("need.trades"));
  ok("draft: trade-more copy refused", A.validateDraft({ ...good, desc_en: "Make 10 trades during the Budget week." }).includes("rewards_bad_habit"));
  ok("draft: streak pressure refused", A.validateDraft({ ...good, why_en: "Don't lose your streak!" }).includes("rewards_bad_habit"));
  ok("draft: silly minimums refused", A.validateDraft({ ...good, need: { stock_views: 500 } }).length > 0);
  ok("draft: wide windows refused", A.validateDraft({ ...good, pad: [0, 40] }).includes("pad"));
  ok("draft: tier 4 refused", A.validateDraft({ ...good, tier: 4 }).includes("tier"));
}

console.log(`achievements: ${pass}/${pass + fail} passing`);
if (fail) process.exit(1);
