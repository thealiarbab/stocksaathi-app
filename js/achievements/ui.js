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
// The medal: a struck metal disc in the tier's colour. A tiered medal shows
// its target on the face (30, 100: the way running apps print "5K" on the
// badge); a one-off shows the family's emoji. Not earned yet = the same disc
// as a thin outline, so the shape is known before it is won.
const compact = (n) => { try { return new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 }).format(n); } catch { return String(n); } };
function medalFace(def) {
  const t = Number(def.threshold);
  if (def.tiers > 1 && def.metric !== "balanced_level" && Number.isFinite(t) && t >= 2) return `<b>${esc(compact(t))}</b>`;
  return `<span class="ach-emoji">${esc(def.emoji || "🏅")}</span>`;
}
function medal(def, { size = "md", locked = false } = {}) {
  const tier = locked ? "locked" : (def.tiers > 1 || def.tier > 1 ? TIERS[def.tier]?.key : "gold") || "bronze";
  return `<span class="ach-medal ach-${size} ach-t-${tier}" aria-hidden="true"><span class="ach-face">${medalFace(def)}</span></span>`;
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

  let picked = focus || null;   // the shelf medal whose story is open
  const draw = (data) => {
    const hi = lang;
    if (!data) {
      overlay.innerHTML = `<div class="modal ach-sheet" role="dialog" aria-modal="true" aria-label="Achievements"><p class="muted" style="padding: var(--sp-6);">${hi ? "Load ho raha hai…" : "Loading…"}</p></div>`;
      return;
    }
    const { defs, earned, earnedSet } = view(data);
    const evOf = new Map(earned.map((e) => [e.code, e]));
    const ordered = [...defs.values()];
    const fams = new Map();
    for (const d of ordered) {
      if (!fams.has(d.family)) fams.set(d.family, []);
      fams.get(d.family).push(d);
    }
    for (const list of fams.values()) list.sort((a, b) => a.tier - b.tier);
    // One entry per family: best tier earned, the next one, progress to it.
    const all = [...fams.values()].map((list) => {
      const got = list.filter((d) => earnedSet.has(d.code));
      const best = got[got.length - 1] || null;
      const next = list.find((d) => !earnedSet.has(d.code)) || null;
      const pr = next ? progressFor(next, data.facts) : null;
      return { list, got, best, next, pr, head: best || list[0], cat: list[0].category };
    });
    const inCat = all.filter((f) => cat === "all" || f.cat === cat);
    const shelf = inCat.filter((f) => f.best).sort((a, b) => (evOf.get(b.best.code)?.earned_at || "").localeCompare(evOf.get(a.best.code)?.earned_at || ""));
    const todo = inCat.filter((f) => !f.best);
    const nextUp = inCat.filter((f) => f.next && f.pr && f.pr.target > 1 && f.next.metric !== "balanced_level" && f.pr.pct > 0 && f.pr.pct < 1)
      .sort((a, b) => b.pr.pct - a.pr.pct).slice(0, 3);
    const tierWord = (d) => (d.tiers > 1 ? copyOf(d, null, hi).tier : "");
    const of = (a, b) => (hi ? `${b} me se ${a}` : `${a} of ${b}`);
    const num = (n) => Number(n).toLocaleString("en-IN");
    const progressLine = (f) => f.pr && f.pr.target > 1 && f.next.metric !== "balanced_level"
      ? `<span class="ach-prog"><span class="ach-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${f.pr.target}" aria-valuenow="${Math.min(f.pr.value, f.pr.target)}" aria-label="${esc(copyOf(f.next, null, hi).name)}"><span style="width:${Math.round(f.pr.pct * 100)}%"></span></span><span class="ach-bar-num">${of(num(Math.min(f.pr.value, f.pr.target)), num(f.pr.target))}</span></span>`
      : "";

    // The Khan-style strip: every tier in the catalogue, filled when earned.
    const strip = ordered.map((d) => `<i class="${earnedSet.has(d.code) ? `on ach-t-${TIERS[d.tier]?.key || "gold"}` : ""}"></i>`).join("");
    const tierCount = [0, 0, 0, 0, 0];
    for (const e of earned) tierCount[defs.get(e.code)?.tier || 0]++;
    const tally = [4, 3, 2, 1].filter((t) => tierCount[t]).map((t) => `${tierCount[t]} ${(hi ? TIERS[t].hi : TIERS[t].en).toLowerCase()}`).join(", ");

    const sel = picked ? all.find((f) => f.list.some((d) => d.code === picked)) : null;
    const detail = sel && sel.best ? (() => {
      const c = copyOf(sel.best, evOf.get(sel.best.code)?.evidence, hi);
      const nc = sel.next ? copyOf(sel.next, null, hi) : null;
      const seeded = evOf.get(sel.best.code)?.seeded;
      return `
        <div class="ach-detail">
          ${medal(sel.best, { size: "lg" })}
          <div>
            <h4>${esc(c.name)}${sel.best.tiers > 1 ? ` <span class="ach-tierword ach-t-${TIERS[sel.best.tier].key}">${esc(c.tier)}</span>` : ""}</h4>
            <p>${esc(c.why)}${seeded ? ` <span class="ach-sample">${hi ? "Preview sample" : "Preview sample"}</span>` : ""}</p>
            ${nc ? `<p class="ach-next">${hi ? "Agla" : "Next"}, ${esc(nc.tier)}: ${esc(nc.desc)}</p>${progressLine(sel)}` : `<p class="ach-next is-done">${sel.list.length > 1 ? (hi ? "Saare tiers ho gaye." : "Every tier earned.") : (hi ? "Kama liya." : "Earned.")}</p>`}
          </div>
        </div>`;
    })() : "";

    const section = (title, body, extra = "") => body ? `<section class="ach-sec"><div class="ach-sec-head"><h3>${title}</h3>${extra}</div>${body}</section>` : "";
    const nextHtml = nextUp.map((f) => {
      const nc = copyOf(f.next, null, hi);
      return `
        <li class="ach-next-row">
          ${medal(f.next, { size: "md", locked: true })}
          <div class="ach-next-main">
            <p class="ach-next-name">${esc(nc.name)}${f.next.tiers > 1 ? ` <span class="ach-tierword ach-t-${TIERS[f.next.tier].key}">${esc(nc.tier)}</span>` : ""}</p>
            <p class="ach-next-desc">${esc(nc.desc)}</p>
            ${progressLine(f)}
          </div>
        </li>`;
    }).join("");
    const shelfHtml = shelf.map((f) => {
      const c = copyOf(f.best, null, hi);
      const ev = evOf.get(f.best.code);
      return `
        <li><button type="button" class="ach-shelf-item ${sel === f ? "is-picked" : ""}" data-pick="${esc(f.best.code)}" aria-pressed="${sel === f}">
          ${medal(f.best, { size: "lg" })}
          <span class="ach-shelf-name">${esc(c.name)}</span>
          <span class="ach-shelf-meta">${f.list.length > 1 ? `${esc(tierWord(f.best))}, ${of(f.got.length, f.list.length)}` : esc(dayText(ev?.earned_at))}</span>
        </button></li>${sel === f && detail ? `<li class="ach-detail-li">${detail}</li>` : ""}`;
    }).join("");
    const todoHtml = todo.map((f) => {
      const c = copyOf(f.list[0], null, hi);
      return `
        <li class="ach-todo">
          ${medal(f.list[0], { size: "md", locked: true })}
          <div><p class="ach-todo-name">${esc(c.name)}</p><p class="ach-todo-desc">${esc(c.desc)}</p>${progressLine(f)}</div>
        </li>`;
    }).join("");

    overlay.innerHTML = `
      <div class="modal ach-sheet" role="dialog" aria-modal="true" aria-labelledby="ach-title" tabindex="-1">
        <header class="ach-head">
          <div class="ach-head-row">
            <h2 id="ach-title">Achievements</h2>
            <div class="ach-head-tools">
              <div class="tn-lang" role="group" aria-label="Language">
                <button type="button" data-lang="en" aria-pressed="${!hi}">English</button>
                <button type="button" data-lang="hi" aria-pressed="${hi}">Hinglish</button>
              </div>
              <button type="button" class="ach-x ach-close" aria-label="${hi ? "Band karo" : "Close"}">
                <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>
          </div>
          <p class="ach-sub"><b>${of(earned.length, defs.size)}</b> ${hi ? "kamaye" : "earned"}${tally ? `: ${esc(tally)}` : ""}</p>
          <div class="ach-strip" aria-hidden="true">${strip}</div>
          <nav class="ach-cats" aria-label="${hi ? "Category" : "Category"}">
            <button type="button" data-cat="all" aria-pressed="${cat === "all"}">${hi ? "Sab" : "All"}</button>
            ${CATEGORIES.map((c) => `<button type="button" data-cat="${c.key}" aria-pressed="${cat === c.key}">${esc(hi ? c.hi : c.en)}</button>`).join("")}
          </nav>
        </header>
        <div class="ach-body">
          ${section(hi ? "Agla kadam" : "Next up", nextHtml && `<ul class="ach-next-list">${nextHtml}</ul>`)}
          ${section(hi ? "Tumhari shelf" : "Your shelf", shelfHtml && `<ul class="ach-shelf">${shelfHtml}</ul>`, `<span>${shelf.length}</span>`)}
          ${section(hi ? "Abhi kamana baaki" : "Still to earn", todoHtml && `<ul class="ach-todos">${todoHtml}</ul>`, `<span>${todo.length}</span>`)}
          ${!shelfHtml && !todoHtml ? `<p class="ach-empty">${hi ? "Is category mein abhi kuch nahi." : "Nothing in this category yet."}</p>` : ""}
        </div>
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
    overlay.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => {
      picked = picked === b.dataset.pick ? null : b.dataset.pick;
      const keep = overlay.querySelector(".ach-body")?.scrollTop || 0;
      draw(_data);
      const body = overlay.querySelector(".ach-body"); if (body) body.scrollTop = keep;
      overlay.querySelector(`[data-pick="${b.dataset.pick}"]`)?.focus();
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
  const head = (right) => `<div class="rc-sec-head"><h2 class="rc-sec-title">Achievements</h2>${right ? `<span>${right}</span>` : ""}</div>`;
  if (!d) {
    return `<section class="ach-rc" id="achievements">${head("")}<p class="muted">${hi ? "Load ho raha hai…" : "Loading…"}</p></section>`;
  }
  const { defs, earned } = view(d);
  const recent = [...earned].sort((a, b) => (a.earned_at < b.earned_at ? 1 : -1));
  // The latest medals, one per family at its highest tier (Strava keeps the
  // four most recent on the profile; here up to six).
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
  if (document.getElementById("ach-style")) return;
  const s = document.createElement("style");
  s.id = "ach-style";
  s.textContent = CSS;
  document.head.appendChild(s);
}

const CSS = `
.ach-t-bronze   { --m1: #7A4A22; --m2: #C98B52; --m3: #F2C49A; --mt: #4A2A10; }
.ach-t-silver   { --m1: #5E6875; --m2: #AEB8C4; --m3: #F1F4F8; --mt: #2E3540; }
.ach-t-gold     { --m1: #8A6410; --m2: #D9A824; --m3: #FFE7A0; --mt: #4D3605; }
.ach-t-platinum { --m1: #3C5A7A; --m2: #9FC1DF; --m3: #EEF7FF; --mt: #1D3550; }
.ach-medal { position: relative; flex-shrink: 0; display: grid; place-items: center; border-radius: 50%;
  background: conic-gradient(from 210deg, var(--m1), var(--m3) 18%, var(--m2) 38%, var(--m1) 55%, var(--m3) 72%, var(--m2) 88%, var(--m1));
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.35), 0 2px 6px -2px rgba(15,17,24,.35); }
.ach-medal .ach-face { display: grid; place-items: center; border-radius: 50%; line-height: 1;
  background: radial-gradient(circle at 35% 30%, var(--m3), var(--m2) 70%); box-shadow: inset 0 1px 2px rgba(0,0,0,.25); }
.ach-face b { font-weight: 800; color: var(--mt); letter-spacing: -0.03em; font-variant-numeric: tabular-nums; text-shadow: 0 1px 0 rgba(255,255,255,.45); }
.ach-sm { width: 28px; height: 28px; } .ach-sm .ach-face { width: 22px; height: 22px; font-size: 12px; } .ach-sm .ach-face b { font-size: 9px; }
.ach-md { width: 44px; height: 44px; } .ach-md .ach-face { width: 34px; height: 34px; font-size: 18px; } .ach-md .ach-face b { font-size: 13px; }
.ach-lg { width: 60px; height: 60px; } .ach-lg .ach-face { width: 47px; height: 47px; font-size: 24px; } .ach-lg .ach-face b { font-size: 17px; }
/* Not earned: the same disc drawn as a thin outline. */
.ach-t-locked { background: none; box-shadow: inset 0 0 0 1.5px var(--border-strong, var(--border)); }
.ach-t-locked .ach-face { background: none; box-shadow: inset 0 0 0 1px var(--border); }
.ach-t-locked .ach-face b { color: var(--text-muted); text-shadow: none; font-weight: 700; }
.ach-t-locked .ach-emoji { filter: grayscale(1); opacity: .4; }

.ach-toast { position: fixed; right: 16px; bottom: 96px; z-index: 91; width: min(360px, calc(100vw - 32px));
  display: flex; gap: 14px; align-items: flex-start; padding: 14px 12px 14px 14px;
  background: var(--surface); color: var(--text); border-radius: 12px;
  border: 1px solid var(--border); border-top: 3px solid var(--m2, var(--brand));
  box-shadow: 0 18px 40px -18px rgba(15,17,24,.45);
  opacity: 0; transform: translateY(14px);
  transition: opacity 220ms var(--ease), transform 300ms cubic-bezier(.2,.9,.25,1.15); }
.ach-toast.is-in { opacity: 1; transform: none; }
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
.ach-link { min-height: 36px; padding: 0; border: 0; background: none; color: var(--brand); font-weight: 700; font-size: var(--text-sm); cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
.ach-link:focus-visible, .ach-x:focus-visible, .ach-cats button:focus-visible, .ach-shelf-item:focus-visible { outline: none; box-shadow: var(--sh-focus); }
.ach-x { width: 32px; height: 32px; flex-shrink: 0; border: 0; border-radius: 8px; background: transparent; color: var(--text-muted); display: grid; place-items: center; cursor: pointer; }
.ach-x:hover { background: var(--bg-soft); color: var(--text-strong); }
.ach-stack { display: flex; flex-shrink: 0; padding-top: 2px; }
.ach-stack .ach-medal + .ach-medal { margin-left: -16px; }
.ach-stack .ach-medal:nth-child(1) { z-index: 3; } .ach-stack .ach-medal:nth-child(2) { z-index: 2; }
.ach-toast-summary.is-in .ach-stack .ach-medal { animation: ach-strike 520ms cubic-bezier(.2,.9,.25,1.2) both; }
.ach-toast-summary.is-in .ach-stack .ach-medal:nth-child(2) { animation-delay: 90ms; }
.ach-toast-summary.is-in .ach-stack .ach-medal:nth-child(3) { animation-delay: 180ms; }
.ach-sample { display: inline-block; padding: 1px 7px; border-radius: 4px; background: var(--bg-soft); color: var(--text-muted); font-size: 11px; font-weight: 600; vertical-align: 1px; }
@media (max-width: 559px) { .ach-toast { left: 12px; right: 12px; width: auto; bottom: calc(84px + env(safe-area-inset-bottom)); } }

/* The list: next up (bars), the shelf (earned, with their story), still to earn. */
.ach-sheet { width: min(760px, 100%); max-width: 760px; max-height: min(88vh, 860px); display: flex; flex-direction: column; padding: 0; overflow: hidden; }
.ach-head { flex-shrink: 0; padding: var(--sp-5) var(--sp-5) 0; border-bottom: 1px solid var(--border); }
.ach-head-row { display: flex; justify-content: space-between; gap: var(--sp-3); align-items: center; }
.ach-head h2 { margin: 0; font-size: var(--text-2xl, 24px); letter-spacing: -.02em; }
.ach-head-tools { display: flex; gap: 8px; align-items: center; }
.ach-sub { margin: 6px 0 0; color: var(--text-muted); font-size: var(--text-sm); }
.ach-sub b { color: var(--text-strong); }
.ach-strip { display: grid; grid-template-columns: repeat(auto-fill, minmax(10px, 1fr)); gap: 3px; margin-top: var(--sp-3); }
.ach-strip i { height: 10px; border-radius: 2px; background: var(--bg-soft); box-shadow: inset 0 0 0 1px var(--border); }
.ach-strip i.on { background: linear-gradient(160deg, var(--m3), var(--m2) 60%, var(--m1)); box-shadow: none; }
.ach-cats { display: flex; gap: var(--sp-5); margin-top: var(--sp-4); overflow-x: auto; scrollbar-width: none; }
.ach-cats::-webkit-scrollbar { display: none; }
.ach-cats button { flex-shrink: 0; padding: 0 0 10px; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--text-muted); font: inherit; font-size: var(--text-sm); font-weight: 600; cursor: pointer; }
.ach-cats button:hover { color: var(--text-strong); }
.ach-cats button[aria-pressed="true"] { color: var(--text-strong); border-bottom-color: var(--text-strong); }
.ach-body { flex: 1; overflow-y: auto; padding: 0 var(--sp-5) var(--sp-4); }
.ach-sec { padding-top: var(--sp-5); }
.ach-sec-head { display: flex; align-items: baseline; gap: var(--sp-2); margin-bottom: var(--sp-3); }
.ach-sec-head h3 { margin: 0; font-size: var(--text-md); font-weight: 700; color: var(--text-strong); }
.ach-sec-head span { font-size: var(--text-sm); color: var(--text-muted); font-variant-numeric: tabular-nums; }
.ach-tierword { font-size: var(--text-xs); font-weight: 700; color: color-mix(in srgb, var(--m1) 75%, var(--text-strong)); }
[data-theme="dark"] .ach-tierword { color: var(--m2); }

.ach-next-list, .ach-shelf, .ach-todos, .ach-rc-shelf { list-style: none; margin: 0; padding: 0; }
.ach-next-row { display: flex; gap: var(--sp-3); align-items: flex-start; padding: var(--sp-3) 0; border-bottom: 1px solid var(--divider); }
.ach-next-row:last-child { border-bottom: 0; }
.ach-next-main { flex: 1; min-width: 0; }
.ach-next-name { margin: 0; font-weight: 600; color: var(--text-strong); font-size: var(--text-md); }
.ach-next-desc { margin: 2px 0 0; color: var(--text-muted); font-size: var(--text-sm); line-height: 1.45; }
.ach-prog { display: flex; align-items: center; gap: var(--sp-2); margin-top: 8px; }
.ach-bar { flex: 1; max-width: 260px; display: block; height: 6px; border-radius: 3px; background: var(--bg-soft); overflow: hidden; }
.ach-bar span { display: block; height: 100%; border-radius: 3px; background: var(--brand); }
.ach-bar-num { font-size: var(--text-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }

.ach-shelf { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); grid-auto-flow: dense; gap: var(--sp-2); }
/* The story opens under the tapped medal's row; dense packing lets the
   medals after it fill the rest of that row. */
.ach-detail-li { grid-column: 1 / -1; }
.ach-detail-li .ach-detail { margin-top: 0; }
.ach-shelf-item { width: 100%; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: var(--sp-3) var(--sp-2); border: 1px solid transparent; border-radius: var(--r-sm); background: none; font: inherit; color: inherit; text-align: center; cursor: pointer; }
.ach-shelf-item:hover { background: var(--bg-soft); }
.ach-shelf-item.is-picked { border-color: var(--border); background: var(--bg-soft); }
.ach-shelf-name { font-size: var(--text-sm); font-weight: 600; color: var(--text-strong); line-height: 1.3; }
.ach-shelf-meta { font-size: var(--text-xs); color: var(--text-muted); }
.ach-detail { display: flex; gap: var(--sp-4); align-items: flex-start; margin-top: var(--sp-3); padding: var(--sp-4); background: var(--bg-soft); border-radius: var(--r-sm); }
.ach-detail h4 { margin: 0 0 4px; font-size: var(--text-lg); color: var(--text-strong); }
.ach-detail p { margin: 0 0 4px; font-size: var(--text-sm); line-height: 1.55; color: var(--text); }
.ach-detail .ach-next { color: var(--text-muted); }
.ach-detail .ach-next.is-done { color: var(--brand); font-weight: 600; }

.ach-todos { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: var(--sp-5); }
.ach-todo { display: flex; gap: var(--sp-3); align-items: flex-start; padding: var(--sp-3) 0; border-bottom: 1px solid var(--divider); }
.ach-todo > div { min-width: 0; flex: 1; }
.ach-todo-name { margin: 0; font-weight: 600; font-size: var(--text-sm); color: var(--text-strong); }
.ach-todo-desc { margin: 2px 0 0; font-size: var(--text-xs); color: var(--text-muted); line-height: 1.45; }
.ach-empty { padding: var(--sp-6) 0; color: var(--text-muted); }
.ach-foot { flex-shrink: 0; margin: 0; padding: var(--sp-3) var(--sp-5) var(--sp-4); font-size: var(--text-xs); color: var(--text-muted); border-top: 1px solid var(--divider); }

/* On the report card: the latest medals, then a link to the full list. */
.ach-rc { margin-top: var(--sp-6); padding-top: var(--sp-5); border-top: 1px solid var(--border); }
.ach-rc-shelf { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); column-gap: var(--sp-5); }
.ach-rc-shelf li { display: flex; gap: var(--sp-3); align-items: center; padding: var(--sp-3) 0; border-bottom: 1px solid var(--divider); min-width: 0; }
.ach-rc-shelf li > span { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ach-rc-shelf b { font-size: var(--text-sm); color: var(--text-strong); font-weight: 600; }
.ach-rc-shelf small { font-size: var(--text-xs); color: var(--text-muted); }

@media (max-width: 720px) {
  .ach-rc-shelf { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ach-todos { grid-template-columns: 1fr; }
}
@media (max-width: 559px) {
  .ach-overlay { align-items: flex-end; padding: 0; }
  .ach-sheet { width: 100%; max-height: 92vh; border-radius: 16px 16px 0 0; }
  .ach-head { padding: var(--sp-4) var(--sp-4) 0; }
  .ach-head { position: relative; }
  .ach-head-row { flex-wrap: wrap; padding-right: 40px; }
  .ach-close { position: absolute; top: var(--sp-3); right: var(--sp-3); }
  .ach-body { padding: 0 var(--sp-4) var(--sp-4); }
  .ach-shelf { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .ach-detail { flex-direction: column; }
  .ach-rc-shelf { grid-template-columns: 1fr; }
  .ach-foot { padding: var(--sp-3) var(--sp-4) calc(var(--sp-4) + env(safe-area-inset-bottom)); }
}

@media (prefers-reduced-motion: reduce) {
  .ach-toast { transition: opacity 120ms linear; transform: none; }
  .ach-toast.is-in .ach-toast-medal .ach-medal, .ach-toast-summary.is-in .ach-stack .ach-medal { animation: none; }
  .ach-toast.is-in .ach-toast-medal::after { animation: none; display: none; }
}
`;
