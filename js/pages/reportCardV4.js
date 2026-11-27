// =============================================================================
// REPORT CARD, the card page (28 Nov 2026). Owner accounts only until the
// owner switches it on for everyone; reportCard.js hands over to this file
// when isOwner() and still draws the mark-sheet page for everyone else.
//
// One object, the card (js/coach/reportCardArt.js), and around it:
//   What changed this week     parts that moved 3+ marks since the last saved card
//   Your card, week by week    the saved cards, small (table report_card_weeks)
//   Six parts                  a pin per part, plated by that part's own cut points
//   The road                   every letter, where you are, what the next one takes
// plus "Play this week's story" (five flat screens built from the card's own
// facts) and "Send my card" (a picture; no rupee amounts, no stock names).
//
// Rules of this page:
//   - A draw never rebuilds the page: morphHtml patches what changed, and all
//     taps go through ONE listener on <main> (nodes outlive a draw).
//   - A gradient only where there is metal. No boxes around sections, no blur.
//   - The numbers come from the same score as before (reportCardCore.js);
//     the week rules are in reportCardWeek.js and tested in Node.
// =============================================================================

import { getState, subscribe } from "../state.js";
import { ensureUniverseLoaded } from "../data/universe.js";
import { getQuoteBatch } from "../data/marketData.js";
import { scoreReportCard, GRADES } from "../coach/reportCardCore.js";
import { factText, unlockText, pillarName, pillarCopy, overallSummary } from "../coach/reportCardCopy.js";
import { niftyCloses, cachedNiftyCloses } from "../data/indexCloses.js";
import { loadActivity, cachedActivity } from "../features/learning.js";
import { morphHtml } from "../components/morph.js";
import { logEvent } from "../features/telemetry.js";
import { sb } from "../db/supabase.js";
import { pinSvg, pinDefs } from "../achievements/pins.js";
import * as W from "../coach/reportCardWeek.js";
import { cardSvg, miniSvg, sealSvg, starSvg, shareSvg, artDefs, PART_PIN, C } from "../coach/reportCardArt.js";
import { v4Kit as K } from "./reportCard.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hinglish = () => { try { return !!getState()?.settings?.hinglish; } catch { return false; } };
const T = (en, hi) => (hinglish() ? hi : en);
const ev = (what, props) => { try { logEvent("report_card", what, props || {}); } catch {} };

const NAME = { discipline: "Discipline", results: "Results", research: "Research", diversification: "Spread", learning: "Learning", market: "vs Nifty" };
const PLATE = { bronze: "Bronze", silver: "Silver", gold: "Gold", platinum: "Platinum" };
const CARD_WORD = {
  platinum: ["A rainbow card.", "Rainbow card."], gold: ["A gold card.", "Gold card."],
  silver: ["A silver card.", "Silver card."], bronze: ["A bronze card.", "Bronze card."], plain: ["", ""],
};
const day = (isoDay, long = false) => {
  try { return new Date(isoDay + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: long ? "long" : "short", timeZone: "UTC" }); } catch { return isoDay; }
};
const marks = (n) => T(`${n} mark${n === 1 ? "" : "s"}`, `${n} mark${n === 1 ? "" : "s"}`);

const ic = (d, w = 3) => `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
const UP = ic("M12 19V5M5 12l7-7 7 7"), DOWN = ic("M12 5v14M5 12l7 7 7-7"), SAME = ic("M5 12h14"), TICK = ic("M5 12.5l4.5 4.5L19 7.5", 3.4), CROSS = ic("M6 6l12 12M18 6L6 18", 2.6);
const mark = (d) => `<span class="rc4-mk ${d}">${d === "up" ? UP : d === "down" ? DOWN : SAME}</span>`;

// ---- Saved weeks (server) -------------------------------------------------------
const WK_KEY = "ss.rcWeeks.v1", WK_FRESH_MS = 10 * 60_000, WK_PAINT_MS = 7 * 24 * 3_600_000;
function savedWeeks(uid, maxAge) {
  try {
    const o = JSON.parse(localStorage.getItem(WK_KEY) || "null");
    if (!uid || !o || o.uid !== uid || !Array.isArray(o.weeks) || !(Date.now() - (o.at || 0) < maxAge)) return null;
    return o.weeks;
  } catch { return null; }
}
async function token() {
  try {
    const client = await sb();
    if (!client) return null;
    const res = await Promise.race([client.auth.getSession(), new Promise((r) => setTimeout(() => r(null), 3000))]);
    return res?.data?.session?.access_token || null;
  } catch { return null; }
}
/** Ask the server to score and save this week's card; returns the saved weeks, oldest first. */
async function loadWeeks(uid) {
  const fresh = savedWeeks(uid, WK_FRESH_MS);
  if (fresh) return fresh;
  try {
    const tk = await token();
    if (!tk) return savedWeeks(uid, WK_PAINT_MS);
    const res = await fetch("/api/ai?op=report-card-week", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tk}` }, body: "{}" });
    if (!res.ok) throw new Error("http_" + res.status);
    const data = await res.json();
    if (!Array.isArray(data?.weeks)) throw new Error("no_weeks");
    try { localStorage.setItem(WK_KEY, JSON.stringify({ uid, weeks: data.weeks, at: Date.now() })); } catch {}
    return data.weeks;
  } catch { return savedWeeks(uid, WK_PAINT_MS); }
}

// ---- The view model: everything the page shows, from the score and the saved weeks
function model(rc, weeks, state) {
  const o = rc.overall, graded = o.state === "graded";
  const wk = W.weekStartIso();
  const saved = weeks || [];
  const prev = W.lastWeek(saved, wk);
  const latest = saved[saved.length - 1] || null;
  const score = graded ? o.score : null;
  const grade = graded ? W.stickyGrade(score, latest?.grade) : null;
  const parts = W.partsOf(rc);
  const plat = {};
  for (const k of W.PART_KEYS) plat[k] = parts[k] == null ? null : W.partPlating(k, parts[k], rc.pillars[k].detail);
  const { best, low } = W.standouts(rc);
  // Since when the student has held this letter (saved weeks, counted back).
  let since = null;
  if (grade) for (let i = saved.length - 1; i >= 0 && saved[i].grade === grade; i--) since = saved[i].week;
  const nexts = W.PART_KEYS.map((k) => ({ key: k, n: parts[k] == null ? null : W.nextPlating(k, parts[k], rc.pillars[k].detail) }))
    .filter((x) => x.n && !x.n.needsTrades && x.key !== "market").sort((a, b) => a.n.left - b.n.left);
  return {
    graded, wk, score, grade, rawGrade: o.grade, parts, plat, prev, saved, best, low, since,
    name: state.user?.displayName || state.user?.username || "",
    plating: graded ? W.cardPlating(grade) : "plain",
    stats: W.PART_KEYS.map((k) => ({ key: k, score: parts[k], dir: W.dirOf(prev?.parts?.[k], parts[k]) })),
    changes: prev ? W.changesSince(prev.parts, parts) : null,
    row: graded ? W.weekRow(saved, { score, grade }, wk) : [],
    next: graded ? W.nextGrade(score, grade) : null,
    road: graded ? W.road(score, grade, saved) : [],
    nextPlate: nexts[0] || null,
    unlock: o.unlock || { have: 0, need: 5 },
    holding: graded && score < (GRADES.find((g) => g.grade === grade)?.min ?? 0),
  };
}
const cardOf = (vm, w) => ({
  w, score: vm.score, grade: vm.grade, building: vm.unlock, name: vm.name, plating: vm.plating, stats: vm.stats,
  art: vm.best ? { key: vm.best.key, tier: vm.plat[vm.best.key] } : null,
  label: vm.graded ? T(`Report card: ${vm.score} marks, grade ${vm.grade}`, `Report card: ${vm.score} marks, grade ${vm.grade}`) : T(`Report card: ${vm.unlock.have} of ${vm.unlock.need} trades`, `Report card: ${vm.unlock.need} me se ${vm.unlock.have} trades`),
});

// ---- Page -----------------------------------------------------------------------
export function renderReportCardV4(main) {
  ensureStyle();
  let alive = true, ready = false, asked = false, queued = false;
  const first = getState();
  const uid = first.user?.id || null;
  const firstTs = (first.transactions || []).reduce((m, t) => Math.min(m, t.ts), Infinity);
  const since = Number.isFinite(firstTs) ? firstTs : Date.now();
  const extras = { activity: cachedActivity(), nifty: cachedNiftyCloses(since), universeReady: false, pricesReady: false };
  let weeks = savedWeeks(uid, WK_PAINT_MS);
  let last = null;
  let achUi = null;
  K.resetAiFor(uid);

  const show = () => { if (alive && !ready) { ready = true; render(); } };
  const held = Object.entries(first.holdings || {}).filter(([s, h]) => h?.qty > 0 && !s.startsWith("MF_")).map(([s]) => s);
  Promise.allSettled([
    ensureUniverseLoaded().then(() => { extras.universeReady = true; }),
    (held.length ? getQuoteBatch(held) : Promise.resolve()).then(() => { extras.pricesReady = true; }),
    loadActivity().then((a) => { if (a) extras.activity = a; }),
    Number.isFinite(firstTs) ? niftyCloses(since).then((n) => { if (n) extras.nifty = n; }) : null,
    loadWeeks(uid).then((w) => { if (w) weeks = w; }),
  ]).then(() => { if (!alive) return; ready = true; render(); askAi(); });
  setTimeout(show, 3000);
  setTimeout(() => { show(); askAi(); }, 8000);
  import("../achievements/ui.js").then((m) => {
    if (!alive) return;
    achUi = m;
    m.ensureAchStyle?.();
    if (!m.achievementsData()) m.loadAchievements().then(() => { if (alive) schedule(); });
    schedule();
    if (location.hash === "#achievements") {
      history.replaceState(history.state, "", location.pathname + location.search);
      m.openAchievements();
    }
  }).catch(() => {});

  render();
  // Several state changes in one frame are one draw.
  function schedule() { if (queued || !alive) return; queued = true; requestAnimationFrame(() => { queued = false; if (alive) render(); }); }
  const unsub = subscribe(schedule);

  const onClick = (e) => {
    if (!alive) return;
    if (e.target.closest(".ach-rc-open") && achUi) { achUi.openAchievements(); return; }
    const el = e.target.closest("[data-rc]");
    if (!el || !last || !main.contains(el)) return;
    const [act, key] = el.dataset.rc.split(":");
    if (act === "pillar" && last.rc.pillars[key]) { ev("part:" + key); K.openPillar(last.rc.pillars[key], last); }
    else if (act === "how") { ev("how"); K.openHow(last.rc, { card: true }); }
    else if (act === "ai") K.openAiMore();
    else if (act === "story" && last.vm.graded) openStory(last, () => openSend(last.vm));
    else if (act === "send" && last.vm.graded) openSend(last.vm);
  };
  main.addEventListener("click", onClick);
  window.addEventListener("ss:navigate", () => { alive = false; unsub?.(); main.removeEventListener("click", onClick); }, { once: true });

  function askAi() {
    if (!alive || asked || !last) return;
    asked = true;
    K.maybeFetchAiCard(getState(), last.rc, last.input).then(() => { if (alive) schedule(); });
    schedule();
  }

  // Runs inside the state subscriber: a throw here would stop the other
  // subscribers too (auth sync among them).
  function render() {
    try { draw(); } catch (e) {
      console.error("[report-card] render failed", e);
      try { morphHtml(main, top(null) + `<p class="muted">${T("The report card could not be drawn right now. Your trades and data are safe; please reload.", "Report card abhi nahi ban paaya. Tumhare trades aur data safe hain; page reload karo.")}</p>`); } catch {}
    }
  }

  function draw() {
    const state = getState();
    if (!ready) { morphHtml(main, top(null) + skeleton()); return; }
    const input = K.buildInput(state, extras);
    const rc = scoreReportCard(input);
    const vm = model(rc, weeks, state);
    if (vm.graded) rc.overall.grade = vm.grade;        // dialogs and Saathi's remarks use the letter on screen
    last = { input, rc, vm };
    const hi = hinglish();
    morphHtml(main, `
      ${top(vm)}
      <div class="rc4-cols">
        <div>${hero(vm, rc, hi)}${vm.graded ? changed(vm, hi) + weeksRow(vm, hi) : ""}</div>
        <div>${six(vm, rc, hi)}${vm.graded ? roadHtml(vm, hi) : ""}</div>
      </div>
      ${K.renderAiCard()}
      ${(state.transactions || []).length === 0 ? `<section class="rc4-sec rc4-start"><p class="rc4-quiet">${T("Place a few trades, finish a crash replay, ask Saathi a question. Each one opens a part of your card.", "Kuch trades lagao, ek crash replay poora karo, Saathi se sawaal pucho. Har cheez card ka ek hissa kholti hai.")}</p><a href="/stocks" class="btn btn-primary">${T("Browse markets", "Markets dekho")}</a></section>` : ""}
      ${achUi ? achUi.achievementsCardHtml() : ""}`);
  }
}

function top(vm) {
  const sub = !vm ? "" : vm.graded ? T(`Week of ${day(vm.wk, true)}`, `${day(vm.wk, true)} ka hafta`) : T("A grade for how you decide, not for how the market moved.", "Grade tumhare faislon ka hai, market ke chalne ka nahi.");
  return `
    <header class="rc4-top">
      <div><h1>${T("Report card", "Report card")}</h1><p>${esc(sub)}&nbsp;</p></div>
      <button type="button" class="btn btn-ghost btn-sm" data-rc="how">${T("How it's scored", "Score kaise banta hai")}</button>
    </header>`;
}

function skeleton() {
  return `<div class="rc4-cols"><div><section class="rc4-hero"><div class="skeleton rc4-skel"></div></section></div><div></div></div>`;
}

function hero(vm, rc, hi) {
  const card = cardSvg(cardOf(vm, 236));
  if (!vm.graded) {
    return `<section class="rc4-hero"><div class="rc4-obj">${card}</div><p class="rc4-build">${esc(overallSummary(rc.overall, hi))}</p></section>`;
  }
  return `
    <section class="rc4-hero">
      <button type="button" class="rc4-obj" data-rc="story" aria-label="${esc(T(`Your card: ${vm.score} marks, grade ${vm.grade}. Play this week's story.`, `Tumhara card: ${vm.score} marks, grade ${vm.grade}. Is hafte ki story chalao.`))}">${card}</button>
      <div class="rc4-acts">
        <button type="button" class="btn btn-primary" data-rc="story">${T("Play this week's story", "Is hafte ki story")}</button>
        <button type="button" class="btn btn-ghost" data-rc="send">${T("Send my card", "Card bhejo")}</button>
      </div>
    </section>`;
}

function changed(vm, hi) {
  let body;
  if (!vm.prev) body = `<p class="rc4-quiet">${T("This is your first saved card. From next week this shows which parts moved.", "Yeh tumhara pehla saved card hai. Agle hafte se yahan dikhega kaunsa hissa hila.")}</p>`;
  else if (!vm.changes.length) body = `<p class="rc4-quiet">${T(`All parts are within 2 marks of your card of ${day(vm.prev.week)}.`, `Saare hisse ${day(vm.prev.week)} ke card se 2 marks ke andar hain.`)}</p>`;
  else body = `<ul class="rc4-chg">${vm.changes.slice(0, 4).map((c) => `<li>${mark(c.by > 0 ? "up" : "down")}<b>${esc(NAME[c.key])}</b><span>${T(`${c.was} to ${c.now}`, `${c.was} se ${c.now}`)}</span></li>`).join("")}</ul>`;
  return `<section class="rc4-sec"><h2>${T("What changed this week", "Is hafte kya badla")}</h2>${body}</section>`;
}

function weeksRow(vm, hi) {
  const items = vm.row.map((w) => `<li class="${w.now ? "now" : ""}">${miniSvg({ score: w.score, grade: w.grade, plating: w.plating, label: `${w.now ? T("This week", "Yeh hafta") : day(w.week)}: ${w.score}, ${w.grade}` })}<span>${w.now ? T("This week", "Yeh hafta") : esc(day(w.week))}</span></li>`).join("");
  const nx = vm.next ? `<li class="nx">${miniSvg({ score: vm.next.at, grade: vm.next.grade, next: true })}<span>${esc(T(`${PLATE[vm.next.plating] || vm.next.grade} at ${vm.next.at}`, `${vm.next.at} par ${PLATE[vm.next.plating] || vm.next.grade}`))}</span></li>` : "";
  return `<section class="rc4-sec"><h2>${T("Your card, week by week", "Tumhara card, hafte dar hafte")}</h2><ol class="rc4-wk">${items}${nx}</ol></section>`;
}

function six(vm, rc, hi) {
  const items = W.PART_KEYS.map((k) => {
    const p = rc.pillars[k];
    if (!p || p.state === "hidden") return "";
    const name = `<b>${esc(NAME[k])}</b>`;
    if (p.state === "scored") {
      const t = vm.plat[k];
      return `<li><button type="button" data-rc="pillar:${k}" aria-label="${esc(`${pillarName(k, hi)}: ${p.score} ${T("of 100", "/100")}, ${PLATE[t]}`)}">${pinSvg(PART_PIN[k], t, { size: 64 })}${name}<span class="pl rc4-t-${t}">${PLATE[t]}</span><i>${p.score} ${mark(vm.stats.find((s) => s.key === k).dir)}</i></button></li>`;
    }
    const faint = `<span class="rc4-faint">${pinSvg(PART_PIN[k], "bronze", { size: 64 })}</span>`;
    if (p.state === "pending") return `<li><div class="rc4-off">${faint}${name}<span class="pl">${T("Loading", "Load ho raha")}</span><i>–</i></div></li>`;
    return `<li><button type="button" data-rc="pillar:${k}" aria-label="${esc(`${pillarName(k, hi)}: ${unlockText(k, p.unlock, hi)}`)}">${faint}${name}<span class="pl">${T("Not open yet", "Abhi band")}</span><i>–</i></button></li>`;
  }).join("");
  let nextp = "";
  if (vm.nextPlate) {
    const { key, n } = vm.nextPlate;
    const tip = pillarCopy(key, hi)?.tryThis || "";
    nextp = `<p class="rc4-nextp"><span class="rc4-faint">${pinSvg(PART_PIN[key], n.plating, { size: 40 })}</span><span><b>${esc(T(`Next plating: ${NAME[key]} to ${n.plating}.`, `Agli plating: ${NAME[key]} ${n.plating} par.`))}</b> ${esc(T(`${marks(n.left)} to go.`, `${marks(n.left)} aur.`))} ${esc(tip)}</span></p>`;
  }
  return `<section class="rc4-sec"><h2>${T("Six parts", "Chhe hisse")}</h2><ul class="rc4-six">${items}</ul>${nextp}</section>`;
}

function roadHtml(vm, hi) {
  const rows = vm.road.map((r) => {
    const word = CARD_WORD[r.plating]?.[hi ? 1 : 0] || "";
    let t, sub;
    if (r.state === "here") {
      t = T("You are here", "Tum yahan ho");
      sub = vm.holding
        ? T(`${r.grade} is holding at ${vm.score} marks. Under ${r.at - W.HOLD_MARKS} it changes.`, `${r.grade} ${vm.score} marks par tika hai. ${r.at - W.HOLD_MARKS} se neeche badlega.`)
        : vm.since && vm.since < vm.wk ? T(`${r.grade} since ${day(vm.since, true)}, ${vm.score} marks.`, `${day(vm.since, true)} se ${r.grade}, ${vm.score} marks.`)
        : T(`${r.grade}, ${vm.score} marks.`, `${r.grade}, ${vm.score} marks.`);
    } else if (r.state === "next") {
      t = T(`Next: ${r.grade} at ${r.at}`, `Agla: ${r.at} par ${r.grade}`);
      sub = `${T(`${marks(r.left)} to go.`, `${marks(r.left)} aur.`)} ${word}`;
    } else if (r.state === "far") {
      t = T(`${r.grade} at ${r.at}`, `${r.at} par ${r.grade}`); sub = word;
    } else {
      t = T(`${r.grade} at ${r.at}`, `${r.at} par ${r.grade}`);
      sub = r.since ? T(`Reached ${day(r.since, true)}.`, `${day(r.since, true)} ko pahunche.`) : "";
    }
    const dim = r.state === "far" || r.state === "next";
    return `<li class="${r.state}"><span class="rc4-node">${r.state === "done" ? TICK : ""}</span><span class="rc4-rs ${dim ? "rc4-faint" : ""}">${sealSvg(r.grade, r.state === "here" ? 58 : 44, r.plating)}</span><span class="rc4-rt"><b>${esc(t)}</b><small>${esc(sub)}</small></span></li>`;
  }).join("");
  return `<section class="rc4-sec"><h2>${T("The road", "Raasta")}</h2><ol class="rc4-road">${rows}</ol></section>`;
}

// ---- This week's story: five flat screens from the card's own facts -------------
function mainFact(p, hi) {
  if (!p?.facts?.length) return "";
  return factText(p.facts.find((f) => f.tone !== "info") || p.facts[0], hi);
}
function storyScreens({ vm, rc, input }, hi) {
  const nTrades = (input.trades || []).length;
  const lw = rc.pillars.learning?.detail;
  const art = (bg, inner) => `<div class="rc4-art">${starSvg(bg)}<span>${inner}</span></div>`;
  const s = [];
  s.push({ bg: C.indigo, html: `${art("#4355E0", miniSvg({ w: 128, score: "?", grade: "", plating: vm.plating }))}
    <p class="rc4-big">${T("Your card for the week is in.", "Is hafte ka card aa gaya.")}</p>
    <p class="rc4-small">${esc(T(`${nTrades} trade${nTrades === 1 ? "" : "s"}${lw?.weeks ? ` and ${lw.showed} of your last ${lw.weeks} weeks` : ""} went into it. Here is what counted most.`, `${nTrades} trade${nTrades === 1 ? "" : "s"}${lw?.weeks ? ` aur pichhle ${lw.weeks} me se ${lw.showed} hafte` : ""} isme gine gaye. Sabse zyada kya gina, dekho.`))}</p>` });
  if (vm.best) {
    const b = vm.best, was = vm.prev?.parts?.[b.key];
    const moved = Number.isFinite(was) && Math.abs(b.score - was) >= W.MOVE_MARKS;
    s.push({ bg: C.deep, html: `${art("#0B4A39", pinSvg(PART_PIN[b.key], vm.plat[b.key], { size: 136 }))}
      <p class="rc4-big">${esc(T(`${NAME[b.key]} is your strongest part.`, `${NAME[b.key]} tumhara sabse mazboot hissa hai.`))}</p>
      <p class="rc4-small">${esc(mainFact(b, hi))}</p>
      <p class="rc4-tag">${esc(moved ? T(`${NAME[b.key]} ${was} to ${b.score}`, `${NAME[b.key]} ${was} se ${b.score}`) : T(`${NAME[b.key]}: ${b.score} of 100, ${PLATE[vm.plat[b.key]]}`, `${NAME[b.key]}: ${b.score}/100, ${PLATE[vm.plat[b.key]]}`))}</p>` });
  }
  if (vm.low) {
    const l = vm.low, n = W.nextPlating(l.key, l.score, l.detail);
    s.push({ bg: C.plum, html: `${art("#3D2165", pinSvg(PART_PIN[l.key], vm.plat[l.key], { size: 136 }))}
      <p class="rc4-big">${esc(T(`${NAME[l.key]} has the most room.`, `${NAME[l.key]} me sabse zyada gunjaish hai.`))}</p>
      <p class="rc4-small">${esc(mainFact(l, hi))} ${esc(pillarCopy(l.key, hi)?.tryThis || "")}</p>
      ${n && !n.needsTrades ? `<p class="rc4-tag">${esc(T(`${marks(n.left)} to ${n.plating}`, `${n.plating} tak ${marks(n.left)}`))}</p>` : ""}` });
  }
  if (vm.changes?.length) {
    const up = vm.changes.filter((c) => c.by > 0).length, dn = vm.changes.length - up;
    const say = (n, en, hiW) => (n ? T(`${n === 1 ? "One part" : n === 2 ? "Two parts" : n + " parts"} ${en}`, `${n} hisse ${hiW}`) : "");
    s.push({ bg: C.navy, html: `<ul class="rc4-lst">${vm.changes.slice(0, 6).map((c) => `<li><b class="${c.by > 0 ? "up" : "dn"}">${c.by > 0 ? "+" : "−"}${Math.abs(c.by)}</b>${esc(NAME[c.key])}</li>`).join("")}</ul>
      <p class="rc4-big">${esc([say(up, "up", "upar"), say(dn, "down", "neeche")].filter(Boolean).join(", ") + ".")}</p>
      <p class="rc4-small">${esc(T(`Against your card of ${day(vm.prev.week, true)}.`, `${day(vm.prev.week, true)} ke card ke saamne.`))}</p>` });
  } else {
    s.push({ bg: C.navy, html: `<ul class="rc4-lst">${vm.stats.filter((x) => Number.isFinite(x.score)).map((x) => `<li><b>${x.score}</b>${esc(NAME[x.key])}</li>`).join("")}</ul>
      <p class="rc4-big">${vm.prev ? T("Every part held steady.", "Har hissa tika raha.") : T("Your first saved card.", "Tumhara pehla saved card.")}</p>
      <p class="rc4-small">${vm.prev ? esc(T(`Nothing moved 3 marks since ${day(vm.prev.week, true)}.`, `${day(vm.prev.week, true)} se kuch bhi 3 marks nahi hila.`)) : T("Next week this screen shows what moved.", "Agle hafte yahan dikhega kya hila.")}</p>` });
  }
  s.push({ bg: C.navy, last: true, html: `<div class="rc4-art rc4-art-card">${cardSvg(cardOf(vm, 188))}</div>
    <p class="rc4-big rc4-mid">${esc(vm.next ? T(`${vm.grade} this week. ${marks(vm.next.left)} to ${/^A/.test(vm.next.grade) ? "an" : "a"} ${vm.next.grade}.`, `Is hafte ${vm.grade}. ${vm.next.grade} tak ${marks(vm.next.left)}.`) : T(`${vm.grade} this week. The top of the road.`, `Is hafte ${vm.grade}. Raaste ka sabse upar.`))}</p>` });
  return s;
}

function openStory(last, onSend) {
  const hi = hinglish();
  const screens = storyScreens(last, hi);
  const n = screens.length;
  const prevFocus = document.activeElement;
  const ov = document.createElement("div");
  ov.className = "rc4-story";
  ov.innerHTML = `
    <div class="rc4-st-box" tabindex="-1" role="dialog" aria-modal="true" aria-label="${esc(T("This week's story", "Is hafte ki story"))}" style="background:${screens[0].bg}">
      <div class="rc4-seg" aria-hidden="true">${screens.map((_, i) => `<i class="${i ? "" : "on"}"></i>`).join("")}</div>
      <button type="button" class="rc4-st-x" data-st="close" aria-label="${esc(T("Close", "Band karo"))}">${CROSS}</button>
      ${screens.map((s, i) => `<div class="rc4-sc ${i ? "" : "on"}" ${i ? "hidden" : ""}>${s.html}<div class="rc4-sf">${s.last
        ? `<button type="button" class="rc4-pill" data-st="send">${T("Send my card", "Card bhejo")}</button><button type="button" class="rc4-ghost" data-st="close">${T("Open the page", "Page kholo")}</button>`
        : `<span class="rc4-tap">${T("Tap to go on", "Aage ke liye tap karo")}</span>`}</div></div>`).join("")}
      <button type="button" tabindex="-1" class="rc4-zone back" data-st="back" aria-label="${esc(T("Back", "Peeche"))}"></button>
      <button type="button" tabindex="-1" class="rc4-zone next" data-st="next" aria-label="${esc(T("Next", "Aage"))}"></button>
    </div>`;
  document.body.appendChild(ov);
  const box = ov.querySelector(".rc4-st-box"), scs = [...ov.querySelectorAll(".rc4-sc")], segs = [...ov.querySelectorAll(".rc4-seg i")];
  const nextZone = ov.querySelector(".rc4-zone.next"), backZone = ov.querySelector(".rc4-zone.back");
  let at = 0;
  // A step changes classes and one colour; nothing is rebuilt.
  function go(to) {
    to = Math.max(0, Math.min(n - 1, to));
    if (to === at) return;
    scs[at].classList.remove("on"); scs[at].hidden = true;
    at = to;
    scs[at].classList.add("on"); scs[at].hidden = false;
    segs.forEach((el, i) => el.classList.toggle("on", i <= at));
    box.style.background = screens[at].bg;
    nextZone.hidden = at === n - 1;
    backZone.hidden = at === 0;
    ev("story:" + (at + 1));
    if (at === n - 1) ov.querySelector("[data-st=send]")?.focus({ preventScroll: true });
  }
  function close() {
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("ss:navigate", close);
    ov.remove();
    try { prevFocus?.focus?.({ preventScroll: true }); } catch {}
  }
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); go(at + 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); go(at - 1); }
  };
  ov.addEventListener("click", (e) => {
    const b = e.target.closest("[data-st]");
    if (!b) { if (e.target === ov) close(); return; }
    const a = b.dataset.st;
    if (a === "next") go(at + 1);
    else if (a === "back") go(at - 1);
    else if (a === "send") { close(); onSend?.(); }
    else close();
  });
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("ss:navigate", close, { once: true });
  backZone.hidden = true;
  box.focus({ preventScroll: true });      // arrow keys and Escape work from here; the tap zones stay out of the tab order
  ev("story:open");
}

// ---- Send my card: a picture ----------------------------------------------------
let _fontCss = null;
async function interCss() {
  if (_fontCss != null) return _fontCss;
  try {
    const buf = new Uint8Array(await (await fetch("/fonts/inter-latin.woff2")).arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    _fontCss = `@font-face{font-family:Inter;src:url(data:font/woff2;base64,${btoa(bin)}) format("woff2");font-weight:100 900}`;
  } catch { _fontCss = ""; }
  return _fontCss;
}
function shareNums(vm) {
  const out = [{ big: vm.grade, small: T("this week", "is hafte") }, { big: String(vm.score), small: T("marks of 100", "100 me se marks") }];
  const done = W.PART_KEYS.filter((k) => vm.plat[k] === "gold" || vm.plat[k] === "platinum").length;
  out.push({ big: T(`${done} of 6`, `6 me se ${done}`), small: T("parts at gold or above", "hisse gold ya upar") });
  if (vm.prev && Number.isFinite(vm.prev.score)) {
    const d = vm.score - vm.prev.score;
    out.push({ big: (d > 0 ? "+" : d < 0 ? "−" : "") + Math.abs(d), small: T("on my last card", "pichhle card se"), tone: d > 0 ? "up" : d < 0 ? "down" : "" });
  } else out.push({ big: T("Week 1", "Hafta 1"), small: T("my first card", "mera pehla card") });
  return out;
}
/** The card as a 1080 x 1920 PNG blob. */
async function cardPng(vm) {
  const svg = shareSvg({ card: cardOf(vm, 400), week: T(`Week of ${day(vm.wk)}`, `${day(vm.wk)} ka hafta`), nums: shareNums(vm), fontCss: await interCss() });
  const img = new Image();
  img.decoding = "sync";
  await new Promise((ok, bad) => { img.onload = ok; img.onerror = () => bad(new Error("svg_image")); img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg); });
  const cv = document.createElement("canvas");
  cv.width = 1080; cv.height = 1920;
  const cx = cv.getContext("2d");
  cx.drawImage(img, 0, 0, 1080, 1920);
  // Safari can paint an SVG image before its embedded font is ready: draw again a beat later.
  await new Promise((r) => setTimeout(r, 120));
  cx.drawImage(img, 0, 0, 1080, 1920);
  return await new Promise((ok, bad) => cv.toBlob((b) => (b ? ok(b) : bad(new Error("no_blob"))), "image/png"));
}

function openSend(vm) {
  ev("send:open");
  K.openDialog(`
    <div class="modal rc-dlg rc4-send" role="dialog" aria-modal="true" aria-labelledby="rc4-send-t">
      <div class="rc-dlg-top"><span class="rc-kicker">${T("Report card", "Report card")}</span>${K.closeBtn()}</div>
      <h2 id="rc4-send-t">${T("Send my card", "Card bhejo")}</h2>
      <div class="rc4-send-pic" aria-busy="true"><div class="skeleton"></div></div>
      <p class="rc-note">${T("The picture has your name, grade and marks. No rupee amounts and no stock names.", "Picture me tumhara naam, grade aur marks hain. Rupaye ya stock ke naam nahi.")}</p>
      <div class="modal-foot">
        <button type="button" class="btn btn-ghost" data-act="save" disabled>${T("Save picture", "Picture save karo")}</button>
        <button type="button" class="btn btn-primary" data-act="share" disabled>${T("Share", "Share karo")}</button>
      </div>
    </div>`, (overlay) => {
    const pic = overlay.querySelector(".rc4-send-pic"), save = overlay.querySelector("[data-act=save]"), share = overlay.querySelector("[data-act=share]");
    const fileName = `stocksaathi-report-card-${vm.wk}.png`;
    cardPng(vm).then((blob) => {
      if (!overlay.isConnected) return;
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.alt = T(`Your report card: ${vm.score} marks, grade ${vm.grade}`, `Tumhara report card: ${vm.score} marks, grade ${vm.grade}`);
      img.src = url;
      pic.replaceChildren(img);
      pic.removeAttribute("aria-busy");
      const file = new File([blob], fileName, { type: "image/png" });
      save.disabled = false;
      save.addEventListener("click", () => {
        const a = document.createElement("a");
        a.href = url; a.download = fileName;
        document.body.appendChild(a); a.click(); a.remove();
        ev("send:save");
      });
      let canShare = false;
      try { canShare = !!navigator.canShare?.({ files: [file] }); } catch {}
      if (!canShare) { share.hidden = true; save.classList.replace("btn-ghost", "btn-primary"); return; }
      share.disabled = false;
      share.addEventListener("click", async () => {
        try { await navigator.share({ files: [file], title: "StockSaathi", text: T(`My StockSaathi report card: ${vm.grade} this week.`, `Mera StockSaathi report card: is hafte ${vm.grade}.`) }); ev("send:share"); } catch {}
      });
    }).catch(() => {
      if (!overlay.isConnected) return;
      pic.removeAttribute("aria-busy");
      pic.innerHTML = `<p class="rc4-send-err">${T("The picture could not be made on this browser.", "Is browser par picture nahi ban paayi.")}</p>`;
    });
  });
}

// ---- Styles (this page only; owner preview, so not in the shared stylesheet yet) -
function ensureStyle() {
  if (!document.getElementById("ach-pin-defs")) document.body.insertAdjacentHTML("beforeend", pinDefs());
  if (!document.getElementById("rc-art-defs")) document.body.insertAdjacentHTML("beforeend", artDefs());
  if (document.getElementById("rc4-style")) return;
  const st = document.createElement("style");
  st.id = "rc4-style";
  st.textContent = CSS;
  document.head.appendChild(st);
}

const CSS = `
:root{--rc4-up:#0C8F63;--rc4-down:#C73B77;--rc4-mint:#19B37A}
[data-theme="dark"]{--rc4-up:#1FD1A1;--rc4-down:#FF7EB6;--rc4-mint:#1FD1A1}
.rc4-top{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:8px 12px;margin-bottom:18px}
.rc4-top h1{white-space:nowrap;font-size:var(--text-2xl);font-weight:800;letter-spacing:-.02em;margin:0;line-height:1.2}
.rc4-top p{margin:2px 0 0;color:var(--text-muted);font-size:var(--text-md)}
.rc4-top .btn{flex:none}
.rc4-cols{display:block}
.rc4-hero{display:grid;justify-items:center;gap:18px;margin-bottom:30px}
.rc4-obj{display:block;line-height:0;padding:0;border:0;background:none;border-radius:14px;font:inherit;color:inherit}
button.rc4-obj{cursor:pointer;-webkit-tap-highlight-color:transparent}
button.rc4-obj:focus-visible{outline:2px solid var(--brand);outline-offset:6px}
.rc4-obj svg{display:block;width:min(236px,70vw);height:auto}
.rc4-skel{width:min(236px,70vw);aspect-ratio:208/262;border-radius:14px}
.rc4-acts{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
.rc4-build{margin:0;max-width:34ch;text-align:center;color:var(--text-muted);font-size:var(--text-md);line-height:1.5}
.rc4-sec{margin-bottom:30px}
.rc4-sec h2{font-size:var(--text-lg);font-weight:700;letter-spacing:-.01em;margin:0 0 12px;color:var(--text-strong)}
.rc4-sec ul,.rc4-sec ol{list-style:none;margin:0;padding:0}
.rc4-start{display:grid;gap:14px;justify-items:start}
.rc4-quiet{margin:0;color:var(--text-muted);font-size:var(--text-md);line-height:1.5}
.rc4-mk{display:inline-flex;vertical-align:-2px}.rc4-mk.up{color:var(--rc4-up)}.rc4-mk.down{color:var(--rc4-down)}.rc4-mk.flat{color:var(--text-dim)}
.rc4-chg li{display:flex;gap:8px;align-items:center;padding:7px 0;font-size:var(--text-base);color:var(--text-muted);font-variant-numeric:tabular-nums}
.rc4-chg b{color:var(--text);font-weight:600;min-width:88px}
.rc4-wk{display:flex;gap:10px}
.rc4-wk li{display:grid;justify-items:center;gap:6px;line-height:0}
.rc4-wk svg{display:block;width:clamp(44px,14vw,52px);height:auto}
.rc4-wk span{font-size:11.5px;color:var(--text-dim);line-height:1.2;white-space:nowrap}
.rc4-wk li.now span{color:var(--text);font-weight:600}
.rc4-wk .is-next{color:var(--text-dim)}
.rc4-six{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px 6px}
.rc4-six button,.rc4-off{display:grid;justify-items:center;text-align:center;width:100%;line-height:1.25;padding:4px 0;border:0;background:none;border-radius:12px;font:inherit;color:inherit;box-sizing:border-box}
.rc4-six button{cursor:pointer;-webkit-tap-highlight-color:transparent}
.rc4-six button:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.rc4-six svg{display:block}
.rc4-six b{font-size:13.5px;font-weight:600;margin-top:6px;color:var(--text)}
.rc4-six .pl{font-size:12px;font-weight:700;color:var(--text-dim)}
.rc4-six i{font-style:normal;font-size:12px;color:var(--text-dim);display:flex;gap:4px;align-items:center;font-variant-numeric:tabular-nums}
.rc4-six .pl.rc4-t-bronze{color:#9A5A28}.rc4-six .pl.rc4-t-silver{color:#5E6B7A}.rc4-six .pl.rc4-t-gold{color:#94690A}.rc4-six .pl.rc4-t-platinum{color:#6B4FB3}
[data-theme="dark"] .rc4-six .pl.rc4-t-bronze{color:#D08A52}[data-theme="dark"] .rc4-six .pl.rc4-t-silver{color:#C9D2DC}[data-theme="dark"] .rc4-six .pl.rc4-t-gold{color:#E8B62E}[data-theme="dark"] .rc4-six .pl.rc4-t-platinum{color:#C9A8FF}
.rc4-faint{opacity:.4;filter:grayscale(.7);line-height:0;flex:none;display:block}
[data-theme="dark"] .rc4-faint{opacity:.45;filter:grayscale(.6)}
.rc4-nextp{display:flex;gap:12px;align-items:center;margin:20px 0 0;font-size:var(--text-md);line-height:1.5;color:var(--text-muted)}
.rc4-nextp b{color:var(--text);font-weight:600}
.rc4-road li{display:grid;grid-template-columns:22px 58px 1fr;gap:14px;align-items:center;padding:9px 0;position:relative}
.rc4-road li:not(:last-child)::after{content:"";position:absolute;left:9.5px;top:50%;height:100%;width:3px;background:var(--border)}
.rc4-road li.here:not(:last-child)::after,.rc4-road li.done:not(:last-child)::after{background:var(--rc4-mint)}
.rc4-node{width:22px;height:22px;border-radius:50%;background:var(--bg);border:3px solid var(--border-strong);display:grid;place-items:center;z-index:1;color:#06281f;box-sizing:border-box}
.rc4-node svg{width:12px;height:12px}
.rc4-road .done .rc4-node{background:var(--rc4-mint);border-color:var(--rc4-mint)}
.rc4-road .here .rc4-node{border-color:var(--rc4-mint);border-width:6px;background:#fff}
.rc4-road .next .rc4-node{border-color:#E8B62E}
.rc4-rs{line-height:0;display:grid;justify-items:center}
.rc4-rt b{display:block;font-size:15px;font-weight:600;color:var(--text)}
.rc4-rt small{font-size:13px;color:var(--text-muted)}
.rc4-road .here .rc4-rt b{font-weight:800}
.rc4-road .far .rc4-rt b,.rc4-road .far .rc4-rt small{color:var(--text-dim)}
@media (min-width:960px){
  .rc4-cols{display:grid;grid-template-columns:380px minmax(0,1fr);gap:56px;align-items:start}
  .rc4-obj svg,.rc4-skel{width:280px}
  .rc4-six{max-width:520px}
}
.rc4-story{position:fixed;inset:0;z-index:1300;background:#050609;display:grid;place-items:center;overscroll-behavior:contain;touch-action:manipulation}
.rc4-st-box{position:relative;width:min(100vw,400px);height:min(100dvh,720px);color:#FFF4DC;display:flex;flex-direction:column;padding:14px 20px 20px;box-sizing:border-box;overflow:hidden;font-family:inherit}
@media (min-width:480px) and (min-height:760px){.rc4-st-box{border-radius:22px}}
.rc4-seg{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:5px;margin-right:38px;padding-top:10px}
.rc4-seg i{height:4px;border-radius:9px;background:rgba(255,244,220,.3)}.rc4-seg i.on{background:#FFF4DC}
.rc4-st-x{position:absolute;top:6px;right:8px;width:40px;height:40px;z-index:3;border:0;background:none;color:#FFF4DC;display:grid;place-items:center;cursor:pointer;border-radius:10px}
.rc4-st-x svg{width:20px;height:20px}
.rc4-st-x:focus-visible,.rc4-pill:focus-visible,.rc4-ghost:focus-visible{outline:2px solid #FFF4DC;outline-offset:2px}
.rc4-sc{display:none;flex:1;flex-direction:column;min-height:0}.rc4-sc.on{display:flex}
.rc4-art{position:relative;display:grid;place-items:center;height:min(236px,34vh);margin:14px 0 8px;line-height:0}
.rc4-art .rc-st-star{position:absolute;width:min(230px,33vh);height:auto}
.rc4-art>span{position:relative}.rc4-art>span svg{width:auto;height:min(136px,20vh)}
.rc4-art-card{height:min(258px,38vh)}.rc4-art-card svg{height:100%;width:auto}
.rc4-big{font-size:29px;line-height:1.08;font-weight:800;letter-spacing:-.025em;margin:0;color:#FFF4DC}
.rc4-big.rc4-mid{text-align:center}
.rc4-small{font-size:14.5px;line-height:1.45;margin:12px 0 0;color:rgba(255,244,220,.85)}
.rc4-tag{align-self:flex-start;margin:16px 0 0;background:#FFF4DC;color:#1C2340;font-weight:700;font-size:13px;border-radius:8px;padding:5px 10px}
.rc4-sf{margin-top:auto;padding-top:12px;display:flex;justify-content:space-between;align-items:center;gap:10px;position:relative;z-index:2}
.rc4-tap{font-size:12.5px;color:rgba(255,244,220,.7);margin-left:auto;pointer-events:none}
.rc4-pill{background:#FFF4DC;color:#1C2340;font:inherit;font-weight:800;font-size:14px;border-radius:10px;padding:10px 16px;border:0;cursor:pointer}
.rc4-ghost{background:none;border:0;color:rgba(255,244,220,.85);font:inherit;font-size:13.5px;font-weight:600;cursor:pointer;padding:10px 4px;text-decoration:underline;text-underline-offset:3px}
.rc4-lst{list-style:none;margin:min(30px,3vh) 0 min(26px,3vh);padding:0}
.rc4-lst li{display:grid;grid-template-columns:84px 1fr;align-items:baseline;padding:min(11px,1.3vh) 0;border-top:1.5px solid rgba(255,244,220,.22);font-size:16px}
.rc4-lst li:last-child{border-bottom:1.5px solid rgba(255,244,220,.22)}
.rc4-lst b{font-size:27px;font-weight:900;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.rc4-lst .up{color:#1FD1A1}.rc4-lst .dn{color:#FF7EB6}
.rc4-zone{position:absolute;top:52px;bottom:0;border:0;background:none;padding:0;z-index:1;cursor:pointer;-webkit-tap-highlight-color:transparent}
.rc4-zone.back{left:0;width:30%}.rc4-zone.next{right:0;width:70%}
.rc4-zone,.rc4-st-box{outline:none}
.rc4-send-pic{width:min(230px,58vw);aspect-ratio:9/16;margin:4px auto 12px;border-radius:14px;overflow:hidden;background:#1C2340;display:grid;place-items:center}
.rc4-send-pic img,.rc4-send-pic .skeleton{width:100%;height:100%;display:block}
.rc4-send-err{color:#FFF4DC;font-size:13px;padding:16px;text-align:center;line-height:1.4;margin:0}
@media (prefers-reduced-motion:no-preference){.rc4-seg i{transition:background-color .15s}}
`;
