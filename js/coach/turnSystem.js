// =============================================================================
// The system prompt for one coach turn on /chat, in one place: the chat page
// sends it and the replay test set (coach/replay.js) builds the same text, so
// the tests run against exactly what a student gets.
//
//   lean = true   the short brief (SYSTEM_PROMPT_LEAN) + live facts + dossier
//   lean = false  the long rulebook + its add-ons (tool section, tone rule,
//                 prefetched news, the discovery nudge)
// =============================================================================
import { SYSTEM_PROMPT, SYSTEM_PROMPT_LEAN, runtimeFacts } from "./persona.js";
import { isDiscoveryQuery } from "./agent.js";
import { marketStatus } from "../data/prices.js";

// The language rule, repeated last in the prompt (it holds better there). The
// Hinglish switch picks the language; nothing guesses it from the student's
// words. One copy, used by the chat page and by the replay test set.
export function turnLangNote(hinglish) {
  return hinglish
    ? `

# THIS TURN: LANGUAGE
Hinglish mode is on. Reply in casual Hinglish: mix everyday Roman Hindi with natural English words and phrases. Keep finance terms like P/E, SIP, NAV, price, profit, company and stock in English. Avoid formal Hindi translations such as 'tulna', 'ummeed', 'nirnay', 'nivesh', 'laabh', 'saalana', 'keemat' and 'moolya'.`
    : `

# THIS TURN: LANGUAGE
Reply in English.`;
}

export function discoveryNudgeFor(userText) {
  return isDiscoveryQuery(userText)
    ? `

# THIS TURN
This is a discovery question. Search for the instruments AND call get_stock_price for every symbol you plan to name - in parallel, in ONE turn - then reply with the names and their prices together. (Rows from the screener or the movers lookup already carry prices: show those with [[table]] and do not look their prices up again.) A list of names with no prices is not an acceptable answer, and do not ask whether the user wants the prices.`
    : "";
}

export function turnSystem({ lean, userText = "", dossier = "", chartNote = "", turnLang = "", newsBlock = "", discoveryNudge = "" }) {
  return lean
    ? `${SYSTEM_PROMPT_LEAN}\n\n${runtimeFacts(marketStatus(), userText)}\n\n${dossier}` + chartNote + turnLang
    : `${SYSTEM_PROMPT}\n\n# TOOL USE\nYou have tools for live data: get_stock_price, get_crypto_price, search_stocks, get_market_news, get_user_portfolio, get_trade_history, get_watchlist, get_limit_orders, get_fundamentals, screen_stocks (rank the whole market by P/E, size, ROE and more), get_market_movers (top gainers, losers, most traded), read_chart (read a stock's price chart, with RSI, MACD and moving averages), get_index (Nifty, Sensex, sector indices, India VIX), get_corporate_actions (dividends, splits, bonuses), get_mutual_fund (a fund's NAV, category, risk and returns), compare_stocks (up to 25 companies in ONE lookup, with each sector's typical P/E: use it for any list of stocks or the student's holdings as a group), get_profit_and_loss (the student's booked and paper profit, returns and value over time), get_popular_on_stocksaathi (what students bought most). USE them whenever the user asks about any specific stock, crypto, market state, company fundamentals (profit, EPS, ROE, P/E, debt, market cap), or their portfolio. Never guess numbers — always call the tool.\n\nCRITICAL: Call tools via the STRUCTURED tool_calls API only. NEVER write literal text like 'CALL search_stocks(...)' or '[Tool call: ...]' or fenced ` + "```tool_calls```" + ` JSON in your visible response. Those are internal scaffolding the user must never see. If you want to call a tool, emit the tool_call JSON block and let the system handle it. Your visible reply either (a) answers the user's question with real data you just received from a tool, or (b) says you'll look it up — never describes the mechanics of looking it up.\n\n${runtimeFacts(marketStatus(), userText)}\n\n${dossier}\n\n# TONE\nKeep replies conversational and short by default (1–3 sentences). Only go longer when the user asks for explanation or depth.` + newsBlock + discoveryNudge + chartNote + turnLang;
}
