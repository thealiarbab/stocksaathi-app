# Brief: Achievements, 80+ (queue item #3)

Read `AGENTS.md` first: commit identity, ship-to-main, the build
(`build/bundle.mjs`, `LITERALS`), no DROP/DELETE through the Supabase
connector, new SQL functions revoked from anon, and owner previews via
`isOwner()` all apply. This brief is self-contained.

Do this **after** report card v2 (`docs/BRIEF_report_card_v2.md`) has
shipped. The report card's 8 hard-coded badges (`BADGES` in
`js/pages/reportCard.js`) are replaced by this work.

## You own this

Achievements are a new system and yours to design: definitions, storage,
awarding, UI. Outside it, change only what it needs (the report card's badge
area, the bell, the admin page) and list every such change in your final
report. The owner reviews the diff, not the summary.

Finish the whole task: design, build, backfill on real data, ship to the
owner accounts first. Don't stop at a plan unless something below is
genuinely blocked; then say exactly what and why.

## What the owner asked for

- **80+ achievements**, tiered (for example bronze, silver, gold), across:
  milestones, streaks, good habits, learning, and seasonal ones.
- **Seasonal content from the market calendar:** results season (quarterly),
  Union Budget (1 Feb), RBI monetary policy meetings, Diwali / Muhurat
  trading, month and quarter ends. NSE holidays are in
  `js/data/nseCalendar.js`. Store dated events in a table, not in code, so
  next year's dates are an insert.
- **AI-drafted seasonal concepts with owner approval:** each season, a model
  drafts new seasonal achievements (name, rule, tier, copy in English and
  Hinglish) into an approval queue on the admin page (`/a`). Nothing goes
  live until the owner approves it. Any new model call goes through
  `callLlm` in `api/ai.js`, so it is recorded in `llm_usage` like every
  other call; don't change existing effort settings.
- **"Sexy" toast popups** when one is earned. The owner asked for the
  frontend-design skill for these: use it. Match the app's look (see
  `components/tradeNote.js` and `css/components.css` for the current
  style), work at 1366x768 and on phones, and respect reduced motion.
- **Returning users** who already qualify get their popups on next login.
  Don't fire 15 toasts in a row: show one summary ("You've earned 12
  achievements") that opens the full list.
- **Delivery:** insert into `public.notifications` with category
  `achievements`; the bell and phone push follow automatically, including
  the 22:00-07:00 IST hold. The category already exists in
  `js/features/notifications.js` and `js/components/bell.js`.
- **Owner first:** ship behind `isOwner()` (`js/features/preview.js`), and
  seed the owner accounts (`aliarbab2009`, admin) with many achievements so
  he can preview the toasts, the list and the tiers.

## Design rules

- **The server decides.** Award in the database, where the trades are
  (SQL functions, triggers or a pg_cron job), never from the browser. Users
  must not be able to insert or edit their own achievements (RLS: read your
  own, no writes).
- **Never reward bad habits.** This is a learning app for teenagers. No
  "make 100 trades" or "trade every day" achievements: overtrading and
  churning are behaviours the coach flags (`js/coach/biasCore.js`, stored on
  each trade in `transactions.bias_flags`). Reward holding through a dip,
  diversifying, learning (crash replays, coach questions, explainers),
  patience and steady improvement.
- **Gentle streaks.** No loss-aversion pressure ("you'll lose your streak!"),
  and give a grace day. Streaks are about returning to learn, not trading
  daily.
- **Real data only:** real prices (`getRealPricePaise`, `realCloses.js`),
  never the synthetic chart walk.
- **Explainable:** every achievement says what earned it, in the user's own
  numbers, in English and Hinglish (`settings.hinglish`).
- **Telemetry:** shown / opened / dismissed through `telemetry.js`
  `logEvent()` + `EV_KINDS` in `api/ai.js` (`user_events.kind` has a CHECK
  whitelist the connector cannot change).

## Validate on real data before shipping

The Supabase connector reaches production (project `hwlmwraowcylxzdpumca`);
read-only queries are fine. There are about 7,100+ real trades in
`transactions`, plus `profiles`, `user_events`, crash replays and coach
messages.

- Compute the backfill without writing it, and report how many users would
  earn each achievement. Retire or re-tune any that nobody or almost everybody
  earns.
- Keep the rule logic in a pure module where it can run in Node, and add
  `scripts/test-achievements.mjs` (edge cases: no trades, only buys, split
  price mismatch, a user who earns 40 at once, streak grace day), wired into
  `.github/workflows/perf-syntax.yml` like `test-bias-core.mjs`.

## Ship

- Commit as Ali Arbab, push to `main`, apply migrations to production in the
  same task. No `sw.js` bump (the build hashes assets).
- Ship to the owner accounts only. The owner decides when everyone gets it.
- Update `AGENTS.md` with an "Achievements" section: tables, how awarding
  runs, the approval queue, how to add a season's dates.
- Final report for the owner: the full list with tiers, the earned-by counts
  from the backfill, what the toasts look like, every file touched outside
  the new system, and anything left undone.
