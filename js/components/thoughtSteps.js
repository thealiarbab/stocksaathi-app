// =============================================================================
// THOUGHT STEPS: what Saathi is doing while it works, shown in the reply
// bubble, then folded into one row above the answer.
//
// Structure from Groww GR-1 (owner's 28 phone screenshots, 24 Nov 2026,
// F:\DOWNLoaded Shit\GR-01 RECON):
//   - a waiting word that rotates, with a light sweep across the letters;
//   - a narration line (the model's own words between lookups);
//   - the lookups as a tree of steps: a spinner while running, then a tick;
//   - when the answer starts, all of it folds into one quiet row, and a tap
//     opens a sheet that replays every step.
// StockSaathi's own part: each finished step shows its receipt, the number
// it actually fetched ("Checked RELIANCE price ··· ₹1,351.00"), so a student
// can see where every figure in the answer came from. The spinner is a tiny
// three-bar candlestick, and the fold row counts the lookups.
//
// Display only. Nothing here is saved into the text the model reads back.
// =============================================================================

import { openSheet } from "./pickSheet.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const inr = (n) => "₹" + Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Each waiting word has its own little icon (owner's mockups, 24 Nov).
const ICONS = {
  chart: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 13.5h12M4 11V7M7 11V4M10 11V8M13 11V5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  brain: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.2c-.8-1-2.6-1-3.3.3-1.4 0-2.2 1.5-1.6 2.6-1 .8-.9 2.5.2 3.1-.2 1.4 1 2.6 2.4 2.3.7 1 2.3 1 2.3-.2V3.2zm0 0c.8-1 2.6-1 3.3.3 1.4 0 2.2 1.5 1.6 2.6 1 .8.9 2.5-.2 3.1.2 1.4-1 2.6-2.4 2.3-.7 1-2.3 1-2.3-.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>`,
  calc: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="1.8" width="10" height="12.4" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.5 4.8h5M5.6 8h.1M8 8h.1M10.4 8h.1M5.6 10.6h.1M8 10.6h.1M10.4 10.6h.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  spark: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 2.5l1.2 3.3 3.3 1.2-3.3 1.2L7 11.5 5.8 8.2 2.5 7l3.3-1.2zM12.2 10.3l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>`,
};
const WORDS_EN = [["Reading the charts…", "chart"], ["Thinking…", "brain"], ["Checking the numbers…", "calc"], ["Crafting your answer…", "spark"]];
const WORDS_HI = [["Charts dekh raha hoon…", "chart"], ["Soch raha hoon…", "brain"], ["Numbers check kar raha hoon…", "calc"], ["Jawab bana raha hoon…", "spark"]];

// The smaller line under each step.
const SUB = {
  get_stock_price: ["Fetching the latest quote", "Last traded price"],
  get_crypto_price: ["Fetching the latest quote", "Latest price"],
  get_fundamentals: ["Fetching company numbers", "Fundamentals retrieved"],
  get_user_portfolio: ["Reading your holdings", "Holdings retrieved"],
  get_trade_history: ["Reading your trade log", "Trades retrieved"],
  get_watchlist: ["Reading your watchlist", "Watchlist retrieved"],
  get_limit_orders: ["Reading your queued orders", "Orders retrieved"],
  get_market_news: ["Scanning today's headlines", "Headlines retrieved"],
  search_stocks: ["Searching NSE and BSE", "Matches found"],
  check: ["Matching every number to a lookup", "Numbers checked"],
};

export function createTrace() {
  return { t0: Date.now(), groups: [], think: "", answerAt: 0, endAt: 0 };
}

function args(tc) {
  try { const a = tc?.function?.arguments; return typeof a === "string" ? JSON.parse(a || "{}") : (a || {}); } catch { return {}; }
}

function toolLabel(name, a, done) {
  const sym = String(a.symbol || a.ticker || a.coin || "").toUpperCase();
  const q = String(a.query || "").trim();
  const T = (run, fin) => (done ? fin : run);
  switch (name) {
    case "get_stock_price": return T(`Checking ${sym || "the"} price`, `Checked ${sym || "the"} price`);
    case "get_crypto_price": return T(`Checking ${sym || "the coin"} price`, `Checked ${sym || "the coin"} price`);
    case "get_fundamentals": return T(`Pulling ${sym || "company"} numbers`, `Pulled ${sym || "company"} numbers`);
    case "get_user_portfolio": return T("Opening your portfolio", "Opened your portfolio");
    case "get_trade_history": return T("Reading your trades", "Read your trades");
    case "get_watchlist": return T("Opening your watchlist", "Opened your watchlist");
    case "get_limit_orders": return T("Checking your orders", "Checked your orders");
    case "get_market_news": return T(q ? `Reading news on ${q}` : "Reading the latest news", q ? `Read news on ${q}` : "Read the latest news");
    case "search_stocks": return T(q ? `Searching “${q}”` : "Searching stocks", q ? `Searched “${q}”` : "Searched stocks");
    default: return T("Looking that up", "Looked it up");
  }
}

// The number the step fetched, from the tool's own result. Format only.
function receipt(name, facts) {
  if (!facts || typeof facts !== "object") return null;
  const pct = (v) => (Number.isFinite(v) ? { v: `${v > 0 ? "+" : ""}${v.toFixed(2)}%`, dir: v > 0 ? "up" : v < 0 ? "down" : "" } : null);
  const count = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  switch (name) {
    case "get_stock_price":
    case "get_crypto_price": {
      if (!Number.isFinite(facts.price_inr)) return null;
      const p = pct(facts.day_change_pct);
      return { text: inr(facts.price_inr), extra: p?.v, dir: p?.dir };
    }
    case "get_user_portfolio":
      return Number.isFinite(facts.holdings_count) ? { text: count(facts.holdings_count, "holding") } : null;
    case "get_trade_history": {
      const n = Array.isArray(facts.trades) ? facts.trades.length : facts.count;
      return Number.isFinite(n) ? { text: count(n, "trade") } : null;
    }
    case "get_watchlist": {
      const n = Array.isArray(facts.items) ? facts.items.length : Array.isArray(facts.watchlist) ? facts.watchlist.length : facts.count;
      return Number.isFinite(n) ? { text: count(n, "stock") } : null;
    }
    case "get_limit_orders": {
      const n = Array.isArray(facts.orders) ? facts.orders.length : facts.count;
      return Number.isFinite(n) ? { text: count(n, "order") } : null;
    }
    case "get_market_news": {
      const n = Array.isArray(facts.items) ? facts.items.length : Array.isArray(facts.headlines) ? facts.headlines.length : facts.count;
      return Number.isFinite(n) ? { text: count(n, "headline") } : null;
    }
    case "search_stocks":
      return Number.isFinite(facts.count) ? { text: `${facts.count} match${facts.count === 1 ? "" : "es"}` } : null;
    case "get_fundamentals": {
      const pe = facts.pe ?? facts.pe_ratio ?? facts.trailingPE;
      return Number.isFinite(pe) ? { text: `P/E ${Number(pe).toFixed(1)}` } : null;
    }
    default: return null;
  }
}

// Feed an agent onStep event into the trace.
export function traceStep(trace, st) {
  if (!trace || !st) return;
  const last = trace.groups[trace.groups.length - 1];
  if (st.action === "narration" && st.text) {
    trace.groups.push({ text: clip(st.text, 220), steps: [] });
  } else if (st.action === "tool_calls") {
    const g = last && !last.steps.length ? last : (trace.groups.push({ text: "", steps: [] }), trace.groups[trace.groups.length - 1]);
    for (const tc of st.calls || []) {
      const name = tc?.function?.name || "";
      const a = args(tc);
      g.steps.push({ name, a, state: "run", label: toolLabel(name, a, false), t: Date.now() });
    }
  } else if (st.action === "tool_results") {
    const running = trace.groups.flatMap((g) => g.steps).filter((s) => s.state === "run");
    (st.lookups || []).forEach((lk, i) => {
      const s = running[i];
      if (!s) return;
      s.state = lk?.status === "returned" ? "done" : "fail";
      s.label = s.state === "done" ? toolLabel(s.name, s.a, true) : `Couldn't get ${toolLabel(s.name, s.a, false).replace(/^\w+\s/, "").toLowerCase()}`;
      s.r = s.state === "done" ? receipt(s.name, lk.facts) : null;
      s.ms = Date.now() - s.t;
    });
  } else if (st.action === "figure_check") {
    trace.groups.push({ text: "", steps: [{ name: "check", a: {}, state: "run", label: "Double-checking the numbers", t: Date.now() }] });
  }
}

// Summaries can mention the instructions; those lines are never shown.
const HIDE_RE = /\b(system prompt|instructions?|the rules?|tool|function call|app context|context block|stocksaathi_|<\/?\w+>|json)\b/i;
export function traceReasoning(trace, delta) {
  if (!trace || !delta) return;
  trace.think = (trace.think + delta).slice(-1500);
}
function latestThought(trace) {
  const parts = String(trace.think || "")
    .replace(/\*\*/g, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12 && s.length < 200 && !HIDE_RE.test(s));
  return parts.length ? parts[parts.length - 1] : "";
}

function clip(s, n) { s = String(s || "").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

const candle = `<span class="ts-candle" aria-hidden="true"><i></i><i></i><i></i></span>`;
const tick = `<svg class="ts-tick" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.2 8.3l2 2 3.8-4.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const cross = `<svg class="ts-tick ts-x" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

function subLine(s) {
  if (s.state === "fail") return "Couldn't get it this time";
  const pair = SUB[s.name] || ["Looking it up", "Retrieved"];
  return s.state === "run" ? pair[0] : pair[1];
}
function stepHtml(s) {
  const right = s.state === "run"
    ? `<span class="ts-pill is-run">Running</span>`
    : s.state === "fail"
      ? `<span class="ts-pill is-fail">Missed</span>`
      : s.r
        ? `<span class="ts-rcpt">${esc(s.r.text)}${s.r.extra ? `<b class="${s.r.dir === "up" ? "positive" : s.r.dir === "down" ? "negative" : ""}">${esc(s.r.extra)}</b>` : ""}</span>`
        : `<span class="ts-pill is-done">Done</span>`;
  const t = s.ms ? `<span class="ts-ms">${(s.ms / 1000).toFixed(1)}s</span>` : "";
  return `<li class="ts-step is-${s.state}">
      <span class="ts-ico">${s.state === "run" ? candle : s.state === "done" ? tick : cross}</span>
      <span class="ts-text"><span class="ts-label">${esc(s.label)}</span><span class="ts-sub">${esc(subLine(s))}${t ? ` · ${t}` : ""}</span></span>
      <span class="ts-right">${right}</span>
    </li>`;
}
function stepsHtml(groups) {
  return groups.map((g) => `
    <div class="ts-group">
      ${g.text ? `<p class="ts-narr">${esc(g.text)}</p>` : ""}
      ${g.steps.length ? `<ul class="ts-steps">${g.steps.map(stepHtml).join("")}</ul>` : ""}
    </div>`).join("");
}

function secs(trace) {
  const end = trace.answerAt || trace.endAt || Date.now();
  return Math.max(1, Math.round((end - trace.t0) / 1000));
}
function lookups(trace) { return trace.groups.flatMap((g) => g.steps).filter((s) => s.state === "done" && s.name !== "check").length; }

// The live block while Saathi works.
export function liveTraceHtml(trace, { hinglish = false } = {}) {
  const words = hinglish ? WORDS_HI : WORDS_EN;
  const [word, icon] = words[Math.floor((Date.now() - trace.t0) / 2400) % words.length];
  const thought = latestThought(trace);
  const all = trace.groups.flatMap((g) => g.steps);
  const done = all.filter((x) => x.state !== "run").length;
  const pct = all.length ? Math.round((done / all.length) * 100) : 0;
  return `<div class="ts-live" role="status" aria-live="polite">
    <div class="ts-head">
      <span class="ts-wico ts-w-${icon}" aria-hidden="true">${ICONS[icon]}</span>
      <span class="ts-word">${esc(word)}</span>
      ${done ? `<span class="ts-pill is-done">${done} done</span>` : ""}
      <span class="ts-secs">${secs(trace)}s</span>
    </div>
    ${thought ? `<p class="ts-think">${ICONS.brain}<span>${esc(thought)}</span></p>` : ""}
    ${stepsHtml(trace.groups)}
    ${all.length > 1 ? `<div class="ts-bar" aria-hidden="true"><i style="width:${pct}%"></i></div>` : ""}
  </div>`;
}

// The folded row above a finished answer. `idx` lets the page find the trace.
export function foldedTraceHtml(trace, idx) {
  if (!trace || (!trace.groups?.length && !trace.think)) return "";
  const n = lookups(trace);
  const label = n ? `Checked ${n} thing${n === 1 ? "" : "s"} · thought ${secs(trace)}s` : `Thought for ${secs(trace)}s`;
  return `<button type="button" class="ts-fold" data-trace="${idx}" aria-haspopup="dialog">${n ? tick : `<span class="ts-dot" aria-hidden="true"></span>`}<span>${esc(label)}</span><span class="ts-chev" aria-hidden="true">›</span></button>`;
}

export function openTraceSheet(trace) {
  if (!trace) return;
  const thought = latestThought(trace);
  const body = trace.groups.length
    ? stepsHtml(trace.groups)
    : `<p class="ts-narr">${esc(thought || "Saathi answered from what it already had: no lookups this time.")}</p>`;
  const note = `<div class="ts-note">${ICONS.spark}<p><strong>Where these numbers come from.</strong> Your portfolio, the time and market status come from StockSaathi itself; every other figure comes from the lookups above. A step shows a tick only after its lookup came back.</p></div>`;
  openSheet({ title: "How Saathi got this", className: "ts-sheet", html: `<div class="ts-replay">${body}</div>${note}` });
}

// A compact copy for saving on the message (display only).
export function freezeTrace(trace) {
  if (!trace) return null;
  const now = Date.now();
  return {
    t0: trace.t0, answerAt: trace.answerAt || now, endAt: now, think: "",
    groups: trace.groups.map((g) => ({ text: g.text, steps: g.steps.map((s) => ({ name: s.name, a: {}, state: s.state === "run" ? "done" : s.state, label: s.label, r: s.r || null, ms: s.ms || 0 })) })),
  };
}
