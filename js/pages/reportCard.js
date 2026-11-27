// =============================================================================
// REPORT CARD (v2, 13 Nov 2026) — a grade for how the user decides.
//
// The score itself lives in coach/reportCardCore.js (pure, tested in Node and
// measured on real users) and its sentences in coach/reportCardCopy.js. This
// file only gathers the inputs and draws the page:
//   trades + detector results  state.transactions (bias_flags) via biasLedger
//   holdings                   REAL prices only (getRealPricePaise), else cost
//   learning                   report_card_activity() (features/learning.js)
//   Nifty 50                   real closes (data/indexCloses.js)
//
// Compact by default: a grade, one tile per pillar with its main fact, and
// pop-up dialogs for everything else. The page draws once its inputs are in
// (or after 3 s with what it has), so the grade never flickers while loading.
//
// Badges are unchanged from v1 on purpose: achievements replace them.
// =============================================================================

import { getState, subscribe, getReturnSummary, getRealPricePaise, getReservedCashPaise, setSetting } from "../state.js";
import { getInstrument, ensureUniverseLoaded } from "../data/universe.js";
import { getQuoteBatch } from "../data/marketData.js";
import { computeTradeStats } from "../data/tradeStats.js";
import { aiLang } from "../features/aiLang.js";
import { scoreReportCard, benchmarkPl, GRADES, WEIGHTS, gradeFor } from "../coach/reportCardCore.js";
import { isOwner } from "../features/preview.js";
import { tradesWithFlags } from "../coach/biasLedger.js";
import { factText, unlockText, pillarName, pillarCopy, gradeTitle, overallSummary, promptLines } from "../coach/reportCardCopy.js";
import { niftyCloses, cachedNiftyCloses } from "../data/indexCloses.js";
import { loadActivity, cachedActivity } from "../features/learning.js";
import { onBackdropClick } from "../components/backdrop.js";
import { smoothedPl } from "../coach/reportCardWeek.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hinglish = () => { try { return !!getState()?.settings?.hinglish; } catch { return false; } };
const T = (en, hi) => (hinglish() ? hi : en);

let aiCard = null;           // { narrative, strengths, watchouts } | null
let aiCardLoading = false;
let aiCardSignature = null;  // last basis asked for: ask again only when it changes
let aiCardUser = null;       // whose card `aiCard` is
let aiInflight = null;       // the request in flight, shared by repeat callers

// The AI card is saved in the browser (31 Oct): it is reused until the user
// trades, their grade or a pillar moves a band, or their return moves 2 points.
const AI_CARD_KEY = "ss.reportCardAi.v2";
const AI_CARD_MOVE_PTS = 2;
const AI_CARD_MAX_AGE_MS = 7 * 24 * 3_600_000;
const band = (p) => (p?.state === "scored" ? Math.round(p.score / 10) : p?.state?.[0] || "-");
function aiCardBasis(state, rc) {
  return {
    userId: state.user?.id || "anon",
    lang: aiLang(),
    tx: (state.transactions || []).length,
    holds: Object.keys(state.holdings || {}).sort().join(","),
    retPct: getReturnSummary(state).pct * 100,
    rc: `${rc.overall.grade || "-"}|${Object.values(rc.pillars).map(band).join("")}`,
  };
}
const basisKey = (b) => `${b.userId}|${b.lang}|${b.tx}|${b.holds}|${b.rc}`;
function savedAiCard(state, rc) {
  try {
    const o = JSON.parse(localStorage.getItem(AI_CARD_KEY) || "null");
    if (!o?.data?.narrative || !o.basis) return null;
    const b = aiCardBasis(state, rc);
    if (basisKey(o.basis) !== basisKey(b)) return null;
    if (!Number.isFinite(o.basis.retPct) || Math.abs(o.basis.retPct - b.retPct) >= AI_CARD_MOVE_PTS) return null;
    if (!(Date.now() - (o.at || 0) < AI_CARD_MAX_AGE_MS)) return null;
    return o.data;
  } catch { return null; }
}
function saveAiCard(state, rc, data) {
  try { localStorage.setItem(AI_CARD_KEY, JSON.stringify({ basis: aiCardBasis(state, rc), data, at: Date.now() })); } catch {}
}

const BADGES = [
  { code: "first_trade",    title: "First Steps",    emoji: "🌱", desc: "Placed your first trade" },
  { code: "diversified",    title: "Well Diversified", emoji: "🪻", desc: "Held ≥5 positions across ≥3 sectors" },
  { code: "held_through_dip", title: "Held the Line", emoji: "🛡", desc: "Overrode a panic-sell signal" },
  { code: "time_traveler",  title: "Time Traveler",  emoji: "⏱", desc: "Completed a crash replay scenario" },
  { code: "coach_listener", title: "Coach Listener", emoji: "🎓", desc: "Received 10+ coach messages" },
  { code: "no_fomo",        title: "No FOMO",        emoji: "🧘", desc: "No pump-chase flags in last 30 days" },
  { code: "long_term",      title: "Long Termer",    emoji: "🏛", desc: "Held a position for ≥30 days" },
  { code: "curious",        title: "Curious",        emoji: "🔭", desc: "Viewed 10+ different stocks" },
];

// ---- Inputs ---------------------------------------------------------------------
function kindOf(symbol) {
  if (!symbol || String(symbol).startsWith("MF_")) return "MF";
  const k = getInstrument(symbol)?.kind;
  return k === "MF" ? "MF" : k === "ETF" ? "ETF" : "STOCK";
}

let _tradesMemo = { key: null, trades: [] };
function tradesOf(state, universeReady) {
  const tx = state.transactions || [];
  const key = `${state.user?.id}|${tx.length}|${tx[tx.length - 1]?.id}|${universeReady}`;
  if (_tradesMemo.key !== key) _tradesMemo = { key, trades: tradesWithFlags(tx, kindOf) };
  return _tradesMemo.trades;
}

function createdAtOf(state) {
  const c = state.user?.createdAt;
  const ms = typeof c === "number" ? c : Date.parse(c || "");
  if (Number.isFinite(ms)) return ms;
  const first = (state.transactions || []).reduce((m, t) => Math.min(m, t.ts), Infinity);
  return Number.isFinite(first) ? first : null;
}

function buildInput(state, extras) {
  const tx = state.transactions || [];
  const trades = tradesOf(state, extras.universeReady);
  const positions = [];
  for (const [symbol, h] of Object.entries(state.holdings || {})) {
    if (!(h?.qty > 0)) continue;
    const inst = getInstrument(symbol);
    // A real price, else what was paid. Never the chart walk.
    const px = getRealPricePaise(symbol) || Number(h.avgCostPaise) || 0;
    positions.push({ symbol, name: inst?.name || symbol, valuePaise: Math.round(h.qty * px), kind: kindOf(symbol), sector: inst?.sector || null });
  }
  const bench = extras.nifty ? benchmarkPl(trades, extras.nifty) : null;
  const plPaise = getReturnSummary(state).plPaise;
  const sig = extras.activity;      // { weeks, research, curve } from report_card_signals()
  const now = Date.now();
  const cashPaise = (state.portfolio?.cashPaise || 0) + getReservedCashPaise(state);
  const valuePaise = cashPaise + positions.reduce((s, p) => s + p.valuePaise, 0);
  return {
    now,
    accountCreatedAt: createdAtOf(state),
    trades,
    stats: computeTradeStats(tx),
    portfolio: { cashPaise, positions },
    activity: sig ? { weeks: sig.weeks } : null,
    activeNow: true,                 // the viewer is in the app this week
    research: sig?.research ?? null,
    curve: sig?.curve ?? null,
    // Only once real prices are in: a holding valued at cost would read as
    // breaking even. The score reads the middle of the last five days.
    profit: extras.pricesReady ? { plPaise, scorePlPaise: smoothedPl(plPaise, valuePaise, sig?.curve, now) } : null,
    market: bench ? { userPlPaise: plPaise, ...bench } : null,
  };
}

// ---- Page -----------------------------------------------------------------------
export function renderReportCard(main) {
  // Owner accounts get the card page (reportCardV4.js) until it is switched on
  // for everyone; ?rc_old=1 shows them this page.
  if (isOwner() && !/[?&]rc_old=1/.test(location.search)) {
    let gone = false;
    window.addEventListener("ss:navigate", () => { gone = true; }, { once: true });
    import("./reportCardV4.js").then((m) => { if (!gone) m.renderReportCardV4(main); })
      .catch((e) => { console.error("[report-card] card page failed to load", e); if (!gone) renderMarkSheet(main); });
    return;
  }
  renderMarkSheet(main);
}

function renderMarkSheet(main) {
  let alive = true;
  let ready = false;
  shapeShown = false;
  const first = getState();
  const firstTs = (first.transactions || []).reduce((m, t) => Math.min(m, t.ts), Infinity);
  const since = Number.isFinite(firstTs) ? firstTs : Date.now();
  const extras = { activity: cachedActivity(), nifty: cachedNiftyCloses(since), universeReady: false, pricesReady: false };
  let last = null;             // { input, rc } of the latest draw

  if (aiCardUser !== (first.user?.id || null)) { aiCard = null; aiCardSignature = null; aiCardUser = first.user?.id || null; }

  // Draw when every input is in, or after 3 s with what there is. Saathi's
  // card is asked for once, after the inputs (or 8 s), so its text is written
  // for the grade on screen.
  let asked = false;
  const show = () => { if (alive && !ready) { ready = true; render(); } };
  const held = Object.entries(first.holdings || {}).filter(([s, h]) => h?.qty > 0 && !s.startsWith("MF_")).map(([s]) => s);
  Promise.allSettled([
    ensureUniverseLoaded().then(() => { extras.universeReady = true; }),
    (held.length ? getQuoteBatch(held) : Promise.resolve()).then(() => { extras.pricesReady = true; }),
    loadActivity().then((a) => { if (a) extras.activity = a; }),
    Number.isFinite(firstTs) ? niftyCloses(since).then((n) => { if (n) extras.nifty = n; }) : null,
  ]).then(() => { if (!alive) return; ready = true; render(); askAi(); });
  setTimeout(show, 3000);
  setTimeout(() => { show(); askAi(); }, 8000);

  render();
  const unsub = subscribe(() => { if (alive) render(); });
  const onClick = (e) => {
    const el = e.target.closest("[data-rc]");
    if (!alive || !el || !last || !main.contains(el)) return;
    const [act, key] = el.dataset.rc.split(":");
    if (act === "pillar" && last.rc.pillars[key]) openPillar(last.rc.pillars[key], last);
    else if (act === "how") openHow(last.rc);
    else if (act === "ai") openAiMore();
  };
  main.addEventListener("click", onClick);
  window.addEventListener("ss:navigate", () => { alive = false; unsub?.(); main.removeEventListener("click", onClick); }, { once: true });

  function askAi() {
    if (!alive || asked || !last) return;
    asked = true;
    maybeFetchAiCard(getState(), last.rc, last.input).then((d) => { if (!alive) return; if (d) aiCard = d; render(); });
    if (aiCardLoading) render();
  }

  // render() runs inside the state subscriber: a throw here would also stop
  // the other subscribers (auth sync among them). Never let one bad row do that.
  function render() {
    try { draw(); } catch (e) {
      console.error("[report-card] render failed", e);
      try { main.innerHTML = head() + `<div class="card" style="padding: var(--sp-5);"><p class="muted" style="margin:0;">${T("The report card could not be drawn right now. Your trades and data are safe; please reload.", "Report card abhi nahi ban paaya. Tumhare trades aur data safe hain; page reload karo.")}</p></div>`; } catch {}
    }
  }

  function draw() {
    const state = getState();
    if (!ready) { main.innerHTML = head() + skeleton(); return; }
    const input = buildInput(state, extras);
    const rc = scoreReportCard(input);
    last = { input, rc };
    const hi = hinglish();
    const owner = isOwner();
    if (owner && !achUi && !achUiLoading) {
      achUiLoading = true;
      import("../achievements/ui.js").then((m) => { achUi = m; if (alive) render(); }).catch(() => {});
    }
    main.innerHTML = `
      ${head()}
      ${topCard(rc, state, hi)}
      ${markSheet(rc, hi)}
      ${renderAiCard()}
      ${state.transactions.length === 0 ? emptyCard() : ""}
      ${owner ? (achUi ? achUi.achievementsCardHtml() : "") : badgesCard(state)}
    `;
    if (owner && achUi) achUi.mountAchievementsCard(main);
    // The shape draws itself once per visit, not on every re-render.
    if (!shapeShown) { shapeShown = true; main.querySelector(".rc-shape")?.classList.add("is-new"); }
  }
}

// Achievements replace the old badges for owner accounts (their preview).
let achUi = null, achUiLoading = false, shapeShown = false;

function head() {
  return `
    <header class="rc-head">
      <div>
        <h1>${T("Report card", "Report card")}</h1>
        <p>${T("A grade for how you decide, not for how the market moved.", "Grade tumhare faislon ka hai, market ke chalne ka nahi.")}</p>
      </div>
      <button type="button" class="btn btn-ghost btn-sm" data-rc="how">${T("How this is scored", "Score kaise banta hai")}</button>
    </header>`;
}

function skeleton() {
  return `
    <section class="rc-hero"><div class="rc-hero-main">
      <div class="skeleton" style="height:84px;width:120px;border-radius:6px;"></div>
      <div class="skeleton" style="height:16px;width:min(320px,80%);border-radius:4px;margin-top:14px;"></div></div>
      <div class="skeleton rc-shape-skel"></div></section>
    <section class="rc-sheet">${[0, 1, 2, 3, 4, 5].map(() => `<div class="rc-row"><div class="skeleton" style="height:18px;border-radius:4px;grid-column:1/-1;"></div></div>`).join("")}</section>`;
}

// ---- The hero: grade, where it sits on the scale, and the shape ----------------
// Six parts drawn as a hexagon (the student's "shape"); a locked part is a
// dashed spoke. Order matches the mark sheet.
const SHORT = {
  discipline: ["Discipline", "Discipline"], results: ["Results", "Results"], research: ["Research", "Research"],
  diversification: ["Spread", "Spread"], learning: ["Learning", "Learning"], market: ["vs Nifty", "vs Nifty"],
};
function shapeSvg(rc, hi) {
  const ps = Object.values(rc.pillars).filter((p) => p.state !== "hidden");
  const n = ps.length;
  if (n < 3) return "";
  const R = 92, cx = 150, cy = 128;
  const at = (i, r) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  };
  const ring = (f) => ps.map((_, i) => at(i, R * f).map((v) => v.toFixed(1)).join(",")).join(" ");
  const pts = ps.map((p, i) => at(i, R * (p.state === "scored" ? Math.max(0.04, p.score / 100) : 0)));
  const labels = ps.map((p, i) => {
    const [x, y] = at(i, R + 20);
    const anchor = Math.abs(x - cx) < 4 ? "middle" : x > cx ? "start" : "end";
    const dy = y < cy - R * 0.6 ? -4 : y > cy + R * 0.6 ? 14 : 4;
    const g = p.state === "scored" ? gradeFor(p.score) : "–";
    return `<text x="${x.toFixed(1)}" y="${(y + dy).toFixed(1)}" text-anchor="${anchor}" class="rc-shape-label ${p.state === "scored" ? "" : "is-off"}"><tspan class="rc-shape-name">${esc(SHORT[p.key]?.[hi ? 1 : 0] || pillarName(p.key, hi))}</tspan><tspan class="rc-shape-grade" dx="5">${esc(g)}</tspan></text>`;
  }).join("");
  const spokes = ps.map((p, i) => {
    const [x, y] = at(i, R);
    return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="${p.state === "scored" ? "" : "is-off"}"/>`;
  }).join("");
  const dots = ps.map((p, i) => p.state === "scored" ? `<circle cx="${pts[i][0].toFixed(1)}" cy="${pts[i][1].toFixed(1)}" r="3.5" class="tone-${toneOf(p.score)}"/>` : "").join("");
  const label = ps.map((p) => `${pillarName(p.key, hi)} ${p.state === "scored" ? `${p.score} of 100` : T("not open yet", "abhi band")}`).join(", ");
  return `
    <svg class="rc-shape" viewBox="0 0 300 256" role="img" aria-label="${esc(T("Your shape: ", "Tumhara shape: ") + label)}">
      <g class="rc-shape-grid">${[1, 0.75, 0.5, 0.25].map((f) => `<polygon points="${ring(f)}"/>`).join("")}${spokes}</g>
      <g class="rc-shape-you"><polygon points="${pts.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" ")}"/>${dots}</g>
      ${labels}
    </svg>`;
}

// The grade scale with the student's marker on it (cut points from the core).
function scaleHtml(score, hi) {
  const bands = [...GRADES].reverse().map((g, i, arr) => ({ grade: g.grade, from: g.min, to: arr[i + 1]?.min ?? 100 }));
  const you = gradeFor(score);
  // Equal-width grades (the D band is 0-47, drawn to scale it would take half
  // the bar); the pin sits proportionally inside its own grade.
  const n = bands.length;
  const k = Math.max(0, bands.findIndex((b) => b.grade === you));
  const inBand = Math.max(0, Math.min(1, (score - bands[k].from) / Math.max(1, bands[k].to - bands[k].from)));
  const pinPct = ((k + inBand) / n) * 100;
  return `
    <div class="rc-band" aria-label="${esc(T(`Grade scale. You are at ${score}, grade ${you}.`, `Grade scale. Tum ${score} par ho, grade ${you}.`))}">
      <div class="rc-band-track">
        ${bands.map((b) => `<span class="${b.grade === you ? "is-you" : ""}" style="flex:1 1 0"><b>${esc(b.grade)}</b></span>`).join("")}
        <i class="rc-band-pin" style="left:${pinPct.toFixed(1)}%"></i>
      </div>
      <div class="rc-band-nums" aria-hidden="true">${bands.slice(1).map((b, i) => `<span style="left:${(((i + 1) / n) * 100).toFixed(2)}%">${b.from}</span>`).join("")}</div>
    </div>`;
}

function topCard(rc, state, hi) {
  const o = rc.overall;
  const graded = o.state === "graded";
  const u = o.unlock || { have: 0, need: 5 };
  const nPos = Object.values(state.holdings || {}).filter((h) => h?.qty > 0).length;
  const nTx = state.transactions.length;
  const counts = T(
    `${nTx} trade${nTx === 1 ? "" : "s"} and ${nPos} holding${nPos === 1 ? "" : "s"} so far`,
    `Ab tak ${nTx} trade${nTx === 1 ? "" : "s"} aur ${nPos} holding${nPos === 1 ? "" : "s"}`);
  const gradeBlock = graded
    ? `<p class="rc-grade tone-${toneOf(o.score)}"><span class="rc-letter">${esc(o.grade)}</span><span class="rc-marks"><b class="tabular">${o.score}</b>/100</span></p>
       <h2 class="rc-title">${esc(gradeTitle(o.grade, hi))}</h2>`
    : `<p class="rc-grade is-building"><span class="rc-letter tabular">${u.have}<small>/${u.need}</small></span><span class="rc-marks">${T("trades", "trades")}</span></p>
       <h2 class="rc-title">${T("Building your record", "Record ban raha hai")}</h2>`;
  return `
    <section class="rc-hero ${graded ? "" : "is-building"}">
      <div class="rc-hero-main">
        ${gradeBlock}
        <p class="rc-sum">${esc(overallSummary(o, hi))}</p>
        ${graded ? scaleHtml(o.score, hi) : `<div class="rc-slots" aria-hidden="true">${Array.from({ length: u.need }, (_, i) => `<i class="${i < u.have ? "on" : ""}"></i>`).join("")}</div>`}
        <p class="rc-counts">${esc(counts)}</p>
      </div>
      ${shapeSvg(rc, hi)}
    </section>`;
}

// Colour follows the grade, so the same letter is always the same colour.
const toneOf = (score) => { const g = gradeFor(score); return g === "A+" || g === "A" ? "good" : g === "D" ? "bad" : "warn"; };
const chevron = `<svg class="rc-row-go" aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>`;

// ---- The mark sheet: one row per part, like a school report card ---------------
function markSheet(rc, hi) {
  const rows = Object.values(rc.pillars).filter((p) => p.state !== "hidden").map((p) => markRow(p, hi)).join("");
  return `
    <section class="rc-sheet" aria-labelledby="rc-sheet-title">
      <h2 id="rc-sheet-title" class="rc-sec-title">${T("Mark sheet", "Mark sheet")}</h2>
      <div class="rc-sheet-head" aria-hidden="true">
        <span>${T("Part", "Hissa")}</span><span>${T("Marks", "Marks")}</span><span>${T("Grade", "Grade")}</span><span>${T("Remark", "Remark")}</span>
      </div>
      ${rows}
    </section>`;
}

function markRow(p, hi) {
  const name = esc(pillarName(p.key, hi));
  if (p.state === "scored") {
    const fact = p.facts.find((f) => f.tone !== "info") || p.facts[0];
    const tone = toneOf(p.score);
    return `
      <button type="button" class="rc-row tone-${tone}" data-rc="pillar:${p.key}">
        <span class="rc-row-name">${name}<small>${T(`Counts for ${p.share}%`, `${p.share}% ginta hai`)}</small></span>
        <span class="rc-row-marks"><b class="tabular">${p.score}</b><i class="rc-meter"><i style="width:${p.score}%"></i></i></span>
        <span class="rc-row-grade">${esc(gradeFor(p.score))}</span>
        <span class="rc-row-remark">${esc(factText(fact, hi))}</span>
        ${chevron}
      </button>`;
  }
  if (p.state === "pending") {
    return `
      <div class="rc-row is-locked">
        <span class="rc-row-name">${name}</span>
        <span class="rc-row-marks"><b>–</b></span><span class="rc-row-grade">–</span>
        <span class="rc-row-remark">${T("Could not load this right now. It is left out of your grade until it loads.", "Yeh abhi load nahi hua. Load hone tak grade me nahi gina jaata.")}</span>
      </div>`;
  }
  const u = p.unlock || {};
  const prog = Number.isFinite(u.have) && u.need > 0 ? Math.round((Math.min(u.have, u.need) / u.need) * 100) : 0;
  return `
    <button type="button" class="rc-row is-locked" data-rc="pillar:${p.key}">
      <span class="rc-row-name">${name}<small>${T(`Will count for ${p.weight}%`, `Khulne par ${p.weight}% ginega`)}</small></span>
      <span class="rc-row-marks"><b>–</b><i class="rc-meter"><i style="width:${prog}%"></i></i></span>
      <span class="rc-row-grade">${T("Not open", "Band")}</span>
      <span class="rc-row-remark">${esc(unlockText(p.key, u, hi))}</span>
      ${chevron}
    </button>`;
}

// ---- Dialogs --------------------------------------------------------------------
function openDialog(html, onMount) {
  const prevFocus = document.activeElement;
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay rc-overlay";
  overlay.innerHTML = html;
  document.body.appendChild(overlay);
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  function close() {
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("ss:navigate", close);
    overlay.remove();
    try { prevFocus?.focus?.(); } catch {}
  }
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("ss:navigate", close, { once: true });
  onBackdropClick(overlay, close);
  overlay.querySelectorAll("[data-act=ok]").forEach((b) => b.addEventListener("click", close));
  onMount?.(overlay, close);
  // Focus the main button without scrolling to it: on a phone the sheet is
  // taller than the screen and must open at its top, where the facts are.
  (overlay.querySelector(".btn-primary") || overlay.querySelector("button"))?.focus({ preventScroll: true });
  const sheet = overlay.querySelector(".modal");
  if (sheet) sheet.scrollTop = 0;
  return close;
}

const closeBtn = () => `<button type="button" class="rc-x" data-act="ok" aria-label="${T("Close", "Band karo")}">
  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>`;

function partsRows(p, hi) {
  const d = p.detail || {};
  const row = (label, value, score) => `<tr><td>${esc(label)}</td><td class="tabular">${esc(value)}</td><td class="tabular">${score == null ? "–" : score + "/100"}</td></tr>`;
  if (p.key === "diversification" && d.parts) {
    return `<table class="rc-parts"><tbody>
      ${d.parts.stock == null ? "" : row(T("Biggest stock", "Sabse bada stock"), d.topStockPct + "%", d.parts.stock)}
      ${d.parts.sector == null ? "" : row(T("Biggest sector", "Sabse bada sector") + (d.topSector ? ` (${d.topSector})` : ""), d.topSectorPct + "%", d.parts.sector)}
      ${row(T("Positions, by size", "Positions, size ke hisaab se"), T(`like ${d.effective} equal ones`, `${d.effective} barabar jaisi`), d.parts.positions)}
      ${row(T("Cash", "Cash"), d.cashPct + "%", d.cashJudged ? d.parts.cash : null)}
    </tbody></table>`;
  }
  if (p.key === "learning" && d.parts) {
    return `<table class="rc-parts"><tbody>
      ${row(T("Weeks you showed up", "Jitne hafte aaye"), `${d.showed} / ${d.weeks}`, d.parts.showedUp)}
      ${row(T("Weeks with some learning", "Jin hafton me kuch seekha"), `${d.learned} / ${d.weeks}`, d.parts.learnedWeeks)}
      ${row(T("How much", "Kitna"), T(`${d.replays} replays, ${d.questions} questions, ${d.reads} explainers`, `${d.replays} replay, ${d.questions} sawaal, ${d.reads} explainer`), d.parts.depth)}
      ${row(T("Kinds tried", "Kitni tarah ki cheezein"), `${Math.round((d.parts.breadth / 100) * 3)} / 3`, d.parts.breadth)}
    </tbody></table>`;
  }
  return "";
}

function openPillar(p, { input, rc }) {
  const hi = hinglish();
  const c = pillarCopy(p.key, hi);
  if (!c) return;
  const scored = p.state === "scored";
  const facts = scored
    ? p.facts.map((f) => `<li class="tone-${f.tone}">${esc(factText(f, hi))}</li>`).join("")
    : `<li class="tone-info">${esc(p.state === "locked" ? unlockText(p.key, p.unlock, hi) : T("Could not load this right now.", "Yeh abhi load nahi hua."))}</li>`;
  const st = input.stats;
  const context = p.key === "discipline" && st && st.roundTrips?.length
    ? `<p class="rc-note">${esc(T(
        `Closed positions so far: ${st.wins} won, ${st.losses} lost, ${st.evens} even. For context only: wins and losses are luck as much as skill, so they are not part of this score.`,
        `Ab tak band hui positions: ${st.wins} jeeti, ${st.losses} haari, ${st.evens} barabar. Sirf context ke liye: jeet haar me luck bhi hota hai, isliye yeh score me nahi ginti.`))}</p>`
    : "";
  const share = scored ? T(`${p.share}% of your grade today`, `Aaj tumhare grade ka ${p.share}%`) : T(`${p.weight}% of the grade once unlocked`, `Unlock hone par grade ka ${p.weight}%`);
  openDialog(`
    <div class="modal rc-dlg" role="dialog" aria-modal="true" aria-labelledby="rc-dlg-title">
      <div class="rc-dlg-top"><span class="rc-kicker">${esc(share)}</span>${closeBtn()}</div>
      <h2 id="rc-dlg-title">${esc(c.name)}${scored ? ` <span class="rc-dlg-score tabular">${p.score}<small>/100</small></span>` : ""}</h2>
      <ul class="rc-facts">${facts}</ul>
      ${scored ? partsRows(p, hi) : ""}
      ${context}
      <h3>${T("What counts", "Kya ginta hai")}</h3><p>${esc(c.what)}</p>
      <h3>${T("How it is scored", "Score kaise banta hai")}</h3><p>${esc(c.how)}</p>
      <p class="rc-try"><b>${T("Something to try", "Ek cheez try karo")}</b>${esc(c.tryThis)}</p>
      <div class="modal-foot">
        ${scored ? `<button type="button" class="btn btn-ghost" data-act="ask">${T("Ask Saathi", "Saathi se pucho")}</button>` : ""}
        <button type="button" class="btn btn-primary" data-act="ok">${T("Got it", "Samajh gaya")}</button>
      </div>
    </div>`, (overlay, close) => {
    overlay.querySelector("[data-act=ask]")?.addEventListener("click", () => {
      close();
      const lines = p.facts.map((f) => factText(f, hi)).filter(Boolean).join(" ");
      askSaathi(hi
        ? `Mere report card me ${c.name} ${p.score}/100 hai. ${lines} Isko mere saath samjhao?`
        : `My report card gives me ${p.score}/100 for ${c.name}. ${lines} Can you go through it with me?`);
    });
  });
}

function openHow(rc, { card = false } = {}) {
  const hi = hinglish();
  const rows = Object.values(rc.pillars).filter((p) => p.state !== "hidden").map((p) => `
    <tr><td>${esc(pillarName(p.key, hi))}</td>
      <td class="tabular">${p.state === "scored" ? p.share + "%" : "–"}</td>
      <td class="tabular">${p.state === "scored" ? p.score + "/100" : esc(p.state === "locked" ? T("not yet", "abhi nahi") : T("loading", "load ho raha"))}</td></tr>`).join("");
  const scale = GRADES.map((g, i) => `<span class="${rc.overall.grade === g.grade ? "is-you" : ""}"><b>${g.grade}</b> ${i === GRADES.length - 1 ? T(`under ${GRADES[i - 1].min}`, `${GRADES[i - 1].min} se kam`) : g.min + "+"}</span>`).join("");
  openDialog(`
    <div class="modal rc-dlg" role="dialog" aria-modal="true" aria-labelledby="rc-dlg-title">
      <div class="rc-dlg-top"><span class="rc-kicker">${T("Report card", "Report card")}</span>${closeBtn()}</div>
      <h2 id="rc-dlg-title">${T("How this is scored", "Score kaise banta hai")}</h2>
      <p>${T("The grade reads what you do on StockSaathi, not just how many trades you place: your habits around each trade, what your money actually made, whether you looked into a stock before buying it (its page on earlier days, its chart, your watchlist, questions to Saathi), how spread out you are, and how steadily you learn. After 4 weeks or 10 trades, your result against the Nifty 50 joins too.",
        "Grade woh padhta hai jo tum StockSaathi par karte ho, sirf trades ki ginti nahi: har trade ke aas paas tumhari aadatein, paise ne asal me kya banaya, kharidne se pehle stock ko dekha ya nahi (pehle din uska page, chart, watchlist, Saathi se sawaal), paisa kitna phaila hai, aur kitna lagataar seekhte ho. 4 hafte ya 10 trades ke baad Nifty 50 ke saamne tumhara result bhi judta hai.")}</p>
      <p>${T("Full weights: ", "Poora wazan: ")}${Object.entries(WEIGHTS).map(([k, w]) => `${esc(pillarName(k, hinglish()))} ${w}%`).join(", ")}.</p>
      <table class="rc-parts"><thead><tr><th>${T("Part", "Hissa")}</th><th>${T("Share today", "Aaj ka hissa")}</th><th>${T("Score", "Score")}</th></tr></thead><tbody>${rows}</tbody></table>
      <p>${T("A part without enough history is left out and the others share its weight, so being new never lowers a grade. The overall grade needs Discipline, which unlocks after 5 trades.",
        "Jis hisse ka data kam hai woh chhod diya jaata hai aur uska wazan baakiyon me bant jaata hai, isliye naya hone se grade kam nahi hota. Overall grade ke liye Discipline chahiye, jo 5 trades ke baad khulta hai.")}</p>
      <h3>${T("The grade scale", "Grade scale")}</h3>
      <div class="rc-scale">${scale}</div>
      <p>${T("These cut points come from how StockSaathi students really score: about half sit at B or B+, and an A+ is roughly 1 in 20.",
        "Yeh cut points StockSaathi ke students ke asli score se liye gaye hain: lagbhag aadhe B ya B+ par hain, aur A+ lagbhag 20 me se 1 ko milta hai.")}</p>
      <p>${T("Results reads the middle value of your last five days, so one sharp day in the market does not move your grade.",
        "Results pichhle paanch din ka beech ka value padhta hai, isliye market ka ek tez din tumhara grade nahi hilaata.")}${card ? " " + T("A letter is reached at its cut point and kept until you are 2 marks under it, so it does not flip back and forth.",
        "Letter apne cut point par milta hai aur tab tak rehta hai jab tak tum usse 2 marks neeche na ho, isliye woh aage peeche nahi hota.") : ""}</p>
      ${card ? `<p>${T("Each of the six parts has its own plating (bronze, silver, gold, platinum), with cut points set for that part: the parts do not spread alike, so one rule for all six would mislead.",
        "Chhe hisson me har ek ki apni plating hai (bronze, silver, gold, platinum), aur cut points us hisse ke hisaab se hain: saare hisse ek jaise nahi phailte.")}</p>` : ""}
      <p class="rc-note">${T("Only real exchange prices are used. A holding with no live price is counted at what you paid for it.",
        "Sirf asli exchange prices use hote hain. Jis holding ka live price nahi hai woh utne par gini jaati hai jitne me tumne kharidi.")}</p>
      <div class="modal-foot"><button type="button" class="btn btn-primary" data-act="ok">${T("Got it", "Samajh gaya")}</button></div>
    </div>`);
}

function openAiMore() {
  if (!aiCard) return;
  const sList = (aiCard.strengths || []).map((x) => `<li class="tone-good">${esc(x)}</li>`).join("");
  const wList = (aiCard.watchouts || []).map((x) => `<li class="tone-warn">${esc(x)}</li>`).join("");
  openDialog(`
    <div class="modal rc-dlg" role="dialog" aria-modal="true" aria-labelledby="rc-dlg-title">
      <div class="rc-dlg-top"><span class="rc-kicker">Saathi</span>${closeBtn()}</div>
      <h2 id="rc-dlg-title">${T("Saathi's read of your card", "Tumhare card par Saathi ki raay")}</h2>
      <p>${esc(aiCard.narrative || "")}</p>
      ${sList ? `<h3>${T("Strengths", "Strengths")}</h3><ul class="rc-facts">${sList}</ul>` : ""}
      ${wList ? `<h3>${T("Watch-outs", "Dhyan do")}</h3><ul class="rc-facts">${wList}</ul>` : ""}
      <div class="modal-foot"><button type="button" class="btn btn-primary" data-act="ok">${T("Got it", "Samajh gaya")}</button></div>
    </div>`);
}

// Open the coach with a question already typed, so one tap sends it.
function askSaathi(text) {
  setSetting("coachPanelOpen", true);
  let tries = 0;
  const fill = () => {
    // The pop-up is the chat view now: its box is #chat-input inside
    // #coach-embed. This still looked for the old panel's #coach-input, so
    // the question was never typed in (24 Nov 2026). The pop-up loads on
    // first use, hence the longer wait.
    const input = document.querySelector("#coach-embed #chat-input");
    if (!input || input.disabled) { if (tries++ < 80) setTimeout(fill, 50); return; }
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  };
  setTimeout(fill, 30);
}

// ---- Badges (unchanged from v1; achievements replace them) ------------------------
function badgesCard(state) {
  const earnedBadges = computeBadges(state);
  return `
    <section class="rc-badges" aria-labelledby="rc-badges-title">
      <div class="rc-sec-head"><h2 id="rc-badges-title" class="rc-sec-title">${T("Badges", "Badges")}</h2><span>${T(`${earnedBadges.size} of ${BADGES.length} earned`, `${BADGES.length} me se ${earnedBadges.size} mile`)}</span></div>
      <ul class="rc-badge-list">
        ${BADGES.map((b) => {
          const earned = earnedBadges.has(b.code);
          return `<li class="${earned ? "is-earned" : ""}"><span class="rc-badge-ico" aria-hidden="true">${b.emoji}</span><span class="rc-badge-txt"><b>${esc(b.title)}</b><small>${esc(b.desc)}</small></span><span class="rc-badge-state">${earned ? T("Earned", "Mila") : T("Not yet", "Abhi nahi")}</span></li>`;
        }).join("")}
      </ul>
    </section>`;
}

function computeBadges(state) {
  // The two counts v1's analysis fed in, read the way v1 read them.
  const interventionHolds = state.coachMessages.filter(m => m.eventType === "INTERVENTION_HOLD").length;
  const fomoCount = state.coachMessages.filter(m => m.biases?.some(b => b.bias === "fomo" || b.bias === "pump_chase")).length;
  const earned = new Set();
  if (state.transactions.length > 0) earned.add("first_trade");
  const holdings = Object.entries(state.holdings);
  if (holdings.length >= 5) {
    const sectors = new Set(holdings.map(([s]) => getInstrument(s)?.sector).filter(Boolean));
    if (sectors.size >= 3) earned.add("diversified");
  }
  if (interventionHolds > 0) earned.add("held_through_dip");
  if (state.demo.crashReplayCompleted.length > 0) earned.add("time_traveler");
  if (state.coachMessages.length >= 10) earned.add("coach_listener");
  if (fomoCount === 0 && state.transactions.length >= 3) earned.add("no_fomo");
  // Long-term held: any holding >30 days old
  const longTerm = holdings.some(([_, h]) => (Date.now() - h.firstBoughtAt) > 30 * 86400000);
  if (longTerm) earned.add("long_term");
  // We track "viewed stocks" via coachMessages with STOCK_INTRO
  const viewedStocks = new Set(state.coachMessages.filter(m => m.eventType === "STOCK_INTRO").map(m => m.triggerSymbol));
  if (viewedStocks.size >= 10) earned.add("curious");
  return earned;
}

function emptyCard() {
  return `
    <section class="rc-empty">
      <h2>${T("Your report card fills in as you go", "Report card tumhare saath bharta hai")}</h2>
      <p>${T("Place a few trades, finish a crash replay, ask Saathi a question. Each one opens a row of the mark sheet.", "Kuch trades lagao, ek crash replay poora karo, Saathi se sawaal pucho. Har cheez mark sheet ki ek row kholti hai.")}</p>
      <a href="/stocks" class="btn btn-primary">${T("Browse markets", "Markets dekho")}</a>
    </section>`;
}

// ---- Saathi's card ----------------------------------------------------------------
function renderAiCard() {
  if (!aiCard && !aiCardLoading) return "";
  if (aiCardLoading && !aiCard) {
    return `
      <section class="rc-remarks is-loading" aria-busy="true">
        <h2 class="rc-sec-title">${T("Saathi's remarks", "Saathi ki remarks")}</h2>
        <p class="muted">${T("Saathi is reading your card…", "Saathi tumhara card padh raha hai…")}</p>
      </section>`;
  }
  const more = (aiCard.strengths || []).length + (aiCard.watchouts || []).length > 0;
  return `
    <section class="rc-remarks">
      <h2 class="rc-sec-title">${T("Saathi's remarks", "Saathi ki remarks")}</h2>
      <p class="rc-ai-text">${esc(aiCard.narrative || "")}</p>
      ${more ? `<button type="button" class="rc-link" data-rc="ai">${T("Strengths and watch-outs", "Strengths aur dhyan dene wali baatein")}</button>` : ""}
    </section>
  `;
}

function maybeFetchAiCard(state, rc, input) {
  if (!(state.transactions || []).length) return Promise.resolve(null);   // nothing to write about yet
  const saved = savedAiCard(state, rc);
  const sig = basisKey(aiCardBasis(state, rc));
  if (saved) { aiCard = saved; aiCardSignature = sig; return Promise.resolve(saved); }
  if (aiCardSignature === sig) return aiInflight || Promise.resolve(aiCard);
  aiCardSignature = sig;
  aiCardLoading = true;
  aiInflight = fetchAiCard(state, rc, input).finally(() => { aiInflight = null; aiCardLoading = false; });
  return aiInflight;
}

async function fetchAiCard(state, rc, input) {
  // Win/loss per ROUND TRIP (open -> fully closed) from the shared maths in
  // js/data/tradeStats.js; the win rate leaves out trips that ended even.
  const stats = input.stats;
  const sectorCounts = {};
  for (const p of input.portfolio.positions) {
    if (p.sector) sectorCounts[p.sector] = (sectorCounts[p.sector] || 0) + 1;
  }
  const topSectors = Object.entries(sectorCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s]) => s);
  const biasFlags = (rc.pillars.discipline.detail?.groups || []).map((g) => g.key);

  try {
    const res = await fetch("/api/ai?op=report-card" + aiLang(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        totalTrades: (state.transactions || []).length,
        winRate: stats.winRate,
        wins: stats.wins, losses: stats.losses, evens: stats.evens,
        biggestWin: Math.round(stats.biggestWinPaise / 100),
        biggestLoss: Math.round(stats.biggestLossPaise / 100),
        avgHoldDays: Math.round(stats.avgHoldDays),
        biasFlags,
        portfolioReturnPct: getReturnSummary(state).pct * 100,
        topSectors,
        startedAt: Number.isFinite(input.accountCreatedAt) ? new Date(input.accountCreatedAt).toLocaleDateString("en-IN") : "",
        grade: rc.overall.grade,
        score: rc.overall.score,
        pillars: Object.fromEntries(Object.values(rc.pillars).map((p) => [p.key, p.state === "scored" ? p.score : null])),
        card: promptLines(rc),
      }),
    });
    if (!res.ok) throw new Error("http_" + res.status);
    const data = await res.json();
    if (!data?.narrative) throw new Error("no_narrative");
    saveAiCard(state, rc, data);
    return data;
  } catch (e) {
    aiCardSignature = null;        // a failed call may be tried again on the next visit
    return null;
  }
}


// What the card page (reportCardV4.js) shares with this one: the inputs, the
// dialogs and Saathi's remarks, so there is one copy of each.
export const v4Kit = {
  buildInput, openPillar, openHow, openAiMore, openDialog, closeBtn, renderAiCard, emptyCard,
  maybeFetchAiCard: (state, rc, input) => maybeFetchAiCard(state, rc, input).then((d) => { if (d) aiCard = d; return d; }),
  resetAiFor(uid) { if (aiCardUser !== (uid || null)) { aiCard = null; aiCardSignature = null; aiCardUser = uid || null; } },
};
