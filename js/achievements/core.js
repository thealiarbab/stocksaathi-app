// =============================================================================
// ACHIEVEMENTS — the catalogue and the rules, as pure functions.
//
// No imports and no browser APIs, so Node runs this exact file in
// scripts/test-achievements.mjs and scripts/achievements-seed.mjs.
//
// Who decides: the DATABASE awards achievements (public._ach_facts +
// _ach_award, migration 2026-11-13b), from the trades, events and real
// closes it holds. deriveFacts() below is the same rules written in JS: the
// reference the SQL mirrors, and what the Node tests pin down (no trades,
// only buys, a split price mismatch, a user who earns 40 at once, the
// streak grace day). The browser never awards anything; it only shows what
// the server returned, filling the copy with fill().
//
// The catalogue is seeded into public.achievement_defs from here
// (node scripts/achievements-seed.mjs > the seed SQL). AI-drafted seasonal
// ones live only in the table, as status 'draft' until the owner approves.
//
// Never reward bad habits: no trade counts, no "trade every day". Rewards are
// for holding through a dip, spreading money out, patience, learning and
// coming back to learn. Streaks forgive a missed day (GRACE_DAYS) and never
// warn about losing a streak.
//
// You have to be around (25 Nov 2026): days held, a dip held through and a
// comeback count only while the user has been active in the last 14 days
// (ACTIVE_DAYS). Measured on every account: about 9 in 10 "patience" awards
// were going to accounts that had left, for a holding nobody was watching.
// =============================================================================

export const TIERS = [
  null,
  { key: "bronze", en: "Bronze", hi: "Bronze" },
  { key: "silver", en: "Silver", hi: "Silver" },
  { key: "gold", en: "Gold", hi: "Gold" },
  { key: "platinum", en: "Platinum", hi: "Platinum" },
];

export const CATEGORIES = [
  { key: "milestone", en: "Milestones", hi: "Milestones" },
  { key: "habit", en: "Good habits", hi: "Achhi aadatein" },
  { key: "learning", en: "Learning", hi: "Seekhna" },
  { key: "streak", en: "Coming back", hi: "Wapas aana" },
  { key: "season", en: "Market calendar", hi: "Market calendar" },
];

// A learning streak survives one missed day: two active days at most this
// many calendar days apart are one streak (Mon, Wed, Thu = 3 days).
export const GRACE_DAYS = 2;
// Weekly regular: one missed week is forgiven the same way.
export const GRACE_WEEKS = 2;
// Time-based metrics count only for a user active this recently.
export const ACTIVE_DAYS = 14;
// Red Day Calm: a session where the market (Nifty 50 ETF close) fell this much.
export const RED_DAY_DROP = 0.01;
// Trades flagged by the coach (bias_flags with a severity) start counting
// on this day; older trades carry no flags at all.
export const FLAG_ERA = "2026-10-24";
export const FLAG_MIN_SEVERITY = 0.5;
// Same guard as the bias detectors: a buy price more than 25% away from that
// day's real close is a data mismatch (split-adjusted history, a bad quote),
// so no price-based achievement judges that holding.
export const PRICE_MISMATCH = 0.25;
// A close below 60% of the one before is a corporate action (split, bonus) in
// the unadjusted exchange file, not a dip anyone held through.
export const CORP_ACTION_DROP = 0.6;

// Metrics an AI-drafted seasonal achievement may use. Nothing here counts
// trades: the coach flags overtrading, so no achievement may ask for it.
export const SEASON_METRICS = {
  visit_days: "days the app was opened in the window",
  learn_actions: "questions to the coach, crash replays, news and lessons read",
  stock_views: "different stocks looked at",
  report_views: "times the report card was opened",
  review_views: "times the portfolio or report card was opened",
  held_through: "1 if a position was held through the whole window",
  questions: "questions asked to the coach",
  replays: "crash replays finished",
  news_reads: "news stories opened",
};

// ---------------------------------------------------------------------------
// The catalogue. One family = one rule with 1-4 tiers. `t` in the copy is the
// tier's threshold; other {keys} come from the user's own evidence.
// ---------------------------------------------------------------------------
export const FAMILIES = [
  // ---------------------------------------------------------------- milestones
  {
    family: "first_steps", category: "milestone", emoji: "🌱", metric: "trades", tiers: [1],
    name: { en: "First Steps", hi: "Pehla Kadam" },
    desc: { en: "Place your first trade.", hi: "Apna pehla trade karo." },
    why: { en: "Your first trade was {symbol} on {date}.", hi: "Tumhara pehla trade {symbol} tha, {date} ko." },
  },
  {
    family: "first_profit", category: "milestone", emoji: "🪙", metric: "profit_booked", tiers: [1],
    name: { en: "First Profit Booked", hi: "Pehla Munafa" },
    desc: { en: "Sell shares for more than you paid.", hi: "Shares ko kharid se zyada daam pe becho." },
    why: { en: "You sold {symbol} {pct}% above what you paid.", hi: "Tumne {symbol} kharid se {pct}% upar becha." },
  },
  {
    family: "your_price", category: "milestone", emoji: "🎯", metric: "limit_fills", tiers: [1, 5],
    name: { en: "Your Price", hi: "Apna Daam" },
    desc: { en: "Get {t} limit order{s} filled at the price you chose.", hi: "{t} limit order apne chune hue daam pe fill karwao." },
    why: { en: "Limit orders filled at your price: {n}.", hi: "Tumhare {n} limit order tumhare daam pe fill hue." },
  },
  {
    family: "fund_first", category: "milestone", emoji: "🧺", metric: "fund_buys", tiers: [1],
    name: { en: "Basket Buyer", hi: "Basket Wala" },
    desc: { en: "Buy your first mutual fund or ETF: many companies in one go.", hi: "Pehla mutual fund ya ETF kharido: ek saath kai companies." },
    why: { en: "Your first fund was {symbol}.", hi: "Tumhara pehla fund {symbol} tha." },
  },
  {
    family: "old_friend", category: "streak", emoji: "🤝", metric: "member_days", tiers: [30, 90, 180],
    name: { en: "Old Friend", hi: "Purana Dost" },
    desc: { en: "Still learning with Saathi {t} days after joining.", hi: "Join karne ke {t} din baad bhi Saathi ke saath seekh rahe ho." },
    why: { en: "You joined {days} days ago and you're still here.", hi: "Tum {days} din pehle jude the aur abhi bhi yahin ho." },
  },
  {
    family: "regular", category: "streak", emoji: "📅", metric: "visit_days", tiers: [10, 20, 40],
    name: { en: "Regular", hi: "Regular" },
    desc: { en: "Open StockSaathi on {t} different days.", hi: "{t} alag-alag din StockSaathi kholo." },
    why: { en: "You've opened the app on {n} different days.", hi: "Tumne {n} alag din app khola hai." },
  },

  // ---------------------------------------------------------------- good habits
  {
    family: "long_termer", category: "habit", emoji: "🏛️", metric: "max_hold_days", tiers: [30, 60, 90, 180],
    name: { en: "Long Termer", hi: "Lambi Soch" },
    desc: { en: "Hold one position for {t} days.", hi: "Ek position {t} din tak hold karo." },
    why: { en: "You've held {symbol} for {days} days.", hi: "Tumne {symbol} ko {days} din hold kiya." },
  },
  {
    family: "held_the_line", category: "habit", emoji: "🛡️", metric: "dip_pct", tiers: [5, 10, 20],
    name: { en: "Held the Line", hi: "Datey Rahe" },
    desc: { en: "Keep holding while a stock you own is {t}% below what you paid.", hi: "Jab stock kharid se {t}% neeche ho, tab bhi hold karte raho." },
    why: { en: "{symbol} closed {pct}% below your price on {date}, and you held on.", hi: "{date} ko {symbol} tumhare daam se {pct}% neeche band hua, phir bhi tum date rahe." },
  },
  {
    family: "comeback", category: "habit", emoji: "🌅", metric: "comebacks", tiers: [1, 2, 4],
    name: { en: "Comeback", hi: "Wapsi" },
    desc: { en: "Hold {t} position{s} through a 5% dip until {it} back above your price.", hi: "{t} position ko 5% girne ke baad bhi hold karo, jab tak woh tumhare daam se upar na aa jaaye." },
    why: { en: "Holdings that dipped 5% and came back: {n} (latest: {symbol}).", hi: "Tumhare {n} stock 5% gire aur wapas aaye, sabse haal mein {symbol}." },
  },
  {
    family: "spread_out", category: "habit", emoji: "🧩", metric: "max_sectors", tiers: [3, 5, 8],
    name: { en: "Spread Out", hi: "Phaila Hua Paisa" },
    desc: { en: "Hold stocks from {t} different sectors at the same time.", hi: "Ek saath {t} alag sectors ke stocks rakho." },
    why: { en: "You held {n} sectors at once: {sectors}.", hi: "Tumne ek saath {n} sectors rakhe: {sectors}." },
  },
  {
    family: "balanced_basket", category: "habit", emoji: "⚖️", metric: "balanced_level", tiers: [1, 2, 3],
    tierDesc: [
      null,
      { en: "Hold 4+ stocks with none over 35% of your shares.", hi: "4+ stocks rakho, koi bhi 35% se zyada na ho." },
      { en: "Hold 6+ stocks with none over 30% of your shares.", hi: "6+ stocks rakho, koi bhi 30% se zyada na ho." },
      { en: "Hold 10+ stocks with none over 20% of your shares.", hi: "10+ stocks rakho, koi bhi 20% se zyada na ho." },
    ],
    name: { en: "Balanced Basket", hi: "Santulit Basket" },
    desc: { en: "No single stock takes over your portfolio.", hi: "Koi ek stock poore portfolio pe haavi na ho." },
    why: { en: "You hold {n} stocks and the biggest is only {top_pct}%.", hi: "Tumhare paas {n} stocks hain aur sabse bada sirf {top_pct}% hai." },
  },
  {
    family: "fund_patience", category: "habit", emoji: "🌳", metric: "fund_hold_days", tiers: [30, 60, 90],
    name: { en: "Fund Patience", hi: "Fund Ka Sabr" },
    desc: { en: "Keep a mutual fund or ETF for {t} days.", hi: "Ek mutual fund ya ETF {t} din tak rakho." },
    why: { en: "You've kept {symbol} for {days} days.", hi: "Tumne {symbol} ko {days} din rakha hai." },
  },
  {
    family: "sip_spirit", category: "habit", emoji: "🗓️", metric: "fund_months", tiers: [2, 3, 5],
    name: { en: "SIP Spirit", hi: "SIP Wali Aadat" },
    desc: { en: "Put money into a fund or ETF in {t} different months.", hi: "{t} alag mahino mein fund ya ETF mein paisa lagao." },
    why: { en: "You added to funds in {months} different months.", hi: "Tumne {months} alag mahino mein funds mein paisa lagaya." },
  },
  {
    family: "patient_profit", category: "habit", emoji: "⏳", metric: "patient_profits", tiers: [1, 3],
    name: { en: "Worth the Wait", hi: "Intezaar Ka Phal" },
    desc: { en: "Sell at a profit after holding for 30+ days ({t} time{s}).", hi: "30+ din hold karke {t} baar munafe mein becho." },
    why: { en: "Sales at a profit after 30+ days: {n} (latest: {symbol}).", hi: "Tumhari {n} sales 30+ din baad munafe mein thi, sabse haal mein {symbol}." },
  },
  {
    family: "sleep_on_it", category: "habit", emoji: "🌙", metric: "slept_on", tiers: [3, 8, 15],
    name: { en: "Slept On It", hi: "Soch Samajh Ke" },
    desc: { en: "Buy {t} stocks only after reading about them on an earlier day.", hi: "{t} stocks ko pehle kisi din padh kar, baad mein kharido." },
    why: { en: "Stocks you read up on before the day you bought them: {n} (latest: {symbol}).", hi: "Tumne {n} stocks pehle dekh kar baad mein kharide. Sabse naya: {symbol}." },
  },
  {
    family: "homework", category: "habit", emoji: "🔖", metric: "homework", tiers: [1, 3],
    name: { en: "Did the Homework", hi: "Homework Pura" },
    desc: { en: "Buy {t} stock{s} at least a week after adding {them} to your watchlist.", hi: "{t} stock watchlist mein daalne ke kam se kam ek hafte baad kharido." },
    why: { en: "{symbol} sat on your watchlist {days} days before you bought it.", hi: "{symbol} kharidne se pehle {days} din tumhari watchlist mein raha." },
  },
  {
    family: "calm_hands", category: "habit", emoji: "🧘", metric: "calm_days", tiers: [7, 14, 21],
    name: { en: "Calm Hands", hi: "Shaant Haath" },
    desc: { en: "Trade for {t} days without the coach flagging a pattern.", hi: "{t} din tak aise trade karo ki coach koi pattern na pakde." },
    why: { en: "{trades} trades over {days} days with no pattern flagged.", hi: "{days} din mein {trades} trades, ek bhi pattern nahi." },
  },
  {
    family: "steady_improver", category: "habit", emoji: "📈", metric: "improver", tiers: [1],
    name: { en: "Getting Better", hi: "Behtar Ho Rahe" },
    desc: { en: "Halve how often the coach flags your trades.", hi: "Coach ke flags ko aadha kar do." },
    why: { en: "Flagged trades went from {before_pct}% to {after_pct}% of your recent trades.", hi: "Flag wale trades {before_pct}% se {after_pct}% ho gaye." },
  },

  {
    family: "set_and_wait", category: "habit", emoji: "🎣", metric: "limit_waits", tiers: [1, 3, 6],
    name: { en: "Set and Wait", hi: "Daam Lagao, Ruko" },
    desc: { en: "Get {t} limit order{s} filled after waiting a day or more for your price.", hi: "{t} limit order apne daam ke liye ek din ya zyada ruk kar fill karwao." },
    why: { en: "Limit orders that waited a day or more for your price: {n}.", hi: "Tumhare {n} limit order ek din ya zyada ruk kar tumhare daam pe fill hue." },
  },
  {
    family: "red_day_calm", category: "habit", emoji: "☂️", metric: "red_days", tiers: [1, 3, 6],
    name: { en: "Red Day Calm", hi: "Laal Din, Shaant Mann" },
    desc: { en: "On {t} day{s} the market falls 1% or more, open the app, look at your holdings and sell nothing.", hi: "{t} din jab market 1% ya zyada gire, app kholo, apni holdings dekho aur kuch mat becho." },
    why: { en: "Falling days you watched without selling: {n} (latest: {date}).", hi: "Tumne {n} girte din bina beche dekhe, sabse naya {date}." },
  },

  // ---------------------------------------------------------------- learning
  {
    family: "time_traveller", category: "learning", emoji: "⏱️", metric: "replays", tiers: [1, 3, 5],
    name: { en: "Time Traveller", hi: "Time Traveller" },
    desc: { en: "Finish {t} crash replay{s}.", hi: "{t} alag crash replay poore karo." },
    why: { en: "Crash replays you've finished: {n}.", hi: "Tumne {n} crash replay poore kiye." },
  },
  {
    family: "curious_mind", category: "learning", emoji: "💬", metric: "question_days", tiers: [1, 5, 10],
    name: { en: "Curious Mind", hi: "Jigyasu" },
    desc: { en: "Ask Saathi a question on {t} day{s}.", hi: "{t} din Saathi se sawaal poocho." },
    why: { en: "Days you asked Saathi something: {n}.", hi: "Tumne {n} din Saathi se sawaal pooche." },
  },
  {
    family: "bookworm", category: "learning", emoji: "📚", metric: "reads", tiers: [1, 3, 8],
    name: { en: "Bookworm", hi: "Kitaabi Keeda" },
    desc: { en: "Read {t} lesson{s} or explainer{s}.", hi: "{t} lesson ya explainer padho." },
    why: { en: "Lessons and explainers you've read: {n}.", hi: "Tumne {n} lessons aur explainers padhe." },
  },
  {
    family: "researcher", category: "learning", emoji: "🔭", metric: "stocks_viewed", tiers: [10, 30, 75],
    name: { en: "Researcher", hi: "Khoji" },
    desc: { en: "Look up {t} different stocks.", hi: "{t} alag stocks dekho." },
    why: { en: "You've looked into {n} different stocks.", hi: "Tumne {n} alag stocks dekhe." },
  },
  {
    family: "news_hound", category: "learning", emoji: "📰", metric: "news_days", tiers: [2, 5, 10],
    name: { en: "News Reader", hi: "Khabri" },
    desc: { en: "Read market news on {t} different days.", hi: "{t} alag din market news padho." },
    why: { en: "You read the news on {n} different days.", hi: "Tumne {n} alag din news padhi." },
  },

  {
    family: "on_my_radar", category: "learning", emoji: "📡", metric: "watchlist_adds", tiers: [1, 5, 10],
    name: { en: "On My Radar", hi: "Nazar Mein" },
    desc: { en: "Add {t} stock{s} to your watchlist.", hi: "{t} stock watchlist mein daalo." },
    why: { en: "Stocks you've put on your watchlist: {n}.", hi: "Tumne {n} stock watchlist mein daale." },
  },
  {
    family: "chart_reader", category: "learning", emoji: "👓", metric: "chart_stocks", tiers: [3, 10, 25],
    name: { en: "Chart Reader", hi: "Chart Padhne Wale" },
    desc: { en: "Use the chart on {t} different stocks.", hi: "{t} alag stocks ka chart dekho." },
    why: { en: "Stocks whose chart you've explored: {n}.", hi: "Tumne {n} stocks ke chart dekhe." },
  },
  {
    family: "sector_scholar", category: "learning", emoji: "🧭", metric: "sectors_viewed", tiers: [5, 8, 11],
    name: { en: "Sector Scholar", hi: "Sector Ka Gyaan" },
    desc: { en: "Look up stocks from {t} different sectors. No buying needed.", hi: "{t} alag sectors ke stocks dekho. Kharidna zaroori nahi." },
    why: { en: "Sectors you've looked into: {n}.", hi: "Tumne {n} sectors ke stocks dekhe." },
  },
  {
    family: "asked_why", category: "learning", emoji: "💡", metric: "bias_reads", tiers: [1, 3, 5],
    name: { en: "Asked Why", hi: "Kyun Poocha" },
    desc: { en: "Open the explainer for {t} pattern{s} the coach noted on your trades.", hi: "Coach ne tumhare trades pe jo pattern note kiye, unme se {t} ka explainer kholo." },
    why: { en: "Patterns you've read up on after a coach note: {n}.", hi: "Coach ke note ke baad tumne {n} pattern samjhe." },
  },

  // ---------------------------------------------------------------- coming back
  {
    family: "learning_streak", category: "streak", emoji: "🔥", metric: "learn_streak", tiers: [3, 5, 7],
    name: { en: "On a Roll", hi: "Lagataar" },
    desc: { en: "Learn something on {t} days in a row. One day off is fine.", hi: "{t} din lagataar kuch seekho. Ek din ki chhutti chalegi." },
    why: { en: "Your best run: {days} learning days, never more than one day off in between.", hi: "Tumhara best: {days} din seekhna, beech mein ek din se zyada gap nahi." },
  },
  {
    family: "weekly_regular", category: "streak", emoji: "🗓", metric: "week_streak", tiers: [2, 4, 6, 8],
    name: { en: "Week After Week", hi: "Har Hafte" },
    desc: { en: "Come back {t} weeks in a row. One week off is fine.", hi: "{t} hafte lagataar wapas aao. Ek hafte ki chhutti chalegi." },
    why: { en: "You came back {weeks} weeks running.", hi: "Tum {weeks} hafte lagataar aaye." },
  },

  {
    family: "weekend_scholar", category: "streak", emoji: "🛋️", metric: "weekend_learn", tiers: [1, 3, 6],
    name: { en: "Weekend Scholar", hi: "Weekend Ki Padhai" },
    desc: { en: "Learn something on {t} weekend{s}, when the market is shut.", hi: "{t} weekend pe kuch seekho, jab market band hota hai." },
    why: { en: "Weekends you learned on: {n}.", hi: "Tumne {n} weekend pe seekha." },
  },

  // ---------------------------------------------------------------- market calendar
  // Dated events live in public.market_events, not here: next year's dates
  // are an insert. `t` counts the events of that kind the user took part in.
  {
    family: "results_reader", category: "season", emoji: "📊", metric: "season", tiers: [1, 2, 4],
    rule: { event_kind: "results_season", pad: [0, 0], need: { stock_views: 5, learn_actions: 1 } },
    name: { en: "Results Reader", hi: "Results Padhne Wale" },
    desc: { en: "During {t} results season{s}, look up 5+ stocks and learn something.", hi: "{t} results season mein 5+ stocks dekho aur kuch seekho." },
    why: { en: "Results seasons you studied: {n} (latest: {event}).", hi: "Tumne {n} results season mein companies padhi, sabse naya {event}." },
  },
  {
    family: "budget_buff", category: "season", emoji: "🏦", metric: "season", tiers: [1, 2, 3],
    rule: { event_kind: "budget", pad: [0, 1], need: { learn_actions: 1 } },
    name: { en: "Budget Buff", hi: "Budget Samajhne Wale" },
    desc: { en: "Learn something on Union Budget day (or the day after), {t} year{s}.", hi: "Budget ke din (ya agle din) kuch seekho, {t} saal." },
    why: { en: "Budget days you learned on: {n} (latest: {event}).", hi: "Tumne {n} Budget din seekha, sabse naya {event}." },
  },
  {
    family: "rate_watcher", category: "season", emoji: "🏛", metric: "season", tiers: [1, 3, 6],
    rule: { event_kind: "rbi_policy", pad: [0, 1], need: { learn_actions: 1 } },
    name: { en: "Rate Watcher", hi: "Rate Pe Nazar" },
    desc: { en: "Learn something on {t} RBI policy day{s}.", hi: "{t} RBI policy din kuch seekho." },
    why: { en: "RBI policy days you learned on: {n} (latest: {event}).", hi: "Tumne {n} RBI policy din seekha, sabse naya {event}." },
  },
  {
    family: "diwali_holder", category: "season", emoji: "🪔", metric: "season", tiers: [1, 2, 3],
    rule: { event_kind: "diwali", pad: [14, 7], need: { held_through: 1, visit_days: 1 } },
    name: { en: "Diwali Holder", hi: "Diwali Wala Investor" },
    desc: { en: "Hold a stock from two weeks before Diwali to a week after, and look in at least once, {t} year{s}.", hi: "Diwali se do hafte pehle se ek hafte baad tak stock hold karo aur beech mein ek baar app kholo, {t} saal." },
    why: { en: "Diwalis you held through: {n} (latest: {event}).", hi: "Tumne {n} Diwali hold kiya, sabse naya {event}." },
  },
  {
    family: "muhurat", category: "season", emoji: "✨", metric: "season", tiers: [1],
    rule: { event_kind: "diwali", pad: [0, 0], need: { visit_days: 1 } },
    name: { en: "Muhurat Moment", hi: "Muhurat Ka Pal" },
    desc: { en: "Open StockSaathi on Muhurat trading day.", hi: "Muhurat trading ke din StockSaathi kholo." },
    why: { en: "You were here for {event}.", hi: "Tum {event} pe yahan the." },
  },
  {
    family: "month_end_review", category: "season", emoji: "🧾", metric: "season", tiers: [1, 3, 6],
    rule: { event_kind: "month_end", pad: [2, 0], need: { report_views: 1 } },
    name: { en: "Month-end Review", hi: "Mahine Ka Hisaab" },
    desc: { en: "Open your report card in the last 3 days of {t} month{s}.", hi: "{t} mahine, aakhri 3 din mein report card dekho." },
    why: { en: "Month-ends you reviewed: {n} (latest: {event}).", hi: "Tumne {n} mahine ka hisaab dekha, sabse naya {event}." },
  },
  {
    family: "quarter_reflection", category: "season", emoji: "🪞", metric: "season", tiers: [1, 2, 4],
    rule: { event_kind: "quarter_end", pad: [6, 0], need: { report_views: 1 } },
    name: { en: "Quarter Reflection", hi: "Teen Mahine Ka Hisaab" },
    desc: { en: "Open your report card in the last week of {t} quarter{s}.", hi: "{t} quarter ke aakhri hafte mein report card dekho." },
    why: { en: "Quarters you looked back on: {n} (latest: {event}).", hi: "Tumne {n} quarter ka hisaab dekha, sabse naya {event}." },
  },
  {
    family: "fresh_start", category: "season", emoji: "🎒", metric: "season", tiers: [1],
    rule: { event_kind: "fy_start", pad: [0, 6], need: { learn_actions: 1 } },
    name: { en: "Fresh Start", hi: "Nayi Shuruaat" },
    desc: { en: "Learn something in the first week of the financial year (April).", hi: "Financial year ke pehle hafte (April) mein kuch seekho." },
    why: { en: "You started {event} by learning.", hi: "Tumne {event} seekh kar shuru kiya." },
  },
];

// ---------------------------------------------------------------------------
// Flat definitions (one per tier), as stored in public.achievement_defs.
// ---------------------------------------------------------------------------
export function codeOf(family, tier, tierCount) {
  return tierCount > 1 ? `${family}_${TIERS[tier].key}` : family;
}

export function buildDefs(families = FAMILIES) {
  const out = [];
  let sort = 0;
  for (const f of families) {
    f.tiers.forEach((threshold, i) => {
      const tier = i + 1;
      const td = f.tierDesc?.[tier];
      out.push({
        code: codeOf(f.family, tier, f.tiers.length),
        family: f.family,
        tier,
        tiers: f.tiers.length,
        category: f.category,
        emoji: f.emoji,
        name_en: f.name.en,
        name_hi: f.name.hi,
        desc_en: fill(td?.en || f.desc.en, plural(threshold)),
        desc_hi: fill(td?.hi || f.desc.hi, plural(threshold)),
        why_en: f.why.en,
        why_hi: f.why.hi,
        metric: f.metric,
        threshold,
        rule: f.rule || null,
        sort: (sort += 10),
      });
    });
  }
  return out;
}

// {t} = the threshold; {s} / {it} / {them} make the English read right for 1.
function plural(t) {
  return { t, s: t === 1 ? "" : "s", it: t === 1 ? "it's" : "they're", them: t === 1 ? "it" : "them" };
}

/** Replace {key} with evidence values. Unknown keys stay readable ("—"). */
export function fill(tpl, ev = {}) {
  return String(tpl ?? "").replace(/\{([a-z_]+)\}/g, (_, k) => {
    const v = ev?.[k];
    if (v == null) return "—";
    if (Array.isArray(v)) return v.join(", ");
    if (typeof v === "number") return fmtNum(v);
    return String(v);
  });
}

function fmtNum(n) {
  if (!Number.isFinite(n)) return "—";
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? r.toLocaleString("en-IN") : r.toFixed(1);
}

// ---------------------------------------------------------------------------
// Evaluation: which definitions a user's facts satisfy (earned or not).
// facts = { m: { metric: number }, ev: { metric: {...} }, season: { code: { n, event, date } } }
// ---------------------------------------------------------------------------
export function evaluate(facts, defs) {
  const out = [];
  for (const d of defs) {
    if (d.status && d.status !== "active") continue;
    if (d.metric === "season") {
      const s = facts?.season?.[d.code];
      if (s && s.n >= Number(d.threshold)) out.push({ code: d.code, evidence: { ...s } });
      continue;
    }
    const v = Number(facts?.m?.[d.metric] ?? 0);
    if (v >= Number(d.threshold)) out.push({ code: d.code, evidence: { ...(facts?.ev?.[d.metric] || {}), value: v } });
  }
  return out;
}

/** Progress toward a definition not yet earned: { value, target, pct }. */
export function progressFor(def, facts) {
  if (def.metric === "season") {
    const n = Number(facts?.season?.[def.code]?.n ?? 0);
    return { value: n, target: Number(def.threshold), pct: Math.min(1, n / Number(def.threshold)) };
  }
  const v = Number(facts?.m?.[def.metric] ?? 0);
  const t = Number(def.threshold);
  return { value: Math.floor(v * 10) / 10, target: t, pct: t > 0 ? Math.max(0, Math.min(1, v / t)) : 0 };
}

// How a batch of new achievements reaches the user. A returning user who
// already qualifies for 15 gets ONE summary, never 15 toasts in a row.
export const SUMMARY_AT = 3;
export function deliveryPlan(newOnes) {
  const list = [...(newOnes || [])].sort((a, b) => (b.tier || 0) - (a.tier || 0));
  if (list.length >= SUMMARY_AT) return { kind: "summary", count: list.length, top: list.slice(0, 3) };
  return { kind: "each", items: list };
}

// ---------------------------------------------------------------------------
// Fact derivation: the reference for public._ach_facts. Input is one user's
// rows, already in plain JS:
//   now            Date or ms
//   createdAt      profile created_at (ISO)
//   trades         [{ symbol, side, qty, price_paise, created_at, bias_flags }]
//   instruments    { SYMBOL: { sector, isFund } }   (sector null = "Other")
//   closes         { SYMBOL: [[ "YYYY-MM-DD", closePaise ], ...] } real closes
//   limitFills     number of filled LIMIT orders
//   watchlist      [{ symbol, added_at }]
//   holdings       [{ symbol, qty, price_paise }]   price = real price now
//   events         [{ kind, at, subject }] user_events + coach (kind
//                  'chat_user' / 'crash_end') + learn_events (kind 'learn')
// ---------------------------------------------------------------------------
const DAY = 86_400_000;
const EPS = 1e-6;

export function istDate(at) {
  const t = typeof at === "number" ? at : Date.parse(at);
  return new Date(t + 5.5 * 3_600_000).toISOString().slice(0, 10);
}
const dnum = (ymd) => Date.parse(ymd + "T00:00:00Z") / DAY;
const ms = (at) => (typeof at === "number" ? at : Date.parse(at));

export function episodes(trades) {
  const bySym = new Map();
  const sorted = [...(trades || [])].sort((a, b) => ms(a.created_at) - ms(b.created_at));
  for (const t of sorted) {
    if (!bySym.has(t.symbol)) bySym.set(t.symbol, { pos: 0, cur: null, list: [] });
    const s = bySym.get(t.symbol);
    const q = Number(t.qty) || 0;
    if (t.side === "BUY") {
      if (s.pos <= EPS) { s.cur = { symbol: t.symbol, t0: ms(t.created_at), tEnd: null, buys: [], sells: [], firstPx: Number(t.price_paise) }; s.list.push(s.cur); }
      s.pos += q;
      s.cur.buys.push(t);
    } else {
      if (!s.cur) continue;          // a sell with nothing bought first: ignore
      s.pos -= q;
      s.cur.sells.push(t);
      if (s.pos <= EPS) { s.cur.tEnd = ms(t.created_at); s.cur = null; s.pos = 0; }
    }
  }
  const out = [];
  for (const s of bySym.values()) for (const e of s.list) {
    const bq = e.buys.reduce((a, b) => a + Number(b.qty), 0);
    const bv = e.buys.reduce((a, b) => a + Number(b.qty) * Number(b.price_paise), 0);
    e.avgBuy = bq > 0 ? bv / bq : 0;
    out.push(e);
  }
  return out;
}

/** Best run of active days where gaps of up to `grace` calendar days count as one run. */
export function bestRun(days, grace) {
  const u = [...new Set(days)].sort();
  let best = 0, run = 0, prev = null;
  for (const d of u) {
    const n = dnum(d);
    run = prev != null && n - prev <= grace ? run + 1 : 1;
    best = Math.max(best, run);
    prev = n;
  }
  return best;
}
export function weekOf(ymd) {
  const d = new Date(ymd + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7;      // Monday = 0
  return new Date(d.getTime() - dow * DAY).toISOString().slice(0, 10);
}

const LEARN_KINDS = new Set(["chat_user", "news_click", "replay_start", "replay_finish", "crash_end", "learn"]);
const isLessonPath = (s) => typeof s === "string" && (s.startsWith("/learn/") || s.startsWith("/learn-stock-market"));
const isFlagged = (flags) => Array.isArray(flags) && flags.some((f) => f && f.severity != null && Number(f.severity) >= FLAG_MIN_SEVERITY);

export function deriveFacts(input) {
  const now = ms(input.now ?? Date.now());
  const today = istDate(now);
  const trades = (input.trades || []).filter((t) => t && t.symbol && (t.side === "BUY" || t.side === "SELL"));
  const inst = input.instruments || {};
  const events = input.events || [];
  const m = {}, ev = {};
  const set = (k, v, e) => { m[k] = v; if (e) ev[k] = e; };
  // Time only counts while the user is around (see ACTIVE_DAYS).
  const recent = events.some((x) => now - ms(x.at) <= ACTIVE_DAYS * DAY) || trades.some((t) => now - ms(t.created_at) <= ACTIVE_DAYS * DAY);

  // -- trades and episodes
  const sorted = [...trades].sort((a, b) => ms(a.created_at) - ms(b.created_at));
  set("trades", sorted.length, sorted[0] ? { symbol: sorted[0].symbol, date: istDate(sorted[0].created_at) } : null);
  const eps = episodes(sorted);

  // Profit booked / worth the wait: a sell above the running average buy
  // price of that holding.
  let profit = null; const patient = [];
  for (const e of eps) {
    let q = 0, v = 0;
    const rows = [...e.buys.map((b) => ({ ...b, _b: 1 })), ...e.sells].sort((a, b) => ms(a.created_at) - ms(b.created_at));
    for (const r of rows) {
      if (r._b) { q += Number(r.qty); v += Number(r.qty) * Number(r.price_paise); continue; }
      if (q <= 0) continue;
      const avg = v / q;
      if (Number(r.price_paise) > avg) {
        // First profit: sold on a later day than the holding began, not a same-day flip.
        if (istDate(r.created_at) > istDate(e.t0) && (!profit || ms(r.created_at) < ms(profit.at))) profit = { at: r.created_at, symbol: r.symbol, pct: round1((Number(r.price_paise) / avg - 1) * 100) };
        if (ms(r.created_at) - e.t0 >= 30 * DAY) patient.push({ symbol: r.symbol, at: ms(r.created_at), key: r.symbol + ":" + e.t0 });
      }
    }
  }
  set("profit_booked", profit ? 1 : 0, profit ? { symbol: profit.symbol, pct: profit.pct } : null);
  const patientEps = new Map();
  for (const p of patient) patientEps.set(p.key, p);
  const latestPatient = [...patientEps.values()].sort((a, b) => b.at - a.at)[0];
  set("patient_profits", patientEps.size, latestPatient ? { n: patientEps.size, symbol: latestPatient.symbol } : null);

  // Longest hold, funds
  let best = null, bestFund = null;
  for (const e of eps) {
    const days = Math.floor(((e.tEnd ?? now) - e.t0) / DAY);
    if (!best || days > best.days) best = { days, symbol: e.symbol };
    if (inst[e.symbol]?.isFund && (!bestFund || days > bestFund.days)) bestFund = { days, symbol: e.symbol };
  }
  set("max_hold_days", recent ? best?.days || 0 : 0, best);
  set("fund_hold_days", recent ? bestFund?.days || 0 : 0, bestFund);
  const fundBuys = sorted.filter((t) => t.side === "BUY" && inst[t.symbol]?.isFund);
  set("fund_buys", fundBuys.length, fundBuys[0] ? { symbol: fundBuys[0].symbol } : null);
  const months = new Set(fundBuys.map((t) => istDate(t.created_at).slice(0, 7)));
  set("fund_months", months.size, { months: months.size });

  // Sectors held at once (funds are one "Funds" bucket; "Other" never counts)
  let maxSec = { n: 0, sectors: [] };
  for (const a of eps) {
    const secs = new Set();
    for (const b of eps) {
      if (b.t0 <= a.t0 && (b.tEnd == null || b.tEnd > a.t0)) {
        const s = sectorOf(inst[b.symbol]);
        if (s) secs.add(s);
      }
    }
    if (secs.size > maxSec.n) maxSec = { n: secs.size, sectors: [...secs].sort() };
  }
  set("max_sectors", maxSec.n, maxSec);

  // Dips held and comebacks, on real closes only.
  let dip = null; const comebacks = [];
  for (const e of eps) {
    if (inst[e.symbol]?.isFund && !(input.closes?.[e.symbol]?.length)) continue;
    const series = (input.closes?.[e.symbol] || []).slice().sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const d0 = istDate(e.t0);
    const dEnd = e.tEnd != null ? istDate(e.tEnd) : null;
    // Reference: the last close on or up to 6 days before the first buy.
    const ref = [...series].reverse().find(([d]) => d <= d0 && dnum(d0) - dnum(d) < 7);
    if (!ref || !(e.avgBuy > 0)) continue;
    if (Math.abs(e.firstPx / ref[1] - 1) > PRICE_MISMATCH) continue;   // split / bad quote: not judged
    const win = series.filter(([d]) => d > d0 && (dEnd == null || d < dEnd) && d <= today);
    let bad = false;
    for (let i = 1; i < win.length; i++) if (win[i][1] / win[i - 1][1] < CORP_ACTION_DROP) bad = true;
    if (bad) continue;
    let low = null, firstDipDay = null, recoveredAt = null;
    for (const [d, c] of win) {
      const dd = (e.avgBuy - c) / e.avgBuy;
      if (!low || dd > low.dd) low = { dd, d };
      if (dd >= 0.05 && !firstDipDay) firstDipDay = d;
      if (firstDipDay && d > firstDipDay && c >= e.avgBuy && !recoveredAt) recoveredAt = d;
    }
    if (low && low.dd > 0 && (!dip || low.dd > dip.dd)) dip = { dd: low.dd, symbol: e.symbol, date: low.d };
    if (recoveredAt) comebacks.push({ symbol: e.symbol, d: recoveredAt });
  }
  set("dip_pct", dip && recent ? floor1(dip.dd * 100) : 0, dip ? { pct: floor1(dip.dd * 100), symbol: dip.symbol, date: dip.date } : null);
  comebacks.sort((a, b) => (a.d < b.d ? 1 : -1));
  set("comebacks", recent ? comebacks.length : 0, comebacks[0] ? { n: comebacks.length, symbol: comebacks[0].symbol } : null);

  // Balanced basket, on today's holdings at real prices.
  const hv = (input.holdings || []).filter((h) => Number(h.qty) > 0).map((h) => ({ symbol: h.symbol, v: Number(h.qty) * Number(h.price_paise || 0) })).filter((h) => h.v > 0);
  const tot = hv.reduce((a, h) => a + h.v, 0);
  const top = tot > 0 ? Math.max(...hv.map((h) => h.v)) / tot : 1;
  const n = hv.length;
  const level = n >= 10 && top <= 0.20 ? 3 : n >= 6 && top <= 0.30 ? 2 : n >= 4 && top <= 0.35 ? 1 : 0;
  set("balanced_level", level, n ? { n, top_pct: round1(top * 100) } : null);

  set("limit_fills", Number(input.limitFills || 0), { n: Number(input.limitFills || 0) });

  // Slept on it: first buy of a stock on a later day than its first page view.
  const firstView = new Map();
  for (const x of events) if (x.kind === "stock_view" && x.subject) {
    const d = istDate(x.at);
    if (!firstView.has(x.subject) || d < firstView.get(x.subject)) firstView.set(x.subject, d);
  }
  const firstBuy = new Map();
  for (const t of sorted) if (t.side === "BUY" && !firstBuy.has(t.symbol)) firstBuy.set(t.symbol, t.created_at);
  const slept = [...firstBuy.entries()].filter(([s, at]) => firstView.has(s) && firstView.get(s) < istDate(at)).sort((a, b) => ms(b[1]) - ms(a[1]));
  set("slept_on", slept.length, slept[0] ? { n: slept.length, symbol: slept[0][0] } : null);

  // Homework: bought 7+ days after adding to the watchlist.
  let hw = [];
  for (const w of input.watchlist || []) {
    const b = sorted.find((t) => t.side === "BUY" && t.symbol === w.symbol && ms(t.created_at) >= ms(w.added_at) + 7 * DAY);
    if (b) hw.push({ symbol: w.symbol, days: Math.floor((ms(b.created_at) - ms(w.added_at)) / DAY), at: ms(b.created_at) });
  }
  hw.sort((a, b) => b.at - a.at);
  set("homework", hw.length, hw[0] ? { n: hw.length, symbol: hw[0].symbol, days: hw[0].days } : null);

  // Calm hands: the longest stretch of 3+ consecutive unflagged trades.
  const era = sorted.filter((t) => ms(t.created_at) >= Date.parse(FLAG_ERA + "T00:00:00Z"));
  let calm = null, runStart = null, runN = 0, runLast = null;
  const closeRun = () => {
    if (runN >= 3) {
      const days = Math.floor((runLast - runStart) / DAY);
      if (!calm || days > calm.days) calm = { days, trades: runN };
    }
  };
  for (const t of era) {
    if (isFlagged(t.bias_flags)) { closeRun(); runStart = null; runN = 0; continue; }
    if (runStart == null) runStart = ms(t.created_at);
    runN++; runLast = ms(t.created_at);
  }
  closeRun();
  set("calm_days", calm?.days || 0, calm);

  // Getting better: of the last 30 flag-era trades, the newest 15 are
  // flagged at most half as often as the 15 before (which had 20%+).
  let improver = 0, impEv = null;
  if (era.length >= 30) {
    const last30 = era.slice(-30);
    const a = last30.slice(0, 15).filter((t) => isFlagged(t.bias_flags)).length / 15;
    const b = last30.slice(15).filter((t) => isFlagged(t.bias_flags)).length / 15;
    if (a >= 0.2 && b <= a / 2) { improver = 1; impEv = { before_pct: Math.round(a * 100), after_pct: Math.round(b * 100) }; }
  }
  set("improver", improver, impEv);

  // -- learning and visits
  const days = (pred) => [...new Set(events.filter(pred).map((x) => istDate(x.at)))];
  const replays = new Set(events.filter((x) => (x.kind === "replay_finish" || x.kind === "crash_end") && x.subject).map((x) => x.subject));
  set("replays", replays.size, { n: replays.size });
  const qd = days((x) => x.kind === "chat_user");
  set("question_days", qd.length, { n: qd.length });
  const reads = new Set();
  for (const x of events) {
    if (x.kind === "page_view" && isLessonPath(x.subject)) reads.add(String(x.subject).split("?")[0]);
    if (x.kind === "learn") reads.add("learn:" + (x.subject || ""));
  }
  set("reads", reads.size, { n: reads.size });
  const sv = new Set(events.filter((x) => x.kind === "stock_view" && x.subject).map((x) => x.subject));
  set("stocks_viewed", sv.size, { n: sv.size });
  const nd = days((x) => x.kind === "news_click");
  set("news_days", nd.length, { n: nd.length });
  const visit = days((x) => x.kind === "page_view" || x.kind === "chat_user");
  set("visit_days", visit.length, { n: visit.length });
  const learnDays = days((x) => LEARN_KINDS.has(x.kind) || (x.kind === "page_view" && isLessonPath(x.subject)));
  const ls = bestRun(learnDays, GRACE_DAYS);
  set("learn_streak", ls, { days: ls });
  const weeks = [...new Set(visit.map(weekOf))];
  const ws = bestRun(weeks, GRACE_WEEKS * 7);
  set("week_streak", ws, { weeks: ws });

  // Old friend: days since joining, only while they still come back (active
  // in the last 14 days).
  const member = input.createdAt && recent ? Math.floor((now - ms(input.createdAt)) / DAY) : 0;
  set("member_days", member, member ? { days: member } : null);

  // -- added 25 Nov 2026: parts of the site that earned nothing
  const wl = new Set([...(input.watchlist || []).map((w) => w.symbol), ...events.filter((x) => x.kind === "watchlist_add" && x.subject).map((x) => x.subject)]);
  set("watchlist_adds", wl.size, { n: wl.size });
  const charts = new Set(events.filter((x) => x.kind === "chart_interact" && x.subject).map((x) => x.subject));
  set("chart_stocks", charts.size, { n: charts.size });
  const secsSeen = new Set([...sv].map((sym) => sectorOf(inst[sym])).filter(Boolean));
  set("sectors_viewed", secsSeen.size, { n: secsSeen.size });
  const biasReads = new Set(events.filter((x) => x.kind === "learn" && String(x.subject || "").startsWith("bias:")).map((x) => x.subject));
  set("bias_reads", biasReads.size, { n: biasReads.size });
  const weekends = new Set(learnDays.filter((d) => { const w = new Date(d + "T00:00:00Z").getUTCDay(); return w === 0 || w === 6; }).map(weekOf));
  set("weekend_learn", weekends.size, { n: weekends.size });
  set("limit_waits", Number(input.limitWaits || 0), { n: Number(input.limitWaits || 0) });
  // Red day calm: on a day the market fell (input.redDays, from the Nifty 50
  // ETF's real closes) the user opened the app, held something bought on an
  // earlier day and sold nothing that day.
  const visitSet = new Set(visit);
  const sellDays = new Set(sorted.filter((t) => t.side === "SELL").map((t) => istDate(t.created_at)));
  const redCalm = [...new Set(input.redDays || [])].filter((d) => d <= today && visitSet.has(d) && !sellDays.has(d)
    && eps.some((e) => istDate(e.t0) < d && (e.tEnd == null || istDate(e.tEnd) > d))).sort();
  set("red_days", redCalm.length, redCalm.length ? { n: redCalm.length, date: redCalm[redCalm.length - 1] } : null);

  return { m, ev };
}

function sectorOf(i) {
  if (!i) return null;
  if (i.isFund) return "Funds";
  if (!i.sector || i.sector === "Other" || i.sector === "ETF") return null;
  return i.sector;
}
function round1(x) { return Math.round(x * 10) / 10; }
function floor1(x) { return Math.floor(x * 10) / 10; }

// ---------------------------------------------------------------------------
// Seasonal: per-event metrics in a window, and the count of events a user
// took part in. events = [{ id, kind, name, starts_on, ends_on }]
// ---------------------------------------------------------------------------
export function windowOf(event, pad = [0, 0]) {
  const a = new Date(Date.parse(event.starts_on + "T00:00:00Z") - (pad[0] || 0) * DAY).toISOString().slice(0, 10);
  const b = new Date(Date.parse(event.ends_on + "T00:00:00Z") + (pad[1] || 0) * DAY).toISOString().slice(0, 10);
  return [a, b];
}

export function seasonMetrics(input, win) {
  const [a, b] = win;
  const now = ms(input.now ?? Date.now());
  const inWin = (at) => { const d = istDate(at); return d >= a && d <= b; };
  const evs = (input.events || []).filter((x) => inWin(x.at));
  const lesson = (x) => x.kind === "page_view" && isLessonPath(x.subject);
  const out = {
    visit_days: new Set(evs.filter((x) => x.kind === "page_view" || x.kind === "chat_user").map((x) => istDate(x.at))).size,
    learn_actions: evs.filter((x) => LEARN_KINDS.has(x.kind) || lesson(x)).length,
    stock_views: new Set(evs.filter((x) => x.kind === "stock_view").map((x) => x.subject)).size,
    report_views: evs.filter((x) => x.kind === "page_view" && x.subject === "/report-card").length,
    review_views: evs.filter((x) => x.kind === "page_view" && (x.subject === "/report-card" || x.subject === "/portfolio")).length,
    questions: evs.filter((x) => x.kind === "chat_user").length,
    replays: evs.filter((x) => x.kind === "replay_finish" || x.kind === "crash_end").length,
    news_reads: evs.filter((x) => x.kind === "news_click").length,
    held_through: 0,
  };
  // Held through: only once the window is over.
  const startMs = Date.parse(a + "T00:00:00+05:30");
  const endMs = Date.parse(b + "T00:00:00+05:30") + DAY;
  if (endMs <= now) {
    for (const e of episodes(input.trades || [])) {
      if (e.t0 < startMs && (e.tEnd == null || e.tEnd >= endMs)) { out.held_through = 1; break; }
    }
  }
  return out;
}

export function meets(metrics, need) {
  return Object.entries(need || {}).every(([k, v]) => Number(metrics?.[k] ?? 0) >= Number(v));
}

/** facts.season for every seasonal definition. */
export function deriveSeason(input, defs, marketEvents) {
  const now = ms(input.now ?? Date.now());
  const today = istDate(now);
  const season = {};
  for (const d of defs) {
    if (d.metric !== "season" || !d.rule) continue;
    const evs = (marketEvents || []).filter((e) => (d.rule.event_id ? e.id === d.rule.event_id : e.kind === d.rule.event_kind));
    let n = 0, last = null;
    for (const e of evs) {
      const w = windowOf(e, d.rule.pad);
      if (w[0] > today) continue;
      if (meets(seasonMetrics(input, w), d.rule.need)) { n++; if (!last || e.starts_on > last.starts_on) last = e; }
    }
    if (n) season[d.code] = { n, event: last.name, date: last.starts_on };
  }
  return season;
}

/** Validate an AI-drafted concept before it may enter the approval queue. */
export function validateDraft(c) {
  const errs = [];
  const str = (v, max) => typeof v === "string" && v.trim().length >= 2 && v.length <= max;
  if (!str(c?.name_en, 40)) errs.push("name_en");
  if (!str(c?.name_hi, 40)) errs.push("name_hi");
  for (const k of ["desc_en", "desc_hi", "why_en", "why_hi"]) if (!str(c?.[k], 160)) errs.push(k);
  if (![1, 2, 3].includes(Number(c?.tier))) errs.push("tier");
  const need = c?.need;
  if (!need || typeof need !== "object" || !Object.keys(need).length) errs.push("need");
  else for (const [k, v] of Object.entries(need)) {
    if (!(k in SEASON_METRICS)) errs.push(`need.${k}`);
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > (k === "held_through" ? 1 : 30)) errs.push(`need.${k}=${v}`);
  }
  const pad = c?.pad || [0, 0];
  if (!Array.isArray(pad) || pad.length !== 2 || pad.some((p) => !Number.isInteger(p) || p < 0 || p > 14)) errs.push("pad");
  const text = [c?.name_en, c?.desc_en, c?.why_en, c?.name_hi, c?.desc_hi, c?.why_hi].join(" ").toLowerCase();
  if (/\b(trade|trades|trading) (every|daily|\d+ times)|\b\d+\s+trades\b|overtrad|don'?t lose|lose your streak|streak khatam/.test(text)) errs.push("rewards_bad_habit");
  return errs;
}
