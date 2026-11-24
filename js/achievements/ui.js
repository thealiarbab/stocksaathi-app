// =============================================================================
// ACHIEVEMENTS — what the user sees: the unlock toast, the one-summary toast
// for a returning user, the full list, and the report card's achievements
// card. Owner accounts only for now (isOwner(); the database checks the same
// scope in my_achievements()).
//
// Nothing here awards anything. The database decides (migration
// 2026-11-13b): pg_cron every 10 minutes, plus ach_check() which asks the
// server to look at this user right after a trade or a replay. This file
// reads my_achievements(), shows what is new, and marks it seen.
//
// Toasts: one at a time, quiet, from the same corner as the coach's
// after-trade note. 3+ new at once (a returning user who already
// qualifies) become ONE summary that opens the list. No confetti and no
// sound, and never on top of an order: a pin that a trade earned shows on
// the next page the user opens. Reduced motion: a plain fade.
//
// The list (25 Nov 2026) is a pin board: "Next up" (what to do today, the
// closest pin, a calendar pin that is opening), "On the way" (pins that only
// need time) and one grid per group where earned pins are in colour and the
// rest are faint prints. The art lives in pins.js.
// Telemetry: web_events kind "achievement" (shown / opened / dismissed).
// =============================================================================

import { getState, subscribe } from "../state.js";
import { sb } from "../db/supabase.js";
import { logEvent } from "../features/telemetry.js";
import { isOwner } from "../features/preview.js";
import { onBackdropClick } from "../components/backdrop.js";
import { CATEGORIES, FAMILIES, TIERS, fill, progressFor, deliveryPlan } from "./core.js";
import { pinDefs, pinSvg, eventPinSvg, hasPin } from "./pins.js";

const AUTO_HIDE_MS = 9_000;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hinglish = () => { try { return !!getState()?.settings?.hinglish; } catch { return false; } };
const reduced = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
const track = (target, props) => { try { logEvent("achievement", target, props); } catch {} };

let _data = null;            // last my_achievements() answer
let _loading = null;
const _listeners = new Set();
const _shown = new Set();    // codes toasted in this tab (never twice)

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
export async function loadAchievements({ force = false } = {}) {
  if (_data && !force) return _data;
  if (_loading) return _loading;
  _loading = (async () => {
    try {
      const client = await sb();
      if (!client) return null;
      const { data, error } = await client.rpc("my_achievements");
      if (error || !data) return _data;
      _data = data.enabled ? data : null;
      for (const f of _listeners) { try { f(_data); } catch {} }
      return _data;
    } catch { return _data; } finally { _loading = null; }
  })();
  return _loading;
}
export const achievementsData = () => _data;
export function onAchievements(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }

async function markSeen(codes) {
  if (!codes?.length) return;
  if (_data) for (const e of _data.earned) if (codes.includes(e.code)) e.seen = true;
  try { const client = await sb(); await client?.rpc("ach_mark_seen", { p_codes: codes }); } catch {}
}

function view(data) {
  const defs = new Map((data?.defs || []).map((d) => [d.code, d]));
  const earned = (data?.earned || []).filter((e) => defs.has(e.code));
  return { defs, earned, earnedSet: new Set(earned.map((e) => e.code)) };
}

function copyOf(def, ev, hi) {
  return {
    name: hi ? def.name_hi : def.name_en,
    desc: hi ? def.desc_hi : def.desc_en,
    why: fill(hi ? def.why_hi : def.why_en, ev || {}),
    tier: TIERS[def.tier] ? (hi ? TIERS[def.tier].hi : TIERS[def.tier].en) : "",
  };
}

// ---------------------------------------------------------------------------
// The medal: an enamel pin, drawn in pins.js. The plating is the tier
// (bronze, silver, gold, rainbow for platinum); a tiered pin prints its
// target on a small tab (30, 5%). Not earned yet = the same pin as a faint
// grey print, the way a sticker album prints what goes in an empty slot.
// An AI-drafted seasonal achievement has no drawing of its own, so it is
// built from parts with the event's date on a ribbon (eventPinSvg).
const compact = (n) => { try { return new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 }).format(n); } catch { return String(n); } };
const PIN_PX = { sm: 30, md: 44, lg: 60, xl: 84 };
function plateOf(def) {
  const t = Number(def.threshold);
  if (!(def.tiers > 1) || def.metric === "balanced_level" || !Number.isFinite(t) || t < 2) return null;
  return compact(t) + (def.metric === "dip_pct" ? "%" : "");
}
const stampOf = (iso) => { try { return new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit", timeZone: "UTC" }); } catch { return ""; } };
function medal(def, { size = "md", locked = false } = {}) {
  const px = PIN_PX[size] || 44;
  const tierKey = TIERS[def.tier]?.key || "bronze";
  const svg = def.source === "ai" && !hasPin(def.family)
    ? eventPinSvg({ kind: def.event_kind, need: def.need, stamp: def.event_on ? stampOf(def.event_on) : "" }, tierKey, { size: px })
    : pinSvg(def.family, def.tiers > 1 || def.tier > 1 ? tierKey : "gold", { size: px, plate: plateOf(def), category: def.category });
  return `<span class="ach-pin ach-${size}${locked ? " is-locked" : ""}" aria-hidden="true">${svg}</span>`;
}
const dayText = (iso) => { try { return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }); } catch { return ""; } };

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
const _queue = [];
let _card = null, _timer = null;

function enqueue(item) { _queue.push(item); if (!_card) next(); }
function next() {
  const item = _queue.shift();
  if (!item) return;
  if (item.kind === "summary") showSummary(item); else showOne(item);
}

function place(card) {
  const fab = document.querySelector(".coach-fab");
  const r = fab && fab.offsetParent ? fab.getBoundingClientRect() : null;
  if (!r || window.innerWidth < 560) return;
  card.style.right = `${Math.max(12, window.innerWidth - r.right)}px`;
  card.style.bottom = `${Math.max(12, window.innerHeight - r.top + 12)}px`;
}

function mountToast(card, codes, target) {
  ensureStyle();
  place(card);
  document.body.appendChild(card);
  _card = card;
  requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add("is-in")));
  const arm = () => { clearTimeout(_timer); _timer = setTimeout(() => close("timeout"), AUTO_HIDE_MS); };
  card.addEventListener("pointerenter", () => clearTimeout(_timer));
  card.addEventListener("pointerleave", arm);
  card.addEventListener("focusin", () => clearTimeout(_timer));
  arm();
  markSeen(codes);
  function close(why) {
    clearTimeout(_timer);
    if (_card !== card) return;
    _card = null;
    if (why === "dismissed") track(target, { action: "dismissed" });
    card.classList.remove("is-in");
    setTimeout(() => { card.remove(); next(); }, reduced() ? 0 : 240);
  }
  card.querySelector(".ach-x")?.addEventListener("click", () => close("dismissed"));
  card.querySelector("[data-open]")?.addEventListener("click", () => {
    track(target, { action: "opened" });
    close("opened");
    openAchievements({ focus: card.querySelector("[data-open]").dataset.open || null });
  });
  return close;
}

function showOne({ def, ev, seeded }) {
  const hi = hinglish();
  const c = copyOf(def, ev, hi);
  const card = document.createElement("aside");
  card.className = `ach-toast ach-tt-${TIERS[def.tier]?.key || "bronze"}`;
  card.setAttribute("role", "status");
  card.setAttribute("aria-live", "polite");
  card.innerHTML = `
    <div class="ach-toast-medal">${medal(def, { size: "lg" })}</div>
    <div class="ach-toast-body">
      <p class="ach-toast-kicker">${hi ? "Naya pin" : "New pin"}${def.tiers > 1 ? `<span class="ach-tier-word">${esc(c.tier)}</span>` : ""}</p>
      <h3 class="ach-toast-name">${esc(c.name)}</h3>
      <p class="ach-toast-why">${esc(c.why)}${seeded ? ` <span class="ach-sample">${hi ? "Preview sample" : "Preview sample"}</span>` : ""}</p>
      <button type="button" class="ach-link" data-open="${esc(def.code)}">${hi ? "Saare achievements dekho" : "See all achievements"}</button>
    </div>
    <button type="button" class="ach-x" aria-label="${hi ? "Band karo" : "Dismiss"}">
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>`;
  mountToast(card, [def.code], def.code);
  track(def.code, { action: "shown", tier: def.tier });
}

function showSummary({ items }) {
  const hi = hinglish();
  const n = items.length;
  const top = [...items].sort((a, b) => b.def.tier - a.def.tier || a.def.sort - b.def.sort);
  const fams = [];
  for (const it of top) if (!fams.some((x) => x.def.family === it.def.family)) fams.push(it);
  const card = document.createElement("aside");
  card.className = "ach-toast ach-toast-summary";
  card.setAttribute("role", "status");
  card.setAttribute("aria-live", "polite");
  card.innerHTML = `
    <div class="ach-stack" aria-hidden="true">${fams.slice(0, 3).map((it) => medal(it.def, { size: "md" })).join("")}</div>
    <div class="ach-toast-body">
      <h3 class="ach-toast-name">${hi ? `Tumne ${n} achievements kamaye` : `You've earned ${n} achievements`}</h3>
      <p class="ach-toast-why">${esc((hi ? "Jaise " : "Including ") + fams.slice(0, 3).map((it) => copyOf(it.def, it.ev, hi).name).join(", "))}.</p>
      <button type="button" class="ach-link" data-open="">${hi ? `Saare ${n} dekho` : `See all ${n}`}</button>
    </div>
    <button type="button" class="ach-x" aria-label="${hi ? "Band karo" : "Dismiss"}">
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>`;
  mountToast(card, items.map((it) => it.def.code), "summary");
  track("summary", { action: "shown", count: n });
}

/** Show whatever the server awarded that this user has not seen yet. */
export async function showNew() {
  if (!isOwner()) return;
  // ach_unseen() reads only the rows not shown yet. my_achievements() works
  // out every number the sheet needs, so it is kept for opening the sheet.
  let fresh = null;
  try {
    const client = await sb();
    const { data, error } = await client.rpc("ach_unseen");
    if (!error && data) {
      if (!data.enabled) return;
      fresh = (data.items || []).filter((x) => x?.def?.code && !_shown.has(x.def.code))
        .map((x) => ({ def: x.def, ev: x.evidence, seeded: x.seeded, tier: x.def.tier }));
    }
  } catch {}
  if (fresh == null) {
    const data = await loadAchievements({ force: true });
    if (!data) return;
    const { defs } = view(data);
    fresh = data.earned
      .filter((e) => !e.seen && !_shown.has(e.code) && defs.has(e.code))
      .map((e) => ({ def: defs.get(e.code), ev: e.evidence, seeded: e.seeded, tier: defs.get(e.code).tier }));
  }
  if (!fresh.length) return;
  for (const f of fresh) _shown.add(f.def.code);
  const plan = deliveryPlan(fresh);
  if (plan.kind === "summary") enqueue({ kind: "summary", items: fresh });
  else for (const it of plan.items) enqueue({ kind: "one", ...it });
}

// ---------------------------------------------------------------------------
// The list: next up, on the way, and the pin board
// ---------------------------------------------------------------------------
let _overlay = null;

const todayIst = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const daysFrom = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
const pl = (n) => (n === 1 ? "" : "s");

// What one step of each metric is, in plain words, and where to go to take it.
//   kind "do"    something the user can go and do now (a button)
//   kind "wait"  only time and coming back (no button; "On the way")
//   anything not listed is situational (a dip, a comeback): never a to-do
// buy: the step needs a purchase, so it ranks last and its button opens a
//   page to look around on, never an order screen.
// perDay: at most one step a day (or week, or month).
// session: how many steps are still a fair "finish it today".
const BROWSE = ["Browse stocks", "Stocks dekho"];
const UNITS = {
  trades: { kind: "do", buy: true, route: "/stocks", cta: BROWSE, left: () => ["Place your first trade", "Apna pehla trade karo"] },
  limit_fills: { kind: "do", buy: true, route: "/stocks", cta: BROWSE, left: (n) => [`${n} more limit order${pl(n)} to get filled at your price`, `${n} aur limit order apne daam pe fill karwao`] },
  fund_buys: { kind: "do", buy: true, route: "/stocks", cta: ["See funds and ETFs", "Funds aur ETFs dekho"], left: () => ["Buy your first fund or ETF", "Pehla fund ya ETF kharido"] },
  max_sectors: { kind: "do", buy: true, route: "/stocks", cta: ["Explore sectors", "Sectors dekho"], left: (n) => [`${n} more sector${pl(n)} to hold at the same time`, `${n} aur sector ek saath rakhne hain`] },
  fund_months: { kind: "do", buy: true, perDay: true, route: "/stocks", cta: ["See funds and ETFs", "Funds aur ETFs dekho"], left: (n) => [`Add to a fund in ${n} more month${pl(n)}`, `${n} aur mahine fund mein paisa lagao`] },
  slept_on: { kind: "do", buy: true, route: "/stocks", cta: BROWSE, left: (n) => [`${n} more stock${pl(n)} to read about a day before you buy`, `${n} aur stock ek din pehle padh kar kharido`] },
  homework: { kind: "do", buy: true, route: "/stocks", cta: BROWSE, left: () => ["Add a stock to your watchlist, then wait a week before buying", "Stock watchlist mein daalo, phir ek hafte baad kharido"] },
  replays: { kind: "do", session: 1, route: "/crash-replay", cta: ["Open crash replays", "Crash replay kholo"], left: (n) => [`${n} more crash replay${pl(n)} to finish`, `${n} aur crash replay poore karo`] },
  question_days: { kind: "do", perDay: true, route: "/chat", cta: ["Ask Saathi", "Saathi se poocho"], left: (n) => [n === 1 ? "Ask Saathi one question" : `Ask Saathi on ${n} more days`, n === 1 ? "Saathi se ek sawaal poocho" : `${n} aur din Saathi se poocho`] },
  reads: { kind: "do", session: 3, route: "/learn", cta: ["Open lessons", "Lessons kholo"], left: (n) => [`${n} more lesson${pl(n)} to read`, `${n} aur lesson padho`] },
  stocks_viewed: { kind: "do", session: 10, route: "/stocks", cta: BROWSE, left: (n) => [`${n} more stock${pl(n)} to look up`, `${n} aur stock dekhne hain`] },
  news_days: { kind: "do", perDay: true, route: "/news", cta: ["Read the news", "News padho"], left: (n) => [n === 1 ? "Read one news story today" : `Read the news on ${n} more days`, n === 1 ? "Aaj ek khabar padho" : `${n} aur din news padho`] },
  learn_streak: { kind: "do", perDay: true, route: "/learn", cta: ["Open lessons", "Lessons kholo"], left: (n) => [`${n} more learning day${pl(n)} in a row`, `${n} aur din lagataar seekho`] },
  watchlist_adds: { kind: "do", session: 5, route: "/stocks", cta: BROWSE, left: (n) => [`${n} more stock${pl(n)} to add to your watchlist`, `${n} aur stock watchlist mein daalo`] },
  chart_stocks: { kind: "do", session: 3, route: "/stocks", cta: BROWSE, left: (n) => [`Use the chart on ${n} more stock${pl(n)}`, `${n} aur stock ka chart dekho`] },
  sectors_viewed: { kind: "do", session: 5, route: "/stocks", cta: ["Explore sectors", "Sectors dekho"], left: (n) => [`Look up stocks in ${n} more sector${pl(n)}`, `${n} aur sector ke stocks dekho`] },
  weekend_learn: { kind: "do", perDay: true, route: "/learn", cta: ["Open lessons", "Lessons kholo"], left: (n) => [`Learn something on ${n} more weekend${pl(n)}`, `${n} aur weekend kuch seekho`] },
  member_days: { kind: "wait", unit: (n) => [`day${pl(n)}`, "din"] },
  visit_days: { kind: "wait", unit: (n) => [`day${pl(n)}`, "din"] },
  max_hold_days: { kind: "wait", unit: (n) => [`day${pl(n)}`, "din"], held: true },
  fund_hold_days: { kind: "wait", unit: (n) => [`day${pl(n)}`, "din"], held: true },
  week_streak: { kind: "wait", unit: (n) => [`week${pl(n)}`, "hafte"] },
};
// How a live number reads in the story ("Now: 94 days").
const NOW_UNIT = { dip_pct: ["%", "%"], max_hold_days: [" days", " din"], fund_hold_days: [" days", " din"], member_days: [" days", " din"], visit_days: [" days", " din"], calm_days: [" days", " din"], week_streak: [" weeks", " hafte"], learn_streak: [" days", " din"] };

// What a calendar pin asks for, in plain words ("Open your report card"),
// from the rule's `need`. Core families carry it in core.js; an AI-drafted
// one brings its own.
const CORE_NEED = new Map(FAMILIES.filter((f) => f.rule?.need).map((f) => [f.family, f.rule.need]));
function needWords(need, hi) {
  const n = need || {};
  const parts = [];
  if (n.held_through) parts.push(hi ? "ek stock hold karte raho" : "keep holding a stock");
  if (n.report_views || n.review_views) parts.push(hi ? "apna report card kholo" : "open your report card");
  if (n.stock_views) parts.push(hi ? `${n.stock_views} stocks dekho` : `look up ${n.stock_views} stock${pl(n.stock_views)}`);
  if (n.replays) parts.push(hi ? "ek crash replay poora karo" : "finish a crash replay");
  if (n.questions) parts.push(hi ? "Saathi se sawaal poocho" : "ask Saathi a question");
  if (n.news_reads) parts.push(hi ? "news padho" : "read the news");
  if (n.learn_actions) parts.push(hi ? "kuch seekho (lesson, replay, news ya Saathi se sawaal)" : "learn something (a lesson, a replay, the news or a question to Saathi)");
  if (n.visit_days && !parts.length) parts.push(hi ? "StockSaathi kholo" : "open StockSaathi");
  else if (n.visit_days > 1) parts.push(hi ? `${n.visit_days} din wapas aao` : `come back on ${n.visit_days} days`);
  const text = parts.join(hi ? ", " : ", ");
  return text ? text[0].toUpperCase() + text.slice(1) : "";
}

// Owner preview: the sheet as a new user (?ach_debug=new) or a typical one
// (?ach_debug=typical) sees it. Built from the owner's own answer with the
// earned list and the numbers cut down. Nothing is saved or marked seen.
function previewAs(data, mode) {
  const keep = mode === "typical" ? new Set(["first_steps", "researcher_bronze"]) : new Set();
  const small = mode === "typical"
    ? { trades: 3, stocks_viewed: 12, visit_days: 4, week_streak: 1, member_days: 12, max_hold_days: 19, max_sectors: 2, slept_on: 1, watchlist_adds: 2, chart_stocks: 1, sectors_viewed: 3, dip_pct: 2.1 }
    : { stocks_viewed: 2, visit_days: 1, week_streak: 1, member_days: 1 };
  const m = {};
  for (const k of Object.keys(data.facts?.m || {})) m[k] = small[k] ?? 0;
  return { ...data, preview: mode, earned: (data.earned || []).filter((e) => keep.has(e.code)).map((e) => ({ ...e, seeded: false, seen: true })), facts: { ...data.facts, m, ev: {}, season: {} } };
}

// One entry per family: best tier earned, the next one, progress to it, and
// for calendar pins when their next window is.
function familiesOf(data) {
  const { defs, earned, earnedSet } = view(data);
  const today = todayIst();
  const fams = new Map();
  for (const d of defs.values()) {
    if (!fams.has(d.family)) fams.set(d.family, []);
    fams.get(d.family).push(d);
  }
  const all = [];
  for (const list of fams.values()) {
    list.sort((a, b) => a.tier - b.tier);
    const got = list.filter((d) => earnedSet.has(d.code));
    const best = got[got.length - 1] || null;
    const next = list.find((d) => !earnedSet.has(d.code)) || null;
    const head = best || list[0];
    const ai = head.source === "ai";
    let cal = null;
    const w = next && (ai ? (next.win_from && next.win_to ? { from: next.win_from, to: next.win_to } : null) : data.calendar?.[next.code]);
    if (w && w.to >= today) cal = { ...w, state: w.from <= today ? "open" : "soon", days: Math.max(0, daysFrom(today, w.from)) };
    // A limited edition whose window has closed is not shown unless earned.
    if (ai && !best && !cal) continue;
    all.push({ key: head.family, list, got, best, next, head, ai, cal, cat: ai ? "limited" : head.category, pr: next ? progressFor(next, data.facts) : null });
  }
  return { all, defs, earned, earnedSet };
}

// Up to three things worth doing next: one to finish today, the closest one,
// and a calendar pin that is open or opens within a week.
function chooseNext(all) {
  const acts = [];
  for (const f of all) {
    const u = f.next && UNITS[f.next.metric];
    if (!u || u.kind !== "do" || !f.pr) continue;
    const left = Math.ceil(f.pr.target - f.pr.value - 1e-9);
    if (left <= 0) continue;
    acts.push({ f, u, left, today: u.perDay ? left <= 1 : left <= (u.session || 3) });
  }
  const buy = (a) => (a.u.buy ? 1 : 0);
  const today = acts.filter((a) => a.today).sort((a, b) => buy(a) - buy(b) || a.left - b.left || b.f.pr.pct - a.f.pr.pct);
  const closest = [...acts].sort((a, b) => b.f.pr.pct - a.f.pr.pct || buy(a) - buy(b) || a.left - b.left);
  const cals = all.filter((f) => f.next && f.cal && (f.cal.state === "open" || f.cal.days <= 7)).sort((a, b) => (a.cal.state === "open" ? 0 : 1) - (b.cal.state === "open" ? 0 : 1) || a.cal.days - b.cal.days);
  const out = [], used = new Set();
  const push = (row) => { if (row && !used.has(row.f) && out.length < 3) { used.add(row.f); out.push(row); } };
  push(today[0]);
  push(closest.find((a) => a.f.pr.pct > 0 && !used.has(a.f)));
  if (cals[0]) push({ f: cals[0], cal: true });
  for (const a of today) push(a);
  for (const a of closest) push(a);
  return out;
}
function chooseWaiting(all) {
  return all.map((f) => ({ f, u: f.next && UNITS[f.next.metric] }))
    .filter((x) => x.u?.kind === "wait" && x.f.pr && x.f.pr.value > 0 && x.f.pr.value < x.f.pr.target)
    .map((x) => ({ ...x, left: Math.ceil(x.f.pr.target - x.f.pr.value) }))
    .sort((a, b) => a.left - b.left).slice(0, 3);
}

export async function openAchievements({ focus = null } = {}) {
  if (_overlay) return;
  ensureStyle();
  const prevFocus = document.activeElement;
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay ach-overlay";
  document.body.appendChild(overlay);
  _overlay = overlay;
  let lang = hinglish();
  let cat = "all";
  let preview = null;
  try { preview = isOwner() ? new URLSearchParams(location.search).get("ach_debug") : null; } catch {}
  if (preview !== "new" && preview !== "typical") preview = null;
  track(focus || "list", { action: "opened", from: focus ? "toast" : "list" });

  let picked = null;            // the family whose story is open
  let storyOf = () => "";       // set by draw(): the story for a family key
  let pickedFromFocus = !!focus;
  const draw = (raw) => {
    const hi = lang;
    if (!raw) {
      overlay.innerHTML = `<div class="modal ach-sheet" role="dialog" aria-modal="true" aria-label="Achievements"><p class="muted" style="padding: var(--sp-6);">${hi ? "Load ho raha hai…" : "Loading…"}</p></div>`;
      return;
    }
    const data = preview ? previewAs(raw, preview) : raw;
    const { all, defs, earned } = familiesOf(data);
    const evOf = new Map(earned.map((e) => [e.code, e]));
    if (pickedFromFocus) { picked = defs.get(focus)?.family || null; pickedFromFocus = false; }
    const T = (en, h) => (hi ? h : en);
    const of = (a, b) => (hi ? `${b} me se ${a}` : `${a} of ${b}`);
    const num = (n) => Number(n).toLocaleString("en-IN");
    const tierWord = (d) => (d.tiers > 1 ? copyOf(d, null, hi).tier : "");
    const tierChip = (d) => (d.tiers > 1 ? ` <span class="ach-tierword ach-t-${TIERS[d.tier].key}">${esc(tierWord(d))}</span>` : "");
    const calText = (c) => (c.state === "open"
      ? T(`Open now, until ${dayText(c.to)}`, `Abhi khula hai, ${dayText(c.to)} tak`)
      : c.days <= 1 ? T("Opens tomorrow", "Kal khulega") : c.days <= 14 ? T(`Opens in ${c.days} days`, `${c.days} din mein khulega`) : T(`Opens ${dayText(c.from)}`, `${dayText(c.from)} ko khulega`));

    // "Open your report card between 28 Nov and 30 Nov."
    const calLine = (f) => {
      const words = needWords(f.ai ? f.next.need : CORE_NEED.get(f.key), hi);
      if (!words || !f.cal) return "";
      const when = f.cal.from === f.cal.to ? T(`on ${dayText(f.cal.from)}`, `${dayText(f.cal.from)} ko`)
        : f.cal.state === "open" ? T(`before ${dayText(f.cal.to)} ends`, `${dayText(f.cal.to)} tak`)
          : T(`between ${dayText(f.cal.from)} and ${dayText(f.cal.to)}`, `${dayText(f.cal.from)} se ${dayText(f.cal.to)} ke beech`);
      return `${words} ${when}.`;
    };

    // The track: one dot per step up to 12 steps, else a bar. The pin you get
    // sits at the end of it.
    const trackHtml = (f, { unit = "", end = true } = {}) => {
      const t = f.pr.target, v = Math.min(f.pr.value, t);
      if (!(t > 1) || f.next.metric === "balanced_level") return "";
      const body = t <= 12 && Number.isInteger(t) && Number.isInteger(v)
        ? `<span class="ach-dots">${Array.from({ length: t }, (_, i) => `<i class="${i < Math.floor(v + 1e-9) ? "on" : ""}"></i>`).join("")}</span>`
        : `<span class="ach-bar"><span style="width:${Math.round(f.pr.pct * 100)}%"></span></span>`;
      return `<span class="ach-prog" role="progressbar" aria-valuemin="0" aria-valuemax="${t}" aria-valuenow="${v}" aria-label="${esc(copyOf(f.next, null, hi).name)}">${body}${end ? medal(f.next, { size: "sm" }) : ""}<span class="ach-bar-num">${of(num(v), num(t))}${unit ? " " + esc(unit) : ""}</span></span>`;
    };
    const goBtn = (u) => (u?.route ? `<a class="ach-go" href="${u.route}" data-go>${esc(T(u.cta[0], u.cta[1]))}</a>` : "");

    const inCat = all.filter((f) => cat === "all" || f.cat === cat);
    const pins = all.length, pinsOn = all.filter((f) => f.best).length;

    // ---- next up
    const nextRows = chooseNext(inCat).map((row) => {
      const f = row.f, nc = copyOf(f.next, null, hi);
      const line = row.cal ? esc(calLine(f) || nc.desc) : esc(T(...row.u.left(row.left)));
      const chip = row.cal ? ` <span class="ach-when">${esc(calText(f.cal))}</span>` : tierChip(f.next);
      return `
        <li class="ach-next-row">
          ${medal(f.next, { size: "lg", locked: true })}
          <div class="ach-next-main">
            <p class="ach-next-name">${esc(nc.name)}${chip}</p>
            <p class="ach-next-desc">${line}</p>
            ${row.cal ? "" : trackHtml(f)}
            ${row.cal ? "" : goBtn(row.u)}
          </div>
        </li>`;
    }).join("");

    // ---- on the way (time only)
    const ev = data.facts?.ev || {};
    const waitRows = chooseWaiting(inCat).map(({ f, u, left }) => {
      const nc = copyOf(f.next, null, hi);
      const unit = T(...u.unit(left));
      const sym = u.held ? ev[f.next.metric]?.symbol : null;
      const line = sym ? T(`${sym}: ${num(left)} ${unit} to go`, `${sym}: ${num(left)} ${unit} baaki`) : T(`${num(left)} ${unit} to go`, `${num(left)} ${unit} baaki`);
      return `
        <li class="ach-next-row ach-wait-row">
          ${medal(f.next, { size: "md", locked: true })}
          <div class="ach-next-main">
            <p class="ach-next-name">${esc(nc.name)}${tierChip(f.next)}</p>
            <p class="ach-next-desc">${esc(line)}</p>
            ${trackHtml(f, { unit: T(...u.unit(f.pr.target)), end: false })}
          </div>
        </li>`;
    }).join("");

    // ---- the story under a tapped pin
    const story = (f) => {
      const d = f.best || f.next || f.head;
      const c = f.best ? copyOf(f.best, evOf.get(f.best.code)?.evidence, hi) : copyOf(d, null, hi);
      const nc = f.next ? copyOf(f.next, null, hi) : null;
      const seeded = f.best && evOf.get(f.best.code)?.seeded;
      const u = f.next && UNITS[f.next.metric];
      const live = (() => {
        const md = f.best || f.next;
        if (!md || md.metric === "season" || md.metric === "balanced_level") return "";
        const v = Number(data.facts?.m?.[md.metric] ?? 0);
        const nu = NOW_UNIT[md.metric];
        if (!nu || !(v > 0)) return "";
        if (f.best && !(v > Number(evOf.get(f.best.code)?.evidence?.value ?? f.best.threshold))) return "";
        return `<p class="ach-live">${esc(T(f.best ? "Now" : "So far"))}: ${esc(num(Math.floor(v * 10) / 10) + T(nu[0], nu[1]))}</p>`;
      })();
      const tiers = f.list.length > 1 ? `<ul class="ach-tiers" aria-label="${T("Tiers", "Tiers")}">${f.list.map((t) => {
        const on = f.got.includes(t);
        return `<li class="${on ? "is-on" : ""}">${medal(t, { size: "sm", locked: !on })}<span>${esc(copyOf(t, null, hi).tier)}</span></li>`;
      }).join("")}</ul>` : "";
      return `
        <div class="ach-detail">
          ${medal(d, { size: "xl", locked: !f.best })}
          <div class="ach-detail-main">
            <h4>${esc(c.name)}${f.best ? tierChip(f.best) : ""}</h4>
            ${f.best ? `<p>${esc(c.why)}${seeded ? ` <span class="ach-sample">Preview sample</span>` : ""}</p>` : `<p>${esc(c.desc)}</p>`}
            ${f.cal && f.next ? `<p class="ach-when">${esc(calText(f.cal))}</p>${calLine(f) ? `<p>${esc(calLine(f))}</p>` : ""}` : ""}
            ${live}
            ${f.best && nc ? `<p class="ach-next">${T("Next", "Agla")}, ${esc(nc.tier)}: ${esc(nc.desc)}</p>` : ""}
            ${f.best && !nc ? `<p class="ach-next is-done">${f.list.length > 1 ? T("Every tier earned.", "Saare tiers ho gaye.") : T("Earned.", "Kama liya.")}</p>` : ""}
            ${f.next && f.pr ? trackHtml(f) : ""}
            ${u?.kind === "do" ? goBtn(u) : ""}
            ${tiers}
          </div>
        </div>`;
    };

    storyOf = (key) => { const f = all.find((x) => x.key === key); return f ? story(f) : ""; };

    // ---- the board: one grid per group, earned in colour, the rest as prints
    const groups = [...CATEGORIES.map((c) => ({ key: c.key, name: hi ? c.hi : c.en })), { key: "limited", name: T("Limited editions", "Limited editions") }];
    const slot = (f) => {
      const d = f.best || f.next || f.head;
      const c = copyOf(d, null, hi);
      const e = f.best && evOf.get(f.best.code);
      const meta = f.best
        ? (f.list.length > 1 ? `${tierWord(f.best)}, ${of(f.got.length, f.list.length)}` : dayText(e?.earned_at))
        : f.cal && (f.cal.state === "open" || f.cal.days <= 31) ? calText(f.cal)
          : f.pr && f.pr.target > 1 && f.pr.pct > 0 && f.next.metric !== "balanced_level" ? of(num(Math.min(f.pr.value, f.pr.target)), num(f.pr.target)) : "";
      const on = picked === f.key;
      return `
        <li><button type="button" class="ach-slot ${f.best ? "is-on" : ""} ${on ? "is-picked" : ""}" data-pick="${esc(f.key)}" aria-expanded="${on}">
          ${medal(d, { size: "lg", locked: !f.best })}
          <span class="ach-slot-name">${esc(c.name)}</span>
          ${meta ? `<span class="ach-slot-meta">${esc(meta)}</span>` : ""}
        </button></li>${on ? `<li class="ach-detail-li is-open"><div class="ach-detail-clip">${story(f)}</div></li>` : ""}`;
    };
    const board = groups.map((g) => {
      const list = inCat.filter((f) => f.cat === g.key);
      if (!list.length) return "";
      const got = list.filter((f) => f.best).length;
      const done = g.key !== "limited" && list.every((f) => f.best && !f.next);
      return `
        <section class="ach-sec">
          <div class="ach-sec-head"><h3>${esc(g.name)}</h3><span>${of(got, list.length)}</span>${done ? `<span class="ach-set">${T("Set complete", "Set poora")}</span>` : ""}</div>
          <ul class="ach-board">${list.map(slot).join("")}</ul>
        </section>`;
    }).join("");

    const hasLimited = all.some((f) => f.cat === "limited");
    const section = (title, body, note = "") => body ? `<section class="ach-sec"><div class="ach-sec-head"><h3>${title}</h3></div>${note}${body}</section>` : "";
    // Only the first draw builds the sheet. Later draws swap its contents, so
    // the sheet never replays its entrance and nothing flashes.
    const old = overlay.querySelector(".ach-sheet[aria-labelledby]");
    const keepTop = old?.querySelector(".ach-body")?.scrollTop || 0;
    const html = `
      <div class="modal ach-sheet" role="dialog" aria-modal="true" aria-labelledby="ach-title" tabindex="-1">
        <header class="ach-head">
          <div class="ach-head-row">
            <h2 id="ach-title">Achievements</h2>
            <div class="ach-head-tools">
              <div class="tn-lang" role="group" aria-label="Language">
                <button type="button" data-lang="en" aria-pressed="${!hi}">English</button>
                <button type="button" data-lang="hi" aria-pressed="${hi}">Hinglish</button>
              </div>
              <button type="button" class="ach-x ach-close" aria-label="${T("Close", "Band karo")}">
                <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>
          </div>
          <p class="ach-sub"><b>${of(pinsOn, pins)}</b> ${T("pins on your board", "pins tumhare board pe")}<span class="ach-sub-2">${of(earned.length, defs.size)} ${T("achievements", "achievements")}</span>${preview ? `<span class="ach-sample">${preview === "new" ? "Preview: new user" : "Preview: typical user"}</span>` : ""}</p>
          <nav class="ach-cats" aria-label="Category">
            <button type="button" data-cat="all" aria-pressed="${cat === "all"}">${T("All", "Sab")}</button>
            ${groups.filter((g) => g.key !== "limited" || hasLimited).map((g) => `<button type="button" data-cat="${g.key}" aria-pressed="${cat === g.key}">${esc(g.name)}</button>`).join("")}
          </nav>
        </header>
        <div class="ach-body">
          ${section(T("Next up", "Agla kadam"), nextRows && `<ul class="ach-next-list">${nextRows}</ul>`)}
          ${section(T("On the way", "Raaste mein"), waitRows && `<ul class="ach-next-list">${waitRows}</ul>`, `<p class="ach-note">${T("Nothing to do here. These arrive while you hold and keep coming back.", "Yahan kuch karna nahi hai. Hold karte raho aur wapas aate raho, yeh khud aa jaayenge.")}</p>`)}
          ${board || `<p class="ach-empty">${T("Nothing in this group yet.", "Is group mein abhi kuch nahi.")}</p>`}
          <p class="ach-foot">${T("Every achievement comes from your own trades and learning. Trading more never earns one.",
            "Har achievement tumhare apne trades aur seekhne se aata hai. Zyada trade karne se koi achievement nahi milta.")}</p>
        </div>
      </div>`;
    if (old) {
      const tmp = document.createElement("div");
      tmp.innerHTML = html;
      old.replaceChildren(...tmp.firstElementChild.childNodes);
      const body = old.querySelector(".ach-body"); if (body) body.scrollTop = keepTop;
    } else overlay.innerHTML = html;
    overlay.querySelectorAll("[data-lang]").forEach((b) => b.addEventListener("click", () => {
      lang = b.dataset.lang === "hi"; draw(_data);
      overlay.querySelector(`[data-lang="${lang ? "hi" : "en"}"]`)?.focus();
    }));
    overlay.querySelectorAll("[data-cat]").forEach((b) => b.addEventListener("click", () => {
      cat = b.dataset.cat; draw(_data);
      overlay.querySelector(`[data-cat="${cat}"]`)?.focus();
    }));
    // A tap on a pin opens its story in place: nothing else is redrawn. The
    // story slides open (one grid-row transition, no layout loop) and the one
    // that was open slides shut.
    overlay.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => toggleStory(b)));
    // A button that leads somewhere closes the sheet; the router follows the link.
    overlay.querySelectorAll("[data-go]").forEach((a) => a.addEventListener("click", () => { track("next", { action: "go", to: a.getAttribute("href") }); setTimeout(close, 0); }));
    overlay.querySelector(".ach-close").addEventListener("click", close);
  };

  function wireStory(li) {
    li.querySelectorAll("[data-go]").forEach((a) => a.addEventListener("click", () => { track("next", { action: "go", to: a.getAttribute("href") }); setTimeout(close, 0); }));
  }
  function shut(li) {
    if (!li) return;
    li.previousElementSibling?.querySelector(".ach-slot")?.classList.remove("is-picked");
    li.previousElementSibling?.querySelector(".ach-slot")?.setAttribute("aria-expanded", "false");
    if (reduced()) { li.remove(); return; }
    li.classList.remove("is-open");
    li.addEventListener("transitionend", () => li.remove(), { once: true });
    setTimeout(() => li.remove(), 320);
  }
  function toggleStory(btn) {
    const key = btn.dataset.pick;
    const open = overlay.querySelector(".ach-detail-li");
    const same = picked === key;
    shut(open);
    picked = same ? null : key;
    if (same) return;
    const li = document.createElement("li");
    li.className = "ach-detail-li";
    li.innerHTML = `<div class="ach-detail-clip">${storyOf(key)}</div>`;
    btn.parentElement.after(li);
    btn.classList.add("is-picked");
    btn.setAttribute("aria-expanded", "true");
    wireStory(li);
    if (reduced()) li.classList.add("is-open");
    else requestAnimationFrame(() => requestAnimationFrame(() => li.classList.add("is-open")));
    setTimeout(() => li.scrollIntoView({ block: "nearest", behavior: reduced() ? "auto" : "smooth" }), reduced() ? 0 : 240);
  }

  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  function close() {
    if (_overlay !== overlay) return;
    document.removeEventListener("keydown", onKey, true);
    unsub();
    overlay.remove();
    _overlay = null;
    track(focus || "list", { action: "dismissed", from: "list" });
    try { prevFocus?.focus?.(); } catch {}
  }
  const unsub = onAchievements((d) => { if (_overlay === overlay) draw(d); });
  document.addEventListener("keydown", onKey, true);
  onBackdropClick(overlay, close);
  draw(_data);
  const data = await loadAchievements({ force: true });
  if (_overlay !== overlay) return;
  if (!data) { close(); return; }
  draw(data);
  overlay.querySelector(".ach-sheet")?.focus({ preventScroll: true });
  overlay.querySelector(".ach-detail-li")?.scrollIntoView({ block: "center" });
  const unseen = data.earned.filter((e) => !e.seen).map((e) => e.code);
  if (unseen.length && !preview) markSeen(unseen);
}

// ---------------------------------------------------------------------------
// The report card's achievements card (owners; replaces the 8 old badges)
// ---------------------------------------------------------------------------
export function achievementsCardHtml() {
  const hi = hinglish();
  const d = _data;
  const head = (right) => `<div class="rc-sec-head"><h2 class="rc-sec-title">Achievements</h2>${right ? `<span>${right}</span>` : ""}</div>`;
  if (!d) {
    return `<section class="ach-rc" id="achievements">${head("")}<p class="muted">${hi ? "Load ho raha hai…" : "Loading…"}</p></section>`;
  }
  const { defs, earned } = view(d);
  const recent = [...earned].sort((a, b) => (a.earned_at < b.earned_at ? 1 : -1));
  // The latest pins, one per family at its highest tier, up to six.
  const seen = new Set(); const shelf = [];
  for (const e of recent) {
    const def = defs.get(e.code);
    if (seen.has(def.family)) continue;
    const best = recent.filter((x) => defs.get(x.code).family === def.family).map((x) => defs.get(x.code)).sort((a, b) => b.tier - a.tier)[0];
    seen.add(def.family); shelf.push({ def: best, at: e.earned_at });
  }
  return `
    <section class="ach-rc" id="achievements">
      ${head(hi ? `${defs.size} me se ${earned.length} kamaye` : `${earned.length} of ${defs.size} earned`)}
      ${shelf.length ? `<ul class="ach-rc-shelf">${shelf.slice(0, 6).map(({ def, at }) => `
        <li>${medal(def, { size: "md" })}<span><b>${esc(hi ? def.name_hi : def.name_en)}</b><small>${def.tiers > 1 ? esc(hi ? TIERS[def.tier].hi : TIERS[def.tier].en) + ", " : ""}${esc(dayText(at))}</small></span></li>`).join("")}</ul>`
        : `<p class="muted">${hi ? "Pehla achievement trade, replay ya Saathi se sawaal se aata hai." : "Your first one comes from a trade, a crash replay or a question to Saathi."}</p>`}
      <button type="button" class="rc-link ach-rc-open">${hi ? "Saare achievements aur agla kadam" : "See all achievements and what's next"}</button>
    </section>`;
}

/** Wire the card after the report card renders; refreshes it in place. */
export function mountAchievementsCard(root) {
  const host = root?.querySelector?.(".ach-rc");
  if (!host) return;
  ensureStyle();
  host.querySelector(".ach-rc-open")?.addEventListener("click", () => openAchievements());
  if (!_data) loadAchievements().then((d) => {
    const h = root.querySelector(".ach-rc");
    if (d && h) { h.outerHTML = achievementsCardHtml(); mountAchievementsCard(root); }
  });
  if (location.hash === "#achievements" && !_overlay) {
    history.replaceState(history.state, "", location.pathname + location.search);
    openAchievements();
  }
}

// ---------------------------------------------------------------------------
// Boot: returning users see what they earned while away; new awards show
// as they arrive (bell Realtime row, or a check right after a trade).
// ---------------------------------------------------------------------------
let _started = false;
export function startAchievements() {
  if (_started || !isOwner()) return;
  _started = true;
  showNew();
  document.addEventListener("ss:notification", (e) => {
    if (e.detail?.category === "achievements") setTimeout(() => showNew(), 600);
  });
  // A trade never gets a pin popped on top of it (celebration right after an
  // order is the pattern that makes people trade more). The trade is only
  // remembered; the server is asked on the next page the user opens (it
  // throttles to once per 30 s), or the 10-minute sweep finds it.
  let lastTx = (getState()?.transactions || []).length;
  let traded = false;
  subscribe((s) => {
    const n = (s?.transactions || []).length;
    if (n > lastTx) traded = true;
    lastTx = n;
  });
  // A finished crash replay or a coach question lands on the server as an
  // event; check when the user leaves those pages.
  let lastPath = location.pathname;
  window.addEventListener("ss:navigate", () => {
    const was = lastPath; lastPath = location.pathname;
    if (traded || /^\/(crash-replay|chat)/.test(was)) { traded = false; setTimeout(checkNow, 1500); }
    setTimeout(openFromHash, 300);
  });
  // The bell links to /report-card#achievements: open the list here, so the
  // report card page itself needs no achievements code.
  window.addEventListener("hashchange", openFromHash);
  setTimeout(openFromHash, 300);
}
function openFromHash() {
  if (location.hash !== "#achievements" || _overlay) return;
  history.replaceState(history.state, "", location.pathname + location.search);
  openAchievements();
}
async function checkNow() {
  try {
    const client = await sb();
    const { data } = await client.rpc("ach_check");
    if (data?.awarded > 0) showNew();
  } catch {}
}

// ---------------------------------------------------------------------------
// Styles (this module only loads for owner accounts, so they ride with it)
// ---------------------------------------------------------------------------
function ensureStyle() {
  if (!document.getElementById("ach-style")) {
    const s = document.createElement("style");
    s.id = "ach-style";
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  // The plating gradients every pin refers to, once per page.
  if (!document.getElementById("ach-pin-defs")) document.body.insertAdjacentHTML("beforeend", pinDefs());
}

const CSS = `
.ach-t-bronze   { --m1: #7A4A22; --m2: #C98B52; }
.ach-t-silver   { --m1: #5E6875; --m2: #AEB8C4; }
.ach-t-gold     { --m1: #8A6410; --m2: #D9A824; }
.ach-t-platinum { --m1: #6B4FB8; --m2: #C3A1FF; }
/* The pin (pins.js draws it). Not earned yet: a faint print of the same pin. */
.ach-pin { display: inline-block; flex-shrink: 0; line-height: 0; }
.ach-pin svg { display: block; }
.ach-pin.is-locked { opacity: .5; filter: grayscale(.7); }
[data-theme="dark"] .ach-pin.is-locked { opacity: .45; filter: grayscale(.6); }

.ach-toast { position: fixed; right: 16px; bottom: 96px; z-index: 91; width: min(360px, calc(100vw - 32px));
  display: flex; gap: 14px; align-items: center; padding: 14px 12px 14px 14px;
  background: var(--surface); color: var(--text); border-radius: 12px;
  border: 1px solid var(--border-strong, var(--border));
  box-shadow: 0 18px 40px -18px rgba(15,17,24,.45);
  opacity: 0; transform: translateY(14px);
  transition: opacity 220ms var(--ease), transform 300ms cubic-bezier(.2,.9,.25,1.15); }
.ach-toast.is-in { opacity: 1; transform: none; }
.ach-sheet:focus { outline: none; }
.ach-tt-bronze { --m2: #C98B52; } .ach-tt-silver { --m2: #AEB8C4; } .ach-tt-gold { --m2: #D9A824; } .ach-tt-platinum { --m2: #C3A1FF; }
.ach-toast-summary { --m2: var(--brand); }
.ach-toast-medal { flex-shrink: 0; }
/* The pin is pressed in once and catches the light once. Nothing loops. */
.ach-toast.is-in .ach-toast-medal .ach-pin { animation: ach-press 520ms cubic-bezier(.2,.9,.25,1.2) 80ms both, ach-glint 700ms ease-out 560ms 1 both; }
@keyframes ach-press { 0% { transform: scale(.4) rotate(-22deg); opacity: 0; } 70% { transform: scale(1.08) rotate(3deg); opacity: 1; } 100% { transform: none; } }
@keyframes ach-glint { 0%, 100% { filter: none; } 40% { filter: brightness(1.35) saturate(1.1); } }
.ach-toast-body { flex: 1; min-width: 0; }
.ach-toast-kicker { margin: 0; font-size: var(--text-xs); color: var(--text-muted); font-weight: 600; display: flex; gap: 6px; align-items: center; }
.ach-tier-word { color: color-mix(in srgb, var(--m2) 70%, var(--text-strong)); font-weight: 700; }
.ach-toast-name { margin: 2px 0 4px; font-size: var(--text-lg); letter-spacing: -.01em; color: var(--text-strong); }
.ach-toast-why { margin: 0 0 8px; font-size: var(--text-sm); line-height: 1.5; color: var(--text); }
.ach-link { min-height: 36px; padding: 0; border: 0; background: none; color: var(--brand); font-weight: 700; font-size: var(--text-sm); cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
.ach-link:focus-visible, .ach-x:focus-visible, .ach-cats button:focus-visible, .ach-slot:focus-visible, .ach-go:focus-visible { outline: none; box-shadow: var(--sh-focus); }
.ach-x { width: 32px; height: 32px; flex-shrink: 0; align-self: flex-start; border: 0; border-radius: 8px; background: transparent; color: var(--text-muted); display: grid; place-items: center; cursor: pointer; }
.ach-x:hover { background: var(--bg-soft); color: var(--text-strong); }
.ach-stack { display: flex; flex-shrink: 0; }
.ach-stack .ach-pin + .ach-pin { margin-left: -18px; }
.ach-stack .ach-pin:nth-child(1) { position: relative; z-index: 3; } .ach-stack .ach-pin:nth-child(2) { position: relative; z-index: 2; }
.ach-toast-summary.is-in .ach-stack .ach-pin { animation: ach-press 520ms cubic-bezier(.2,.9,.25,1.2) both; }
.ach-toast-summary.is-in .ach-stack .ach-pin:nth-child(2) { animation-delay: 90ms; }
.ach-toast-summary.is-in .ach-stack .ach-pin:nth-child(3) { animation-delay: 180ms; }
.ach-sample { display: inline-block; padding: 1px 7px; border-radius: 4px; background: var(--bg-soft); color: var(--text-muted); font-size: 11px; font-weight: 600; vertical-align: 1px; }
@media (max-width: 559px) { .ach-toast { left: 12px; right: 12px; width: auto; bottom: calc(84px + env(safe-area-inset-bottom)); } }

/* The sheet: next up, on the way, then the board. */
.ach-sheet { width: min(760px, 100%); max-width: 760px; max-height: min(88vh, 860px); display: flex; flex-direction: column; padding: 0; overflow: hidden; }
.ach-head { flex-shrink: 0; padding: var(--sp-5) var(--sp-5) 0; border-bottom: 1px solid var(--border); }
.ach-head-row { display: flex; justify-content: space-between; gap: var(--sp-3); align-items: center; }
.ach-head h2 { margin: 0; font-size: var(--text-2xl, 24px); letter-spacing: -.02em; }
.ach-head-tools { display: flex; gap: 8px; align-items: center; }
.ach-sub { margin: 6px 0 0; color: var(--text-muted); font-size: var(--text-sm); display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; }
.ach-sub b { color: var(--text-strong); }
.ach-sub-2 { font-size: var(--text-xs); color: var(--text-dim, var(--text-muted)); }
.ach-cats { display: flex; gap: var(--sp-5); margin-top: var(--sp-4); overflow-x: auto; scrollbar-width: none; }
.ach-cats::-webkit-scrollbar { display: none; }
.ach-cats button { flex-shrink: 0; padding: 0 0 10px; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--text-muted); font: inherit; font-size: var(--text-sm); font-weight: 600; cursor: pointer; }
.ach-cats button:hover { color: var(--text-strong); }
.ach-cats button[aria-pressed="true"] { color: var(--text-strong); border-bottom-color: var(--text-strong); }
.ach-body { flex: 1; overflow-y: auto; overscroll-behavior: contain; padding: 0 var(--sp-5) var(--sp-4); }
.ach-sec { padding-top: var(--sp-5); }
.ach-sec-head { display: flex; align-items: baseline; gap: var(--sp-2); margin-bottom: var(--sp-2); }
.ach-sec-head h3 { margin: 0; font-size: var(--text-md); font-weight: 700; color: var(--text-strong); }
.ach-sec-head span { font-size: var(--text-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; }
.ach-sec-head .ach-set { padding: 1px 8px; border-radius: 999px; background: var(--brand-soft); color: var(--brand); font-weight: 700; }
.ach-note { margin: 0 0 2px; font-size: var(--text-xs); line-height: 1.5; color: var(--text-muted); }
.ach-tierword { font-size: var(--text-xs); font-weight: 700; color: color-mix(in srgb, var(--m1) 75%, var(--text-strong)); }
[data-theme="dark"] .ach-tierword { color: var(--m2); }
.ach-when { font-size: var(--text-xs); font-weight: 700; color: color-mix(in srgb, var(--warning) 70%, var(--text-strong)); }
[data-theme="dark"] .ach-when { color: #FFC93C; }

.ach-next-list, .ach-board, .ach-tiers, .ach-rc-shelf { list-style: none; margin: 0; padding: 0; }
.ach-next-row { display: flex; gap: var(--sp-3); align-items: flex-start; padding: var(--sp-3) 0; border-bottom: 1px solid var(--divider); }
.ach-next-row:last-child { border-bottom: 0; }
.ach-next-main { flex: 1; min-width: 0; }
.ach-next-name { margin: 0; font-weight: 600; color: var(--text-strong); font-size: var(--text-md); }
.ach-next-desc { margin: 2px 0 0; color: var(--text-muted); font-size: var(--text-sm); line-height: 1.45; }
.ach-prog { display: flex; align-items: center; gap: var(--sp-2); margin-top: 8px; }
.ach-bar { flex: 1; max-width: 280px; display: block; height: 6px; border-radius: 3px; background: var(--border); overflow: hidden; }
.ach-bar span { display: block; height: 100%; border-radius: 3px; background: var(--brand); }
.ach-dots { display: flex; gap: 4px; flex-wrap: wrap; }
.ach-dots i { width: 9px; height: 9px; border-radius: 50%; background: var(--border); }
.ach-dots i.on { background: var(--brand); }
.ach-bar-num { font-size: var(--text-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ach-go { display: inline-flex; align-items: center; min-height: 36px; margin-top: 10px; padding: 0 14px; border-radius: 8px; background: var(--brand); color: #04261C; font-size: var(--text-sm); font-weight: 700; text-decoration: none; }
.ach-go:hover { background: var(--brand-dark, var(--brand)); color: #04261C; }

/* The board. The story opens under the tapped pin's row; dense packing lets
   the pins after it fill the rest of that row. */
.ach-board { display: grid; grid-template-columns: repeat(auto-fill, minmax(76px, 1fr)); grid-auto-flow: dense; gap: 2px; }
.ach-detail-li { grid-column: 1 / -1; display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows 240ms var(--ease), opacity 200ms var(--ease); }
.ach-detail-li.is-open { grid-template-rows: 1fr; opacity: 1; }
.ach-detail-clip { min-height: 0; overflow: hidden; }
.ach-slot { transition: background-color 160ms var(--ease), border-color 160ms var(--ease); }
.ach-slot { width: 100%; height: 100%; display: flex; flex-direction: column; align-items: center; gap: 4px; padding: var(--sp-2) 2px; border: 1px solid transparent; border-radius: var(--r-sm); background: none; font: inherit; color: inherit; text-align: center; cursor: pointer; }
.ach-slot:hover { background: var(--bg-soft); }
.ach-slot.is-picked { border-color: var(--border); background: var(--bg-soft); }
.ach-slot-name { font-size: var(--text-xs); font-weight: 500; color: var(--text-muted); line-height: 1.25; }
.ach-slot.is-on .ach-slot-name { font-weight: 600; color: var(--text-strong); }
.ach-slot-meta { font-size: var(--text-11, 11px); color: var(--text-muted); line-height: 1.25; }
.ach-detail { display: flex; gap: var(--sp-4); align-items: flex-start; margin: 2px 0 var(--sp-2); padding: var(--sp-4); background: var(--bg-soft); border-radius: var(--r-sm); }
.ach-detail-main { flex: 1; min-width: 0; }
.ach-detail h4 { margin: 0 0 4px; font-size: var(--text-lg); color: var(--text-strong); }
.ach-detail p { margin: 0 0 4px; font-size: var(--text-sm); line-height: 1.55; color: var(--text); }
.ach-detail .ach-next { color: var(--text-muted); }
.ach-detail .ach-next.is-done { color: var(--brand); font-weight: 600; }
.ach-detail .ach-live { color: var(--text-strong); font-weight: 600; }
.ach-detail .ach-when { font-size: var(--text-xs); }
.ach-tiers { display: flex; gap: var(--sp-4); margin-top: var(--sp-3); }
.ach-tiers li { display: flex; flex-direction: column; align-items: center; gap: 2px; font-size: var(--text-11, 11px); color: var(--text-muted); }
.ach-tiers li.is-on { color: var(--text-strong); font-weight: 600; }
.ach-empty { padding: var(--sp-6) 0; color: var(--text-muted); }
.ach-foot { margin: var(--sp-5) 0 0; padding-top: var(--sp-3); font-size: var(--text-xs); line-height: 1.5; color: var(--text-muted); border-top: 1px solid var(--divider); }

/* On the report card: the latest pins, then a link to the full list. */
.ach-rc { margin-top: var(--sp-6); padding-top: var(--sp-5); border-top: 1px solid var(--border); }
.ach-rc-shelf { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); column-gap: var(--sp-5); }
.ach-rc-shelf li { display: flex; gap: var(--sp-3); align-items: center; padding: var(--sp-2) 0; border-bottom: 1px solid var(--divider); min-width: 0; }
.ach-rc-shelf li > span:last-child { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ach-rc-shelf b { font-size: var(--text-sm); color: var(--text-strong); font-weight: 600; }
.ach-rc-shelf small { font-size: var(--text-xs); color: var(--text-muted); }

@media (max-width: 720px) {
  .ach-rc-shelf { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 559px) {
  .ach-overlay { align-items: flex-end; padding: 0; }
  .ach-sheet { width: 100%; max-height: 92vh; max-height: 92dvh; border-radius: 16px 16px 0 0; }
  .ach-head { position: relative; padding: var(--sp-3) var(--sp-4) 0; }
  .ach-head-row { padding-right: 36px; }
  .ach-head h2 { font-size: var(--text-xl, 20px); }
  .ach-head .tn-lang button { height: 26px; padding: 0 9px; }
  .ach-close { position: absolute; top: 10px; right: 10px; }
  .ach-cats { margin-top: var(--sp-3); gap: var(--sp-4); }
  .ach-body { padding: 0 var(--sp-4) calc(var(--sp-4) + env(safe-area-inset-bottom)); }
  .ach-detail { gap: var(--sp-3); padding: var(--sp-3); }
  .ach-detail .ach-xl svg { width: 64px; height: auto; }
  .ach-rc-shelf { grid-template-columns: 1fr; }
}

@media (max-width: 359px) {
  .ach-head-row { flex-wrap: wrap; row-gap: 6px; }
}

@media (prefers-reduced-motion: reduce) {
  .ach-toast { transition: opacity 120ms linear; transform: none; }
  .ach-detail-li, .ach-slot { transition: none; }
  .ach-toast.is-in .ach-toast-medal .ach-pin, .ach-toast-summary.is-in .ach-stack .ach-pin { animation: none; }
}
`;
