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
import { runAgent } from "./agent.js";
import { buildDossier } from "./dossier.js";
import { turnSystem, discoveryNudgeFor } from "./turnSystem.js";
import { withLookupProvenance, normalizeLookupProvenance } from "./lookupProvenance.js";
import { rememberTable, extractChartMarker, cardRecord, CHART_TOOL_NOTE } from "../features/chatCards.js";

// Phrases from the 24 Nov "you pasted that block" chat. None may ever appear.
const PASTED = /\b(you|u) (have )?pasted\b|pasted (it|that|this) (in|into)|in(side)? your (own )?message|can(?:'|no)t verify (that|the|this) (block|context|data)|won'?t act on (it|that)|i (made|invented) (that|it) up/i;
const LEAKS = /stocksaathi_app_context|stocksaathi_lookup_provenance|system prompt|\btool_calls?\b|\bget_[a-z_]+\b|screen_stocks|read_chart/i;
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
    turns: [{ say: "which large company on the whole NSE has the highest pe? show its chart", expect: { tools: ["screen_stocks", "read_chart"], maxLookups: 4, marker: "chart", never: [LEAKS] } }],
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
    id: "concept",
    title: "Explain P/E simply",
    from: "Baseline: a concept question needs no lookups and no essay.",
    turns: [{ say: "explain pe ratio like i'm 12", expect: { maxLookups: 0, maxWords: 190, never: [LEAKS] } }],
  },
];

const words = (t) => (String(t || "").trim().match(/\S+/g) || []).length;

function judge(expect = {}, { raw, text, card, tools }) {
  const out = [];
  const add = (name, ok, detail = "") => out.push({ name, ok: !!ok, detail });
  add("answered", !!text && text.length > 1);
  for (const re of expect.never || []) {
    const m = raw.match(re);
    add(`never says ${String(re).slice(1, 38)}…`, !m, m ? `"${m[0]}"` : "");
  }
  for (const re of expect.must || []) add(`says ${String(re).slice(1, 38)}…`, re.test(raw));
  for (const t of expect.tools || []) add(`used ${t}`, tools.includes(t));
  if (expect.maxLookups != null) add(`at most ${expect.maxLookups} lookup${expect.maxLookups === 1 ? "" : "s"}`, tools.length <= expect.maxLookups, `${tools.length} ran`);
  if (expect.marker === "table") add("shows a table", card?.type === "table" || /\n\s*\|.+\|\s*\n\s*\|?\s*:?-{2,}/.test(raw));
  else if (expect.marker) add(`shows the ${expect.marker} card`, card?.type === expect.marker);
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
        discoveryNudge: discoveryNudgeFor(turn.say),
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
      const checks = error ? [{ name: "answered", ok: false, detail: error }] : judge(turn.expect, { raw, text, card: ex.card, tools });
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
