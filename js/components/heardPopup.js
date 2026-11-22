// =============================================================================
// HEARD-FROM CARD — "How did you hear about StockSaathi?" as one required tap.
//
// Same sheet as the term explainer and the What's-new card (.term-pop), with
// tappable chips instead of a dropdown. No close button, no Esc, no backdrop
// dismiss: "Don't remember" is the way out. Continue stays disabled until a
// chip is picked.
//
// Who sees what comes from the database (heard_config(), 2026-11-22b):
//   popup     the card replaces the old onboarding dropdown for this account
//   backfill  one-time ask on /portfolio for recent accounts that skipped it
//   debug     is_admin(): ?heard_debug=1 opens the card on any page, with the
//             admin tools from heardDebug.js (loaded only for admins)
// Saves go through save_heard_from(), which checks the value and cleans the
// "Where?" text again on the server.
//
// Events (web_events): click heard_from:<value> (same name as the old
// dropdown, so existing queries keep working), and kind "heard" for
// heard_popup:shown, heard_popup:more and heard_popup:other_text. Previews in
// dry-run mode carry props.debug = true.
// =============================================================================

import { sb } from "../db/supabase.js";
import { getState, setState } from "../state.js";
import { logEvent } from "../features/telemetry.js";

// [value, label, icon]. Values are what profiles.heard_from stores.
export const HEARD_MAIN = [
  ["chatgpt", "ChatGPT", "chat"],
  ["google", "Google", "search"],
  ["instagram", "Instagram", "camera"],
  ["youtube", "YouTube", "play"],
  ["whatsapp", "WhatsApp", "phone"],
  ["friend", "A friend", "person"],
  ["family", "Family", "people"],
  ["school", "School / teacher", "cap"],
  ["ambassador", "StockSaathi ambassador", "badge"],
  ["other_ai", "Another AI (Gemini, Perplexity…)", "spark"],
];
// Always the last two, in this order.
export const HEARD_TAIL = [
  ["other", "Other", "dots"],
  ["dont_remember", "Don't remember", "question"],
];
export const HEARD_MORE = [
  ["telegram", "Telegram", "plane"],
  ["reddit", "Reddit", "bubbles"],
  ["discord", "Discord", "pad"],
  ["x", "X / Twitter", "x"],
  ["snapchat", "Snapchat", "ghost"],
  ["facebook", "Facebook", "thumb"],
  ["linkedin", "LinkedIn", "case"],
  ["quora", "Quora", "qa"],
  ["play_store", "Play Store", "store"],
  ["article", "A blog / article", "doc"],
  ["other_search", "Another search engine (Bing, DuckDuckGo…)", "compass"],
];
export const HEARD_VALUES = new Set([...HEARD_MAIN, ...HEARD_TAIL, ...HEARD_MORE].map((o) => o[0]));
export const DETAIL_MAX = 60;

const ICONS = {
  chat: `<path d="M5 18.5l1.3-3.4A7.5 7.5 0 1 1 9.2 18L5 18.5z"/><path d="M12 8.2l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z"/>`,
  search: `<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l4.5 4.5"/>`,
  camera: `<rect x="4" y="4" width="16" height="16" rx="5"/><circle cx="12" cy="12" r="3.6"/><path d="M16.6 7.4h.01"/>`,
  play: `<rect x="3.5" y="6" width="17" height="12" rx="3.5"/><path d="M10.5 9.5v5l4-2.5z"/>`,
  phone: `<path d="M4.5 19.5l1.2-3.6A8 8 0 1 1 8.4 18.6z"/><path d="M9.3 9.2c.3 2.2 2.3 4.4 4.9 5.2l1.1-1.2-1.6-.9-.7.6c-.9-.4-1.8-1.3-2.2-2.2l.6-.7-.9-1.6z"/>`,
  person: `<circle cx="12" cy="8.5" r="3.5"/><path d="M5.5 19.5a6.5 6.5 0 0 1 13 0"/>`,
  people: `<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="16.5" cy="9.5" r="2.4"/><path d="M15.5 14.2a4.6 4.6 0 0 1 5 4.8"/>`,
  cap: `<path d="M3 9.5L12 5l9 4.5-9 4.5z"/><path d="M7 11.6V16c1.4 1.3 3 2 5 2s3.6-.7 5-2v-4.4"/>`,
  badge: `<circle cx="12" cy="9" r="5"/><path d="M8.8 13l-1.3 6.5L12 17l4.5 2.5-1.3-6.5"/>`,
  spark: `<path d="M10 4l1.4 3.6L15 9l-3.6 1.4L10 14l-1.4-3.6L5 9l3.6-1.4z"/><path d="M17 13l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>`,
  dots: `<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>`,
  question: `<circle cx="12" cy="12" r="8"/><path d="M9.6 9.6a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.4"/><path d="M12 16.8h.01"/>`,
  plane: `<path d="M20 4.5L3.5 11l6 2 2 6z"/><path d="M9.5 13L20 4.5"/>`,
  bubbles: `<path d="M4 15.5l.9-2.5A6 6 0 1 1 7 15z"/><path d="M14.5 17.5a5 5 0 0 0 5-6.2"/>`,
  pad: `<rect x="3" y="7.5" width="18" height="10" rx="5"/><path d="M8 11v3M6.5 12.5h3"/><path d="M15.5 12h.01M17.5 13.5h.01"/>`,
  x: `<path d="M5 5l14 14M19 5L5 19"/>`,
  ghost: `<path d="M6 19V11a6 6 0 0 1 12 0v8l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5z"/><path d="M10 10.5h.01M14 10.5h.01"/>`,
  thumb: `<path d="M8 11v8H5v-8z"/><path d="M8 11l3.5-6c1.2 0 2 .9 2 2l-.5 3h4.6a1.6 1.6 0 0 1 1.6 1.9l-1.2 5.6a2 2 0 0 1-2 1.5H8"/>`,
  case: `<rect x="3.5" y="7.5" width="17" height="11" rx="2"/><path d="M9 7.5V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 6v1.5"/><path d="M3.5 12.5h17"/>`,
  qa: `<circle cx="11" cy="11" r="6.5"/><path d="M14.5 15.5L19 20"/><path d="M11 13.6v.01M9.4 9a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.8.6-.8 1.1"/>`,
  store: `<path d="M5 4.5v15l8.5-7.5z"/><path d="M5 4.5l12 6.8-3.5 0.7M5 19.5l12-6.8"/>`,
  doc: `<path d="M7 3.5h7l4 4v13H7z"/><path d="M14 3.5v4h4"/><path d="M9.5 12h6M9.5 15.5h6"/>`,
  compass: `<circle cx="12" cy="12" r="8"/><path d="M15 9l-1.8 4.2L9 15l1.8-4.2z"/>`,
  more: `<path d="M12 6v12M6 12h12"/>`,
  less: `<path d="M6 12h12"/>`,
};
const svg = (name) => `<svg class="hp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** The "Where?" text as the server will store it: no tags, no angle
 *  brackets, single spaces, 60 characters at most. Empty → null. */
export function cleanDetail(s) {
  let t = String(s ?? "").replace(/<[^>]*>/g, "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  t = t.slice(0, DETAIL_MAX).trim();
  return t || null;
}

// Order: shuffled per account (a stable seed from the user id, so the same
// person sees the same order each time), "Other" and "Don't remember" last.
function seedOf(str) {
  let h = 2166136261;
  for (const c of String(str || "anon")) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let a = seed || 1;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function shuffled(list, seed) {
  const r = rng(seed), out = list.slice();
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

// heard_config() once per signed-in account per page load.
let _cfg = null, _cfgFor = null, _cfgP = null;
export async function heardConfig() {
  const uid = getState()?.user?.id || null;
  if (!uid) return { popup: false, backfill: false, debug: false };
  if (_cfg && _cfgFor === uid) return _cfg;
  if (_cfgP && _cfgFor === uid) return _cfgP;
  _cfgFor = uid;
  _cfgP = (async () => {
    try {
      const client = await sb();
      if (!client) return { popup: false, backfill: false, debug: false };
      const { data, error } = await client.rpc("heard_config");
      if (error) throw error;
      _cfg = { popup: !!data?.popup, backfill: !!data?.backfill, debug: !!data?.debug };
      return _cfg;
    } catch (e) {
      console.warn("[heard] config failed:", e?.message || e);
      return { popup: false, backfill: false, debug: false };
    } finally { _cfgP = null; }
  })();
  return _cfgP;
}

async function save(value, detail) {
  const client = await sb();
  if (!client) throw new Error("offline");
  const { data, error } = await client.rpc("save_heard_from", { p_value: value, p_detail: detail });
  if (error) throw new Error(error.message);
  setState((s) => ({ ...s, user: { ...s.user, heardFrom: value, heardFromDetail: data?.detail ?? null } }));
  return data;
}

const COPY = {
  onboarding: {
    kicker: "One quick question",
    title: "How did you hear about StockSaathi?",
    sub: "Pick one. It helps us reach more students like you.",
  },
  backfill: {
    kicker: "Before you carry on",
    title: "How did you find StockSaathi?",
    sub: "One tap, asked only once. It helps us reach more students like you.",
  },
};

/**
 * Open the card. Resolves with { value, detail } once an answer is saved
 * (or, in an admin dry run, picked), or null if an admin closed a preview.
 *   variant  "onboarding" | "backfill"
 *   debug    true only when heard_config() said debug (is_admin())
 */
export function openHeardPopup({ variant = "onboarding", debug = false } = {}) {
  return new Promise((resolve) => {
    const uid = getState()?.user?.id || "";
    const st = {
      variant: COPY[variant] ? variant : "onboarding",
      seed: seedOf(uid),
      pick: null,
      detail: "",
      moreOpen: false,
      busy: false,
      dryRun: !!debug,          // previews never write unless the admin turns this off
      debug: !!debug,
      error: "",
    };
    const tag = () => (st.debug && st.dryRun ? { debug: true } : {});

    const el = document.createElement("div");
    el.className = "term-pop-overlay hp-overlay";
    el.innerHTML = `<div class="term-pop hp" role="dialog" aria-modal="true" aria-labelledby="hp-title" tabindex="-1"></div>`;
    const card = el.firstElementChild;

    const chip = ([v, label, ico]) => `
      <button type="button" class="hp-chip${st.pick === v ? " on" : ""}" data-v="${esc(v)}" aria-pressed="${st.pick === v}">
        ${svg(ico)}<span class="hp-label">${esc(label)}</span>
      </button>`;

    const paint = () => {
      const c = COPY[st.variant];
      const main = [...shuffled(HEARD_MAIN, st.seed), ...HEARD_TAIL];
      const more = shuffled(HEARD_MORE, st.seed ^ 0x9e3779b9);
      const pickedMore = HEARD_MORE.some((o) => o[0] === st.pick);
      const moreOpen = st.moreOpen || pickedMore;
      card.innerHTML = `
        <div class="hp-debug-slot"></div>
        <div class="hp-body">
          <div class="hp-kicker">${esc(c.kicker)}</div>
          <h2 class="term-pop-title" id="hp-title">${esc(c.title)}</h2>
          <p class="hp-sub">${esc(c.sub)}</p>
          <div class="hp-grid" role="group" aria-label="Where you heard about StockSaathi">
            ${main.slice(0, -2).map(chip).join("")}
            <button type="button" class="hp-chip hp-more-btn" aria-expanded="${moreOpen}" aria-controls="hp-more">
              ${svg(moreOpen ? "less" : "more")}<span class="hp-label">${moreOpen ? "Fewer options" : "More options"}</span>
            </button>
          </div>
          <div class="hp-grid hp-more" id="hp-more"${moreOpen ? "" : " hidden"}>
            ${more.map(chip).join("")}
          </div>
          <div class="hp-grid hp-tail">
            ${main.slice(-2).map(chip).join("")}
          </div>
          <div class="hp-other"${st.pick === "other" ? "" : " hidden"}>
            <label class="label" for="hp-detail">Where? (optional)</label>
            <input class="input" id="hp-detail" maxlength="${DETAIL_MAX}" autocomplete="off" placeholder="e.g. a poster at my coaching centre" value="${esc(st.detail)}">
            <div class="hp-count dim text-xs"><span>${st.detail.length}</span>/${DETAIL_MAX}</div>
          </div>
          ${st.error ? `<p class="hp-error" role="alert">${esc(st.error)}</p>` : ""}
        </div>
        <div class="hp-actions">
          <button type="button" class="btn btn-primary term-pop-ok hp-go" ${st.pick && !st.busy ? "" : "disabled"}>${st.busy ? "Saving…" : "Continue"}</button>
        </div>`;
      if (st.debug) mountDebug();
    };

    // Admin tools: a separate chunk, fetched only when the server said debug.
    let dbg = null;
    const api = {
      get state() { return st; },
      reset() { st.pick = null; st.detail = ""; st.moreOpen = false; st.error = ""; st.busy = false; st.seed = seedOf(uid); paint(); shown(); },
      reshuffle() { st.seed = (Math.random() * 2 ** 32) >>> 0; paint(); },
      setVariant(v) { st.variant = COPY[v] ? v : "onboarding"; paint(); },
      setDryRun(on) { st.dryRun = !!on; paint(); },
      card, overlay: el,
      close: () => finish(null),
    };
    function mountDebug() {
      const slot = card.querySelector(".hp-debug-slot");
      if (!slot) return;
      if (dbg) { dbg.mount(slot); return; }
      import("./heardDebug.js").then((m) => { dbg = m.createHeardDebug(api); dbg.mount(card.querySelector(".hp-debug-slot")); })
        .catch((e) => console.warn("[heard] debug tools failed:", e?.message || e));
    }

    const shown = () => logEvent("heard", "heard_popup:shown", { variant: st.variant, ...tag() });

    card.addEventListener("click", async (e) => {
      const more = e.target.closest(".hp-more-btn");
      if (more) {
        const open = !(st.moreOpen || HEARD_MORE.some((o) => o[0] === st.pick));
        st.moreOpen = open;
        if (!open && HEARD_MORE.some((o) => o[0] === st.pick)) st.pick = null;
        if (open) logEvent("heard", "heard_popup:more", { variant: st.variant, ...tag() });
        paint();
        return;
      }
      const c = e.target.closest(".hp-chip[data-v]");
      if (c) {
        st.pick = c.dataset.v;
        st.error = "";
        paint();
        if (st.pick === "other") {
          // The field opens below the chips: bring it into view. Phones get no
          // auto-focus (the keyboard would cover the card for an optional field).
          const box = card.querySelector(".hp-other");
          box?.scrollIntoView({ block: "nearest", behavior: "smooth" });
          if (!matchMedia("(pointer: coarse)").matches) card.querySelector("#hp-detail")?.focus({ preventScroll: true });
        }
        else card.querySelector(`.hp-chip[data-v="${st.pick}"]`)?.focus({ preventScroll: true });
        return;
      }
      if (e.target.closest(".hp-go")) submit();
    });
    card.addEventListener("input", (e) => {
      if (e.target.id !== "hp-detail") return;
      st.detail = e.target.value.slice(0, DETAIL_MAX);
      const n = card.querySelector(".hp-count span");
      if (n) n.textContent = String(st.detail.length);
    });
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.id === "hp-detail") { e.preventDefault(); submit(); }
    });

    async function submit() {
      if (!st.pick || st.busy || !HEARD_VALUES.has(st.pick)) return;
      const value = st.pick;
      const detail = value === "other" ? cleanDetail(st.detail) : null;
      if (!(st.debug && st.dryRun)) {
        st.busy = true; st.error = ""; paint();
        try { await save(value, detail); }
        catch (err) {
          console.warn("[heard] save failed:", err?.message || err);
          st.busy = false;
          st.error = "Couldn't save your answer. Check your connection and try again.";
          paint();
          return;
        }
      }
      logEvent("click", `heard_from:${value}`, { variant: st.variant, ...tag() });
      if (detail) logEvent("heard", "heard_popup:other_text", { variant: st.variant, len: detail.length, ...tag() });
      if (st.debug) {
        // Keep the card up for the next preview run; the bar says what happened.
        dbg?.flash?.(st.dryRun ? `Dry run: would save ${value}${detail ? ` · "${detail}"` : ""}` : `Saved ${value} to your profile`);
        if (!st.dryRun) return finish({ value, detail });
        return;
      }
      finish({ value, detail });
    }

    // No Esc, no backdrop dismiss. Tab stays inside the card.
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); return; }
      if (e.key !== "Tab") return;
      const f = [...card.querySelectorAll("button:not([disabled]), input:not([hidden]), select, [tabindex]:not([tabindex='-1'])")]
        .filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      e.preventDefault();
      f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length]?.focus();
    };

    let done = false;
    const prevFocus = document.activeElement;
    function finish(result) {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      dbg?.destroy?.();
      el.remove();
      document.documentElement.classList.remove("term-pop-open");
      document.documentElement.style.removeProperty("--term-pop-gutter");
      try { prevFocus?.focus?.({ preventScroll: true }); } catch {}
      resolve(result);
    }

    paint();
    const gutter = window.innerWidth - document.documentElement.clientWidth;
    if (gutter > 0) document.documentElement.style.setProperty("--term-pop-gutter", gutter + "px");
    document.documentElement.classList.add("term-pop-open");
    document.body.appendChild(el);
    document.addEventListener("keydown", onKey, true);
    // Focus the card itself: focusing the first chip drew a ring that read as "already picked".
    card.focus({ preventScroll: true });
    shown();
  });
}

// ---------------------------------------------------------------------------
// Boot hooks (app.js): the admin ?heard_debug=1 preview, and the one-time
// backfill ask on /portfolio.
// ---------------------------------------------------------------------------
const BACKFILL_LS = "ss.heard.backfill.v1";
let _openNow = false;

export async function heardOnRoute() {
  try {
    const user = getState()?.user;
    if (!user?.id || _openNow) return;
    const q = new URLSearchParams(location.search).get("heard_debug");
    if (q) {
      const cfg = await heardConfig();
      if (!cfg.debug) return;          // not an admin account: the parameter does nothing
      _openNow = true;
      await openHeardPopup({ variant: q === "backfill" ? "backfill" : "onboarding", debug: true });
      _openNow = false;
      return;
    }
    if (!/^\/portfolio\/?$/.test(location.pathname)) return;
    // Cheap checks first, so most visits never call the database.
    if (user.heardFrom || user.heardBackfillShownAt || !user.onboarded) return;
    const made = Date.parse(user.createdAt || "");
    if (!(made > Date.now() - 14 * 86400_000)) return;
    let seen = false;
    try { seen = localStorage.getItem(`${BACKFILL_LS}.${user.id}`) === "1"; } catch {}
    if (seen) return;
    const cfg = await heardConfig();
    if (!cfg.backfill) return;
    _openNow = true;
    // Marked shown the moment it opens, here and on the profile, so it never repeats.
    try { localStorage.setItem(`${BACKFILL_LS}.${user.id}`, "1"); } catch {}
    try { (await sb())?.rpc("mark_heard_backfill_shown").then(() => {}, () => {}); } catch {}
    setState((s) => ({ ...s, user: { ...s.user, heardBackfillShownAt: new Date().toISOString() } }));
    await openHeardPopup({ variant: "backfill", debug: false });
    _openNow = false;
  } catch (e) {
    _openNow = false;
    console.warn("[heard] route hook skipped:", e?.message || e);
  }
}
