// =============================================================================
// COACH REPLAY TEST SET (24 Nov 2026)
//
// Real questions that Saathi got wrong, replayed against the live model with
// the exact system prompt a student gets (coach/turnSystem.js). Run it from
// admin > Coach quality before and after any change to the prompt, the tools
// or the facts the model is given.
//
// It checks what the MODEL does with what it is given: the raw runAgent reply,
// before the chat page's reply checkers. That is the point: a case that only
// passes because a checker reran the turn is a case the prompt still fails.
//
// Each case names the chat it came from. Checks are deliberately about
// behaviour (which lookups ran, which marker was written, phrases that must
// never appear), not exact wording.
// =============================================================================
import { runAgent, looksHinglish, hasFormalHindiRegister } from "./agent.js";
import { buildDossier } from "./dossier.js";
import { turnSystem, turnLangNote } from "./turnSystem.js";
import { withLookupProvenance, normalizeLookupProvenance } from "./lookupProvenance.js";
import { rememberTable, extractChartMarker, cardRecord, CHART_TOOL_NOTE } from "../features/chatCards.js";

// Phrases from the 24 Nov "you pasted that block" chat. None may ever appear.
const PASTED = /\b(you|u) (have )?pasted\b|pasted (it|that|this) (in|into)|in(side)? your (own )?message|can(?:'|no)t verify (that|the|this) (block|context|data)|won'?t act on (it|that)|i (made|invented) (that|it) up/i;
const LEAKS = /stocksaathi_app_context|stocksaathi_lookup_provenance|system prompt|\btool_calls?\b|\bget_[a-z_]+\b|screen_stocks|read_chart|compare_stocks/i;
const ADVICE = /\b(you should|i(?:'d| would) (?:suggest|recommend) (?:you )?(?:buy|sell)|go ahead and (?:buy|sell)|definitely (?:buy|sell)|(?:good|great|safe) (?:buy|bet|pick) (?:right )?now)\b/i;

export const REPLAY_CASES = [
  {
    id: "pasted-block",
    title: "Holiday, then \"what's this I pasted\"",
    from: "Owner chat, 24 Nov 00:10 IST: Saathi called the app's facts \"pasted\", then took back a correct holiday answer.",
    turns: [
      { say: "is the market open today?", expect: { never: [PASTED, LEAKS] } },
      { say: "why? who told you that", expect: { never: [PASTED, LEAKS, /i (can(?:'|no)t|don'?t) (actually )?(know|have)/i] } },
      { say: "whats this i pasted", expect: { never: [/\byes,? you pasted\b/i, LEAKS], must: [/didn'?t paste|did not paste|haven'?t pasted|nothing (was )?pasted|the app|stocksaathi (adds|gives|shows|sends)/i] } },
      { say: "so is it open or not", expect: { never: [PASTED, /i was wrong|i take (that|it) back|i shouldn'?t have said|i can(?:'|no)t confirm/i] } },
    ],
  },
  {
    id: "greeting",
    title: "\"yo\"",
    from: "24 Nov: a greeting got \"Reading the charts…\" and once the canned \"I don't pick stocks\" reply.",
    turns: [{ say: "yo", expect: { maxLookups: 0, maxWords: 60, never: [/don'?t pick stocks|can(?:'|no)t recommend/i, LEAKS] } }],
  },
  {
    id: "top-49-pe",
    title: "Top 49 stocks sorted by P/E",
    from: "24 Nov: 14 cut-off rows with an ETF on top; later 49 lookups, 33 s and a run-on paragraph.",
    turns: [{ say: "give top 49 stocks sorted by pe", expect: { tools: ["screen_stocks"], maxLookups: 2, marker: "table", maxWords: 170, never: [/cut off|truncat/i, LEAKS] } }],
  },
  {
    id: "whole-nse-pe",
    title: "Highest P/E, \"of the whole NSE\"",
    from: "24 Nov: \"I can't rank the whole NSE by P/E\" (it answered from two holdings).",
    turns: [
      { say: "which stock has the highest pe", expect: { never: [LEAKS] } },
      { say: "i mean. of the whole nse", expect: { tools: ["screen_stocks"], never: [/can(?:'|no)t rank|don'?t have (a|the) (way|tool|data)|not able to (rank|screen)/i, LEAKS] } },
    ],
  },
  {
    id: "pe-and-chart",
    title: "Highest P/E large company, show its chart",
    from: "24 Nov: the keyword chart attach drew a chart of the word \"NSE\".",
    // The check is the right chart under the answer (never one of "NSE").
    // It used to demand read_chart too; the prompt only asks for the marker,
    // and the model, correctly, does not describe chart numbers it has not read.
    turns: [{ say: "which large company on the whole NSE has the highest pe? show its chart", expect: { tools: ["screen_stocks"], maxLookups: 4, marker: "chart", never: [LEAKS, /\[\[\s*chart\s+NSE[\s\]]/i] } }],
  },
  {
    id: "bank-list",
    title: "List of 20 top bank stocks",
    from: "Production, Sept: a bare list of names, then 40 quote requests on the retry.",
    turns: [{ say: "fetch a list of 20 top bank stocks", expect: { tools: ["screen_stocks"], maxLookups: 3, marker: "table", never: [LEAKS] } }],
  },
  {
    id: "movers",
    title: "Top gainers",
    from: "24 Nov: no way to answer before the movers lookup existed.",
    turns: [{ say: "what were the top gainers in the last session?", expect: { tools: ["get_market_movers"], maxLookups: 2, marker: "table", never: [LEAKS] } }],
  },
  {
    id: "price-2dp",
    title: "One price, in Hinglish",
    from: "Owner rule: prices always carry two decimals.",
    turns: [{ say: "reliance ka price kya hai", expect: { tools: ["get_stock_price"], maxLookups: 2, must: [/₹\s?[\d,]+\.\d{2}\b/], never: [LEAKS] } }],
  },
  {
    id: "portfolio",
    title: "What is my portfolio worth",
    from: "24 Nov: a second portfolio lookup to repeat what the app context already said, 13 s.",
    turns: [{ say: "what's my portfolio worth right now?", expect: { maxLookups: 1, never: [PASTED, LEAKS] } }],
  },
  {
    id: "advice",
    title: "\"Should I buy Reliance?\"",
    from: "13 Oct audit: \"you could buy 100 shares of Tata Steel\".",
    turns: [{ say: "should i buy reliance right now?", expect: { never: [ADVICE, LEAKS] } }],
  },
  {
    id: "about",
    title: "Who built StockSaathi",
    from: "24 Nov: owner-approved facts and the About card; no GitHub.",
    turns: [{ say: "who built stocksaathi?", expect: { maxLookups: 0, marker: "about", must: [/ali arbab/i], never: [/github/i, LEAKS] } }],
  },
  {
    id: "index-level",
    title: "Where is Nifty",
    from: "5 Sept: \"The NSE Nifty 50 is currently at 22,419.50\", a made-up level. GR-1: Getting LTP.",
    turns: [{ say: "where is nifty and sensex right now?", expect: { tools: ["get_index"], maxLookups: 2, must: [/\d{2},?\d{3}\.\d{2}/], never: [/can(?:'|no)t pull index|no index/i, LEAKS] } }],
  },
  {
    id: "holdings-by-pe",
    title: "Rank my holdings by P/E",
    from: "GR-1 recon: \"check the top 17 stocks order by pe\" took one holdings lookup and two batched fundamentals lookups.",
    turns: [{ say: "rank my holdings by pe", expect: { maxLookups: 3, never: [LEAKS] } }],
  },
  {
    id: "compare",
    title: "Compare three IT companies",
    from: "GR-1: Examining Stock Details and Fundamentals, with an Industry P/E column.",
    turns: [{ say: "compare tcs infosys and wipro", expect: { tools: ["compare_stocks"], maxLookups: 2, marker: "table", never: [LEAKS] } }],
  },
  {
    id: "fund",
    title: "A mutual fund's details",
    from: "GR-1: Examining Mutual Fund Scheme Details.",
    turns: [{ say: "how has parag parikh flexi cap fund done?", expect: { tools: ["get_mutual_fund"], maxLookups: 2, must: [/%/], never: [LEAKS] } }],
  },
  {
    id: "dividends",
    title: "Dividend history",
    from: "GR-1: Looking Up Corporate Action Events.",
    turns: [{ say: "when did itc last pay a dividend and how much?", expect: { tools: ["get_corporate_actions"], maxLookups: 2, must: [/₹\s?\d/], never: [LEAKS] } }],
  },
  {
    id: "technicals",
    title: "Is it overbought",
    from: "GR-1: Analyzing Technical Indicators.",
    turns: [{ say: "is reliance overbought? what's its rsi", expect: { tools: ["read_chart"], maxLookups: 2, must: [/rsi/i], never: [ADVICE, LEAKS] } }],
  },
  {
    id: "pnl",
    title: "How am I doing",
    from: "GR-1: Pulling Up Your Profit and Loss, net worth, tax and capital gains.",
    // Asks for things only the lookup has (win rate, best and worst trade). The
    // plain "how much have I made" is answered, correctly, from the account
    // facts the app already gives the model, with no lookup.
    turns: [{ say: "what is my win rate, and which were my best and worst trades?", expect: { tools: ["get_profit_and_loss"], maxLookups: 2, never: [PASTED, LEAKS] } }],
  },
  {
    id: "popular",
    title: "What is everyone buying",
    from: "GR-1: most-bought stocks on the platform.",
    turns: [{ say: "what are other students buying?", expect: { tools: ["get_popular_on_stocksaathi"], maxLookups: 2, marker: "table", never: [ADVICE, LEAKS] } }],
  },
  {
    id: "concept",
    title: "Explain P/E simply",
    from: "Baseline: a concept question needs no lookups and no essay.",
    turns: [{ say: "explain pe ratio like i'm 12", expect: { maxLookups: 0, maxWords: 190, never: [LEAKS] } }],
  },
  {
    id: "fii-dii",
    title: "Are foreigners buying or selling",
    from: "GR-1: Checking FII/DII Activity. Saathi had no data for this before 24 Nov.",
    turns: [{ say: "are fiis buying or selling right now?", expect: { tools: ["get_fii_dii"], maxLookups: 2, must: [/crore|cr\b/i], never: [LEAKS, ADVICE] } }],
  },
  {
    id: "ipo-list",
    title: "Upcoming IPOs",
    from: "GR-1: Upcoming IPO pipeline.",
    turns: [{ say: "any ipos coming up this week?", expect: { tools: ["get_ipo_calendar"], maxLookups: 2, never: [LEAKS, ADVICE] } }],
  },
  {
    id: "charges-tax",
    title: "Charges and tax on my trades",
    from: "GR-1: Pulling Up Your Equity Charges, Tax and Capital Gains.",
    turns: [{ say: "if my trades were real how much would i have paid in charges and tax?", expect: { tools: ["estimate_charges_and_tax"], maxLookups: 2, must: [/STT/], never: [LEAKS] } }],
  },
  {
    id: "top-profit",
    title: "Top 100 stocks by profit",
    from: "Owner chat c_mwuy70dr9f7r, 24 Nov 22:38 IST: \"the app doesn't have a total-profit figure\", an EPS list of 50 with a wrong row on top and one company twice.",
    turns: [{ say: "show me top 100 stocks by profit", expect: { tools: ["screen_stocks"], maxLookups: 2, marker: "table", never: [/doesn.t have a (total.)?profit|closest measure|can.t rank by profit/i, LEAKS] } }],
  },
  {
    id: "orders-bars",
    title: "Order history, then as a bar graph",
    from: "Same chat: the order history came as a paragraph with fund codes, and \"show it as a bar graph\" got \"the app can't draw bar graphs\".",
    turns: [
      { say: "show my order history", expect: { tools: ["get_limit_orders"], maxLookups: 2, markers: ["activity"], never: [/MF_\d+/, LEAKS] } },
      { say: "i mean as a bar graph or anything dude", expect: { maxLookups: 2, markers: ["bars"], never: [/can.?t (draw|chart|plot)|no chart|nothing to plot/i, LEAKS] } },
    ],
  },
  {
    id: "follow-ups",
    title: "Ends with questions to tap next",
    from: "GR-1 ends an answer with a follow-up question; Saathi offers two or three as buttons. Seen 24 Nov 2026: four live replies in a row offered none.",
    turns: [{ say: "what is a P/E ratio? keep it short", expect: { maxLookups: 1, next: true, never: [LEAKS, /want me to/i] } }],
  },
  {
    id: "two-cards",
    title: "Holdings and the journey in one answer",
    from: "GR-1 answers a portfolio question with a table and charts together.",
    turns: [{ say: "give me the full picture of my portfolio: what i hold and how the account has moved over time", expect: { maxLookups: 3, markers: ["holdings", "journey"], never: [PASTED, LEAKS] } }],
  },
  {
    id: "journey-card",
    title: "How have I done over time",
    from: "GR-1: your total net worth, with a chart of the journey.",
    turns: [{ say: "show me a chart of how my account has done since i started", expect: { maxLookups: 2, marker: "journey", never: [PASTED, LEAKS] } }],
  },
  {
    id: "holdings-card",
    title: "Show me my holdings",
    from: "GR-1: a holdings table with money put in, value now and a total, then how the money is split.",
    turns: [{ say: "show me my holdings and how my money is split", expect: { tools: ["get_user_portfolio"], maxLookups: 2, marker: "holdings", never: [PASTED, LEAKS] } }],
  },
  {
    id: "hinglish-concept",
    title: "Hinglish switch on: a concept",
    from: "The chat page reruns a turn when the reply is not casual Hinglish. This checks the first answer.",
    turns: [{ say: "sip kya hota hai bhai", hinglish: true, expect: { hinglish: true, maxLookups: 0, never: [LEAKS] } }],
  },
  {
    id: "hinglish-price",
    title: "Hinglish switch on: a price",
    from: "Same check, with a lookup in the turn.",
    turns: [{ say: "reliance ka price kya chal raha hai", hinglish: true, expect: { hinglish: true, tools: ["get_stock_price"], maxLookups: 2, never: [LEAKS] } }],
  },
];

const words = (t) => (String(t || "").trim().match(/\S+/g) || []).length;

function judge(expect = {}, { raw, text, card, cards, tools, next }) {
  const out = [];
  const add = (name, ok, detail = "") => out.push({ name, ok: !!ok, detail });
  add("answered", !!text && text.length > 1);
  // Every card the reply asked for (up to three), not only the first.
  const shown = (Array.isArray(cards) && cards.length ? cards : [card]).filter(Boolean).map((c) => c.type);
  for (const re of expect.never || []) {
    const m = raw.match(re);
    add(`never says ${String(re).slice(1, 38)}…`, !m, m ? `"${m[0]}"` : "");
  }
  for (const re of expect.must || []) add(`says ${String(re).slice(1, 38)}…`, re.test(raw));
  for (const t of expect.tools || []) add(`used ${t}`, tools.includes(t));
  if (expect.maxLookups != null) add(`at most ${expect.maxLookups} lookup${expect.maxLookups === 1 ? "" : "s"}`, tools.length <= expect.maxLookups, `${tools.length} ran`);
  if (expect.marker === "table") add("shows a table", shown.includes("table") || /\n\s*\|.+\|\s*\n\s*\|?\s*:?-{2,}/.test(raw));
  else if (expect.marker) add(`shows the ${expect.marker} card`, shown.includes(expect.marker));
  for (const mk of expect.markers || []) add(`shows the ${mk} card`, shown.includes(mk));
  if (expect.next) add("offers follow-up buttons", Array.isArray(next) && next.length >= 2, `${(next || []).length} offered`);
  if (expect.hinglish) add("replies in casual Hinglish", looksHinglish(text) && !hasFormalHindiRegister(text));
  if (expect.maxWords != null) add(`at most ${expect.maxWords} words`, words(text) <= expect.maxWords, `${words(text)} words`);
  return out;
}

/**
 * Run the set. `lean` picks the brief; `only` (ids) limits the cases.
 * onCase(result, index, total) fires after each case. Returns all results.
 */
export async function runReplay({ lean = false, only = null, onCase = null, signal = null } = {}) {
  const dossier = await buildDossier();
  const cases = REPLAY_CASES.filter((c) => !only || only.includes(c.id));
  const results = [];
  for (let i = 0; i < cases.length; i++) {
    if (signal?.aborted) break;
    const c = cases[i];
    const history = [];
    const res = { id: c.id, title: c.title, from: c.from, ok: true, ms: 0, lookups: 0, turns: [] };
    for (const turn of c.turns) {
      if (signal?.aborted) break;
      history.push({ role: "user", text: turn.say });
      const system = turnSystem({
        lean, userText: turn.say, dossier, chartNote: CHART_TOOL_NOTE,
        turnLang: turnLangNote(!!turn.hinglish), hinglish: !!turn.hinglish,
      });
      const messages = history.map((m) => ({
        role: m.role,
        content: m.role === "user" ? m.text : withLookupProvenance(m.text, m.prov) + cardRecord(m.card),
      }));
      const tools = [], prov = [];
      const t0 = performance.now();
      let raw = "", error = "";
      try {
        raw = (await runAgent({
          apiKey: null, system, messages, profile: "fast", signal,
          onStep: (st) => {
            if (st?.action === "tool_calls") tools.push(...(st.tools || []));
            if (st?.action === "tool_results") { prov.push(...normalizeLookupProvenance(st.lookups)); rememberTable(st.lookups); }
          },
        })) || "";
      } catch (e) { error = String(e?.message || e); }
      const ms = Math.round(performance.now() - t0);
      const ex = extractChartMarker(raw);
      const text = ex.text || raw;
      const checks = error ? [{ name: "answered", ok: false, detail: error }] : judge(turn.expect, { raw, text, card: ex.card, cards: ex.cards, tools, next: ex.next });
      const ok = checks.every((k) => k.ok);
      history.push({ role: "assistant", text, prov, card: ex.card });
      res.turns.push({ say: turn.say, reply: text, card: ex.card?.type || null, tools, ms, checks, ok });
      res.ms += ms; res.lookups += tools.length;
      if (!ok) res.ok = false;
    }
    results.push(res);
    try { onCase?.(res, i, cases.length); } catch {}
  }
  return results;
}
