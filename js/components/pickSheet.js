// =============================================================================
// PICK SHEET: the site's one way to choose from a list.
//
// Same sheet as the heard-from card, the term explainer and What's new
// (.term-pop), so every list looks like StockSaathi and never like the
// browser's own menu (the bright-blue native select list on /portfolio,
// 24 Nov 2026). Owner's rule: every list, now and later, uses this.
//
//   openPickSheet({ title, options, value }) -> Promise<value | null>
//     options: [{ value, label, hint?, meta? } | "---"]   ("---" = divider)
//     A search box appears above 8 options. One tap picks and closes.
//     ✕, Esc and a tap on the backdrop close it with null.
//
//   openSheet({ title, html, onMount, className }) -> { card, close, closed }
//     A plain dismissible sheet for anything else (e.g. "How Saathi got this").
//
// Inline triggers for forms and toolbars: mountThemedSelect() in
// themedSelect.js, which opens this sheet.
// =============================================================================

let _uid = 0;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function openSheet({ title = "", html = "", onMount, className = "" } = {}) {
  const id = "ps-" + (++_uid);
  const el = document.createElement("div");
  el.className = "term-pop-overlay ps-overlay";
  el.innerHTML = `
    <div class="term-pop ps ${esc(className)}" role="dialog" aria-modal="true" aria-labelledby="${id}-t" tabindex="-1">
      <div class="term-pop-head">
        <h2 class="term-pop-title ps-title" id="${id}-t">${esc(title)}</h2>
        <button type="button" class="term-pop-x" aria-label="Close">✕</button>
      </div>
      <div class="ps-body">${html}</div>
    </div>`;
  const card = el.firstElementChild;
  const prevFocus = document.activeElement;
  let done = false, resolveClosed;
  const closed = new Promise((r) => { resolveClosed = r; });

  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(null); return; }
    if (e.key !== "Tab") return;
    const f = [...card.querySelectorAll("button:not([disabled]), input:not([hidden]), [tabindex]:not([tabindex='-1'])")]
      .filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    e.preventDefault();
    f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length]?.focus();
  };
  function close(result) {
    if (done) return;
    done = true;
    document.removeEventListener("keydown", onKey, true);
    el.remove();
    if (!document.querySelector(".term-pop-overlay")) {
      document.documentElement.classList.remove("term-pop-open");
      document.documentElement.style.removeProperty("--term-pop-gutter");
    }
    try { prevFocus?.focus?.({ preventScroll: true }); } catch {}
    resolveClosed(result);
  }
  el.addEventListener("click", (e) => { if (e.target === el) close(null); });
  card.querySelector(".term-pop-x").addEventListener("click", () => close(null));

  const gutter = window.innerWidth - document.documentElement.clientWidth;
  if (gutter > 0) document.documentElement.style.setProperty("--term-pop-gutter", gutter + "px");
  document.documentElement.classList.add("term-pop-open");
  document.body.appendChild(el);
  document.addEventListener("keydown", onKey, true);
  card.focus({ preventScroll: true });
  try { onMount?.(card, close); } catch (e) { console.warn("[sheet] mount:", e); }
  return { card, close, closed };
}

export function openPickSheet({ title = "Choose", options = [], value = null, searchPlaceholder = "Search" } = {}) {
  const opts = options.map((o) => (o === "---" ? o
    : typeof o === "string" ? { value: o, label: o } : o));
  const real = opts.filter((o) => o !== "---");
  const searchable = real.length > 8;

  const row = (o) => `
    <button type="button" class="ps-opt${o.value === value ? " on" : ""}" data-i="${opts.indexOf(o)}" role="option" aria-selected="${o.value === value}">
      <span class="ps-opt-main"><span class="ps-opt-label">${esc(o.label)}</span>${o.hint ? `<span class="ps-opt-hint">${esc(o.hint)}</span>` : ""}</span>
      ${o.meta != null && o.meta !== "" ? `<span class="ps-opt-meta">${esc(o.meta)}</span>` : ""}
      <svg class="ps-tick" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>`;
  const list = (q) => {
    const needle = q.trim().toLowerCase();
    const shown = needle
      ? real.filter((o) => `${o.label} ${o.hint || ""} ${o.value}`.toLowerCase().includes(needle))
      : opts;
    if (!shown.length) return `<p class="ps-empty">Nothing matches “${esc(q.trim())}”.</p>`;
    return shown.map((o) => (o === "---" ? `<div class="ps-div" role="separator"></div>` : row(o))).join("");
  };

  return new Promise((resolve) => {
    const sheet = openSheet({
      title,
      className: "ps-pick",
      html: `${searchable ? `<input class="input ps-search" type="search" placeholder="${esc(searchPlaceholder)}" aria-label="${esc(searchPlaceholder)}" autocomplete="off">` : ""}
        <div class="ps-list" role="listbox">${list("")}</div>`,
      onMount(card, close) {
        const listEl = card.querySelector(".ps-list");
        const search = card.querySelector(".ps-search");
        listEl.addEventListener("click", (e) => {
          const b = e.target.closest(".ps-opt");
          if (!b) return;
          const o = opts[Number(b.dataset.i)];
          if (o && o !== "---") close(o.value);
        });
        search?.addEventListener("input", () => { listEl.innerHTML = list(search.value); });
        // Arrow keys move through the options; typing a letter (no search box)
        // jumps to the first option starting with it.
        card.addEventListener("keydown", (e) => {
          const btns = [...listEl.querySelectorAll(".ps-opt")];
          if (!btns.length) return;
          const i = btns.indexOf(document.activeElement);
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const n = e.key === "ArrowDown" ? (i + 1) % btns.length : (i <= 0 ? btns.length - 1 : i - 1);
            btns[n].focus();
          } else if (!search && e.key.length === 1 && /\S/.test(e.key)) {
            const k = e.key.toLowerCase();
            btns.find((b) => b.textContent.trim().toLowerCase().startsWith(k))?.focus();
          }
        });
        const on = listEl.querySelector(".ps-opt.on");
        on?.scrollIntoView({ block: "nearest" });
        if (search && matchMedia("(hover: hover)").matches) search.focus({ preventScroll: true });
      },
    });
    sheet.closed.then(resolve);
  });
}
