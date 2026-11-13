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
// qualifies) become ONE summary that opens the list. Reduced motion: no
// strike, no sheen, a plain fade.
// Telemetry: web_events kind "achievement" (shown / opened / dismissed).
// =============================================================================

import { getState, subscribe } from "../state.js";
import { sb } from "../db/supabase.js";
import { logEvent } from "../features/telemetry.js";
import { isOwner } from "../features/preview.js";
import { onBackdropClick } from "../components/backdrop.js";
import { CATEGORIES, TIERS, fill, progressFor, deliveryPlan } from "./core.js";

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
// The medal: a struck metal disc in the tier's colour, the family's emoji in
// the middle. Locked = an empty dashed ring.
// ---------------------------------------------------------------------------
function medal(def, { size = "md", locked = false } = {}) {
  const tier = locked ? "locked" : (def.tiers > 1 || def.tier > 1 ? TIERS[def.tier]?.key : "gold") || "bronze";
  return `<span class="ach-medal ach-${size} ach-t-${tier}" aria-hidden="true"><span class="ach-face">${esc(def.emoji || "🏅")}</span></span>`;
}

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
      <p class="ach-toast-kicker">${hi ? "Naya achievement" : "Achievement unlocked"}${def.tiers > 1 ? `<span class="ach-tier-word">${esc(c.tier)}</span>` : ""}</p>
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
export async function showNew({ force = true } = {}) {
  if (!isOwner()) return;
  const data = await loadAchievements({ force });
  if (!data) return;
  const { defs } = view(data);
  const fresh = data.earned
    .filter((e) => !e.seen && !_shown.has(e.code) && defs.has(e.code))
    .map((e) => ({ def: defs.get(e.code), ev: e.evidence, seeded: e.seeded, tier: defs.get(e.code).tier }));
  if (!fresh.length) return;
  for (const f of fresh) _shown.add(f.def.code);
  const plan = deliveryPlan(fresh);
  if (plan.kind === "summary") enqueue({ kind: "summary", items: fresh });
  else for (const it of plan.items) enqueue({ kind: "one", ...it });
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------
let _overlay = null;

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
  track(focus || "list", { action: "opened", from: focus ? "toast" : "list" });

  const draw = (data) => {
    const hi = lang;
    if (!data) {
      overlay.innerHTML = `<div class="modal ach-sheet" role="dialog" aria-modal="true" aria-label="Achievements"><p class="muted" style="padding: var(--sp-6);">${hi ? "Load ho raha hai…" : "Loading…"}</p></div>`;
      return;
    }
    const { defs, earned, earnedSet } = view(data);
    const evOf = new Map(earned.map((e) => [e.code, e]));
    const fams = new Map();
    for (const d of [...defs.values()].sort((a, b) => a.sort - b.sort || a.tier - b.tier)) {
      if (!fams.has(d.family)) fams.set(d.family, []);
      fams.get(d.family).push(d);
    }
    const tierCount = [0, 0, 0, 0, 0];
    for (const e of earned) tierCount[defs.get(e.code)?.tier || 0]++;
    const rows = [...fams.values()].filter((list) => cat === "all" || list[0].category === cat).map((list) => {
      const got = list.filter((d) => earnedSet.has(d.code));
      const best = got[got.length - 1];
      const nextDef = list.find((d) => !earnedSet.has(d.code));
      const head = best || list[0];
      const c = copyOf(head, best ? evOf.get(best.code)?.evidence : null, hi);
      const seeded = best && evOf.get(best.code)?.seeded;
      const pr = nextDef ? progressFor(nextDef, data.facts) : null;
      const nc = nextDef ? copyOf(nextDef, null, hi) : null;
      return `
        <li class="ach-row ${best ? "is-earned" : "is-locked"} ${focus && list.some((d) => d.code === focus) ? "is-focus" : ""}" data-family="${esc(head.family)}">
          ${medal(head, { size: "md", locked: !best })}
          <div class="ach-row-main">
            <div class="ach-row-top">
              <h3>${esc(c.name)}</h3>
              ${list.length > 1 ? `<span class="ach-pips" aria-label="${got.length} of ${list.length} tiers">${list.map((d) => `<i class="ach-pip ach-t-${TIERS[d.tier].key} ${earnedSet.has(d.code) ? "on" : ""}"></i>`).join("")}</span>` : ""}
            </div>
            ${best ? `<p class="ach-row-why">${esc(c.why)}${seeded ? ` <span class="ach-sample">Preview sample</span>` : ""}</p>` : ""}
            ${nextDef ? `
              <p class="ach-row-next">${best ? (hi ? "Agla" : "Next") + ` (${esc(nc.tier)}): ` : ""}${esc(nc.desc)}</p>
              ${pr && pr.target > 1 && nextDef.metric !== "balanced_level" ? `
                <div class="ach-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${pr.target}" aria-valuenow="${Math.min(pr.value, pr.target)}" aria-label="${esc(nc.name)}">
                  <span style="width:${Math.round(pr.pct * 100)}%"></span>
                </div>
                <span class="ach-bar-num">${Math.min(pr.value, pr.target).toLocaleString("en-IN")} / ${pr.target.toLocaleString("en-IN")}</span>` : ""}`
            : `<p class="ach-row-next ach-done">${list.length > 1 ? (hi ? "Saare tiers ho gaye" : "Every tier earned") : (hi ? "Kama liya" : "Earned")}</p>`}
          </div>
        </li>`;
    }).join("");
    overlay.innerHTML = `
      <div class="modal ach-sheet" role="dialog" aria-modal="true" aria-labelledby="ach-title" tabindex="-1">
        <header class="ach-head">
          <div>
            <h2 id="ach-title">${hi ? "Achievements" : "Achievements"}</h2>
            <p class="ach-sub">${hi ? `${earned.length} kamaye, ${defs.size} mein se` : `${earned.length} earned of ${defs.size}`}
              <span class="ach-tally">${[4, 3, 2, 1].filter((t) => tierCount[t]).map((t) => `<span><i class="ach-pip on ach-t-${TIERS[t].key}"></i>${tierCount[t]}</span>`).join("")}</span>
            </p>
          </div>
          <div class="ach-head-tools">
            <div class="tn-lang" role="group" aria-label="Language">
              <button type="button" data-lang="en" aria-pressed="${!hi}">English</button>
              <button type="button" data-lang="hi" aria-pressed="${hi}">Hinglish</button>
            </div>
            <button type="button" class="ach-x ach-close" aria-label="${hi ? "Band karo" : "Close"}">
              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </div>
        </header>
        <nav class="ach-cats" aria-label="${hi ? "Category" : "Category"}">
          <button type="button" data-cat="all" aria-pressed="${cat === "all"}">${hi ? "Sab" : "All"}</button>
          ${CATEGORIES.map((c) => `<button type="button" data-cat="${c.key}" aria-pressed="${cat === c.key}">${esc(hi ? c.hi : c.en)}</button>`).join("")}
        </nav>
        <ul class="ach-list">${rows || `<li class="ach-empty">${hi ? "Is category mein abhi kuch nahi." : "Nothing in this category yet."}</li>`}</ul>
        <p class="ach-foot">${hi
          ? "Har achievement tumhare apne trades aur seekhne se aata hai. Zyada trade karne se koi achievement nahi milta."
          : "Every achievement comes from your own trades and learning. Trading more never earns one."}</p>
      </div>`;
    overlay.querySelectorAll("[data-lang]").forEach((b) => b.addEventListener("click", () => {
      lang = b.dataset.lang === "hi"; draw(_data);
      overlay.querySelector(`[data-lang="${lang ? "hi" : "en"}"]`)?.focus();
    }));
    overlay.querySelectorAll("[data-cat]").forEach((b) => b.addEventListener("click", () => {
      cat = b.dataset.cat; draw(_data);
      overlay.querySelector(`[data-cat="${cat}"]`)?.focus();
    }));
    overlay.querySelector(".ach-close").addEventListener("click", close);
  };

  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  function close() {
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
  overlay.querySelector(".ach-row.is-focus")?.scrollIntoView({ block: "center" });
  const unseen = data.earned.filter((e) => !e.seen).map((e) => e.code);
  if (unseen.length) markSeen(unseen);
}

// ---------------------------------------------------------------------------
// The report card's achievements card (owners; replaces the 8 old badges)
// ---------------------------------------------------------------------------
export function achievementsCardHtml() {
  const hi = hinglish();
  const d = _data;
  if (!d) {
    return `<div class="card ach-rc" id="achievements"><div class="card-head"><h3>${hi ? "Achievements" : "Achievements"}</h3></div><p class="muted">${hi ? "Load ho raha hai…" : "Loading…"}</p></div>`;
  }
  const { defs, earned } = view(d);
  const recent = [...earned].sort((a, b) => (a.earned_at < b.earned_at ? 1 : -1));
  // One medal per family, its highest tier, newest first.
  const seen = new Set(); const shelf = [];
  for (const e of recent) {
    const def = defs.get(e.code);
    if (seen.has(def.family)) continue;
    const best = recent.filter((x) => defs.get(x.code).family === def.family).map((x) => defs.get(x.code)).sort((a, b) => b.tier - a.tier)[0];
    seen.add(def.family); shelf.push(best);
  }
  return `
    <div class="card ach-rc" id="achievements">
      <div class="card-head">
        <h3>Achievements</h3>
        <span class="dim" style="font-size: var(--text-xs);">${hi ? `${earned.length} / ${defs.size} kamaye` : `${earned.length} of ${defs.size} earned`}</span>
      </div>
      ${shelf.length ? `<ul class="ach-shelf">${shelf.slice(0, 10).map((def) => `
        <li title="${esc((hi ? def.name_hi : def.name_en) + (def.tiers > 1 ? ` (${TIERS[def.tier].en})` : ""))}">
          ${medal(def, { size: "md" })}<span>${esc(hi ? def.name_hi : def.name_en)}</span>
        </li>`).join("")}</ul>`
        : `<p class="muted">${hi ? "Pehla achievement trade, replay ya Saathi se sawaal se aata hai." : "Your first one comes from a trade, a crash replay or a question to Saathi."}</p>`}
      <button type="button" class="btn btn-ghost btn-sm ach-rc-open">${hi ? "Saare achievements aur agla kadam" : "All achievements and what's next"}</button>
    </div>`;
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
  // Ask the server to look now after a trade (it throttles to once per 30 s).
  let lastTx = (getState()?.transactions || []).length;
  let pending = null;
  subscribe((s) => {
    const n = (s?.transactions || []).length;
    if (n > lastTx) {
      clearTimeout(pending);
      pending = setTimeout(checkNow, 2500);
    }
    lastTx = n;
  });
  // A finished crash replay or a coach question lands on the server as an
  // event; check when the user leaves those pages.
  let lastPath = location.pathname;
  window.addEventListener("ss:navigate", () => {
    const was = lastPath; lastPath = location.pathname;
    if (/^\/(crash-replay|chat)/.test(was)) setTimeout(checkNow, 1500);
  });
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
  if (document.getElementById("ach-style")) return;
  const s = document.createElement("style");
  s.id = "ach-style";
  s.textContent = CSS;
  document.head.appendChild(s);
}

const CSS = `
.ach-t-bronze   { --m1: #7A4A22; --m2: #C98B52; --m3: #F2C49A; }
.ach-t-silver   { --m1: #5E6875; --m2: #AEB8C4; --m3: #F1F4F8; }
.ach-t-gold     { --m1: #8A6410; --m2: #D9A824; --m3: #FFE7A0; }
.ach-t-platinum { --m1: #3C5A7A; --m2: #9FC1DF; --m3: #EEF7FF; }
.ach-medal { position: relative; flex-shrink: 0; display: grid; place-items: center; border-radius: 50%;
  background: conic-gradient(from 210deg, var(--m1), var(--m3) 18%, var(--m2) 38%, var(--m1) 55%, var(--m3) 72%, var(--m2) 88%, var(--m1));
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.35), 0 2px 6px -2px rgba(15,17,24,.35); }
.ach-medal .ach-face { display: grid; place-items: center; border-radius: 50%; line-height: 1;
  background: radial-gradient(circle at 35% 30%, var(--m3), var(--m2) 70%); box-shadow: inset 0 1px 2px rgba(0,0,0,.25); }
.ach-sm { width: 28px; height: 28px; } .ach-sm .ach-face { width: 22px; height: 22px; font-size: 12px; }
.ach-md { width: 44px; height: 44px; } .ach-md .ach-face { width: 34px; height: 34px; font-size: 18px; }
.ach-lg { width: 64px; height: 64px; } .ach-lg .ach-face { width: 50px; height: 50px; font-size: 26px; }
.ach-t-locked { background: none; box-shadow: inset 0 0 0 2px var(--border-strong); }
.ach-t-locked .ach-face { background: var(--bg-soft); box-shadow: none; filter: grayscale(1); opacity: .45; }

.ach-toast { position: fixed; right: 16px; bottom: 96px; z-index: 91; width: min(360px, calc(100vw - 32px));
  display: flex; gap: 14px; align-items: flex-start; padding: 14px 12px 14px 14px;
  background: var(--surface); color: var(--text); border-radius: 18px;
  border: 1px solid color-mix(in srgb, var(--m2, var(--brand)) 55%, var(--border));
  box-shadow: 0 18px 40px -16px rgba(15,17,24,.45);
  opacity: 0; transform: translateY(14px) scale(.96);
  transition: opacity 220ms var(--ease), transform 300ms cubic-bezier(.2,.9,.25,1.15); }
.ach-toast.is-in { opacity: 1; transform: none; }
.ach-toast::before { content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
  background: radial-gradient(120px 90px at 46px 44px, color-mix(in srgb, var(--m2, var(--brand)) 26%, transparent), transparent 70%); }
.ach-toast > * { position: relative; }
.ach-sheet:focus { outline: none; }
.ach-tt-bronze { --m2: #C98B52; } .ach-tt-silver { --m2: #AEB8C4; } .ach-tt-gold { --m2: #D9A824; } .ach-tt-platinum { --m2: #9FC1DF; }
.ach-toast-summary { --m2: var(--brand); }
.ach-toast-medal { position: relative; overflow: hidden; border-radius: 50%; }
.ach-toast.is-in .ach-toast-medal .ach-medal { animation: ach-strike 520ms cubic-bezier(.2,.9,.25,1.2) 80ms both; }
.ach-toast.is-in .ach-toast-medal::after { content: ""; position: absolute; inset: 0; border-radius: 50%; pointer-events: none;
  background: linear-gradient(115deg, transparent 35%, rgba(255,255,255,.75) 50%, transparent 65%);
  transform: translateX(-120%); animation: ach-sheen 900ms ease-out 520ms 1 both; }
@keyframes ach-strike { 0% { transform: scale(.4) rotate(-25deg); opacity: 0; } 70% { transform: scale(1.08) rotate(4deg); opacity: 1; } 100% { transform: none; } }
@keyframes ach-sheen { to { transform: translateX(120%); } }
.ach-toast-body { flex: 1; min-width: 0; }
.ach-toast-kicker { margin: 0; font-size: var(--text-xs); color: var(--text-muted); font-weight: 600; display: flex; gap: 6px; align-items: center; }
.ach-tier-word { color: color-mix(in srgb, var(--m2) 70%, var(--text-strong)); font-weight: 700; }
.ach-toast-name { margin: 2px 0 4px; font-size: var(--text-lg); letter-spacing: -.01em; color: var(--text-strong); }
.ach-toast-why { margin: 0 0 8px; font-size: var(--text-sm); line-height: 1.5; color: var(--text); }
.ach-link { min-height: 36px; padding: 0 12px; border: 0; border-radius: 10px; background: var(--brand-soft); color: var(--brand-dark); font-weight: 700; font-size: var(--text-sm); cursor: pointer; }
[data-theme="dark"] .ach-link { color: var(--brand); }
.ach-link:focus-visible, .ach-x:focus-visible, .ach-cats button:focus-visible { outline: none; box-shadow: var(--sh-focus); }
.ach-x { width: 32px; height: 32px; flex-shrink: 0; border: 0; border-radius: 8px; background: transparent; color: var(--text-muted); display: grid; place-items: center; cursor: pointer; }
.ach-x:hover { background: var(--bg-soft); color: var(--text-strong); }
.ach-stack { display: flex; flex-shrink: 0; padding-top: 2px; }
.ach-stack .ach-medal + .ach-medal { margin-left: -16px; }
.ach-stack .ach-medal:nth-child(1) { z-index: 3; } .ach-stack .ach-medal:nth-child(2) { z-index: 2; }
.ach-toast-summary.is-in .ach-stack .ach-medal { animation: ach-strike 520ms cubic-bezier(.2,.9,.25,1.2) both; }
.ach-toast-summary.is-in .ach-stack .ach-medal:nth-child(2) { animation-delay: 90ms; }
.ach-toast-summary.is-in .ach-stack .ach-medal:nth-child(3) { animation-delay: 180ms; }
.ach-sample { display: inline-block; padding: 1px 7px; border-radius: 999px; background: var(--bg-soft); color: var(--text-muted); font-size: 11px; font-weight: 600; vertical-align: 1px; }
@media (max-width: 559px) { .ach-toast { left: 12px; right: 12px; width: auto; bottom: calc(84px + env(safe-area-inset-bottom)); } }

.ach-sheet { width: min(720px, 100%); max-width: 720px; max-height: min(86vh, 820px); display: flex; flex-direction: column; padding: 0; overflow: hidden; }
.ach-head { flex-shrink: 0; display: flex; justify-content: space-between; gap: var(--sp-3); align-items: flex-start; padding: var(--sp-5) var(--sp-5) var(--sp-3); }
.ach-head h2 { margin: 0; font-size: var(--text-2xl, 24px); letter-spacing: -.02em; }
.ach-sub { margin: 4px 0 0; color: var(--text-muted); font-size: var(--text-sm); display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.ach-tally { display: inline-flex; gap: 10px; font-variant-numeric: tabular-nums; color: var(--text-strong); font-weight: 600; }
.ach-tally span { display: inline-flex; gap: 4px; align-items: center; }
.ach-head-tools { display: flex; gap: 8px; align-items: center; }
.ach-cats { flex-shrink: 0; display: flex; gap: 6px; padding: 0 var(--sp-5) var(--sp-3); overflow-x: auto; scrollbar-width: none; border-bottom: 1px solid var(--divider); }
.ach-cats::-webkit-scrollbar { display: none; }
.ach-cats button { flex-shrink: 0; height: 32px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface); color: var(--text-muted); font-size: var(--text-sm); font-weight: 600; cursor: pointer; }
.ach-cats button[aria-pressed="true"] { background: var(--text-strong); border-color: var(--text-strong); color: var(--surface); }
.ach-list { list-style: none; margin: 0; padding: var(--sp-2) var(--sp-5) var(--sp-3); overflow-y: auto; flex: 1; }
.ach-row { display: flex; gap: 14px; padding: 14px 0; border-bottom: 1px solid var(--divider); }
.ach-row:last-child { border-bottom: 0; }
.ach-row.is-focus { background: linear-gradient(90deg, var(--brand-soft), transparent 70%); margin: 0 calc(-1 * var(--sp-5)); padding-left: var(--sp-5); padding-right: var(--sp-5); }
.ach-row-main { flex: 1; min-width: 0; }
.ach-row-top { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
.ach-row h3 { margin: 0; font-size: var(--text-base); color: var(--text-strong); }
.ach-row.is-locked h3 { color: var(--text-muted); }
.ach-row-why { margin: 3px 0 0; font-size: var(--text-sm); line-height: 1.5; }
.ach-row-next { margin: 3px 0 0; font-size: var(--text-sm); color: var(--text-muted); line-height: 1.5; }
.ach-done { color: color-mix(in srgb, var(--brand) 80%, var(--text-muted)); font-weight: 600; }
.ach-pips { display: inline-flex; gap: 4px; flex-shrink: 0; }
.ach-pip { width: 10px; height: 10px; border-radius: 50%; display: inline-block; box-shadow: inset 0 0 0 1.5px var(--border-strong); }
.ach-pip.on { background: radial-gradient(circle at 35% 30%, var(--m3), var(--m2) 65%, var(--m1)); box-shadow: none; }
.ach-bar { display: inline-block; vertical-align: middle; width: min(220px, 60%); height: 6px; border-radius: 3px; background: var(--bg-soft); overflow: hidden; margin-top: 6px; }
.ach-bar span { display: block; height: 100%; border-radius: 3px; background: var(--brand); }
.ach-bar-num { margin-left: 8px; font-size: var(--text-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; vertical-align: middle; }
.ach-empty { padding: var(--sp-6) 0; color: var(--text-muted); }
.ach-foot { flex-shrink: 0; margin: 0; padding: var(--sp-3) var(--sp-5) var(--sp-4); font-size: var(--text-xs); color: var(--text-muted); border-top: 1px solid var(--divider); }
@media (max-width: 559px) {
  .ach-overlay { align-items: flex-end; padding: 0; }
  .ach-sheet { width: 100%; max-height: 92vh; border-radius: 20px 20px 0 0; }
  .ach-head { padding: var(--sp-4) var(--sp-4) var(--sp-3); flex-wrap: wrap; }
  .ach-cats, .ach-list { padding-left: var(--sp-4); padding-right: var(--sp-4); }
  .ach-foot { padding: var(--sp-3) var(--sp-4) calc(var(--sp-4) + env(safe-area-inset-bottom)); }
}

.ach-rc { margin-top: var(--sp-6); }
.ach-shelf { list-style: none; margin: 0 0 var(--sp-4); padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr)); gap: var(--sp-3); }
.ach-shelf li { display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center; font-size: var(--text-xs); color: var(--text); line-height: 1.3; }

@media (prefers-reduced-motion: reduce) {
  .ach-toast { transition: opacity 120ms linear; transform: none; }
  .ach-toast.is-in .ach-toast-medal .ach-medal, .ach-toast-summary.is-in .ach-stack .ach-medal { animation: none; }
  .ach-toast.is-in .ach-toast-medal::after { animation: none; display: none; }
}
`;
