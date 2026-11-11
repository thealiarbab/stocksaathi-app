# Brief: Report card v2, a real scoring algorithm (queue item #2)

Read `AGENTS.md` first: commit identity, ship-to-main, SW cache bump, no
DROP/DELETE through the Supabase connector, and the owner's style rules all
apply. This brief is self-contained; the 19 Oct handoff file it came from is
not in git.

## You own this

The report card is yours to redesign: `js/pages/reportCard.js` and any new
modules it needs. Restructure it freely. Outside it, change only what the
report card needs, and list every such change in your final report. The
owner reviews the diff, not the summary, so small changes count too.

Finish the whole task: design, build, validate on real data, ship. Do not
stop at a plan or a list of remaining steps unless something below is
genuinely blocked; then say exactly what and why.

## What is wrong today

`analyzeBehavior()` in `js/pages/reportCard.js` (~line 166):

- Starts at 75, then: -10 per panic sell, **+8 per "intervention hold"**,
  -5 FOMO, -6 churn, -8 if the top holding is over 50%, -6 if the top sector
  is over 70%, +3 for 5+ coach messages, + min(10, return%). Clamped 10-100.
  Result: almost everyone lands on a B. It does not separate good habits
  from bad ones.
- **Intervention holds no longer exist.** The panic-sell pause was removed on
  24 Oct (owner's option C: a quiet note after the trade, never a pause). The
  +8 and `selfOverrideRate` are dead.
- It counts biases from `coachMessages`, not from the trades. Since 24 Oct
  every trade stores its detector results in `transactions.bias_flags`
  (`biasFlag()` in `js/coach/biasDetectors.js`; detectors in
  `js/coach/biasCore.js`, pure functions, tested by
  `scripts/test-bias-core.mjs`). Use those.
- It computes its own win rate (~line 324, `wins/(wins+losses)`) separately
  from `js/data/tradeStats.js`. Use the shared maths.
- The badge list is 8 hard-coded entries. Leave badges as they are:
  achievements (#3) replace them later. Don't build achievements here.

## What the owner asked for

A score built on three pillars:

1. **Discipline**: behaviour, not luck. Panic sells, FOMO and pump-chasing,
   churning, overtrading, averaging down without a reason, holding losers
   while selling winners (all from `bias_flags`). Weight each pattern by its
   severity and how recent it is, and normalise by how much the user trades,
   so 2 flags in 300 trades is not scored like 2 flags in 5.
2. **Diversification**: concentration in one stock and one sector, number
   of real positions, and cash left idle (judge cash fairly: holding cash is
   not a mistake for a beginner).
3. **Learning and activity**: steady engagement over time (crash replays,
   coach questions, reading the explainers), not raw trade count. Never
   reward overtrading.

Plus **return relative to the Nifty 50**, at a SMALL weight, and only once
the user has about 4 weeks of history or 10 trades. The owner accepted this
trade-off explicitly. Before that point, don't show it or score it.

Shared maths to use: `computeTradeStats` (round trips, wins, losses, evens,
realised P/L; the win rate excludes evens) and `returnSummary` /
`getReturnSummary` in `js/state.js` (profit = booked + on paper; return on the
money put in).

## Requirements

- **New users:** show a fair "not enough data yet" state per pillar, with
  what unlocks it. Never give a beginner a bad grade for having no history.
- **Explainable:** every pillar shows its score and the 1-3 real facts behind
  it, in the user's own numbers ("3 of your last 20 sells were within a day
  of a 5% drop"). English and Hinglish, like the rest of the app
  (`settings.hinglish`, `js/features/aiLang.js`).
- **Spread:** grades must spread across real users, not cluster. Choose the
  thresholds from the measured distribution, not by guessing.
- **Stable:** a grade shouldn't swing on one day's prices. Discipline and
  Learning are about decisions, so the market shouldn't move them.
- **Real prices only:** `getRealPricePaise`, real closes from
  `js/data/realCloses.js`, never the synthetic chart walk in `marketData.js`.
- The AI card on the page (`/api/ai?op=report-card`, cached per the 31 Oct
  change) should receive the new pillar scores so its text matches.
  Do not change model effort settings.
- UI taste: compact by default, with a button to see more; pop-up dialogs
  over inline expanding panels; important buttons filled. Must work at
  1366x768 and on phones.
- The weekly report email links to `/report-card`
  (`handlers/weekly-report.py`), so the page must still load fast.

## Validate on real data before shipping

The Supabase connector reaches production (project `hwlmwraowcylxzdpumca`).
Read-only queries are fine.

- `transactions` has about 7,100+ real trades (with `bias_flags` from 24 Oct
  on), plus `profiles`, holdings and portfolio snapshots.
- Put the scoring core in a pure module with no imports, as `biasCore.js`
  does, so it runs unchanged in Node against exported rows.
- Report: the grade distribution across real users (before and after), and
  5 example users (no names or ids) with their pillar scores and the facts
  shown, including at least one beginner and one heavy trader.
- Add `scripts/test-report-card.mjs` covering edge cases (no trades, only
  buys, all evens, one huge position, all cash, split-adjusted price
  mismatch), and wire it into `.github/workflows/perf-syntax.yml` the way
  `test-bias-core.mjs` and `test-quote-loop.mjs` are.

**Known trap:** the Nifty (`^NSEI`) cannot go through `/api/history`, because
the handler appends `.NS`. Find a real source for index closes (check
`js/data/crashes.js` and `js/coach/biasCore.js` for how the index is handled
today) or add one properly.

## Ship

- Commit as Ali Arbab, push to `main`, and apply any migration to
  production in the same task. No `sw.js` bump: since 1 Nov the build
  (`build/bundle.mjs`) hashes assets. A file loaded by a runtime string path
  rather than `import` must be added to `LITERALS` there.
- Update `AGENTS.md` with a short "Report card v2" section: how the score
  works, where the code is, and how to re-validate.
- Final report for the owner: what changed and why, the measured grade
  distribution, the example users, every file touched outside the report
  card, and anything left undone.
